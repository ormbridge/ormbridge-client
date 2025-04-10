import { QuerysetStore } from '../stores/querysetStore.js';
import { modelStoreRegistry } from '../registries/modelStoreRegistry.js';

import { isNil } from 'lodash-es';
import hash from 'object-hash';

/**
 * A dynamic wrapper that always returns the latest queryset results
 * This class proxies array operations to always reflect the current state
 * of the underlying QuerysetStore
 */
export class LiveQueryset {
    #queryset;
    #ModelClass;
    #proxy;
  
    constructor(queryset) {
      this.#queryset = queryset;
      this.#ModelClass = queryset.ModelClass;
      
      // Create a proxy that intercepts all array access
      this.#proxy = new Proxy([], {
        get: (target, prop) => {
          // Special handling for iterators and common array methods
          if (prop === Symbol.iterator) {
            return () => this.getCurrentItems()[Symbol.iterator]();
          } else if (typeof prop === 'string' && ['forEach', 'map', 'filter', 'reduce', 'some', 'every', 'find'].includes(prop)) {
            return (...args) => this.getCurrentItems()[prop](...args);
          } else if (prop === 'length') {
            return this.getCurrentItems().length;
          } else if (typeof prop === 'string' && !isNaN(parseInt(prop))) {
            // Handle numeric indices
            return this.getCurrentItems()[prop];
          }
          
          return target[prop];
        }
      });
      
      return this.#proxy;
    }
  
    /**
     * Get the current items from the store
     * @private
     * @returns {Array} The current items in the queryset
     */
    getCurrentItems() {
      const store = querysetStoreRegistry.getStore(this.#queryset);
      
      // Get the current primary keys from the store
      const pks = store.render();
      
      // Map primary keys to full model objects
      return pks.map(pk => {
        // Get the full model instance from the model store
        const pkField = this.#ModelClass.primaryKeyField;
        return modelStoreRegistry.getEntity(this.#ModelClass, pk) || { [pkField]: pk };
      });
    }
  }

class QuerysetStoreRegistry {
  constructor() {
    this._stores = new Map();
  }

  clear() {
    this._stores = new Map();
  }

  _generateKey(queryset) {
    const ast = queryset.build();
    
    // Extract only the relevant parts that affect the queryset results
    const relevantAst = {
      filter: ast.filter ? JSON.stringify(ast.filter) : null,
      search: ast.search ? JSON.stringify(ast.search) : null,
    };
    
    // Generate a hash of the relevant parts
    const queryHash = hash(relevantAst);
    
    return `${queryset.ModelClass.configKey}::${queryset.ModelClass.modelName}::${queryHash}`;
  }

  getStore(queryset) {
    if (isNil(queryset) || isNil(queryset.ModelClass)) {
      throw new Error("QuerysetStoreRegistry.getStore requires a valid queryset");
    }
    
    const key = this._generateKey(queryset);
    
    if (!this._stores.has(key)) {
      const fetchQueryset = async ({ ast, modelClass }) => {
        return await queryset.fetch({
          fields: [modelClass.primaryKeyField]
        });
      };
      
      this._stores.set(key, new QuerysetStore(
        queryset.ModelClass,
        fetchQueryset,
        queryset.build(),
        [], // Initial ground truth PKs
        []  // Initial operations
      ));
      
      // Initial sync
      this._stores.get(key).sync();
    }
    
    return this._stores.get(key);
  }

  /**
   * Get the current state of the queryset, wrapped in a LiveQueryset
   * @param {Object} queryset - The queryset
   * @returns {LiveQueryset} - A live view of the queryset
   */
  getEntity(queryset) {
    return new LiveQueryset(queryset);
  }

  /**
   * Set ground truth for a queryset
   * @param {Object} queryset - The queryset
   * @param {Array} instances - Array of instances to set as ground truth
   * @returns {Array} - The set instances
   */
  setEntity(queryset, instances) {
    if (isNil(queryset) || isNil(instances)) return [];
    
    const store = this.getStore(queryset);
    store.setGroundTruth(
      instances.map(instance => instance[queryset.ModelClass.primaryKeyField] || instance)
    );
    return instances;
  }
}

export const querysetStoreRegistry = new QuerysetStoreRegistry();