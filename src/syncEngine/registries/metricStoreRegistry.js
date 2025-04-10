import { MetricStore } from '../stores/metricStore.js';
import { isNil } from 'lodash-es';
import hash from 'object-hash';

/**
 * Registry for managing MetricStore instances for optimistic metrics calculations
 */
export class MetricStoreRegistry {
    constructor() {
      this._stores = new Map();
      this._querysetStores = new Map(); // Maps queryset hashes to arrays of store keys
    }
  
    /**
     * Clear all stores in the registry
     */
    clear() {
      this._stores.forEach(store => {
        if (store && typeof store.destroy === 'function') {
          store.destroy(); // Clean up resources
        }
      });
      this._stores = new Map();
      this._querysetStores = new Map();
    }
  
    /**
     * Generate a hash for a queryset
     * @private
     * @param {Object} queryset - The queryset object
     * @returns {string} A hash for the queryset
     */
    _generateQuerysetHash(queryset) {
      const ast = queryset.build();
      const relevantAst = {
        filter: ast.filter ? JSON.stringify(ast.filter) : null,
        search: ast.search ? JSON.stringify(ast.search) : null,
        aggregations: ast.aggregations,
      };
      
      return hash(relevantAst);
    }

    /**
     * Generate a unique key for a metric
     * @private
     * @param {Function} ModelClass - The model class
     * @param {string} querysetHash - Hash of the queryset
     * @param {string} metricType - Type of the metric (count, sum, min, max)
     * @param {string} field - Field to calculate on (null for count)
     * @returns {string} A unique key for the metric
     */
    _generateKey(ModelClass, querysetHash, metricType, field) {
      const fieldPart = field ? `::${field}` : '';
      return `${ModelClass.configKey}::${ModelClass.modelName}::${querysetHash}::${metricType}${fieldPart}`;
    }
  
    /**
     * Get a MetricStore instance. Creates one if it doesn't exist.
     * @param {Object} queryset - The queryset object 
     * @param {string} metricType - Type of the metric (count, sum, min, max)
     * @param {string|null} [field=null] - Field to calculate on (null for count, required for sum/min/max)
     * @param {Function} [fetchMetricValue=null] - Optional function to fetch the metric value
     * @param {any} [initialValue=null] - Optional initial value
     * @returns {MetricStore} The metric store instance
     */
    getStore(queryset, metricType, field = null, fetchMetricValue = null, initialValue = null) {
      if (isNil(queryset)) {
        throw new Error("MetricStoreRegistry.getStore requires queryset");
      }

      if (isNil(queryset.ModelClass)) {
        throw new Error("MetricStoreRegistry.getStore requires queryset with ModelClass");
      }

      const ModelClass = queryset.ModelClass;

      if (!metricType) {
        throw new Error("metricType is required");
      }

      // For sum/min/max, field is required
      if ((metricType != 'count') && !field) {
        throw new Error(`Field is required for ${metricType} metric`);
      }

      const querysetHash = this._generateQuerysetHash(queryset);
      const key = this._generateKey(ModelClass, querysetHash, metricType, field);

      // Store the association between queryset hash and metric store key
      if (!this._querysetStores.has(querysetHash)) {
        this._querysetStores.set(querysetHash, []);
      }
      
      const storeKeys = this._querysetStores.get(querysetHash);
      if (!storeKeys.includes(key)) {
        storeKeys.push(key);
      }

      if (!this._stores.has(key)) {
        // Create fetch function if not provided
        if (!fetchMetricValue) {
          fetchMetricValue = this.createFetchMetricValueFn(queryset, metricType, field);
        }

        // Create the store - MetricStore will get its own strategy
        this._stores.set(key, new MetricStore({
          fetchMetricValue,
          metricType,
          ModelClass,
          field,
          initialValue,
          name: `${ModelClass.modelName}.${metricType}${field ? `.${field}` : ''}`
        }));

        // Initial sync
        this._stores.get(key).sync();
      }

      return this._stores.get(key);
    }

    /**
     * Get all metric stores associated with a queryset
     * @param {Object} queryset - The queryset object
     * @returns {Array<MetricStore>} Array of metric stores
     */
    getStoresForQueryset(queryset) {
      if (isNil(queryset) || isNil(queryset.ModelClass)) {
        return [];
      }

      const ModelClass = queryset.ModelClass;
      const querysetHash = this._generateQuerysetHash(queryset);
      const querysetPrefix = `${ModelClass.configKey}::${ModelClass.modelName}::${querysetHash}::`;
      
      // Use Array.from to convert the entries iterator to an array, then filter
      return Array.from(this._stores.entries())
        .filter(([key]) => key.startsWith(querysetPrefix))
        .map(([, store]) => store);
    }
  
    /**
     * Get the metric value from a specific store
     * @param {Object} queryset - The queryset object
     * @param {string} metricType - Type of the metric (count, sum, min, max)
     * @param {string|null} [field=null] - Field to calculate on (null for count)
     * @returns {Object} An object with a value getter that calls the store's render method
     */
    getEntity(queryset, metricType, field = null) {
      // defensive checks
      if (isNil(queryset) || isNil(metricType)) return null;
      
      const ModelClass = queryset.ModelClass;
      if (isNil(ModelClass)) return null;
      
      const querysetHash = this._generateQuerysetHash(queryset);
      const key = this._generateKey(ModelClass, querysetHash, metricType, field);
      
      if (!this._stores.has(key)) {
        return null; // Store doesn't exist yet
      }
      
      const store = this._stores.get(key);
      
      // Return an object with a getter for the value property
      return {
        get value() {
          return store.render();
        }
      };
    }

    /**
     * Get all metric values associated with a queryset
     * @param {Object} queryset - The queryset object
     * @returns {Object} Object with metric values keyed by store name
     */
    getEntities(queryset) {
      if (isNil(queryset)) {
        return {};
      }
    
      const stores = this.getStoresForQueryset(queryset);
      const result = {};
    
      for (let store of stores) {
        if (store.field) {
          if (!result[store.metricType]) {
            result[store.metricType] = {};
          }
          
          // For field-specific metrics, create an object with value getter for each field
          result[store.metricType][store.field] = {
            get value() {
              return store.render();
            }
          };
        } else {
          // For non-field metrics like count, create object with value getter
          result[store.metricType] = {
            get value() {
              return store.render();
            }
          };
        }
      }
    
      return result;
    }
  
    /**
     * Set a metric value, creating or updating the store as needed
     * @param {Object} queryset - The queryset object
     * @param {string} metricType - Type of the metric (count, sum, min, max)
     * @param {string|null} [field=null] - Field to calculate on (null for count)
     * @param {any} value - The value to set as the ground truth
     * @returns {any} The set value
     */
    setEntity(queryset, metricType, field = null, value) {
      // defensive checks
      if (isNil(queryset) || isNil(metricType)) return null;
      
      const ModelClass = queryset.ModelClass;
      if (isNil(ModelClass)) return null;
      
      // Get or create the store
      const store = this.getStore(queryset, metricType, field);
      store.setValue(value);
      
      return value;
    }

    /**
     * Update the ground truth data and optimistic data for all metrics
     * associated with a queryset
     * @param {Object} queryset - The queryset object
     * @param {Array} groundTruthData - Ground truth data array
     * @param {Array} optimisticData - Optimistic data array
     */
    updateDataForQueryset(queryset, groundTruthData, optimisticData) {
      const stores = this.getStoresForQueryset(queryset);
      
      stores.forEach(store => {
        if (store) {
          store.setGroundTruthData(groundTruthData);
          store.setOptimisticData(optimisticData);
        }
      });
    }
  
    /**
     * Sync a specific metric with its ground truth
     * @param {Object} queryset - The queryset object
     * @param {string} metricType - Type of the metric (count, sum, min, max)
     * @param {string|null} [field=null] - Field to calculate on (null for count)
     * @returns {Promise<void>}
     */
    async sync(queryset, metricType, field = null) {
      // defensive checks
      if (isNil(queryset) || isNil(metricType)) return;
      
      const ModelClass = queryset.ModelClass;
      if (isNil(ModelClass)) return;
      
      const querysetHash = this._generateQuerysetHash(queryset);
      const key = this._generateKey(ModelClass, querysetHash, metricType, field);
      
      if (!this._stores.has(key)) {
        return; // Store doesn't exist yet
      }
      
      await this._stores.get(key).sync();
    }

    /**
     * Sync all metrics associated with a queryset
     * @param {Object} queryset - The queryset object
     * @returns {Promise<void>}
     */
    async syncQueryset(queryset) {
      const stores = this.getStoresForQueryset(queryset);
      
      const syncPromises = stores.map(store => store.sync());
      await Promise.all(syncPromises);
    }
  
    /**
     * Sync all metrics in the registry
     * @returns {Promise<void>}
     */
    async syncAll() {
      const syncPromises = [];
      
      for (const store of this._stores.values()) {
        syncPromises.push(store.sync());
      }
      
      await Promise.all(syncPromises);
    }
  
    /**
     * Creates a factory function that generates a fetchMetricValue
     * function for a specific metric type and queryset
     * 
     * @param {Object} queryset - The queryset to use for fetching
     * @param {string} metricType - The type of metric (count, sum, min, max)
     * @param {string|null} [field=null] - Field to calculate on (required for sum, min, max)
     * @returns {Function} A function that fetches the metric value
     */
    createFetchMetricValueFn(queryset, metricType, field = null) {
      // Return a function that executes the query to get the metric value
      return async () => {
        try {
          // Get the base query AST from the queryset
          const baseAst = queryset.build();
          
          // Create a metric-specific query AST
          const metricAst = {
            ...baseAst,
            type: metricType
          };
          
          // Add field parameter for sum/min/max metrics
          if (field && (metricType != 'count')) {
            metricAst.field = field;
          }
          
          // Execute the query with the metric AST
          const response = await queryset.executeQuery(metricAst);
          
          // Return the metric value from the response
          return response.data;
        } catch (error) {
          console.error(`Error fetching metric ${metricType}:`, error);
          throw error;
        }
      };
    }
  }
  
  // Export singleton instance
  export const metricStoreRegistry = new MetricStoreRegistry();