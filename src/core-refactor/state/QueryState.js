import { v7 as uuidv7 } from "uuid";
import { IndexedDBStorage } from "../storage/IndexedDBStorage";
import { QueryStateSerializer } from "../serialization/QueryStateSerializer";

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

export class QueryState {
  constructor(options) {
    this.pkField = options.primaryKey;
    this.ItemClass = options.ItemClass;
    this.fetchGroundTruth = options.fetchGroundTruth;
    this.syncInterval = options.syncInterval || 30000; // 30 seconds default

    // Configuration for operation management
    this.maxOperationAge = options.maxOperationAge || 15 * 1000; // Default: 15 seconds

    this.groundTruth = [];
    this.operations = new Map(); // id -> Operation
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
    this._cacheInitialized = false; // Track if initial load attempt finished
    this._initialLoadPromise = null; // Store the promise for the initial load

    // Initialize storage and serializer if caching is enabled
    if (this._cacheEnabled) {
      // Cache-specific options
      this._cacheStoreName = options.cacheStoreName || 'query_state';
      this._cacheDbName = options.cacheDbName || 'modelsync_cache';
      this._cacheSyncDelay = options.cacheSyncDelay || 100; // ms to wait before auto-sync
      this._cacheAutoSync = options.cacheAutoSync !== false; // default to true

      // Create storage instance
      this._storage = new IndexedDBStorage({
        dbName: this._cacheDbName,
        storeName: this._cacheStoreName,
        version: options.cacheDbVersion || 1
      });

      // Create serializer
      this._serializer = new QueryStateSerializer({
        ItemClass: this.ItemClass,
        primaryKey: this.pkField
      });

      // *** Initiate load but don't block constructor ***
      this._initialLoadPromise = this._loadFromCache()
        .then(loaded => {
          this._cacheInitialized = true; // Mark as initialized
          if (loaded && this._cacheAutoSync) {
            this._scheduleCachedSync();
          }
          return loaded; // Pass loaded status along
        }).catch(err => {
          console.error('Error during initial cache load:', err);
          this._cacheInitialized = true; // Mark as initialized even on error
          return false; // Indicate loading failed
        });
    } else {
        // If cache not enabled, it's immediately "initialized"
        this._cacheInitialized = true;
        this._initialLoadPromise = Promise.resolve(false); // No cache loaded
    }

    // Start periodic sync only after initial cache load attempt finishes
    this._initialLoadPromise.then(() => {
        if (this.syncInterval > 0 && typeof this.fetchGroundTruth === 'function') {
            this._startPeriodicSync();
        }
    });
  }

  /**
   * Returns a promise that resolves once the initial cache load attempt is complete.
   * Useful for ensuring cache state is settled before proceeding.
   * @returns {Promise<boolean>} Resolves with true if cache was loaded, false otherwise.
   */
  async ensureCacheLoaded() {
      if (!this._cacheEnabled) return false;
      return this._initialLoadPromise;
  }


  // Core data access methods
  getGroundTruth() {
    // Consider if waiting for initial load is needed here, depends on requirements.
    // If called immediately, might return empty before cache loads.
    // For now, it returns the current state.
    return [...this.groundTruth];
  }

  /**
   * Check if data is stale (only relevant if caching is enabled)
   */
  get isStale() {
    // Only consider stale if the cache has actually been checked
    return this._cacheEnabled && this._cacheInitialized && this._isStale;
  }

  // Main operation methods
  add(opData) {
    const op = new Operation(opData);
    this.operations.set(op.operationId, op);
    this.version++;
    this._notify('operation_added', { operation: op });
    // Consider triggering a debounced save to cache here if needed
    // this._debouncedSaveToCache();
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
     // Consider triggering a debounced save to cache here if needed
    // this._debouncedSaveToCache();
    return true;
  }

  /**
   * Confirm an operation with final instances data
   * @param {string} opId - Operation ID to confirm
   * @param {Array} [instances] - Final list of instances (optional)
   * @returns {boolean} True if the operation was found and updated
   */
  confirm(opId, instances) {
    const op = this.operations.get(opId);
    if (!op) return false;

    const changes = { status: 'confirmed' };

    // If instances are provided, update them
    if (instances !== undefined) {
      changes.instances = Array.isArray(instances) ? instances : [instances];
    }

    return this.update(opId, changes);
  }

  /**
   * Reject an operation
   * @param {string} opId - Operation ID to reject
   * @returns {boolean} True if the operation was found and updated
   */
  reject(opId) {
    return this.update(opId, { status: 'rejected' });
  }

  // Set ground truth directly (used internally)
  _setGroundTruth(data) {
    // Ensure data is an array
    const dataArray = Array.isArray(data) ? data : [];
    this.groundTruth = dataArray.map(item =>
      this.ItemClass ? new this.ItemClass(item) : { ...item }
    );
    this.version++;
    this._notify('ground_truth_updated', { groundTruth: this.groundTruth });
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
     console.log(`Starting periodic sync every ${this.syncInterval}ms`);
    this.syncTimer = setInterval(() => {
      console.log("Periodic sync triggered");
      this.sync();
    }, this.syncInterval);
  }

  /**
   * Stop periodic sync
   */
  stopSync() {
    if (this.syncTimer) {
        console.log("Stopping periodic sync");
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
    // Increment version if operations were trimmed, as state changed
    // if (changed) {
    //   this.version++;
    // }
    // Decided against version bump here, trim is more like GC.
    // Let cache save handle persisting the trimmed state.
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

    if (this.isSyncing || !this.fetchGroundTruth) {
        console.log(`Sync skipped: isSyncing=${this.isSyncing}, no fetchGroundTruth=${!this.fetchGroundTruth}`);
        return false;
    }

    let success = false; // Track success status
    try {
      this.isSyncing = true;
      this._notify('sync_started', {});
      console.log("Sync started...");

      // Fetch fresh data
      const freshData = await this.fetchGroundTruth();
      console.log("Fetched ground truth:", freshData);

      // Update ground truth
      this._setGroundTruth(freshData);

      // Trim operations instead of deleting all non-inflight ones
      this._trimOperations();
      console.log("Operations trimmed.");


      this.lastSyncTime = Date.now();

      // Update stale flag if using cache
      if (this._cacheEnabled && this._isStale) {
        this._isStale = false;
        this._notify('staleness_changed', { isStale: false });
        console.log("Cache marked as not stale.");
      }

      // --- Save to cache AFTER state updates ---
      if (this._cacheEnabled) {
        try {
          console.log("Attempting to save cache...");
          // IMPORTANT: Wait for the save to complete before resolving the sync promise
          await this._saveToCache(); // Correctly awaits the promise now
          console.log("Cache saved successfully.");
        } catch (cacheError) {
          // Log the error but don't fail the entire sync operation
          // _saveToCache already logs internally
          console.error('Sync completed but cache save failed:', cacheError);
        }
      }

      success = true; // Mark sync as successful overall
      this._notify('sync_completed', {
        success: true,
        time: this.lastSyncTime
      });
      console.log("Sync completed successfully.");
      return true; // Return true for overall success

    } catch (error) {
      console.error("Sync failed:", error) // Log the primary error (e.g., from fetch)
      this._notify('sync_error', { error });
      return false; // Return false as sync failed
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
   * Clean up resources when this QueryState is no longer needed
   */
   async destroy() {
    console.log("Destroying QueryState...");
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
            // Log error but continue cleanup
            console.error("Error closing storage during destroy:", closeError);
            this._storage = null; // Ensure it's nulled even on error
        }
      }

      this._serializer = null;
    }

    this.subscribers.clear();
    console.log("QueryState destroyed.");
  }

  // ========== Cache Management Methods (Internal) ==========

  /**
   * Load state from cache
   * @private
   * @returns {Promise<boolean>} True if data was loaded successfully
   */
  async _loadFromCache() {
    if (!this._cacheEnabled || !this._storage || !this._serializer) {
        console.log("_loadFromCache skipped: Cache not enabled or dependencies missing.");
        return false;
    }
    console.log("Attempting to load from cache...");
    try {
      // Load data from storage
      const data = await this._storage.load(this._cacheStoreName);

      if (!data) {
        // No cached data found
        console.log("No data found in cache.");
        this._isStale = false; // Not stale if nothing was loaded
        return false;
      }
       console.log("Data found in cache, deserializing...");

      // Deserialize and update state
      try {
        const deserialized = this._serializer.deserialize(data, Operation);

        // --- Update internal state directly ---
        // Avoid calling _setGroundTruth here to prevent unnecessary version bumps/notifications during load
        this.groundTruth = deserialized.groundTruth.map(item =>
           this.ItemClass ? new this.ItemClass(item) : { ...item }
        );
        this.operations = new Map(); // Start fresh
        deserialized.operations.forEach((op, id) => {
          this.operations.set(id, op);
        });
        this.version = deserialized.version;
        // --- End direct state update ---

        this._isStale = true; // Mark as stale since it came from cache

        this._notify('cache_loaded', {
          cachedAt: deserialized.cachedAt
        });
        console.log("Cache loaded successfully.");
        return true; // Indicate success

      } catch (deserializationError) {
        console.error('Error deserializing cached data:', deserializationError);
        this._isStale = false; // Treat as non-stale if deserialization fails
        // Consider clearing the corrupted cache entry?
        // await this.clearCache().catch(e => console.error("Failed to clear corrupted cache:", e));
        throw deserializationError; // Re-throw to be caught by the outer catch
      }
    } catch (error) {
      // Errors from storage.load or re-thrown deserialization errors
      console.error('Error during _loadFromCache:', error);
      this._isStale = false; // Not stale if loading failed
      return false; // Indicate loading failed
    }
  }

  /**
   * Save current state to cache
   * @private
   * @returns {Promise<any>} Returns the result from storage.save (e.g., true or key) or throws error
   */
  async _saveToCache() {
    // Ensure init load finished before trying to save, prevents weird states
     if(this._cacheEnabled) await this.ensureCacheLoaded();

    if (!this._cacheEnabled || !this._storage || !this._serializer) {
      // This case should ideally not happen if called from sync after checks,
      // but return a resolved promise indicating no action taken/failure.
      return Promise.resolve(false);
    }

    try {
      // Use serializer to prepare data for storage
      const serialized = this._serializer.serialize(this);

      // Add id for storage
      serialized.id = this._cacheStoreName;

      // --- Return the promise from storage.save ---
      // The storage layer is returns a promise that
      // resolves on success (e.g., with true or the key) and rejects on error.
      return await this._storage.save(serialized);

    } catch (error) {
      // Error should have been logged by storage layer, just re-throw
      // so the caller (like sync method) can be aware.
      // console.error('Error saving to cache:', error); // Redundant if storage logs
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
      // Use the specific key used for storing the state object
      await this._storage.delete(this._cacheStoreName);
      console.log("Cache cleared for key:", this._cacheStoreName);
      return true;
    } catch (error) {
      console.error('Error clearing cache:', error);
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
    console.log(`Scheduling background sync in ${this._cacheSyncDelay}ms`);
    this._syncDelayTimer = setTimeout(() => {
        console.log("Triggering scheduled background sync...");
      this.sync(); // Intentionally not awaited here
      this._syncDelayTimer = null;
    }, this._cacheSyncDelay);
  }
}