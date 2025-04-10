/**
   * Get the metric value from a specific store
   * @param {Function} ModelClass - The model class
   * @param {Object} queryset - The queryset object
   * @param {string} metricName - Name of the metric (count, sum, min, max)
   * @param {string|null} [field=null] - Field to calculate on (null for count)
   * @returns {any} The current optimistic value of the metric or null ifimport { MetricStore } from './stores/metricStore';
import { MetricStrategyFactory } from './stores/metricOptCalcs';
import { isNil } from 'lodash-es';
import hash from 'object-hash';

/**
 * Registry for managing MetricStore instances for optimistic metrics calculations
 */
export class MetricStoreRegistry {
    constructor() {
      this._stores = new Map();
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
    }
  
    /**
     * Generate a unique key for a metric
     * @private
     * @param {Function} ModelClass - The model class
     * @param {Object} queryset - The queryset object
     * @param {string} metricName - Name of the metric (count, sum, min, max)
     * @param {string} field - Field to calculate on (null for count)
     * @returns {string} A unique key for the metric
     */
    _generateKey(ModelClass, queryset, metricName, field) {
      // Get the query AST and remove properties that don't affect metrics
      const ast = queryset.build();
      const relevantAst = {
        nodes: ast.nodes,
        fields: ast.fields,
        aggregations: ast.aggregations,
        initialQueryset: ast.initialQueryset
      };
      
      // Generate a hash of the relevant parts of the queryset
      const queryHash = hash(relevantAst);
      const fieldPart = field ? `::${field}` : '';
      
      return `${ModelClass.configKey}::${ModelClass.modelName}::${queryHash}::${metricName}${fieldPart}`;
    }
  
    /**
     * Get a MetricStore instance. Creates one if it doesn't exist.
     * @param {Function} ModelClass - The model class
     * @param {Object} queryset - The queryset object
     * @param {string} metricName - Name of the metric (count, sum, min, max)
     * @param {string|null} [field=null] - Field to calculate on (null for count, required for sum/min/max)
     * @param {Function} fetchMetricValue - Function to fetch the metric value
     * @param {any} [initialValue=null] - Initial value
     * @returns {MetricStore} The metric store instance
     */
    getStore(ModelClass, queryset, metricName, field = null, fetchMetricValue, initialValue = null) {
      if (isNil(ModelClass)) {
        throw new Error("MetricStoreRegistry.getStore requires ModelClass");
      }
  
      if (isNil(queryset)) {
        throw new Error("MetricStoreRegistry.getStore requires queryset");
      }
  
      if (!metricName) {
        throw new Error("metricName is required");
      }
  
      if (!fetchMetricValue) {
        throw new Error("fetchMetricValue is required");
      }
  
      // For sum/min/max, field is required
      if ((metricName === 'sum' || metricName === 'min' || metricName === 'max') && !field) {
        throw new Error(`Field is required for ${metricName} metric`);
      }
  
      const key = this._generateKey(ModelClass, queryset, metricName, field);
  
      if (!this._stores.has(key)) {
        // Get the appropriate strategy based on metric name
        const strategy = MetricStrategyFactory.getStrategy(metricName, ModelClass, metricName);
  
        // Create the store
        this._stores.set(key, new MetricStore({
          fetchMetricValue,
          strategy,
          field,
          initialValue,
          name: `${ModelClass.modelName}.${metricName}${field ? `.${field}` : ''}`
        }));
  
        // Initial sync
        this._stores.get(key).sync();
      }
  
      return this._stores.get(key);
    }
  
    /**
     * Get the metric value from a specific store
     * @param {Function} ModelClass - The model class
     * @param {Object} queryset - The queryset object
     * @param {string} metricName - Name of the metric (count, sum, min, max)
     * @param {string|null} [field=null] - Field to calculate on (null for count)
     * @returns {any} The current ground truth value of the metric or null if not found
     */
    getEntity(ModelClass, queryset, metricName, field = null) {
      // defensive checks
      if (isNil(ModelClass) || isNil(queryset) || isNil(metricName)) return null;
      
      const key = this._generateKey(ModelClass, queryset, metricName, field);
      
      if (!this._stores.has(key)) {
        return null; // Store doesn't exist yet
      }
      
      return this._stores.get(key).getValue();
    }
  
    /**
     * Set a metric value, creating or updating the store as needed
     * @param {Function} ModelClass - The model class 
     * @param {Object} queryset - The queryset object
     * @param {string} metricName - Name of the metric (count, sum, min, max)
     * @param {string|null} [field=null] - Field to calculate on (null for count)
     * @param {any} value - The value to set as the ground truth
     * @returns {any} The set value
     */
    setEntity(ModelClass, queryset, metricName, field = null, value) {
      // defensive checks
      if (isNil(ModelClass) || isNil(queryset) || isNil(metricName)) return null;
      
      const key = this._generateKey(ModelClass, queryset, metricName, field);
      
      if (!this._stores.has(key)) {
        // Create fetch function using the queryset
        const fetchMetricValue = this.createFetchMetricValueFn(queryset, metricName, field);
        
        // Create a new store
        this.getStore(ModelClass, queryset, metricName, field, fetchMetricValue, value);
        return value;
      }
      
      // Update existing store's ground truth value
      const store = this._stores.get(key);
      store.setValue(value);
      
      return value;
    }
  
    /**
     * Sync a specific metric with its ground truth
     * @param {Function} ModelClass - The model class
     * @param {Object} queryset - The queryset object
     * @param {string} metricName - Name of the metric (count, sum, min, max)
     * @param {string|null} [field=null] - Field to calculate on (null for count)
     * @returns {Promise<void>}
     */
    async sync(ModelClass, queryset, metricName, field = null) {
      // defensive checks
      if (isNil(ModelClass) || isNil(queryset) || isNil(metricName)) return;
      
      const key = this._generateKey(ModelClass, queryset, metricName, field);
      
      if (!this._stores.has(key)) {
        return; // Store doesn't exist yet
      }
      
      await this._stores.get(key).sync();
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