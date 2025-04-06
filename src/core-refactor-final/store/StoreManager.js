// modelsync-client/src/core-refactor-final/StoreManager.js
import { ModelStore } from './ModelStore.js'; // Adjust path
import { QuerySetStore } from '../querysetstore/QuerySetStore.js'; // Adjust path
import hash from 'object-hash'; // Use object-hash

// Assuming your Model base class might have static properties we can check
// import { Model as BaseModel } from '../../../src'; // Example import path

/**
 * Manages ModelStore and QuerySetStore instances, processing API responses
 * and providing access points to the underlying stores and (eventually) live data.
 * Requires knowledge of the application's Model classes.
 */
export class StoreManager {
  /**
   * @param {object} options Configuration for the StoreManager
   * @param {object.<string, Function>} options.modelClasses - REQUIRED map where keys are model type strings
   *                                                          (e.g., 'blog.user', matching API 'type') and values
   *                                                          are the corresponding JavaScript Model class constructors.
   * @param {object} [options.modelStoreConfigs] - Optional map of model types to specific configurations
   *                                              that override or supplement info derived from modelClasses.
   *                                              (e.g., { 'blog.user': { enableCache: true, fetchGroundTruth: myFetchFn } })
   * @param {object} [options.querySetStoreConfigs] - Map of AST hashes to configs for QuerySetStore.
   * @param {object} [options.defaultModelStoreOptions] - Default options applied to all ModelStores.
   * @param {object} [options.defaultQuerySetStoreOptions] - Default options applied to all QuerySetStores.
   */
  constructor(options = {}) {
    // *** REQUIRED: Map of model type strings to Model Class Constructors ***
    if (!options.modelClasses || typeof options.modelClasses !== 'object' || Object.keys(options.modelClasses).length === 0) {
      throw new Error("StoreManager requires a non-empty 'modelClasses' option mapping type strings to Model constructors.");
    }
    this.modelClasses = options.modelClasses;

    // Optional configurations
    this.modelStoreConfigs = options.modelStoreConfigs || {};
    this.querySetStoreConfigs = options.querySetStoreConfigs || {};
    this.defaultModelStoreOptions = options.defaultModelStoreOptions || {};
    this.defaultQuerySetStoreOptions = options.defaultQuerySetStoreOptions || {};

    // Internal store maps
    this.modelStores = new Map(); // Type -> ModelStore instance
    this.querySetStores = new Map(); // AstHash -> QuerySetStore instance

    this._isDestroyed = false;
  }

  // =============================================
  // == FINAL CODE: Response Processing & Routing ==
  // =============================================

  /**
   * Processes a server response for a query, updating stores with received data.
   * @param {object} ast - The query Abstract Syntax Tree.
   * @param {object} responseData - Server response { data, included }.
   * @returns {boolean} Success status.
   */
  processResponse(ast, responseData) {
    // --- No changes needed in this method itself ---
    if (this._isDestroyed) {
      console.warn("StoreManager: Attempted to process response after destroy.");
      return false;
    }
    if (!ast || !responseData || typeof responseData !== 'object' || !responseData.hasOwnProperty('data')) {
        console.error("StoreManager: Invalid arguments or response structure for processResponse.", { ast, responseData });
        return false;
    }
    const astHash = hash(ast);
    try {
      this._processModelData(responseData);
      this._updateQuerySet(ast, astHash, responseData.data);
      return true;
    } catch (error) {
      console.error(`StoreManager: Error processing response for AST hash '${astHash}':`, error);
      return false;
    }
  }

  /**
   * Process model data from response and update appropriate ModelStores.
   * @private
   */
  _processModelData(responseData) {
    // --- No changes needed in this method itself ---
    const itemsByType = this._extractItemsByType(responseData);
    for (const [type, items] of itemsByType) {
      if (items.length > 0) {
        const store = this._getOrCreateModelStore(type); // Relies on updated _getOrCreateModelStore
        if (store) {
          store.add({ type: 'update', status: 'confirmed', instances: items });
        }
      }
    }
  }

  /**
   * Update the QuerySetStore for a specific AST with its ground truth IDs.
   * @private
   */
  _updateQuerySet(ast, astHash, primaryData) {
     // --- No changes needed in this method itself ---
    const store = this._getOrCreateQuerySetStore(ast, astHash);
    if (store) {
      const ids = this._extractPrimaryIds(primaryData);
      store._setGroundTruthIds(ids);
    }
  }

  /**
   * Extract all unique items from response (data and included) and group by type.
   * @private
   */
  _extractItemsByType(responseData) {
     // --- No changes needed in this method itself ---
     const itemsByType = new Map();
     const processedIds = new Set();
     const addItem = (item) => { /* ... same logic ... */
        if (!item || typeof item !== 'object' || !item.type || typeof item.type !== 'string' || item.id === undefined) {
            if (item !== null) { console.warn("StoreManager._extractItemsByType: Skipping invalid item structure:", item); }
            return;
        }
        const itemKey = `${item.type}/${item.id}`;
        if (processedIds.has(itemKey)) return;
        if (!itemsByType.has(item.type)) itemsByType.set(item.type, []);
        itemsByType.get(item.type).push(item);
        processedIds.add(itemKey);
     };
     const primaryData = responseData.data;
     if (primaryData) { (Array.isArray(primaryData) ? primaryData : [primaryData]).forEach(addItem); }
     const included = responseData.included;
     if (included && typeof included === 'object') {
        for (const type in included) {
            const itemsById = included[type];
            if (itemsById && typeof itemsById === 'object') {
                for (const id in itemsById) { addItem(itemsById[id]); }
            }
        }
     }
     return itemsByType;
  }

  /**
   * Extract primary IDs from the 'data' section of the response.
   * @private
   */
  _extractPrimaryIds(data) {
     // --- No changes needed in this method itself ---
     if (data === null || data === undefined) return [];
     const items = Array.isArray(data) ? data : [data];
     return items.filter(item => item && typeof item === 'object' && item.id !== undefined).map(item => item.id);
  }

  /**
   * Get an existing or create a new ModelStore for a type, using modelClasses map.
   * @private
   * @param {string} type - Model type string (e.g., 'blog.user').
   * @returns {ModelStore|null} The store instance or null.
   */
  _getOrCreateModelStore(type) {
    if (this.modelStores.has(type)) {
      return this.modelStores.get(type);
    }

    // *** Get the Model Class constructor from the provided map ***
    const ModelClass = this.modelClasses[type];
    const specificConfig = this.modelStoreConfigs[type] || {}; // Use specific config or empty object

    // *** Determine primaryKey: Use config first, then static property from ModelClass ***
    const primaryKey = specificConfig.primaryKey || ModelClass?.primaryKeyField;
    if (!primaryKey) {
      // Cannot proceed without a primary key definition
      console.error(`StoreManager: Cannot determine primary key for type '${type}'. Provide it in modelStoreConfigs or ensure '${type}' exists in modelClasses with a static 'primaryKeyField'.`);
      return null;
    }

    // *** Determine ItemClass: Use config first, then the ModelClass itself ***
    const ItemClass = specificConfig.ItemClass || ModelClass; // Default to using the ModelClass if no specific ItemClass override

    // *** Determine fetchGroundTruth: MUST be provided either in defaults or specific config ***
    // (ModelStore requires it if syncInterval > 0, which is the default)
    // We assume it's provided in either defaultModelStoreOptions or specificConfig.
    // ModelStore constructor will throw if missing and needed.

    // *** Build final options for ModelStore constructor ***
    try {
      const options = {
        // Defaults first
        ...this.defaultModelStoreOptions,
        // Specific config overrides defaults
        ...specificConfig,
        // Derived values override config/defaults *unless* they were explicitly in specificConfig
        // (e.g. if specificConfig had 'primaryKey', it won't be overwritten by ModelClass.primaryKeyField)
        primaryKey: primaryKey, // Use the determined primaryKey
        ItemClass: ItemClass,   // Use the determined ItemClass
        // Generate safe cache name if not provided
        cacheStoreName: specificConfig.cacheStoreName || `model_${type}`.replace(/[^a-zA-Z0-9_.-]/g, '_'),
        // Determine cache enablement
        enableCache: specificConfig.enableCache ?? this.defaultModelStoreOptions?.enableCache ?? false,
      };

      // Optional: Add validation here to ensure essential options like fetchGroundTruth are present if needed by ModelStore's defaults
      if ((options.syncInterval === undefined || options.syncInterval > 0) && typeof options.fetchGroundTruth !== 'function') {
           console.warn(`StoreManager: ModelStore for type '${type}' will likely require a 'fetchGroundTruth' function based on sync settings, but none was found in config or defaults.`);
           // Allow creation for now, ModelStore constructor might throw later if needed
      }


      const store = new ModelStore(options);
      this.modelStores.set(type, store);
      // console.log(`StoreManager: Created new ModelStore for type: ${type}`);
      return store;
    } catch (error) {
      console.error(`StoreManager: Failed to create ModelStore for type '${type}':`, error);
      return null;
    }
  }

  /**
   * Get an existing or create a new QuerySetStore for an AST.
   * @private
   */
  _getOrCreateQuerySetStore(ast, astHash) {
     // --- No changes needed in this method itself ---
    if (this.querySetStores.has(astHash)) {
      return this.querySetStores.get(astHash);
    }
    const config = this.querySetStoreConfigs[astHash];
    if (!config || typeof config.fetchQuerySet !== 'function') {
       if (config) { console.warn(`StoreManager: Invalid QuerySetStore configuration for AST hash '${astHash}'. Missing 'fetchQuerySet' function.`); }
       // else { console.log(`StoreManager: No QuerySetStore configuration found for AST hash: ${astHash}`); } // Less noisy
      return null;
    }
    try {
      const options = { /* ... same logic ... */
        queryName: astHash,
        ...this.defaultQuerySetStoreOptions,
        ...(config.options || {}),
        fetchQuerySet: config.fetchQuerySet,
        cacheStoreName: config.options?.cacheStoreName || `queryset_${astHash}`.replace(/[^a-zA-Z0-9_.-]/g, '_'),
        enableCache: config.options?.enableCache ?? this.defaultQuerySetStoreOptions?.enableCache ?? false
      };
      const store = new QuerySetStore(options);
      this.querySetStores.set(astHash, store);
      // console.log(`StoreManager: Created new QuerySetStore for AST hash: ${astHash}`);
      return store;
    } catch (error) {
      console.error(`StoreManager: Failed to create QuerySetStore for hash '${astHash}':`, error);
      return null;
    }
  }

  // =============================================
  // == FINAL CODE: Store Accessors & Destroy   ==
  // =============================================

  /**
   * Retrieves an existing ModelStore instance by type.
   * @param {string} type - The model type string.
   * @returns {ModelStore | undefined}
   */
  getModelStore(type) {
    // --- No changes needed ---
    if (this._isDestroyed) return undefined;
    return this.modelStores.get(type);
  }

  /**
   * Retrieves an existing QuerySetStore instance by AST or its hash.
   * @param {object | string} astOrHash - The AST object or its pre-computed hash.
   * @returns {QuerySetStore | undefined}
   */
  getQuerySetStore(astOrHash) {
     // --- No changes needed ---
    if (this._isDestroyed) return undefined;
    const astHash = typeof astOrHash === 'string' ? astOrHash : hash(astOrHash);
    return this.querySetStores.get(astHash);
  }

  /**
   * Cleans up all managed stores and resources.
   */
  async destroy() {
     // --- No changes needed ---
     if (this._isDestroyed) return;
     this._isDestroyed = true;
     console.log("StoreManager: Destroying...");
     const destroyPromises = [];
     this.querySetStores.forEach((store, key) => destroyPromises.push(store.destroy().catch(err => console.error(`Error destroying QuerySetStore ${key}:`, err))));
     this.modelStores.forEach((store, key) => destroyPromises.push(store.destroy().catch(err => console.error(`Error destroying ModelStore ${key}:`, err))));
     await Promise.allSettled(destroyPromises);
     this.querySetStores.clear();
     this.modelStores.clear();
     console.log("StoreManager: Destroyed.");
  }


  // =============================================
  // == PLACEHOLDER CODE: Live Data Retrieval   ==
  // =============================================

  /**
   * Retrieves the live, combined data for a given query AST.
   * Calls internal placeholder `_getQueryDataInternal`.
   * @param {object|string} astOrHash - AST object or hash.
   * @param {object} [options] - Rendering options.
   * @returns {any} Placeholder (currently undefined).
   */
  getQueryData(astOrHash, options = {}) {
     // --- No changes needed ---
    if (this._isDestroyed) return undefined;
    const astHash = typeof astOrHash === 'string' ? astOrHash : hash(astOrHash);
    return this._getQueryDataInternal(astHash, options);
  }

  /**
   * Retrieves the live state of a single model instance by its type and ID.
   * Calls internal placeholder `_getModelInstanceInternal`.
   * @param {string} type - Model type.
   * @param {string|number} id - Primary key.
   * @returns {object|undefined} Placeholder (currently undefined).
   */
  getModelInstance(type, id) {
     // --- No changes needed ---
     if (this._isDestroyed) return undefined;
     return this._getModelInstanceInternal(type, id);
  }

  /**
   * [Placeholder] Internal logic for retrieving live query data.
   * @private
   */
  _getQueryDataInternal(astHash, options) {
     // --- No changes needed ---
    console.log(`[Placeholder] StoreManager._getQueryDataInternal called for hash: ${astHash}. Options:`, options);
    // ... future implementation comments ...
    const querySetStore = this.getQuerySetStore(astHash);
    return querySetStore ? querySetStore.getCurrentIds() : undefined; // Temporary
  }

 /**
 * [Placeholder] Internal logic for retrieving a single live model instance.
 * @private
 */
  _getModelInstanceInternal(type, id) {
     // --- No changes needed ---
    console.log(`[Placeholder] StoreManager._getModelInstanceInternal called for type: ${type}, id: ${id}`);
    if (!type || typeof type !== 'string' || id === null || id === undefined) { console.warn(...); return undefined; }
    // ... future implementation comments ...
    return undefined; // Placeholder return
  }
}