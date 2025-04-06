import { v7 as uuidv7 } from "uuid";
import { IndexedDBStorage } from "../storage/IndexedDBStorage";
import { ModelStoreSerializer } from "./ModelStoreSerializer";

/**
 * Operation class represents a single change to the data
 */
export class Operation {
  constructor(data = {}) {
    this.operationId = data.operationId || `op_${uuidv7()}`;
    this.type = data.type; // 'create', 'update', 'delete'
    this.status = data.status || 'inflight'; // 'inflight', 'confirmed', 'rejected'
    this.instances = Array.isArray(data.instances) ? data.instances : [data.instances];
    this.timestamp = data.timestamp || Date.now();
  }
}

/**
 * ModelStore combines the functionality of the previous LiveModelStore, ModelStore, and RenderEngine
 * into a single, simplified class that handles data management, caching, and rendering.
 * 
 * UPDATE: Sync scheduling responsibility has been moved to StoreManager.
 */
export class ModelStore {
  /**
   * @param {object} options Configuration options
   * @param {string} options.primaryKey Primary key field name
   * @param {Function} options.fetchGroundTruth Function to fetch ground truth data
   * @param {Function} [options.ItemClass] Optional class constructor for items
   * @param {number} [options.maxOperationAge=15000] Max age of operations in milliseconds
   * @param {boolean} [options.enableCache=false] Whether to enable caching
   * @param {string} [options.cacheDbName='modelsync_cache'] IndexedDB database name
   * @param {string} [options.cacheStoreName='query_state'] IndexedDB store name
   * @param {boolean} [options.cacheAutoSync=false] Auto-sync after cache load (now controlled by StoreManager)
   */
  constructor(options) {
    if (!options || typeof options !== 'object') {
      throw new Error("ModelStore requires options object");
    }

    // Core properties
    this.pkField = options.primaryKey;
    this.ItemClass = options.ItemClass;
    this.fetchGroundTruth = options.fetchGroundTruth;
    this.maxOperationAge = options.maxOperationAge || 15000;

    // State
    this.groundTruth = [];
    this.operations = new Map(); // id -> Operation
    this.version = 0; // Incremented on any state change affecting render output
    this.lastSyncTime = 0;
    this.isSyncing = false;

    // Caching configuration
    this._cacheEnabled = options.enableCache === true;
    this._cacheInitialized = false;
    this._initialLoadPromise = null;

    // *** Add Render Cache ***
    this._renderCache = {
        version: -1,             // Version of the data used for the cache
        fullProcessedData: null  // Holds the result of _processOperations
    };

    // Initialize persistence cache if enabled
    if (this._cacheEnabled) {
      this._setupCache(options);
    } else {
      this._cacheInitialized = true;
      this._initialLoadPromise = Promise.resolve(false);
    }

    // Create serializer regardless of cache setting (may be used elsewhere)
    this._serializer = new ModelStoreSerializer({
      ItemClass: this.ItemClass,
      primaryKey: this.pkField
    });
  }

  /**
   * Set up cache-related properties and initial load
   * @private
   */
  _setupCache(options) {
    // Cache options
    this._cacheStoreName = options.cacheStoreName || 'query_state';
    this._cacheDbName = options.cacheDbName || 'modelsync_cache';
    
    // Cache autoSync flag is preserved but defaults to false now
    this._cacheAutoSync = options.cacheAutoSync === true;

    // Storage
    this._storage = new IndexedDBStorage({
      dbName: this._cacheDbName,
      storeName: this._cacheStoreName,
      version: options.cacheDbVersion || 1
    });

    // Initial load
    this._initialLoadPromise = this._loadFromCache()
      .then(loaded => {
        this._cacheInitialized = true;
        return loaded;
      })
      .catch(err => {
        this._cacheInitialized = true;
        console.error('Cache initialization error:', err);
        
        // Re-throw to allow consumer to handle
        throw err;
      });
  }

  // ----- Data Access Methods -----

  /**
   * Returns a promise that resolves when the initial cache load attempt is complete.
   * @returns {Promise<boolean>} True if cache was loaded
   * @throws {Error} If cache load fails
   */
  async ensureInitialized() {
    if (!this._cacheEnabled) return false;
    return this._initialLoadPromise;
  }

  /**
   * Gets the ground truth data without any operations applied
   * @returns {Array<object>} Copy of ground truth data
   */
  getGroundTruth() {
    return [...this.groundTruth];
  }

  /**
   * Renders the live view of data with all applicable operations applied.
   * Uses an internal cache based on the store's version.
   * Can render the full dataset or a subset specified by primary keys.
   *
   * @param {object} [options={}] Additional rendering options.
   * @param {Function} [options.sortFn] Optional sort function: (a, b) => number.
   * @param {Array<string|number>} [options.pks=null] Optional array of primary keys.
   *                                                 - If null/undefined: render all items.
   *                                                 - If an array (even empty): render only items with matching PKs.
   * @returns {Array<object>} Current view of data (full or partial), sorted if requested.
   */
  render(options = {}) {
    const { sortFn, pks } = options; // Intentionally don't default pks to null here
    let processedData;

    // 1. Check cache validity (remains the same)
    if (this._renderCache.version === this.version && this._renderCache.fullProcessedData !== null) {
      processedData = this._renderCache.fullProcessedData;
    } else {
      processedData = this._processOperations();
      this._renderCache.fullProcessedData = processedData;
      this._renderCache.version = this.version;
    }

    // 2. Filter by pks if necessary - CORRECTED LOGIC
    let finalData;
    // Check if pks was explicitly provided as an array
    if (Array.isArray(pks)) {
        // If the array is empty, the result must be empty
        if (pks.length === 0) {
            finalData = [];
        } else {
            // If the array has keys, filter using a Set for efficiency
            const pkSet = new Set(pks);
            finalData = processedData.filter(item => pkSet.has(item[this.pkField]));
        }
    } else {
        // pks is null, undefined, or not an array - use the full list (no filtering)
        finalData = processedData;
    }

    // 3. Apply sorting if provided and return a copy (remains the same)
    if (typeof sortFn === 'function') {
      return [...finalData].sort(sortFn); // Sort a copy
    } else {
      return [...finalData]; // Return a copy
    }
  }

  /** Invalidate the render cache */
  _invalidateRenderCache() {
    // Setting version to -1 ensures the next render call recalculates
    this._renderCache.version = -1;
    this._renderCache.fullProcessedData = null; // Clear data to potentially free memory
  }

  // ----- Operation Methods -----

  /**
   * Adds an operation (create, update, delete)
   * @param {object} opData Operation data
   * @returns {string} Operation ID
   */
  add(opData) {
    const op = new Operation(opData);
    this.operations.set(op.operationId, op);
    this.version++;
    this._invalidateRenderCache(); // Invalidate cache
    return op.operationId;
  }

  /**
   * Updates an existing operation
   * @param {string} opId Operation ID
   * @param {object} changes Changes to apply
   * @returns {boolean} True if operation was found and updated
   */
  update(opId, changes) {
    const op = this.operations.get(opId);
    if (!op) return false;

    Object.assign(op, changes);
    this.version++;
    this._invalidateRenderCache(); // Invalidate cache
    return true;
  }

  /**
   * Confirms an operation with final instances data
   * @param {string} opId Operation ID
   * @param {Array} [instances] Final instance data
   * @returns {boolean} True if operation was found and updated
   */
  confirm(opId, instances) {
    // Uses update internally, which handles version++ and cache invalidation
    const op = this.operations.get(opId);
    if (!op) return false;
    const changes = { status: 'confirmed' };
    if (instances !== undefined) {
      changes.instances = Array.isArray(instances) ? instances : [instances];
    }
    return this.update(opId, changes);
  }

  /**
   * Rejects an operation
   * @param {string} opId Operation ID
   * @returns {boolean} True if operation was found and updated
   */
  reject(opId) {
    // Uses update internally, which handles version++ and cache invalidation
    return this.update(opId, { status: 'rejected' });
  }

  // Removed event communication methods - parent is now fully responsible for control flow

  // ----- Sync Methods -----

  /**
   * Sync with backend
   * @returns {Promise<boolean>} True if sync was successful
   * @throws {Error} Any errors that occur during fetch or processing
   */
  async sync() {
    // Ensure initial load finished - let errors propagate
    if (this._cacheEnabled) {
      await this.ensureInitialized();
    }

    if (this.isSyncing || !this.fetchGroundTruth) {
      console.log(`Sync skipped: isSyncing=${this.isSyncing}, no fetchGroundTruth=${!this.fetchGroundTruth}`);
      return false;
    }

    this.isSyncing = true;
    
    try {
      console.log("Sync started...");

      // Fetch fresh data - let errors propagate
      const freshData = await this.fetchGroundTruth();
      console.log("Fetched ground truth:", freshData);

      // Update ground truth - _setGroundTruth handles version++ and cache invalidation
      this._setGroundTruth(freshData);

      // Trim old operations - _trimOperations handles version++ and cache invalidation if needed
      this._trimOperations();

      this.lastSyncTime = Date.now();

      // Save to persistence cache without catching errors internally
      if (this._cacheEnabled) {
        await this._saveToCache();
        console.log("Cache saved successfully.");
      }

      console.log("Sync completed successfully.");
      return true;
    } finally {
      this.isSyncing = false;
    }
  }

  // ----- Internal Processing Methods -----

  /**
   * Process all operations on top of ground truth to build the *full* current state.
   * This is the core calculation step that the render cache optimizes.
   * @private
   * @returns {Array} Full current state after applying all operations.
   */
  _processOperations() {
    // Create a map from ground truth
    const resultMap = new Map();

    // Add ground truth items to the map
    this.groundTruth.forEach(item => {
      resultMap.set(item[this.pkField], { ...item }); // Store a copy
    });

    // Apply operations in order
    const operations = Array.from(this.operations.values())
      .filter(op => op.status !== 'rejected')
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const operation of operations) {
      this._applyOperation(operation, resultMap); // Modifies resultMap in place
    }

    // Convert map back to array
    return Array.from(resultMap.values());
  }

  /**
   * Apply a single operation to the result map. Operates on the full map.
   * @private
   * @param {Operation} operation - The operation to apply.
   * @param {Map} resultMap - The map representing the current state being built.
   */
  _applyOperation(operation, resultMap) {
    const { type, instances } = operation;

    instances.forEach(instance => {
      // Determine the primary key. Instance could be a full object or just an ID (e.g., for delete).
      const id = (instance && typeof instance === 'object' && instance[this.pkField] !== undefined)
                 ? instance[this.pkField]
                 : instance; // Assume it's the ID itself otherwise

       // Ensure id is valid before proceeding
       if (id === null || id === undefined) {
           console.warn("ModelStore: Operation instance is missing a valid primary key. Skipping instance:", instance);
           return;
       }

      // Apply based on type - modifies resultMap directly
      switch (type) {
        case 'create':
          if (!resultMap.has(id)) {
             // Ensure we have a full object, instantiating if necessary and possible
             let itemToAdd;
             if (typeof instance === 'object') {
                 itemToAdd = this.ItemClass ? new this.ItemClass(instance) : { ...instance };
                 // Ensure the pkField is correctly set if it wasn't the primary source of the ID
                 itemToAdd[this.pkField] = id;
             } else {
                 // Cannot create from just an ID if ItemClass requires more data
                 console.warn(`ModelStore: Create operation for ID ${id} only provided an ID, not full instance data. Cannot create.`);
                 // If ItemClass is not used, we might create a stub, but it's safer to warn/skip
                 // itemToAdd = { [this.pkField]: id }; // Example stub - uncomment if desired, but risky
                 return; // Skip adding if we only have an ID and need instance data
             }
             resultMap.set(id, itemToAdd);
          }
          break;

        case 'update':
          if (resultMap.has(id)) {
             if (instance && typeof instance === 'object') {
                 // Get existing item and merge changes
                 const existingItem = resultMap.get(id);
                 Object.assign(existingItem, instance);
                 // Ensure PK remains correct after merge, just in case
                 existingItem[this.pkField] = id;
             } else {
                 console.warn(`ModelStore: Update operation for ID ${id} received non-object instance data. Skipping update for this instance.`);
             }
          }
          break;

        case 'delete':
          resultMap.delete(id); // Deletes if exists, does nothing otherwise
          break;
      }
    });
  }

  /**
   * Set ground truth directly, increment version, invalidate cache.
   * @private
   */
  _setGroundTruth(data) {
    const dataArray = Array.isArray(data) ? data : [];
    this.groundTruth = dataArray.map(item =>
      this.ItemClass ? new this.ItemClass(item) : { ...item }
    );
    this.version++;
    this._invalidateRenderCache(); // Invalidate cache
  }

  /**
   * Trim operations based on age, increment version and invalidate cache if needed.
   * @private
   */
  _trimOperations() {
    const now = Date.now();
    let changed = false;
    for (const [id, op] of this.operations.entries()) {
      if (op.status !== 'inflight' && now - op.timestamp > this.maxOperationAge) {
        this.operations.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.version++;
      this._invalidateRenderCache(); // Invalidate cache if ops were removed
    }
  }

  // ----- Cache Methods -----

  /**
   * Load data from cache - allows errors to propagate
   * @private
   * @returns {Promise<boolean>} True if data was loaded
   * @throws {Error} Any errors during loading or deserialization
   */
  async _loadFromCache() {
    if (!this._cacheEnabled || !this._storage) {
      return false; // No cache enabled, resolve false immediately.
    }

    // Helper to reset state on failure - ensures store is usable even after error
    const resetState = (reason) => {
        console.warn(`Cache load failed (${reason}). Initializing with empty state.`);
        this._invalidateRenderCache();
        this.groundTruth = [];
        this.operations = new Map();
        this.version = 0; // Reset version
        this._cachedAt = null;
    };

    try {
      // Load data - I/O errors will be caught by the outer catch block
      const data = await this._storage.load(this._cacheStoreName);

      // --- Scenario 1: Empty Cache (Normal) ---
      if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
        console.log("No data found in cache or cache is empty.");
        // Reset state just to be certain we start clean
        resetState("no data found");
        return false; // RESOLVE false: Cache was empty, state is clean.
      }

      console.log("Data found in cache, attempting validation and deserialization...");

      // **Attempt Deserialization**
      let deserialized;
      try {
          deserialized = this._serializer.deserialize(data, Operation);
      } catch (deserializationError) {
          const reason = `deserialization error: ${deserializationError.message}`;
          resetState(reason); // Reset state first
          // Throw an error wrapping the original -> REJECT ensureInitialized
          const error = new Error(`Cache deserialization failed.`);
          error.cause = deserializationError; // Keep original error info
          throw error;
      }

      // --- Scenario 3: Success ---
      // Deserialization succeeded, update internal state
      this.groundTruth = Array.isArray(deserialized.groundTruth) ? deserialized.groundTruth : [];
      this.operations = deserialized.operations instanceof Map ? deserialized.operations : new Map();
      this.version = typeof deserialized.version === 'number' ? deserialized.version : 0;
      this._cachedAt = deserialized.cachedAt || null;
      this._invalidateRenderCache();

      console.log("Cache loaded and deserialized successfully.");
      return true; // RESOLVE true: Cache loaded successfully.

    } catch (error) {
      // Catches:
      // 1. Errors from storage.load() (I/O errors)
      // 2. Errors deliberately thrown above for validation/deserialization failure
      // 3. Other unexpected errors during the process

      // Ensure state is reset if not already done (idempotent)
      // Check if it's one of *our* specific errors where reset was already called
      if (!error.message.includes("Cache validation failed") && !error.message.includes("Cache deserialization failed")) {
           // If it's an I/O error or something else unexpected, reset state now
           resetState(`critical load error: ${error.message}`);
      }

      // Log the actual error that caused the rejection
      console.error("Error during cache load process, ensureInitialized will reject:", error);

      // Re-throw the error to ensure the promise returned by ensureInitialized() REJECTS
      throw error;
    }
  }

  /**
   * Save current state to persistence cache
   * @private
   * @returns {Promise<any>} Result from storage save
   * @throws {Error} Any errors during serialization or saving
   */
  async _saveToCache() {
    if (!this._cacheEnabled || !this._storage) {
      return false;
    }

    // Use serializer to prepare data for storage - let errors propagate
    const serialized = this._serializer.serialize(this);

    // Add id for storage
    serialized.id = this._cacheStoreName;

    // Save to storage - let errors propagate
    return await this._storage.save(serialized);
  }

  /**
   * Clear persistence cache data
   * @returns {Promise<boolean>} Success status
   * @throws {Error} Any errors during deletion
   */
  async clearCache() {
    if (!this._cacheEnabled || !this._storage) {
      return false;
    }

    // Delete from storage - let errors propagate
    await this._storage.delete(this._cacheStoreName);
    console.log("Cache cleared");
    
    // Invalidate render cache
    this._invalidateRenderCache();
    
    return true;
  }

  /**
   * Clean up resources
   * @returns {Promise<void>}
   */
  async destroy() {
    console.log("Destroying ModelStore...");
    
    // Close storage if enabled
    if (this._cacheEnabled && this._storage) {
      try {
        await this._storage.close();
      } catch (err) {
        console.error("Error closing storage:", err);
        throw err; // Allow error to propagate
      } finally {
        this._storage = null;
      }
    }

    // Clear render cache
    this._renderCache = null;

    console.log("ModelStore destroyed successfully.");
  }
}