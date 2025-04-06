// modelsync-client/src/core-refactor/LiveQuerySet.js

import { QuerySetStore, QuerySetOperation } from '../state/QuerySetStore.js';
import { QuerySetRenderEngine } from '../rendering/QuerySetRenderEngine.js';

/**
 * LiveQuerySet combines a QuerySetStore and its associated QuerySetRenderEngine
 * into a single interface focused on managing and rendering a live view of queryset IDs.
 *
 * It provides the standard QuerySetStore API for managing ground truth IDs and
 * operations, but adds `render`, `getCount`, and `getCurrentIds` methods to access
 * the live, optimistically updated view of the IDs.
 *
 * It handles the lifecycle of both components internally.
 */
export class LiveQuerySet {
    /**
     * @param {object} querySetStoreOptions Options passed directly to the QuerySetStore constructor. REQUIRED.
     *        Must include `queryName`, `fetchQuerySet`, etc.
     */
    constructor(querySetStoreOptions) {
        if (!querySetStoreOptions || typeof querySetStoreOptions !== 'object') {
            throw new Error("LiveQuerySet requires 'querySetStoreOptions'.");
        }

        // 1. Create and own the QuerySetStore instance
        this._querySetStore = new QuerySetStore(querySetStoreOptions);

        // 2. Create and own the QuerySetRenderEngine instance, linked to the store
        this._querySetRenderEngine = new QuerySetRenderEngine(this._querySetStore);

        // 3. Activate the RenderEngine's internal subscription to the QuerySetStore
        // This ensures the RenderEngine's cache invalidates automatically.
        this._renderEngineUnsubscriber = this._querySetRenderEngine.subscribeToChanges();

        // 4. Setup for LiveQuerySet's *external* subscribers
        this._subscribers = new Map();
        this._nextSubscriberId = 1;
        this._internalUnsubscriber = null; // For forwarding QuerySetStore events externally

        this._subscribeToStore(); // Setup external notifications
    }

    // --- Internal Setup for External Notifications ---

    /**
     * Subscribes to events from the underlying QuerySetStore to forward
     * them to *external* subscribers of this LiveQuerySet instance.
     * @private
     */
    _subscribeToStore() {
        // Unsubscribe previous listener if re-subscribing
        if (this._internalUnsubscriber) {
            this._internalUnsubscriber();
        }

        // Determine which events external subscribers care about
        const allSubscribedEventTypes = this._getUniqueSubscribedEventTypes();

        // Subscribe to the underlying store to forward events
        this._internalUnsubscriber = this._querySetStore.subscribe(
            (eventType, data) => {
                // Forward the event to external subscribers of LiveQuerySet
                // Pass the store itself as the third argument if needed by external callbacks
                this._notify(eventType, data, this._querySetStore);
            },
            allSubscribedEventTypes // Optimize by only listening to needed events
        );
    }

    // --- Public API (Mirrors QuerySetStore where applicable + Render/Count) ---

    // --- Getters for Core Properties ---

    /**
     * Gets the query name associated with this store.
     * @type {string}
     */
    get queryName() {
        // Handle potential null _querySetStore during destruction edge cases
        return this._querySetStore ? this._querySetStore.queryName : undefined;
    }

    /**
     * Gets the map of pending/processed operations affecting the queryset.
     * Key: operationId, Value: QuerySetOperation instance.
     * Use this for introspection; modify operations via add/confirm/reject.
     * @type {Map<string, QuerySetOperation>}
     */
    get operations() {
        // Return the actual map from the underlying store if it exists
        return this._querySetStore ? this._querySetStore.operations : new Map();
    }

    /**
     * Gets the current version number of the underlying QuerySetStore.
     * Changes whenever ground truth IDs or operations change.
     * @type {number}
     */
    get version() {
         // Return 0 or -1 if store doesn't exist? Let's return underlying or 0.
         return this._querySetStore ? this._querySetStore.version : 0;
    }

    /**
     * Checks if the underlying QuerySetStore considers its data stale
     * (loaded from cache and not yet synced).
     * @type {boolean}
     */
     get isStale() {
        return this._querySetStore ? this._querySetStore.isStale : false;
     }

     /**
      * Indicates if the store is currently performing a sync operation.
      * @type {boolean}
      */
     get isSyncing() {
         return this._querySetStore ? this._querySetStore.isSyncing : false;
     }

    // --- Initialization & State ---

    /**
     * Returns a promise that resolves when the underlying QuerySetStore has
     * attempted its initial cache load (if cache is enabled).
     * @returns {Promise<boolean>} Resolves with true if cache was loaded, false otherwise.
     */
    async ensureInitialized() {
        // Delegate or return false if store doesn't exist
        return this._querySetStore ? this._querySetStore.ensureCacheLoaded() : Promise.resolve(false);
    }

    // --- Data Access ---

    /**
     * Gets the ground truth IDs directly from the QuerySetStore.
     * This does *not* include optimistic updates.
     * @returns {Array<any>} Array of ground truth IDs, or an empty array if the store is not available.
     */
    getGroundTruthIds() {
        return this._querySetStore ? this._querySetStore.getGroundTruthIds() : [];
    }

    /**
     * Renders the **live, optimistic** view of the queryset IDs using the RenderEngine.
     * Applies pending operations (respecting status), sorting, and pagination.
     * This is the primary method for getting the current displayable list of IDs.
     * @param {object} params Parameters for rendering.
     * @param {number} [params.offset=0] Starting index (0-based).
     * @param {number | null | undefined} [params.limit=undefined] Maximum number of IDs to return (all from offset if undefined/null).
     * @param {Function} [params.sortFn] Optional custom sort function `(a, b) => number` for the IDs.
     * @returns {Array<any>} The rendered optimistic ID subset, or an empty array if the engine is not available.
     */
    render(params = {}) {
        return this._querySetRenderEngine ? this._querySetRenderEngine.render(params) : [];
    }

    /**
     * Gets the **live, optimistic** count of IDs in the queryset after applying operations.
     * @returns {number} The current count of items in the queryset, or 0 if the engine is not available.
     */
    getCount() {
        return this._querySetRenderEngine ? this._querySetRenderEngine.getCount() : 0;
    }

    /**
     * Gets the full list of **live, optimistic** IDs after applying operations,
     * without pagination or sorting applied by the render engine.
     * Useful for testing or direct access to the complete calculated set.
     * Note: Order is not guaranteed unless the underlying operations consistently
     * result in a specific order (e.g., if based on Set iteration).
     * Returns an empty array if the engine is not available.
     * @returns {Array<any>} The full list of current optimistic IDs.
     */
    getCurrentIds() {
        // Check if the render engine exists (it might be null during/after destroy)
        if (!this._querySetRenderEngine || !this._querySetStore) {
            return [];
        }

        // Reuse the cache checking and processing logic, similar to getCount/render
        let processedIds;
        const cache = this._querySetRenderEngine._cache; // Access internal cache

        // Check if cache is valid based on QuerySetStore version
        if (cache && cache.processedIds !== null && // Added null check for cache itself
            cache.queryStateVersion === this._querySetStore.version) {
          // Cache HIT: Use the cached processed IDs
          processedIds = cache.processedIds;
        } else {
          // Cache MISS or INVALID: Recalculate the processed IDs
          // Delegate to the internal method which gets the raw optimistic IDs
          processedIds = this._querySetRenderEngine._processOperations();
          // Update the cache only if it exists
          if (cache) {
              cache.processedIds = processedIds;
              cache.queryStateVersion = this._querySetStore.version;
          }
        }

        // Return a *copy* to prevent external mutation of the cached array
        // Ensure processedIds is an array before spreading
        return Array.isArray(processedIds) ? [...processedIds] : [];
    }


    // --- Actions (Mirrors QuerySetStore API) ---

    /**
     * Adds an operation (typically 'create' or 'delete') affecting the set of IDs.
     * This will immediately affect subsequent calls to `render` and `getCount`.
     * @param {object} opData Data for the new QuerySetOperation. Requires `type` and `ids`.
     * @returns {string | null} The ID of the added operation, or null if the store is not available.
     */
    add(opData) {
        return this._querySetStore ? this._querySetStore.add(opData) : null;
    }

    /**
     * Updates the status or other properties of an existing operation.
     * @param {string} opId The ID of the operation to update.
     * @param {object} changes An object containing fields to update on the operation.
     * @returns {boolean} True if the operation was found and updated, false otherwise.
     */
    update(opId, changes) {
        return this._querySetStore ? this._querySetStore.update(opId, changes) : false;
    }

    /**
     * Confirms a QuerySetStore operation, typically after backend confirmation.
     * Updates the operation's status to 'confirmed' and optionally its final IDs list.
     * @param {string} opId The ID of the operation to confirm.
     * @param {Array<any>} [ids] Optional final list of IDs related to the operation (context-dependent).
     * @returns {boolean} True if the operation was found and updated, false otherwise.
     */
    confirm(opId, ids) {
        return this._querySetStore ? this._querySetStore.confirm(opId, ids) : false;
    }

    /**
     * Rejects a QuerySetStore operation, typically after backend failure.
     * Updates the operation's status to 'rejected'. Rejected operations
     * are ignored by the RenderEngine during `render`.
     * @param {string} opId The ID of the operation to reject.
     * @returns {boolean} True if the operation was found and updated, false otherwise.
     */
    reject(opId) {
        return this._querySetStore ? this._querySetStore.reject(opId) : false;
    }

    /**
     * Forces an immediate synchronization cycle for the underlying QuerySetStore.
     * This fetches the fresh list of ground truth IDs from the backend and trims old operations.
     * @returns {Promise<boolean>} True if the sync attempt was successful, false otherwise.
     */
    async forceSync() {
        return this._querySetStore ? this._querySetStore.sync() : Promise.resolve(false);
    }

     /**
     * Stops the periodic synchronization timer configured in the options.
     */
    stopSync() {
        if (this._querySetStore) {
             this._querySetStore.stopSync();
        }
    }

    /**
     * Clears the cache for the underlying QuerySetStore (if cache is enabled).
     * @returns {Promise<boolean>} Success status (true if cleared, false otherwise).
     */
    async clearCache() {
        return this._querySetStore ? this._querySetStore.clearCache() : Promise.resolve(false);
    }


    // --- Event Subscription (for External Listeners) ---

    /**
     * Subscribe to events emitted by the underlying QuerySetStore, forwarded by this LiveQuerySet.
     * Events include changes to ground truth IDs, operations, sync status, cache status, etc.
     * @param {Function} callback Function to call on event: `(eventType, data, sourceStore)`
     *        - eventType: {string} The type of event (e.g., 'sync_started', 'operation_added').
     *        - data: {object} Event-specific data payload, usually includes 'version'.
     *        - sourceStore: {QuerySetStore} The underlying QuerySetStore instance that emitted the event.
     * @param {Array<string> | null} [eventTypes=null] Optional array of specific event types to listen for. If null or omitted, listens to all events.
     * @returns {Function} An unsubscribe function, or a no-op function if the store isn't available.
     */
    subscribe(callback, eventTypes = null) {
        // Prevent subscription if core store is gone (e.g., post-destroy)
        if (!this._querySetStore) {
            console.warn(`LiveQuerySet [${this.queryName || 'Destroyed'}]: Cannot subscribe after destroy.`);
            return () => {}; // Return no-op unsubscribe
        }

        const id = this._nextSubscriberId++;
        this._subscribers.set(id, { callback, eventTypes });

        // Re-subscribe internal listener to potentially optimize listened events
        this._subscribeToStore();

        return () => {
            if (this._subscribers.delete(id)) {
                 // Re-subscribe internal listener after unsubscribing one external listener
                 // only if the store still exists
                 if (this._querySetStore) {
                     this._subscribeToStore();
                 }
            }
        };
    }

     /**
     * Gets unique event types requested by all *external* subscribers.
     * @private
     */
    _getUniqueSubscribedEventTypes() {
        const typeSet = new Set();
        let anySubscriberNeedsAll = false;
        for (const [, sub] of this._subscribers) {
            if (!sub.eventTypes) {
                anySubscriberNeedsAll = true;
                break;
            }
            sub.eventTypes.forEach(type => typeSet.add(type));
        }
        return anySubscriberNeedsAll ? null : (typeSet.size > 0 ? Array.from(typeSet) : null);
    }

    /**
     * Notify external subscribers about an event originating from the QuerySetStore.
     * @private
     */
    _notify(eventType, data, sourceStore) { // Added sourceStore
        const queryName = this.queryName || 'Unknown'; // Get name safely
        for (const [, subscriber] of this._subscribers) {
             if (!subscriber.eventTypes || subscriber.eventTypes.includes(eventType)) {
                 try {
                    // Pass sourceStore as third argument if callback expects it
                    subscriber.callback(eventType, data, sourceStore);
                 } catch (error) {
                    console.error(`LiveQuerySet [${queryName}]: Error in external subscriber callback for event ${eventType}:`, error);
                 }
             }
        }
    }

    // --- Cleanup ---

    /**
     * Cleans up resources for both the QuerySetStore and QuerySetRenderEngine.
     * Stops sync timers, closes storage connections, clears caches, and unsubscribes all listeners.
     * Call this when the LiveQuerySet instance is no longer needed.
     * @returns {Promise<void>}
     */
    async destroy() {
        // Capture name before nulling, handle case where store might already be null
        const queryNameToLog = this.queryName || 'Unknown/Destroyed';
        console.log(`LiveQuerySet [${queryNameToLog}]: Destroying...`);

        // Order: Unsubscribe external -> Unsubscribe internal engine -> Clear subs -> Destroy engine -> Destroy store

        // 1. Unsubscribe the listener used for forwarding events
        if (this._internalUnsubscriber) {
            this._internalUnsubscriber();
            this._internalUnsubscriber = null;
        }

        // 2. Unsubscribe the RenderEngine's internal listener
        if (this._renderEngineUnsubscriber) {
            this._renderEngineUnsubscriber();
            this._renderEngineUnsubscriber = null;
        }

        // 3. Clear external subscribers map
        this._subscribers.clear();

        // 4. Destroy the RenderEngine (clears its cache)
        // Check if it exists before calling destroy
        if (this._querySetRenderEngine) {
            this._querySetRenderEngine.destroy();
            this._querySetRenderEngine = null;
        }

        // 5. Destroy the QuerySetStore
        // Check if it exists before calling destroy
        if (this._querySetStore) {
            await this._querySetStore.destroy();
            this._querySetStore = null;
        }

        console.log(`LiveQuerySet [${queryNameToLog}]: Destroyed successfully.`);
    }
}