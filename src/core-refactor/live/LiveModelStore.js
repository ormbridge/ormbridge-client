import { ModelStore, Operation } from '../state/ModelStore.js';
import { RenderEngine } from '../rendering/RenderEngine.js';

/**
 * LiveModelStore combines a ModelStore and its associated RenderEngine
 * into a single interface focused on managing and rendering data items.
 *
 * It provides the standard ModelStore API for managing ground truth and
 * operations, but adds a `render` method to access the live,
 * optimistically updated view of the data.
 *
 * It handles the lifecycle of both components internally, including ensuring
 * the RenderEngine listens for changes to invalidate its cache.
 */
export class LiveModelStore {
    /**
     * @param {object} modelStoreOptions Options passed directly to the ModelStore constructor. REQUIRED.
     *        Must include `primaryKey`, `fetchGroundTruth`, etc.
     */
    constructor(modelStoreOptions) {
        if (!modelStoreOptions || typeof modelStoreOptions !== 'object') {
            throw new Error("LiveModelStore requires 'modelStoreOptions'.");
        }

        // 1. Create and own the ModelStore instance
        this._modelStore = new ModelStore(modelStoreOptions);

        // 2. Create and own the RenderEngine instance, linked to the ModelStore
        this._renderEngine = new RenderEngine(this._modelStore);

        // 3. Activate the RenderEngine's internal subscription to the ModelStore
        // This ensures the RenderEngine's cache invalidates automatically.
        this._renderEngineUnsubscriber = this._renderEngine.subscribeToChanges();

        // 4. Setup for LiveModelStore's *external* subscribers
        this._subscribers = new Map();
        this._nextSubscriberId = 1;
        this._internalUnsubscriber = null; // For forwarding ModelStore events externally

        this._subscribeToStore(); // Setup external notifications
    }

    // --- Internal Setup for External Notifications ---

    /**
     * Subscribes to events from the underlying ModelStore to forward
     * them to *external* subscribers of this LiveModelStore instance.
     * @private
     */
    _subscribeToStore() {
        // Unsubscribe previous listener if re-subscribing (e.g., due to subscribe/unsubscribe calls)
        if (this._internalUnsubscriber) {
            this._internalUnsubscriber();
        }

        // Determine which events external subscribers care about
        const allSubscribedEventTypes = this._getUniqueSubscribedEventTypes();

        // Subscribe to the underlying store to forward events
        this._internalUnsubscriber = this._modelStore.subscribe(
            (eventType, data) => {
                // Forward the event to external subscribers of LiveModelStore
                this._notify(eventType, data);
            },
            allSubscribedEventTypes // Optimize by only listening to needed events
        );
    }

    // --- Public API (Mirrors ModelStore where applicable + Render) ---

    // --- Getters for Core Properties ---

    /**
     * Gets the primary key field name used by the store.
     * @type {string}
     */
    get pkField() {
        return this._modelStore.pkField;
    }

    /**
     * Gets the ItemClass constructor used for instances.
     * @type {Function | undefined}
     */
    get ItemClass() {
        return this._modelStore.ItemClass;
    }

    /**
     * Gets the map of pending/processed operations.
     * Key: operationId, Value: Operation instance.
     * Use this for introspection; modify operations via add/confirm/reject.
     * @type {Map<string, Operation>}
     */
    get operations() {
        // Return the actual map from the underlying store
        return this._modelStore.operations;
    }

    /**
     * Gets the current version number of the underlying ModelStore.
     * Changes whenever ground truth or operations change.
     * @type {number}
     */
    get version() {
         return this._modelStore.version;
    }

    /**
     * Checks if the underlying ModelStore considers its data stale
     * (loaded from cache and not yet synced).
     * @type {boolean}
     */
     get isStale() {
        return this._modelStore.isStale;
     }

     /**
      * Indicates if the store is currently performing a sync operation.
      * @type {boolean}
      */
     get isSyncing() {
         return this._modelStore.isSyncing;
     }

    // --- Initialization & State ---

    /**
     * Returns a promise that resolves when the underlying ModelStore has
     * attempted its initial cache load (if cache is enabled).
     * @returns {Promise<boolean>} Resolves with true if cache was loaded, false otherwise.
     */
    async ensureInitialized() {
        return this._modelStore.ensureCacheLoaded();
    }

    // --- Data Access ---

    /**
     * Gets the ground truth data items directly from the ModelStore.
     * This does *not* include optimistic updates.
     * @returns {Array<object>} Array of ground truth model instances.
     */
    getGroundTruth() {
        return this._modelStore.getGroundTruth();
    }

    /**
     * Renders the **live, optimistic** view of the data items using the RenderEngine.
     * Applies pending operations (respecting status), sorting, and pagination.
     * This is the primary method for getting the current displayable state.
     * @param {object} params Parameters for rendering.
     * @param {number} [params.offset=0] Starting index (0-based).
     * @param {number | null | undefined} [params.limit=undefined] Maximum number of items to return (all from offset if undefined/null).
     * @param {Function} [params.sortFn] Optional custom sort function `(a, b) => number`.
     * @returns {Array<object>} The rendered optimistic data subset.
     */
    render(params = {}) {
        return this._renderEngine.render(params);
    }

    // --- Actions (Mirrors ModelStore API) ---

    /**
     * Adds an operation (create, update, delete) to the ModelStore.
     * This will immediately affect subsequent calls to `render`.
     * @param {object} opData Data for the new Operation. Requires `type` and `instances`.
     * @returns {string} The ID of the added operation.
     */
    add(opData) {
        return this._modelStore.add(opData);
    }

    /**
     * Updates the status or other properties of an existing operation.
     * Typically used internally but exposed for flexibility. Use `confirm` or `reject` for status changes.
     * @param {string} opId The ID of the operation to update.
     * @param {object} changes An object containing fields to update on the operation.
     * @returns {boolean} True if the operation was found and updated.
     */
    update(opId, changes) {
        // Directly delegates to the underlying store.
        return this._modelStore.update(opId, changes);
    }


    /**
     * Confirms a ModelStore operation, typically after backend confirmation.
     * Updates the operation's status to 'confirmed' and optionally its final instance data.
     * @param {string} opId The ID of the operation to confirm.
     * @param {Array<object>} [instances] Optional final instance data from the backend response.
     * @returns {boolean} True if the operation was found and updated.
     */
    confirm(opId, instances) {
        return this._modelStore.confirm(opId, instances);
    }

    /**
     * Rejects a ModelStore operation, typically after backend failure.
     * Updates the operation's status to 'rejected'. Rejected operations
     * are typically ignored by the RenderEngine during `render`.
     * @param {string} opId The ID of the operation to reject.
     * @returns {boolean} True if the operation was found and updated.
     */
    reject(opId) {
        return this._modelStore.reject(opId);
    }

    /**
     * Forces an immediate synchronization cycle for the underlying ModelStore.
     * This fetches fresh ground truth from the backend and trims old operations.
     * @returns {Promise<boolean>} True if the sync attempt was successful (doesn't guarantee data changed).
     */
    async forceSync() {
        return this._modelStore.sync();
    }

     /**
     * Stops the periodic synchronization timer configured in the options.
     */
    stopSync() {
        this._modelStore.stopSync();
    }

    /**
     * Clears the cache for the underlying ModelStore (if cache is enabled).
     * @returns {Promise<boolean>} Success status.
     */
    async clearCache() {
        return this._modelStore.clearCache();
    }


    // --- Event Subscription (for External Listeners) ---

    /**
     * Subscribe to events emitted by the underlying ModelStore, forwarded by this LiveModelStore.
     * Events include changes to ground truth, operations, sync status, cache status, etc.
     * @param {Function} callback Function to call on event: `(eventType, data)`
     *        - eventType: {string} The type of event (e.g., 'sync_started', 'operation_added', 'cache_loaded', 'staleness_changed').
     *        - data: {object} Event-specific data payload, usually includes 'version'.
     * @param {Array<string> | null} [eventTypes=null] Optional array of specific event types to listen for. If null or omitted, listens to all events.
     * @returns {Function} An unsubscribe function.
     */
    subscribe(callback, eventTypes = null) {
        const id = this._nextSubscriberId++;
        this._subscribers.set(id, { callback, eventTypes });

        // Re-subscribe internal listener to potentially optimize listened events
        this._subscribeToStore();

        return () => {
            if (this._subscribers.delete(id)) {
                 // Re-subscribe internal listener after unsubscribing one external listener
                 // to potentially stop listening to unused events in the underlying store.
                 this._subscribeToStore();
            }
        };
    }

     /**
     * Gets unique event types requested by all *external* subscribers.
     * Used to optimize the internal subscription to ModelStore.
     * @private
     * @returns {Array<string> | null} Array of unique types, or null if no subscriber specified types or if any subscriber wants all events.
     */
    _getUniqueSubscribedEventTypes() {
        const typeSet = new Set();
        let anySubscriberNeedsAll = false;
        // Iterate over external subscribers of LiveModelStore
        for (const [, sub] of this._subscribers) {
            if (!sub.eventTypes) {
                anySubscriberNeedsAll = true;
                break; // If one needs all, we subscribe to all in the underlying store
            }
            sub.eventTypes.forEach(type => typeSet.add(type));
        }
        // Return null to listen to all if any subscriber needs all, or if no types specified at all.
        // Otherwise, return the specific list.
        return anySubscriberNeedsAll ? null : (typeSet.size > 0 ? Array.from(typeSet) : null);
    }

    /**
     * Notify external subscribers about an event originating from the ModelStore.
     * @private
     */
    _notify(eventType, data) {
        // Iterate over external subscribers of LiveModelStore
        for (const [, subscriber] of this._subscribers) {
             // Check if this subscriber wants this specific event type
             if (!subscriber.eventTypes || subscriber.eventTypes.includes(eventType)) {
                 try {
                    // Call the external subscriber's callback
                    subscriber.callback(eventType, data);
                 } catch (error) {
                    console.error(`LiveModelStore: Error in external subscriber callback for event ${eventType}:`, error);
                 }
             }
        }
    }

    // --- Cleanup ---

    /**
     * Cleans up resources for both the ModelStore and RenderEngine.
     * Stops sync timers, closes storage connections, clears caches, and unsubscribes all listeners.
     * Call this when the LiveModelStore instance is no longer needed to prevent memory leaks.
     * @returns {Promise<void>}
     */
    async destroy() {
        console.log("LiveModelStore: Destroying...");

        // 1. Unsubscribe the listener used for forwarding events to external subscribers
        if (this._internalUnsubscriber) {
            this._internalUnsubscriber();
            this._internalUnsubscriber = null;
        }

        // 2. Unsubscribe the RenderEngine's internal listener from the ModelStore
        if (this._renderEngineUnsubscriber) {
            this._renderEngineUnsubscriber();
            this._renderEngineUnsubscriber = null;
        }

        // 3. Clear external subscribers map
        this._subscribers.clear();

        // 4. Destroy the RenderEngine (clears its cache)
        if (this._renderEngine) {
            this._renderEngine.destroy();
            this._renderEngine = null;
        }

        // 5. Destroy the ModelStore (stops timers, closes storage, etc.)
        // This should be last as the render engine might depend on it briefly during shutdown? (Unlikely but safer)
        if (this._modelStore) {
            await this._modelStore.destroy();
            this._modelStore = null;
        }

        console.log("LiveModelStore: Destroyed successfully.");
    }
}