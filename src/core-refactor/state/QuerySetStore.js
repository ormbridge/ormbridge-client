import { v7 as uuidv7 } from "uuid";
import { IndexedDBStorage } from "../storage/IndexedDBStorage";
import { QuerySetStoreSerializer } from "../serialization/QuerySetStoreSerializer";

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
 * QuerySetStore manages a list of IDs representing a queryset
 * Completely decoupled from ModelStore - just manages IDs
 */
export class QuerySetStore {
  constructor(options) {
    this.queryName = options.queryName || 'default_query';
    this.fetchQuerySet = options.fetchQuerySet; // Function to fetch IDs from backend
    this.syncInterval = options.syncInterval || 30000; // 30 seconds default

    // Configuration for operation management
    this.maxOperationAge = options.maxOperationAge || 15 * 1000; // Default: 15 seconds

    this.groundTruthIds = []; // Array of IDs
    this.operations = new Map(); // id -> QuerySetOperation
    this.version = 0;

    // Sync state
    this.lastSyncTime = 0;
    this.isSyncing = false;
    this.syncTimer = null;

    // Subscription system
    this.subscribers = new Map(); // subscriber ID -> { callback, eventTypes }
    this.nextSubscriberId = 1;

    // Caching configuration (opt-in)
    this._cacheEnabled = options.enableCache === true;
    this._isStale = false;
    this._cacheInitialized = false;
    this._initialLoadPromise = null;

    // Initialize storage and serializer if caching is enabled
    if (this._cacheEnabled) {
      // Cache-specific options
      this._cacheStoreName = options.cacheStoreName || `query_${this.queryName}`;
      this._cacheDbName = options.cacheDbName || 'modelsync_querysets';
      this._cacheSyncDelay = options.cacheSyncDelay || 100;
      this._cacheAutoSync = options.cacheAutoSync !== false;

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

      // Initiate load but don't block constructor
      this._initialLoadPromise = this._loadFromCache()
        .then(loaded => {
          this._cacheInitialized = true;
          if (loaded && this._cacheAutoSync) {
            this._scheduleCachedSync();
          }
          return loaded;
        }).catch(err => {
          console.error('Error during initial cache load:', err);
          this._cacheInitialized = true;
          return false;
        });
    } else {
      this._cacheInitialized = true;
      this._initialLoadPromise = Promise.resolve(false);
    }

    // Start periodic sync after initial cache load
    this._initialLoadPromise.then(() => {
      if (this.syncInterval > 0 && typeof this.fetchQuerySet === 'function') {
        this._startPeriodicSync();
      }
    });
  }

  /**
   * Returns a promise that resolves once the initial cache load attempt is complete.
   */
  async ensureCacheLoaded() {
    if (!this._cacheEnabled) return false;
    return this._initialLoadPromise;
  }

  // Core data access methods
  getGroundTruthIds() {
    return [...this.groundTruthIds];
  }

  /**
   * Get current IDs after applying all operations
   * This is the main method to get the current state of the queryset
   */
  getCurrentIds() {
    return this._getCurrentIds();
  }

  /**
   * Check if data is stale (only relevant if caching is enabled)
   */
  get isStale() {
    return this._cacheEnabled && this._cacheInitialized && this._isStale;
  }

  // Main operation methods
  add(opData) {
    // Create a new operation
    const op = new QuerySetOperation({
      ...opData,
      type: opData.type || 'create' // Default to 'create' for add operations
    });
    
    this.operations.set(op.operationId, op);
    this.version++;
    this._notify('operation_added', { operation: op });
    return op.operationId;
  }

  update(opId, changes) {
    const op = this.operations.get(opId);
    if (!op) return false;

    const oldStatus = op.status;
    Object.assign(op, changes);
    this.version++;

    this._notify('operation_updated', {
      operation: op,
      changes,
      oldStatus
    });

    if (oldStatus !== op.status) {
      this._notify('status_changed', {
        operation: op,
        oldStatus,
        newStatus: op.status
      });
    }
    return true;
  }

  /**
   * Confirm an operation with final IDs data
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
   * Reject an operation
   */
  reject(opId) {
    return this.update(opId, { status: 'rejected' });
  }

  // Set ground truth directly (used internally)
  _setGroundTruthIds(ids) {
    // Ensure data is an array of IDs
    this.groundTruthIds = Array.isArray(ids) ? [...ids] : [];
    this.version++;
    this._notify('ground_truth_updated', { groundTruthIds: this.groundTruthIds });
  }

  /**
   * Get current IDs after applying all operations
   * @private
   */
  _getCurrentIds() {
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
          // but we keep it for consistency and event propagation
          break;
      }
    }
    
    return Array.from(idSet);
  }

  // Subscription system
  subscribe(callback, eventTypes = null) {
    const id = this.nextSubscriberId++;
    this.subscribers.set(id, {
      callback,
      eventTypes
    });

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(id);
    };
  }

  _notify(eventType, data) {
    // Combine event data with version
    const eventData = {
      ...data,
      version: this.version
    };

    // Notify appropriate subscribers
    for (const [, subscriber] of this.subscribers) {
      const { callback, eventTypes } = subscriber;

      // If subscriber listens to all events or specifically to this event type
      if (!eventTypes || eventTypes.includes(eventType)) {
        try {
          callback(eventType, eventData, this);
        } catch (error) {
          console.error('Error in subscriber callback:', error);
        }
      }
    }
  }

  // Sync management

  /**
   * Start periodic sync
   * @private
   */
  _startPeriodicSync() {
    // Ensure not already running
    if (this.syncTimer) {
      this.stopSync();
    }
    console.log(`[QuerySetStore:${this.queryName}] Starting periodic sync every ${this.syncInterval}ms`);
    this.syncTimer = setInterval(() => {
      console.log(`[QuerySetStore:${this.queryName}] Periodic sync triggered`);
      this.sync();
    }, this.syncInterval);
  }

  /**
   * Stop periodic sync
   */
  stopSync() {
    if (this.syncTimer) {
      console.log(`[QuerySetStore:${this.queryName}] Stopping periodic sync`);
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
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
        this._notify('operation_removed', { operationId: id, reason: 'age' });
        changed = true;
      }
    }
  }

  /**
   * Sync with backend
   * @returns {Promise<boolean>} True if sync was successful
   */
  async sync() {
    // Ensure initial load attempt is finished before syncing
    if (this._cacheEnabled) {
      await this.ensureCacheLoaded();
    }

    if (this.isSyncing || !this.fetchQuerySet) {
      console.log(`[QuerySetStore:${this.queryName}] Sync skipped: isSyncing=${this.isSyncing}, no fetchQuerySet=${!this.fetchQuerySet}`);
      return false;
    }

    try {
      this.isSyncing = true;
      this._notify('sync_started', {});
      console.log(`[QuerySetStore:${this.queryName}] Sync started...`);

      // Fetch fresh IDs
      const freshIds = await this.fetchQuerySet();
      console.log(`[QuerySetStore:${this.queryName}] Fetched ${freshIds.length} IDs`);

      // Update ground truth
      this._setGroundTruthIds(freshIds);

      // Trim operations
      this._trimOperations();
      console.log(`[QuerySetStore:${this.queryName}] Operations trimmed.`);

      this.lastSyncTime = Date.now();

      // Update stale flag if using cache
      if (this._cacheEnabled && this._isStale) {
        this._isStale = false;
        this._notify('staleness_changed', { isStale: false });
        console.log(`[QuerySetStore:${this.queryName}] Cache marked as not stale.`);
      }

      // Save to cache
      if (this._cacheEnabled) {
        try {
          console.log(`[QuerySetStore:${this.queryName}] Attempting to save cache...`);
          await this._saveToCache();
          console.log(`[QuerySetStore:${this.queryName}] Cache saved successfully.`);
        } catch (cacheError) {
          console.error(`[QuerySetStore:${this.queryName}] Sync completed but cache save failed:`, cacheError);
        }
      }

      this._notify('sync_completed', {
        success: true,
        time: this.lastSyncTime
      });
      console.log(`[QuerySetStore:${this.queryName}] Sync completed successfully.`);
      return true;

    } catch (error) {
      console.error(`[QuerySetStore:${this.queryName}] Sync failed:`, error);
      this._notify('sync_error', { error });
      return false;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Force an immediate sync
   * @returns {Promise<boolean>} True if sync was successful
   */
  forceSync() {
    return this.sync();
  }

  /**
   * Clean up resources when this QuerySetStore is no longer needed
   */
  async destroy() {
    console.log(`[QuerySetStore:${this.queryName}] Destroying...`);
    this.stopSync();

    // Clean up cache resources if enabled
    if (this._cacheEnabled) {
      if (this._syncDelayTimer) {
        clearTimeout(this._syncDelayTimer);
        this._syncDelayTimer = null;
      }

      if (this._storage) {
        try {
          await this._storage.close();
          this._storage = null;
        } catch(closeError) {
          console.error(`[QuerySetStore:${this.queryName}] Error closing storage during destroy:`, closeError);
          this._storage = null;
        }
      }

      this._serializer = null;
    }

    this.subscribers.clear();
    console.log(`[QuerySetStore:${this.queryName}] Destroyed.`);
  }

  // Cache Management Methods (Internal)

  /**
   * Load state from cache
   * @private
   * @returns {Promise<boolean>} True if data was loaded successfully
   */
  async _loadFromCache() {
    if (!this._cacheEnabled || !this._storage || !this._serializer) {
      console.log(`[QuerySetStore:${this.queryName}] _loadFromCache skipped: Cache not enabled or dependencies missing.`);
      return false;
    }
    console.log(`[QuerySetStore:${this.queryName}] Attempting to load from cache...`);
    try {
      // Load data from storage
      const data = await this._storage.load(this._cacheStoreName);

      if (!data) {
        console.log(`[QuerySetStore:${this.queryName}] No data found in cache.`);
        this._isStale = false;
        return false;
      }
      console.log(`[QuerySetStore:${this.queryName}] Data found in cache, deserializing...`);

      // Deserialize and update state
      try {
        const deserialized = this._serializer.deserialize(data, QuerySetOperation);

        // Update internal state directly
        this.groundTruthIds = deserialized.groundTruthIds;
        this.operations = new Map();
        deserialized.operations.forEach((op, id) => {
          this.operations.set(id, op);
        });
        this.version = deserialized.version;

        this._isStale = true;

        this._notify('cache_loaded', {
          cachedAt: deserialized.cachedAt
        });
        console.log(`[QuerySetStore:${this.queryName}] Cache loaded successfully.`);
        return true;

      } catch (deserializationError) {
        console.error(`[QuerySetStore:${this.queryName}] Error deserializing cached data:`, deserializationError);
        this._isStale = false;
        throw deserializationError;
      }
    } catch (error) {
      console.error(`[QuerySetStore:${this.queryName}] Error during _loadFromCache:`, error);
      this._isStale = false;
      return false;
    }
  }

  /**
   * Save current state to cache
   * @private
   */
  async _saveToCache() {
    if(this._cacheEnabled) await this.ensureCacheLoaded();

    if (!this._cacheEnabled || !this._storage || !this._serializer) {
      return Promise.resolve(false);
    }

    try {
      // Use serializer to prepare data for storage
      const serialized = this._serializer.serialize(this);

      // Add id for storage
      serialized.id = this._cacheStoreName;

      return await this._storage.save(serialized);

    } catch (error) {
      throw error;
    }
  }

  /**
   * Clear cached data
   * @returns {Promise<boolean>} Success status
   */
  async clearCache() {
    if (!this._cacheEnabled || !this._storage) {
      return false;
    }

    try {
      await this._storage.delete(this._cacheStoreName);
      console.log(`[QuerySetStore:${this.queryName}] Cache cleared for key:`, this._cacheStoreName);
      return true;
    } catch (error) {
      console.error(`[QuerySetStore:${this.queryName}] Error clearing cache:`, error);
      return false;
    }
  }

  /**
   * Schedule background sync after cache load
   * @private
   */
  _scheduleCachedSync() {
    if (this._syncDelayTimer) {
      clearTimeout(this._syncDelayTimer);
    }
    console.log(`[QuerySetStore:${this.queryName}] Scheduling background sync in ${this._cacheSyncDelay}ms`);
    this._syncDelayTimer = setTimeout(() => {
      console.log(`[QuerySetStore:${this.queryName}] Triggering scheduled background sync...`);
      this.sync();
      this._syncDelayTimer = null;
    }, this._cacheSyncDelay);
  }
}