import { v7 as uuidv7 } from "uuid";
import { IndexedDBStorage } from "../storage/IndexedDBStorage";
import { QuerySetStoreSerializer } from "./QuerySetStoreSerializer";

/**
 * Operation class for QuerySetStore
 * Tracks changes to the set of IDs
 */
export class QuerySetOperation {
  constructor(data = {}) {
    this.operationId = data.operationId || `qop_${uuidv7()}`;
    this.type = data.type; // 'create', 'update', 'delete' - keeping consistent with ModelStore
    this.status = data.status || 'inflight'; // 'inflight', 'confirmed', 'rejected'
    this.ids = Array.isArray(data.ids) ? data.ids : [data.ids];
    this.timestamp = data.timestamp || Date.now();
  }
}

/**
 * QuerySetStore manages a list of IDs representing a queryset with optimistic updates
 * Handles both the data management and rendering concerns in a single class.
 * 
 * UPDATE: Sync scheduling responsibility has been moved to parent component.
 */
export class QuerySetStore {
  /**
   * @param {object} options Configuration options
   * @param {string} options.queryName Name of the query
   * @param {Function} options.fetchQuerySet Function to fetch IDs from backend
   * @param {number} [options.defaultLimit=20] Default limit for pagination
   * @param {number} [options.maxOperationAge=15000] Max age of operations in milliseconds
   * @param {boolean} [options.enableCache=false] Whether to enable caching
   * @param {string} [options.cacheDbName='modelsync_querysets'] IndexedDB database name
   * @param {string} [options.cacheStoreName] IndexedDB store name (defaults to query_{queryName})
   * @param {boolean} [options.cacheAutoSync=false] Auto-sync after cache load (now controlled by parent)
   */
  constructor(options) {
    // Basic configuration
    this.queryName = options.queryName || 'default_query';
    this.fetchQuerySet = options.fetchQuerySet;
    this.maxOperationAge = options.maxOperationAge || 15000;
    
    // Default limit for pagination
    this.defaultLimit = options.defaultLimit || 20;
    
    // Core state
    this.groundTruthIds = []; // Server-provided IDs
    this.operations = new Map(); // id -> QuerySetOperation
    this.version = 0;
    
    // Sync state
    this.lastSyncTime = 0;
    this.isSyncing = false;

    // Rendering cache
    this._renderCache = {
      version: -1, // Version at which cached IDs were processed
      processedIds: null // Cached list of processed IDs
    };

    // Caching configuration (opt-in)
    this._cacheEnabled = options.enableCache === true;
    this._cacheInitialized = false;
    this._initialLoadPromise = null;

    // Initialize cache if enabled
    if (this._cacheEnabled) {
      this._setupCache(options);
    } else {
      this._cacheInitialized = true;
      this._initialLoadPromise = Promise.resolve(false);
    }
  }

  /**
   * Set up cache-related properties and initial load
   * @private
   */
  _setupCache(options) {
    // Cache-specific options
    this._cacheStoreName = options.cacheStoreName || `query_${this.queryName}`;
    this._cacheDbName = options.cacheDbName || 'modelsync_querysets';
    
    // Cache autoSync flag is preserved but defaults to false now
    this._cacheAutoSync = options.cacheAutoSync === true;

    // Create storage instance
    this._storage = new IndexedDBStorage({
      dbName: this._cacheDbName,
      storeName: this._cacheStoreName,
      version: options.cacheDbVersion || 1
    });

    // Create serializer
    this._serializer = new QuerySetStoreSerializer({
      queryName: this.queryName
    });

    // Initial load
    this._initialLoadPromise = this._loadFromCache()
      .then(loaded => {
        this._cacheInitialized = true;
        return loaded;
      })
      .catch(err => {
        this._cacheInitialized = true;
        console.error(`[QuerySetStore:${this.queryName}] Error during initial cache load:`, err);
        
        // Re-throw to allow consumer to handle
        throw err;
      });
  }

  // ----- Data Access and Rendering Methods -----

  /**
   * Returns a promise that resolves once the initial cache load attempt is complete.
   * @returns {Promise<boolean>} Resolves with true if cache was loaded, false otherwise.
   */
  async ensureInitialized() {
    if (!this._cacheEnabled) return false;
    return this._initialLoadPromise;
  }

  /**
   * Gets the ground truth IDs directly without any operations applied.
   * This represents the last-known server state.
   * @returns {Array<any>} Copy of ground truth IDs
   */
  getGroundTruthIds() {
    return [...this.groundTruthIds];
  }

  /**
   * Get all IDs with optimistic updates applied.
   * This is the main method to get the current state of the queryset.
   * @returns {Array} Complete list of current IDs
   */
  getCurrentIds() {
    let processedIds;

    // Check if cache is valid based on version
    if (this._renderCache.processedIds !== null && 
        this._renderCache.version === this.version) {
      // Cache HIT: Use the cached processed IDs
      processedIds = this._renderCache.processedIds;
    } else {
      // Cache MISS or INVALID: Recalculate the processed IDs
      processedIds = this._processOperations();
      // Update the cache
      this._renderCache.processedIds = processedIds;
      this._renderCache.version = this.version;
    }

    return [...processedIds]; // Return a copy to prevent mutations
  }

  /**
   * Get the count of items after applying all operations.
   * @returns {number} Current count of items
   */
  getCount() {
    return this.getCurrentIds().length;
  }

  /**
   * Renders the optimistic view of IDs with pagination and optional sorting.
   * @param {Object} params Rendering parameters
   * @param {number} [params.offset=0] Starting index (0-based)
   * @param {number} [params.limit] Maximum number of items to return (defaults to this.defaultLimit)
   * @param {Function} [params.sortFn] Optional sort function for IDs: (a, b) => number
   * @returns {Array} Rendered subset of IDs
   */
  render(params = {}) {
    // Ensure defaults
    const offset = params.offset || 0;
    const limit = params.limit !== undefined ? params.limit : this.defaultLimit;
    const sortFn = params.sortFn;

    // Get current IDs (already cached if possible)
    const processedIds = this.getCurrentIds();

    // Sort IDs if sortFn provided
    const sortedIds = this._applySorting(processedIds, sortFn);
    
    // Apply pagination
    if (limit === null) {
      return sortedIds.slice(offset);
    }
    return sortedIds.slice(offset, offset + limit);
  }

  /**
   * Get a slice of IDs with optimistic updates and optional sorting applied.
   * Provides pagination-like control using offset/limit pattern.
   * @param {Object} options Slicing options
   * @param {number} [options.offset=0] Starting position (0-based)
   * @param {number} [options.limit] Maximum number of items to return (defaults to this.defaultLimit)
   * @param {Function} [options.sortFn] Optional sort function for IDs: (a, b) => number
   * @returns {Object} Sliced result with IDs and metadata
   */
  getSlice(options = {}) {
    const offset = options.offset || 0;
    const limit = options.limit !== undefined ? options.limit : this.defaultLimit;
    const sortFn = options.sortFn;
    
    // Get current IDs with operations applied
    const allIds = this.getCurrentIds();
    
    // Apply sorting if needed
    const sortedIds = this._applySorting(allIds, sortFn);
    
    // Apply slicing
    const slicedIds = limit ? sortedIds.slice(offset, offset + limit) : sortedIds.slice(offset);
    
    // Return with pagination metadata
    return {
      ids: slicedIds,
      metadata: {
        offset,
        limit,
        totalItems: sortedIds.length,
        hasMore: offset + limit < sortedIds.length
      }
    };
  }

  // ----- Operation Methods -----

  /**
   * Adds an operation (create, update, delete)
   * @param {object} opData Operation data with type and ids
   * @returns {string} Operation ID
   */
  add(opData) {
    // Create a new operation
    const op = new QuerySetOperation({
      ...opData,
      type: opData.type || 'create' // Default to 'create' for add operations
    });
    
    this.operations.set(op.operationId, op);
    this.version++;
    this._invalidateRenderCache();
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
    this._invalidateRenderCache();
    return true;
  }

  /**
   * Confirms an operation with final IDs data
   * @param {string} opId Operation ID
   * @param {Array} [ids] Final IDs data
   * @returns {boolean} True if operation was found and updated
   */
  confirm(opId, ids) {
    const op = this.operations.get(opId);
    if (!op) return false;

    const changes = { status: 'confirmed' };

    // If IDs are provided, update them
    if (ids !== undefined) {
      changes.ids = Array.isArray(ids) ? ids : [ids];
    }

    return this.update(opId, changes);
  }

  /**
   * Rejects an operation
   * @param {string} opId Operation ID
   * @returns {boolean} True if operation was found and updated
   */
  reject(opId) {
    return this.update(opId, { status: 'rejected' });
  }

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

    if (this.isSyncing || !this.fetchQuerySet) {
      console.log(`[QuerySetStore:${this.queryName}] Sync skipped: isSyncing=${this.isSyncing}, no fetchQuerySet=${!this.fetchQuerySet}`);
      return false;
    }

    this.isSyncing = true;
    
    try {
      console.log(`[QuerySetStore:${this.queryName}] Sync started...`);

      // Fetch fresh IDs - let errors propagate
      const freshIds = await this.fetchQuerySet();
      console.log(`[QuerySetStore:${this.queryName}] Fetched ${freshIds.length} IDs`);

      // Update ground truth
      this._setGroundTruthIds(freshIds);

      // Trim operations
      this._trimOperations();

      this.lastSyncTime = Date.now();

      // Save to persistence cache without catching errors internally
      if (this._cacheEnabled) {
        await this._saveToCache();
        console.log(`[QuerySetStore:${this.queryName}] Cache saved successfully.`);
      }

      console.log(`[QuerySetStore:${this.queryName}] Sync completed successfully.`);
      return true;
    } finally {
      this.isSyncing = false;
    }
  }

  // ----- Internal Processing Methods -----

  /**
   * Set ground truth directly (used internally)
   * @private
   */
  _setGroundTruthIds(ids) {
    // Ensure data is an array of IDs
    this.groundTruthIds = Array.isArray(ids) ? [...ids] : [];
    this.version++;
    this._invalidateRenderCache();
  }

  /**
   * Invalidate the render cache when data changes
   * @private
   */
  _invalidateRenderCache() {
    if (this._renderCache) {
      this._renderCache.version = -1;
      this._renderCache.processedIds = null;
    }
  }

  /**
   * Process all operations on top of ground truth to build current state
   * @private
   * @returns {Array} Current list of IDs after applying all operations
   */
  _processOperations() {
    // Start with ground truth IDs
    const idSet = new Set(this.groundTruthIds);
    
    // Apply operations in chronological order
    const operations = Array.from(this.operations.values())
      .filter(op => op.status !== 'rejected')
      .sort((a, b) => a.timestamp - b.timestamp);
    
    for (const op of operations) {
      switch (op.type) {
        case 'create':
          // Add IDs to the set
          op.ids.forEach(id => idSet.add(id));
          break;
        case 'delete':
          // Remove IDs from the set
          op.ids.forEach(id => idSet.delete(id));
          break;
        case 'update':
          // For querysets, 'update' doesn't change membership
          // but we keep it for consistency
          break;
      }
    }
    
    return Array.from(idSet);
  }

  /**
   * Apply sorting to IDs
   * @private
   * @param {Array} ids - IDs to sort
   * @param {Function} sortFn - Custom sort function (a, b) => number
   * @returns {Array} Sorted IDs
   */
  _applySorting(ids, sortFn) {
    if (!sortFn || typeof sortFn !== 'function') {
      return [...ids]; // Return a copy without sorting
    }
    
    return [...ids].sort(sortFn);
  }

  /**
   * Trim operations based on age
   * @private
   */
  _trimOperations() {
    const now = Date.now();
    let changed = false;
    // Remove any operations that are older than the configured age
    // Skip 'inflight' operations as they still need to be processed
    for (const [id, op] of this.operations.entries()) {
      if (op.status !== 'inflight' && now - op.timestamp > this.maxOperationAge) {
        this.operations.delete(id);
        changed = true;
      }
    }
    
    if (changed) {
      this.version++;
      this._invalidateRenderCache();
    }
  }

  // ----- Cache Methods -----

  /**
   * Load state from cache
   * @private
   * @returns {Promise<boolean>} True if data was loaded successfully
   * @throws {Error} Any errors during loading or deserialization
   */
  async _loadFromCache() {
    if (!this._cacheEnabled || !this._storage || !this._serializer) {
      return false;
    }

    console.log(`[QuerySetStore:${this.queryName}] Attempting to load from cache...`);
    
    // Helper to reset state on failure - ensures store is usable even after error
    const resetState = (reason) => {
      console.warn(`[QuerySetStore:${this.queryName}] Cache load failed (${reason}). Initializing with empty state.`);
      this._invalidateRenderCache();
      this.groundTruthIds = [];
      this.operations = new Map();
      this.version = 0; // Reset version
      this._isStale = false;
    };

    try {
      // Load data - I/O errors will be caught by the outer catch block
      const data = await this._storage.load(this._cacheStoreName);

      // --- Scenario 1: Empty Cache (Normal) ---
      if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
        console.log(`[QuerySetStore:${this.queryName}] No data found in cache or cache is empty.`);
        // Reset state just to be certain we start clean
        resetState("no data found");
        return false; // RESOLVE false: Cache was empty, state is clean.
      }

      console.log(`[QuerySetStore:${this.queryName}] Data found in cache, attempting validation and deserialization...`);

      // **Attempt Deserialization**
      let deserialized;
      try {
        deserialized = this._serializer.deserialize(data, QuerySetOperation);
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
      this.groundTruthIds = Array.isArray(deserialized.groundTruthIds) ? deserialized.groundTruthIds : [];
      this.operations = deserialized.operations instanceof Map ? deserialized.operations : new Map();
      this.version = typeof deserialized.version === 'number' ? deserialized.version : 0;
      this._invalidateRenderCache();

      console.log(`[QuerySetStore:${this.queryName}] Cache loaded and deserialized successfully.`);
      return true; // RESOLVE true: Cache loaded successfully.

    } catch (error) {
      // Ensure state is reset if not already done (idempotent)
      if (!error.message.includes("Cache deserialization failed")) {
        // If it's an I/O error or something else unexpected, reset state now
        resetState(`critical load error: ${error.message}`);
      }

      // Log the actual error that caused the rejection
      console.error(`[QuerySetStore:${this.queryName}] Error during cache load process, ensureInitialized will reject:`, error);

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
    if (!this._cacheEnabled || !this._storage || !this._serializer) {
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
   * Clear cached data
   * @returns {Promise<boolean>} Success status
   * @throws {Error} Any errors during deletion
   */
  async clearCache() {
    if (!this._cacheEnabled || !this._storage) {
      return false;
    }

    // Delete from storage - let errors propagate
    await this._storage.delete(this._cacheStoreName);
    console.log(`[QuerySetStore:${this.queryName}] Cache cleared for key:`, this._cacheStoreName);
    
    // Invalidate render cache
    this._invalidateRenderCache();
    
    return true;
  }

  /**
   * Clean up resources
   * @returns {Promise<void>}
   */
  async destroy() {
    console.log(`[QuerySetStore:${this.queryName}] Destroying...`);

    // Clean up cache resources if enabled
    if (this._cacheEnabled && this._storage) {
      try {
        await this._storage.close();
      } catch (err) {
        console.error(`[QuerySetStore:${this.queryName}] Error closing storage:`, err);
        throw err; // Allow error to propagate
      } finally {
        this._storage = null;
        this._serializer = null;
      }
    }

    // Clear render cache
    this._renderCache = null;
    
    console.log(`[QuerySetStore:${this.queryName}] Destroyed.`);
  }
}