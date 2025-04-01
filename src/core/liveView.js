import { QuerySet } from "../flavours/django/querySet.js";
import { Model } from "../flavours/django/model.js";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import {
    EventType,
    getEventReceiver,
    setEventReceiver,
    setNamespaceResolver,
} from "./eventReceivers.js";
import { initializeEventReceiver } from "../config.js";
import {
    MultipleObjectsReturned,
    DoesNotExist,
} from "../flavours/django/errors.js";
import MetricsManager from "./MetricsManager";
import { SyncedArray } from "./syncedArray.js";

// --------------------
// JSDoc Type Definitions
// --------------------
/**
 * @typedef {Object} SerializerOptions
 * @property {number} [depth] - How deep to serialize nested objects.
 * @property {string[]} [fields] - List of fields to include.
 * @property {number} [limit] - Maximum number of items to retrieve.
 * @property {number} [offset] - Offset for pagination.
 */
/**
 * @typedef {Object} LiveQuerySetOptions
 * @property {function(): string} [operationIdGenerator] - Custom operation ID generator function.
 * @property {string} [customNamespace] - Custom namespace to append to the model name.
 * @property {SerializerOptions} [serializer] - Serializer options.
 * @property {Object} [insertBehavior] - Configuration for insertion behavior
 * @property {number|'prepend'|'append'|function(Object, Array): number} [insertBehavior.local=0] - Where to insert locally created items ('prepend' maps to 0, 'append' maps to undefined)
 * @property {number|'prepend'|'append'|function(Object, Array): number} [insertBehavior.remote='append'] - Where to insert remotely created items ('prepend' maps to 0, 'append' maps to undefined)
 */
/**
 * @typedef {Object} MetricResult
 * @property {number|any} value - The metric value.
 */
// --------------------
// Global Variables
// --------------------
export const defaultNamespaceResolver = (modelName) => modelName;
export const activeOperationIds = new Set();

export function generateOperationId() {
    return "op_" + uuidv4();
}

export async function withOperationId(fn) {
    const operationId = generateOperationId();
    activeOperationIds.add(operationId);
    try {
        return await fn(operationId);
    } finally {
        activeOperationIds.delete(operationId);
    }
}
// --------------------
// Live Query Registry
// --------------------
class LiveQueryRegistry {
    constructor() {
        /** @type {Map<string, Set<LiveQuerySet>>} */
        this.namespaceRegistry = new Map();
    }
    register(namespace, liveQuerySet) {
        if (!this.namespaceRegistry.has(namespace)) {
            this.namespaceRegistry.set(namespace, new Set());
        }
        this.namespaceRegistry.get(namespace).add(liveQuerySet);
    }
    unregister(namespace, liveQuerySet) {
        if (this.namespaceRegistry.has(namespace)) {
            this.namespaceRegistry.get(namespace).delete(liveQuerySet);
            if (this.namespaceRegistry.get(namespace).size === 0) {
                this.namespaceRegistry.delete(namespace);
            }
        }
    }
    getForNamespace(namespace) {
        return this.namespaceRegistry.get(namespace) || new Set();
    }
}
export const liveQueryRegistry = new LiveQueryRegistry();

// --------------------
// Event Handling (Handles different instance formats)
// --------------------
export const handleModelEvent = async (event) => {
    // Destructure relevant fields, expecting PK-only data possibly
    const {
        operationId,
        operation_id,
        type,
        event: evt,
        namespace,
        model,
        pk_field_name, // Name of the PK field *if* instances are objects
        instances,     // Array for bulk events: can be [pk1, pk2] OR [{pkField: pk1}, {pkField: pk2}]
        pk,            // PK for single delete (fallback)
        id: topLevelId // PK for single create/update (fallback)
    } = event;

    const eventOperationId = operationId || operation_id || generateOperationId();
    const eventType = type || evt;

    // --- Basic Validation ---
    if (!eventType) {
        console.error(`Event received with no type/event field (OpId: ${eventOperationId}):`, event);
        return;
    }
    if (!namespace) {
        console.warn(`Event received with no namespace (OpId: ${eventOperationId}):`, event);
        return;
    }

    // --- Normalize Event Type ---
    const typeMap = {
        create: EventType.CREATE,
        update: EventType.UPDATE,
        delete: EventType.DELETE,
        bulk_create: EventType.BULK_CREATE,
        bulk_update: EventType.BULK_UPDATE,
        bulk_delete: EventType.BULK_DELETE,
    };
    const normalizedEventType = typeMap[eventType.toLowerCase()] || eventType;
    if (!Object.values(EventType).includes(normalizedEventType)) {
        console.warn(`Unknown event type: ${eventType} (normalized: ${normalizedEventType}, OpId: ${eventOperationId})`);
        return;
    }

    // --- Get Target LQS ---
    const liveQuerySets = liveQueryRegistry.getForNamespace(namespace);
    if (liveQuerySets.size === 0) return;

    // --- Skip Self-Initiated Events ---
    if (activeOperationIds.has(eventOperationId)) {
        // console.debug(`Skipping event handling for self-initiated operation: ${eventOperationId}`);
        return;
    }

    // --- Process for each Root LQS ---
    for (const lqs of liveQuerySets) {
        if (lqs.ModelClass.modelName !== model) continue;
        if (lqs.parent) continue; // Process only on root

        // Trigger async metric refresh
        lqs.refreshMetrics(eventOperationId).catch((error) =>
            console.error(`Error refreshing metrics for ${lqs.namespace} on event ${eventOperationId}:`, error)
        );

        const modelPkField = lqs.ModelClass.primaryKeyField || "id"; // PK field name defined in the Model class
        // PK field name expected in event payload *if* instances are objects
        const eventPkFieldName = pk_field_name || modelPkField;

        try {
            // === Extract PKs and Fetch Data ===
            let primaryKeyValue;      // For single events
            let primaryKeyValues = []; // For bulk events
            let fetchedModel = null;    // Fetched data for single create/update
            let fetchedModels = [];   // Fetched data for bulk create/update

            const isBulk = [EventType.BULK_CREATE, EventType.BULK_UPDATE, EventType.BULK_DELETE].includes(normalizedEventType);

            if (isBulk) {
                // --- Adaptable Bulk PK Extraction ---
                const eventInstances = instances || [];
                if (eventInstances.length > 0) {
                    const firstInstance = eventInstances[0];
                    if (typeof firstInstance === 'object' && firstInstance !== null) {
                        // Assume it's an array of objects: [{ pkField: pk1 }, ...]
                        primaryKeyValues = eventInstances
                            .map(inst => inst ? inst[eventPkFieldName] : undefined)
                            .filter(k => k !== undefined);
                    } else {
                        // Assume it's an array of raw PKs: [pk1, pk2, ...]
                        // Filter out any undefined/null values just in case
                        primaryKeyValues = eventInstances.filter(k => k !== undefined && k !== null);
                    }
                }
                // --- End Adaptable Extraction ---


                if (primaryKeyValues.length === 0) {
                    console.warn(`Invalid ${normalizedEventType} event: no valid PKs found in 'instances' array (OpId: ${eventOperationId}). Expected array of objects with key '${eventPkFieldName}' or array of raw PKs. Payload:`, event);
                    continue; // Skip this LQS for this malformed event
                }

                // --- Fetching for Bulk Events ---
                // BULK_CREATE/BULK_UPDATE: Need full data to filter/apply changes
                if (normalizedEventType === EventType.BULK_CREATE || normalizedEventType === EventType.BULK_UPDATE) {
                   try {
                        // Fetch using the model's defined PK field name for the query
                        fetchedModels = await lqs.qs.filter({ [`${modelPkField}__in`]: primaryKeyValues }).fetch();
                   } catch (fetchErr) {
                        console.error(`Error fetching bulk instances for ${normalizedEventType} (PKs: ${primaryKeyValues.join(',')}, OpId: ${eventOperationId}):`, fetchErr);
                        continue; // Cannot proceed without fetched data
                   }
                }
                // BULK_DELETE: No fetch needed here, handler uses PKs directly.

            } else {
                 // --- Single Event PK Extraction ---
                 // Prioritize specific 'pk', then 'id' at top level, then the named field from payload
                 primaryKeyValue = pk ?? topLevelId ?? event[eventPkFieldName];

                 if (primaryKeyValue === undefined) {
                    console.error(`Invalid ${normalizedEventType} event: missing primary key using field '${eventPkFieldName}' or 'pk'/'id' (OpId: ${eventOperationId})`, event);
                    continue;
                 }

                 // --- Fetching for Single Events ---
                 // CREATE/UPDATE: Always fetch the full model.
                 // DELETE: No fetch needed here.
                 if (normalizedEventType === EventType.CREATE || normalizedEventType === EventType.UPDATE) {
                     try {
                          // Fetch using the model's defined PK field name for the query
                          if (normalizedEventType === EventType.CREATE) {
                              // Expect it to exist now
                             fetchedModel = await lqs.qs.get({ [modelPkField]: primaryKeyValue });
                          } else { // UPDATE
                             // Might not exist anymore, or might be filtered out
                             fetchedModel = await lqs.qs.first({ [modelPkField]: primaryKeyValue });
                          }
                     } catch (err) {
                          if (err instanceof DoesNotExist) {
                              // This is expected if the item was deleted or doesn't match base QS filters
                              console.warn(`Received ${normalizedEventType} event but item PK ${primaryKeyValue} not found during fetch (OpId: ${eventOperationId}). Might be deleted or filtered.`, event);
                              // Let UPDATE handler deal with null `fetchedModel`.
                              // For CREATE, if it doesn't exist *now*, we can't process it.
                              if (normalizedEventType === EventType.CREATE) continue; // Skip if create event target doesn't exist
                          } else {
                              // Log unexpected fetch errors
                              console.error(`Error fetching single instance for ${normalizedEventType} (PK: ${primaryKeyValue}, OpId: ${eventOperationId}):`, err);
                              continue; // Cannot proceed if fetch failed unexpectedly
                          }
                     }
                 }
            }

            // === Call Appropriate LQS Handler ===
            switch (normalizedEventType) {
                case EventType.CREATE:
                    if (fetchedModel) { // Ensure model was fetched successfully
                        lqs.handleExternalCreateEvent(fetchedModel, eventOperationId);
                    }
                    // No else needed, DoesNotExist or fetch errors handled above by continuing
                    break;
                case EventType.UPDATE:
                    // Pass potentially null fetchedModel and the definite primaryKeyValue
                    lqs.handleExternalUpdateEvent(fetchedModel, eventOperationId, primaryKeyValue);
                    break;
                case EventType.DELETE:
                    lqs.handleExternalDeleteEvent(primaryKeyValue, eventOperationId);
                    break;
                case EventType.BULK_CREATE:
                    // Pass the models that were successfully fetched
                    lqs.handleExternalBulkCreateEvent(fetchedModels, eventOperationId);
                    break;
                case EventType.BULK_UPDATE:
                    // Pass the fetched models so the handler can check filters *after* update
                    await lqs.handleExternalBulkUpdateEvent(
                        primaryKeyValues, // Original PKs from event
                        eventPkFieldName, // Name of PK field in event (informational)
                        eventOperationId,
                        fetchedModels     // Result of fetching those PKs
                    );
                    break;
                case EventType.BULK_DELETE:
                    // Pass only the PKs from the event
                    lqs.handleExternalBulkDeleteEvent(primaryKeyValues, eventPkFieldName, eventOperationId);
                    break;
            }

        } catch (err) {
             // Catch errors during handler execution (fetch errors caught and continued above)
            console.error(`Error executing LQS handler for ${normalizedEventType} event (PKs: ${primaryKeyValue ?? primaryKeyValues.join(',')}, OpId: ${eventOperationId}):`, err, event);
        }
    }
};


// --------------------
// LiveQuerySet Class
// --------------------
export class LiveQuerySet {
    /**
     * @typedef {Object} LiveQuerySetOptions
     * @property {function(): string} [operationIdGenerator] - Custom operation ID generator function.
     * @property {string} [customNamespace] - Custom namespace to append to the model name.
     * @property {SerializerOptions} [serializer] - Serializer options.
     * @property {Object} [insertBehavior] - Configuration for insertion behavior
     * @property {number|'prepend'|'append'|function(Object, Array): number} [insertBehavior.local=0] - Where to insert locally created items ('prepend' maps to 0, 'append' maps to undefined/end)
     * @property {number|'prepend'|'append'|function(Object, Array): number} [insertBehavior.remote='append'] - Where to insert remotely created items ('prepend' maps to 0, 'append' maps to undefined/end)
     * @property {LiveQuerySet} [parent] - Parent live queryset from which this is derived (if any) - Handled internally by filter()
     */

    constructor(
        qs,
        dataArray, // Initial data for the root LQS SyncedArray
        options,
        filterFn, // Filter applied by *this* LQS instance (or its parents)
        filterConditions, // Original filter conditions for this LQS level
        createMetricFn,
        parent, // Reference to the parent LQS, if created via .filter()
        createdItems // Set shared across related LQS instances tracking locally created PKs
    ) {
        this.qs = qs; // The QuerySet defining the *potential* data scope
        this.createdItems = createdItems || new Set(); // Track PKs created by *this client* (shared with children)
        this.filterFn = filterFn || (() => true); // Function to test if an item matches *this specific LQS filter*
        this.options = options || {};
        this._serializerOptions = this.options.serializer || {};
        this.originalFilterConditions = filterConditions; // Filters specific to this LQS level
        this.ModelClass = this.qs.ModelClass;
        this.pkField = this.ModelClass.primaryKeyField || "id"; // Cache PK field name
        this.createMetricFn = createMetricFn
            ? createMetricFn
            : (value) => ({ value });
        this.parent = parent;
        this.optimisticMetricsApplied = new Set(); // Track opIDs for metric updates

        // --- SyncedArray Initialization (BEFORE registration) ---
        if (this.parent) {
            // Child LQS uses the parent's SyncedArray
            if (!this.parent.syncedArray) {
                throw new Error("Parent LiveQuerySet does not have a SyncedArray initialized.");
            }
            this.syncedArray = this.parent.syncedArray;
        } else {
            // Root LQS initializes its own SyncedArray
            this.syncedArray = new SyncedArray({
                initialData: dataArray || [],
                primaryKey: this.pkField,
                onChange: (newData, prevData, operationMeta) => {
                    let eventType = 'update';
                    if (newData.length > prevData.length) eventType = 'create';
                    else if (newData.length < prevData.length) eventType = 'delete';
                    this._notify(eventType, newData, prevData, operationMeta?.id);
                },
                ItemClass: this.ModelClass
            });
        }
        // --- End SyncedArray Initialization ---


        // Helper to map position strings/numbers to internal representation
        const getPositionIndex = (pos) => {
            if (pos === 'prepend') return 0;
            if (pos === 'append') return undefined; // SyncedArray interprets undefined as append
            if (typeof pos === 'number' && pos >= 0) return pos;
            if (typeof pos === 'function') return pos; // Allow functions
            return undefined; // Default to append
        }

        // Initialize insertion behavior with defaults (internal representation)
        this.insertBehavior = {
            local: getPositionIndex(this.options?.insertBehavior?.local ?? 0), // Default local prepend (0)
            remote: getPositionIndex(this.options?.insertBehavior?.remote ?? 'append'), // Default remote append (undefined)
        };

        // --- Registration and Event Subscription (AFTER SyncedArray is ready) ---
        const modelName = this.ModelClass.modelName;
        const namespaceResolver = defaultNamespaceResolver;
        this.namespace = namespaceResolver(modelName); // TODO: Consider customNamespace option

        // Only register/subscribe the root LQS
        if (!this.parent) {
            liveQueryRegistry.register(this.namespace, this);
            const eventReceiver = getEventReceiver();
            if (eventReceiver) {
                eventReceiver.subscribe(this.namespace);
            }
        }
        // --- End Registration ---

        this.activeMetrics = new Map();
        this.callbacks = []; // Callbacks specific to this LQS instance
        this.errorCallbacks = []; // Error callbacks specific to this LQS instance
    }

    /**
     * Helper method to find the root queryset's base QuerySet instance
     * @returns {QuerySet} The root queryset instance
     * @private
     */
    _findRootQuerySetInstance() {
        let current = this;
        while (current.parent) {
            current = current.parent;
        }
        return current.qs;
    }

    handleOptimisticMetricUpdates(
        eventType,
        updatedArray, // Full array view from SyncedArray
        originalArray, // Previous full array view
        operationId
    ) {
        const filteredUpdated = updatedArray.filter(this.filterFn);
        const filteredOriginal = originalArray.filter(this.filterFn);

        if (eventType === 'clean') return; // Skip local cleanups

        // Calculate updates based on the *filtered* view change
        const metricUpdates = MetricsManager.optimisticUpdate(
            eventType,
            filteredUpdated,
            filteredOriginal,
            this.activeMetrics,
            operationId
        );

        if (Object.keys(metricUpdates).length > 0) {
            this.applyOptimisticMetrics(metricUpdates, operationId);
        }
    }

    applyOptimisticMetrics(metricUpdates, operationId) {
        if (operationId && this.optimisticMetricsApplied.has(operationId)) {
            return; // Avoid double application
        }
        MetricsManager.applyOptimisticUpdates(metricUpdates, this.activeMetrics);
        if (operationId) {
            this.optimisticMetricsApplied.add(operationId);
        }
        // Note: No automatic propagation to parent here to avoid complexity/double counting.
    }

    /**
     * Refreshes the root LiveQuerySet. Throws error if called on a child.
     * @param {Object} params - Refresh parameters
     * @param {QuerySet} [params.newQs] - New QuerySet to use
     * @param {LiveQuerySetOptions} [params.newOptions] - New options to use
     * @param {boolean} [params.clearData=true] - Whether to replace data in SyncedArray
     * @returns {Promise<void>}
     */
    async refresh({ newQs, newOptions, clearData = true } = {}) {
        if (this.parent) {
            throw new Error("Cannot directly refresh a filtered LiveQuerySet. Refresh the root.");
        }
        if (newQs && newQs.ModelClass !== this.ModelClass) {
            throw new Error("Cannot refresh LiveQuerySet with a different model class");
        }

        let queryChanged = false;
        if (newQs && this.qs !== newQs) {
            this.qs = newQs;
            queryChanged = true;
        }

        if (newOptions) {
            // Basic check; deep comparison might be needed if options structure is complex
             if (JSON.stringify(this.options.serializer) !== JSON.stringify(newOptions.serializer) ||
                 JSON.stringify(this.options.insertBehavior) !== JSON.stringify(newOptions.insertBehavior)) {
                  queryChanged = true;
             }

            this.options = { ...this.options, ...newOptions };
            this._serializerOptions = this.options.serializer || {};

             // Update internal insertBehavior based on new options
            const getPositionIndex = (pos) => {
                if (pos === 'prepend') return 0;
                if (pos === 'append') return undefined;
                if (typeof pos === 'number' && pos >= 0) return pos;
                if (typeof pos === 'function') return pos;
                return undefined; // Default append
            }
             this.insertBehavior = {
                 local: getPositionIndex(this.options?.insertBehavior?.local ?? this.insertBehavior.local),
                 remote: getPositionIndex(this.options?.insertBehavior?.remote ?? this.insertBehavior.remote),
             };
        }

        const queryState = this.qs.build();
        this.originalFilterConditions = queryState.filter?.conditions;

        if (clearData || queryChanged) {
            try {
                const newData = await this.qs.fetch(this._serializerOptions);
                this.syncedArray.resetGroundTruth(newData, true); // Reset with new data, clear optimistic ops
            } catch (error) {
                console.error("Error fetching data during LiveQuerySet refresh:", error);
                this._notifyError(error, "refresh");
                // Keep existing data but clear optimistic ops on fetch failure?
                this.syncedArray.resetGroundTruth(this.syncedArray.getGroundTruth(), true);
            }
        }

        await this.refreshMetrics(); // Refresh metrics regardless
    }

    /**
     * Register a callback for data changes on this LQS instance.
     * Receives the *full* data view from SyncedArray.
     * @param {function(string, Array, Array, string=)} callback - Fn(eventType, newData, prevData, operationId)
     * @returns {function()} - Unsubscribe function
     */
    subscribe(callback) {
        this.callbacks.push(callback);
        return () => {
            this.callbacks = this.callbacks.filter((cb) => cb !== callback);
        };
    }

    /**
     * Internal method to notify subscribers and handle metrics/propagation.
     * @param {string} eventType - 'create', 'update', 'delete', 'clean'
     * @param {Array} updatedArray - Full updated data array from SyncedArray
     * @param {Array} originalArray - Full original data array from SyncedArray
     * @param {string} [operationId] - Associated operation ID
     * @private
     */
    _notify(eventType, updatedArray, originalArray, operationId) {
        // Notify local subscribers
        for (const callback of this.callbacks) {
            try {
                callback(eventType, updatedArray, originalArray, operationId);
            } catch (error) {
                console.error("Error in LiveQuerySet subscriber callback:", error);
            }
        }

        // Update optimistic metrics for *this* filtered view
        this.handleOptimisticMetricUpdates(eventType, updatedArray, originalArray, operationId);

        // Propagate notification to parent if this is a child
        if (this.parent) {
            this.parent._notify(eventType, updatedArray, originalArray, operationId);
        }
    }

    /**
     * Register an error handler for operations initiated on this LQS instance.
     * @param {function(Error, string)} errorCallback - Fn(error, operationType)
     * @returns {function()} - Unsubscribe function
     */
    onError(errorCallback) {
        this.errorCallbacks.push(errorCallback);
        return () => {
            this.errorCallbacks = this.errorCallbacks.filter((cb) => cb !== callback);
        };
    }

    /**
     * Notify error callbacks and propagate error to parent.
     * @param {Error} error - The error
     * @param {string} operation - Operation type
     * @private
     */
    _notifyError(error, operation) {
        for (const callback of this.errorCallbacks) {
            try {
                callback(error, operation);
            } catch (e) {
                console.error("Error in LiveQuerySet error callback:", e);
            }
        }
        if (this.parent) {
            this.parent._notifyError(error, operation);
        }
    }

    /**
     * Returns the current data view filtered by this LQS's cumulative filter.
     * @returns {Array} The filtered data array.
     */
    get data() {
        // Ensure syncedArray is available before filtering
        if (!this.syncedArray) {
           console.warn("Attempted to access LQS data before SyncedArray was initialized.");
           return [];
        }
        return this.syncedArray.data.filter(this.filterFn);
    }

    /**
     * @deprecated Use the `data` getter for the filtered view or `syncedArray.data` for the full view.
     */
    get dataArray() {
        console.warn("LiveQuerySet.dataArray is deprecated. Use the .data getter for the filtered view or .syncedArray.data for the full view.");
         if (!this.syncedArray) {
             return [];
         }
        return this.syncedArray.data;
    }

    /** Destroys this LQS instance. Only root unregisters global listeners. */
    destroy() {
        this.activeMetrics.clear();
        this.callbacks = [];
        this.errorCallbacks = [];
        this.createdItems.clear();

        if (!this.parent) {
            liveQueryRegistry.unregister(this.namespace, this);
            const eventReceiver = getEventReceiver();
            if (eventReceiver) {
                const stillRegistered = liveQueryRegistry.getForNamespace(this.namespace);
                if (stillRegistered.size === 0) {
                    eventReceiver.unsubscribe(this.namespace);
                }
            }
        }
        // Help GC
        this.qs = null;
        this.syncedArray = null;
        this.parent = null;
        this.filterFn = null;
    }

    /** Returns the current filtered data view. */
    async fetch() {
        return this.data;
    }

    /**
     * Creates a new, further filtered LiveQuerySet instance sharing the same data source.
     * @param {Object} conditions - Additional filter conditions.
     * @returns {LiveQuerySet} A new, filtered LiveQuerySet instance.
     */
    filter(conditions) {
        const newFilterFn = (item) => {
            return this.filterFn(item) && // Must pass parent filter
                   Object.entries(conditions).every(([key, value]) => item[key] === value); // And new conditions
        };
        const newQs = this.qs.filter(conditions); // Create corresponding QuerySet

        const filteredLiveQs = new LiveQuerySet(
            newQs, null, this.options, newFilterFn, conditions,
            this.createMetricFn, this, this.createdItems
        );
        return filteredLiveQs;
    }

    /**
     * Deletes items matching the current LQS filter.
     * @returns {Promise<number>} The number of items deleted.
     */
    async delete() {
        if (arguments.length > 0) throw new Error("delete() does not accept arguments.");

        return await withOperationId(async (operationId) => {
            const itemsToDelete = this.data; // Get items matching *this* filter
            if (itemsToDelete.length === 0) return 0;

            const optimisticDeletes = itemsToDelete.map((item, index) => ({
                id: `${operationId}_del_${index}`,
                key: item[this.pkField]
            }));

            this.syncedArray.bulkDeleteOptimistic(optimisticDeletes);

            try {
                // Execute backend delete using *this* LQS's QuerySet
                const result = await this.qs.executeQuery({
                     ...this.qs.build(), type: "delete", operationId, namespace: this.namespace
                });

                if (!result || result.error) {
                    throw new Error(result?.error?.message || result?.error || "Delete failed on backend");
                }

                this.syncedArray.bulkConfirmOptimisticOps(optimisticDeletes.map(op => ({ id: op.id })));
                return itemsToDelete.length;

            } catch (error) {
                console.error(`Error during LiveQuerySet delete (OpId: ${operationId}):`, error);
                this._notifyError(error, "delete");
                this.syncedArray.bulkRemoveOptimisticOps(optimisticDeletes.map(op => op.id)); // Rollback
                throw error;
            }
        });
    }

    /**
     * Creates a new item optimistically and on the backend.
     * @param {Object} itemData - Data for the new item.
     * @returns {Promise<Object>} The created item instance from backend.
     */
    async create(itemData) {
        if (!itemData || typeof itemData !== 'object') throw new Error("Invalid item data for create.");

        return await withOperationId(async (operationId) => {
            const optimisticOpId = `${operationId}_create`;

            this.syncedArray.createOptimistic({
                id: optimisticOpId,
                position: this.insertBehavior.local // Use configured local position
            }, itemData);

            try {
                const rootQs = this._findRootQuerySetInstance();
                const result = await rootQs.executeQuery({
                    type: "create", data: itemData, operationId, namespace: this.namespace
                });

                if (!result || result.error || !result.data) {
                    throw new Error(result?.error?.message || result?.error || "Create failed on backend");
                }

                const createdItem = new this.ModelClass(result.data);
                const pkValue = createdItem[this.pkField];

                this.syncedArray.confirmOptimisticOp(optimisticOpId, createdItem);

                if (pkValue !== undefined) {
                    this.createdItems.add(pkValue);
                } else {
                     console.warn(`Created item missing primary key (OpId: ${operationId}).`, createdItem);
                }

                await this.refreshMetrics(operationId);

                return createdItem;

            } catch (error) {
                console.error(`Error during LiveQuerySet create (OpId: ${operationId}):`, error);
                this._notifyError(error, "create");
                this.syncedArray.removeOptimisticOp(optimisticOpId); // Rollback
                throw error;
            }
        });
    }

    /**
     * Updates items matching the current LQS filter optimistically and on the backend.
     * @param {Object} updates - Fields and values to update.
     * @returns {Promise<Array>} Array of updated items matching filter (after backend confirmation).
     */
    async update(updates) {
        if (arguments.length > 1 || typeof updates !== 'object' || updates === null) {
             throw new Error("Update accepts only a single object argument.");
        }
        if (Object.keys(updates).length === 0) return [];

        return await withOperationId(async (operationId) => {
            const itemsToUpdate = this.data; // Get items matching *this* filter
            if (itemsToUpdate.length === 0) return [];

            const optimisticUpdates = itemsToUpdate.map((item, index) => ({
                id: `${operationId}_upd_${index}`,
                key: item[this.pkField],
                data: updates
            }));

            this.syncedArray.bulkUpdateOptimistic(optimisticUpdates);

            try {
                // Execute backend update using *this* LQS's QuerySet
                const result = await this.qs.executeQuery({
                     ...this.qs.build(), type: "update", data: updates, operationId, namespace: this.namespace
                });

                if (!result || result.error) {
                    throw new Error(result?.error?.message || result?.error || "Update failed on backend");
                }

                 // Confirm ops. Assumes backend applied `updates`.
                 // If backend returns full objects, could use that in serverData.
                this.syncedArray.bulkConfirmOptimisticOps(
                    optimisticUpdates.map(op => ({ id: op.id /*, serverData: updates */ }))
                );

                // Return items matching filter *after* update confirmation
                return this.syncedArray.data.filter(this.filterFn);

            } catch (error) {
                console.error(`Error during LiveQuerySet update (OpId: ${operationId}):`, error);
                this._notifyError(error, "update");
                this.syncedArray.bulkRemoveOptimisticOps(optimisticUpdates.map(op => op.id)); // Rollback
                throw error;
            }
        });
    }

    /**
     * Gets a single object, checking local filtered data first, then backend.
     * @param {Object} [filters] - Additional temporary filters.
     * @returns {Promise<Object>} The matching object instance.
     */
    async get(filters) {
        let localResults = this.data; // Use filtered getter
        if (filters) {
            localResults = localResults.filter(item =>
                Object.entries(filters).every(([key, value]) => item[key] === value)
            );
        }

        if (localResults.length === 1) return localResults[0];
        if (localResults.length > 1) throw new MultipleObjectsReturned(`get() found ${localResults.length} objects locally.`);

        try {
            // Combine LQS query state with additional filters for backend `get`
            const queryBuilt = this.qs.build(); // Build once
            const finalFilters = filters ? { ...(queryBuilt.filters || {}), ...filters } : queryBuilt.filters;
            const freshItem = await this.qs.get(finalFilters || {}); // Use LQS's qs.get()

            // Add/update in ground truth *only* if it matches this LQS filter
            if (this.filterFn(freshItem)) {
                this.syncedArray.createDirect({ position: this.insertBehavior.remote }, freshItem);
            } else {
                 // Found on backend but doesn't match this filter. From this LQS's perspective, it doesn't exist.
                 throw new DoesNotExist(`Object found but does not match the LiveQuerySet filter.`);
            }
            return freshItem;

        } catch (error) {
            if (error instanceof DoesNotExist) {
                // If backend get failed or if filterFn rejected it, throw standard error
                throw new DoesNotExist(`Object not found locally or on backend matching filters.`);
            }
            console.error("Error during LiveQuerySet get:", error);
            this._notifyError(error, "get");
            throw error;
        }
    }

    // --- External Event Handlers (Called by global handleModelEvent on root LQS) ---

    /**
     * Handles external bulk create event. Filters items and adds valid ones.
     * @param {Array<Object>} items - Array of full item data fetched from backend.
     * @param {string} operationId - External operation identifier.
     * @private
     */
    handleExternalBulkCreateEvent(items, operationId) {
        if (!items?.length) return;
        const itemsToAdd = items.filter(this.filterFn);
        if (itemsToAdd.length > 0) {
            this.syncedArray.bulkCreateDirect(
                itemsToAdd.map(item => ({ position: this.insertBehavior.remote, data: item }))
            );
        }
    }

        /**
     * Handles external bulk update event. Uses fetched data to determine adds/updates/removals.
     * @param {Array<string|number>} instancePks - Array of primary keys from the event.
     * @param {string} pkFieldNameInEvent - Name of PK field used in the event payload (informational).
     * @param {string} operationId - External operation identifier.
     * @param {Array<Object>} fetchedInstances - Array of full item data fetched for the instancePks.
     * @private
     */
    async handleExternalBulkUpdateEvent(instancePks, pkFieldNameInEvent, operationId, fetchedInstances) {
        // Note: pkFieldNameInEvent is informational here, we use fetchedInstances
        if (!instancePks?.length) return;
        const currentModelPkField = this.pkField; // Use the PK field defined in the model

        try {
            // Map fetched instances by their actual PK for efficient lookup
            const fetchedMap = new Map(
                (fetchedInstances || []).map(instance => [instance[currentModelPkField], instance])
            );

            const pksToRemove = new Set(); // PKs of items to be removed
            const existingPksInGroundTruth = new Set(this.syncedArray.getGroundTruth().map(item => item[currentModelPkField])); // Check ground truth existence
            const isLocallyCreatedMap = new Map(Array.from(this.createdItems).map(pk => [pk, true])); // Faster lookup for local creation

            // *** NEW: Stage updates and creates separately ***
            const itemsToTrulyUpdate = []; // Items found in ground truth to be updated
            const itemsToNewlyCreate = []; // Items not in ground truth but matching filter

            // Iterate through the PKs *from the original event* to decide action for each
            for (const pk of instancePks) {
                const updatedInstance = fetchedMap.get(pk); // Get the current state from fetched data
                const wasInGroundTruth = existingPksInGroundTruth.has(pk); // Was it in ground truth before?
                const isLocallyCreated = isLocallyCreatedMap.has(pk); // Was it created by this client?

                if (updatedInstance) {
                    // Instance still exists after the update
                    const matchesFilter = this.filterFn(updatedInstance); // Check if it matches *now*

                    if (matchesFilter) {
                        // It matches the filter now.
                        // Stage for update if it exists in ground truth.
                        if (wasInGroundTruth) {
                            itemsToTrulyUpdate.push({ key: pk, data: updatedInstance });
                        } else {
                            // *** ADDED LOGIC: Stage for creation if it wasn't in ground truth ***
                            itemsToNewlyCreate.push({ position: this.insertBehavior.remote, data: updatedInstance });
                        }
                    } else {
                        // No longer matches the filter
                        if (wasInGroundTruth && !isLocallyCreated) {
                            // It was present, but doesn't match anymore, and wasn't created here -> remove
                            pksToRemove.add(pk);
                        }
                        // If it wasn't present, or was locally created, do nothing (it stays filtered out/absent)
                    }
                } else {
                    // Instance not found in fetched data (likely deleted during the update process?)
                    if (wasInGroundTruth && !isLocallyCreated) {
                            // Was present, now it's gone, and wasn't created here -> remove
                        pksToRemove.add(pk);
                    }
                        // If it wasn't present, or was locally created, do nothing
                }
            }

            // Apply changes to SyncedArray ground truth
            if (itemsToTrulyUpdate.length > 0) {
                // bulkUpdateDirect handles updates based on PK
                this.syncedArray.bulkUpdateDirect(itemsToTrulyUpdate);
            }
            // *** ADDED LOGIC: Apply creations ***
            if (itemsToNewlyCreate.length > 0) {
                    // Use bulkCreateDirect which handles idempotency / updates if PK somehow already exists now
                this.syncedArray.bulkCreateDirect(itemsToNewlyCreate);
            }
            if (pksToRemove.size > 0) {
                this.syncedArray.bulkDeleteDirect(Array.from(pksToRemove));
            }

        } catch (err) {
            console.error(`Error processing fetched bulk update data (OpId: ${operationId}):`, err);
        }
    }

    /**
     * Handles external bulk delete event. Removes items by PK.
     * @param {Array<string|number>} instancePks - Array of primary keys to delete.
     * @param {string} pkFieldNameInEvent - Name of PK field used in event payload (informational).
     * @param {string} operationId - External operation identifier.
     * @private
     */
    handleExternalBulkDeleteEvent(instancePks, pkFieldNameInEvent, operationId) {
        // Note: pkFieldNameInEvent is informational
        if (!instancePks || instancePks.length === 0) return;
        this.syncedArray.bulkDeleteDirect(instancePks);
    }

    /**
     * Handles external single create event. Adds item if it matches filter.
     * @param {Object} item - Full item data fetched from backend.
     * @param {string} operationId - External operation identifier.
     * @private
     */
    handleExternalCreateEvent(item, operationId) {
        if (!item) return;
        if (this.filterFn(item)) {
            // Add directly (handles duplicates via PK)
            this.syncedArray.createDirect({ position: this.insertBehavior.remote }, item);
        }
    }

    /**
     * Handles external single update event. Updates/adds/removes based on filter match.
     * @param {Object|null} item - Full item data fetched (or null if not found).
     * @param {string} operationId - External operation identifier.
     * @param {string|number} primaryKey - The primary key of the item being updated.
     * @private
     */
    handleExternalUpdateEvent(item, operationId, primaryKey) {
        const pkValue = item ? item[this.pkField] : primaryKey; // Get PK from item if available, else from param
        if (pkValue === undefined) {
            console.warn(`External update handler missing primary key (OpId: ${operationId})`);
            return;
        }

        const isLocallyCreated = this.createdItems.has(pkValue); // Was it created by this client?

        if (item) { // Updated data exists (fetch was successful)
            if (this.filterFn(item)) {
                // Matches filter: Try to update first.
                const updated = this.syncedArray.updateDirect({ key: pkValue }, item);

                // *** ADDED LOGIC: If updateDirect didn't find the item in ground truth, create it. ***
                if (!updated) {
                    this.syncedArray.createDirect({ position: this.insertBehavior.remote }, item);
                }
            } else {
                // No longer matches filter: Remove if it was in ground truth and not local.
                const wasInGroundTruth = this.syncedArray.getGroundTruth().some(d => d[this.pkField] === pkValue);
                    if (wasInGroundTruth && !isLocallyCreated) {
                        this.syncedArray.deleteDirect({ key: pkValue });
                    }
            }
        } else { // Item is null (deleted or filtered out before fetch could get it)
                // Remove if it was in ground truth and not local.
                const wasInGroundTruth = this.syncedArray.getGroundTruth().some(d => d[this.pkField] === pkValue);
                if (wasInGroundTruth && !isLocallyCreated) {
                    this.syncedArray.deleteDirect({ key: pkValue });
                }
        }
    }

    /**
     * Handles external single delete event. Removes item by PK.
     * @param {number|string} itemId - The primary key of the deleted item.
     * @param {string} operationId - External operation identifier.
     * @private
     */
    handleExternalDeleteEvent(itemId, operationId) {
        if (itemId === undefined) {
             console.warn(`External delete handler missing item ID (OpId: ${operationId})`);
             return;
        }
        this.syncedArray.deleteDirect({ key: itemId });
    }

    // --- Utility Methods ---

    /** Returns the first object from the current filtered data view. */
    async first() {
        const results = this.data;
        return results.length > 0 ? results[0] : null;
    }

    /** Returns the last object from the current filtered data view. */
    async last() {
        const results = this.data;
        return results.length > 0 ? results[results.length - 1] : null;
    }

    // --- Metrics ---

    /** Refreshes active metrics based on the current QuerySet state. */
    async refreshMetrics(operationId) {
        // Ensure qs is valid before refreshing
        if (!this.qs) {
            console.warn("Attempted to refresh metrics on a destroyed LiveQuerySet.");
            return;
        }
        return MetricsManager.scheduleRefresh(this.qs, this.activeMetrics, operationId);
    }

    /** Clears applied optimistic metric flag for a given operation ID */
    clearOptimisticMetricFlag(operationId) {
        if (operationId) this.optimisticMetricsApplied.delete(operationId);
    }

    async count(field) { return MetricsManager.count(this.qs, this.activeMetrics, this.createMetricFn, field); }
    async sum(field) { return MetricsManager.sum(this.qs, this.activeMetrics, this.createMetricFn, field); }
    async avg(field) { return MetricsManager.avg(this.qs, this.activeMetrics, this.createMetricFn, field); }
    async min(field) { return MetricsManager.min(this.qs, this.activeMetrics, this.createMetricFn, field); }
    async max(field) { return MetricsManager.max(this.qs, this.activeMetrics, this.createMetricFn, field); }
}

// --------------------
// Live QuerySet Factory Functions
// --------------------
/**
 * Creates the root LiveQuerySet instance.
 * @param {QuerySet} qs - The base QuerySet.
 * @param {Array} reactiveArray - Initial array (content replaced/managed by LQS).
 * @param {LiveQuerySetOptions} [options] - Configuration options.
 * @param {function(value: any): MetricResult} [createMetricFn] - Optional metric factory.
 * @returns {Promise<LiveQuerySet>} Initialized root LiveQuerySet.
 */
export async function liveView(qs, reactiveArray, options, createMetricFn) {
    if (!(qs instanceof QuerySet)) throw new Error("liveView requires a valid QuerySet instance.");

    const backendKey = qs.modelClass.configKey;
    if (!backendKey) throw new Error(`No configKey found on model class ${qs.modelClass.modelName}`);

    const customNamespace = options?.customNamespace;
    const namespaceResolver = (modelName) => customNamespace ? `${modelName}::${customNamespace}` : defaultNamespaceResolver(modelName);

    const eventReceiver = getEventReceiver(backendKey) || initializeEventReceiver(backendKey);
    if (eventReceiver) {
        eventReceiver.setNamespaceResolver(namespaceResolver);
        eventReceiver.addEventHandler(handleModelEvent); // Assumes idempotent
    } else {
        console.warn(`Could not initialize event receiver for backend key: ${backendKey}`);
    }

    let initialData = [];
    try {
        initialData = await qs.fetch(options?.serializer || {});
    } catch (error) {
        console.error("Failed to fetch initial data for liveView:", error);
    }

    if (reactiveArray && Array.isArray(reactiveArray)) {
        reactiveArray.splice(0, reactiveArray.length, ...initialData); // Initial sync
    } else {
        // Allow creating without a reactive array for internal use cases
        // console.warn("liveView called without a valid reactiveArray. State will be internal only.");
    }

    const queryState = qs.build();
    const rootLQS = new LiveQuerySet(
        qs, initialData, options, undefined, queryState.filter?.conditions, createMetricFn
    );

    // Perform initial metric load asynchronously after LQS is created
    // Use try-catch as metrics might not be essential for basic functionality
    try {
        await rootLQS.refreshMetrics();
    } catch(err) {
        console.error("Initial metric refresh failed:", err);
    }

    return rootLQS;
}

/** @deprecated Use liveView with an explicit reactive array instead. */
export async function legacyLiveView(qs, options) {
    console.warn("legacyLiveView is deprecated. Please use liveView(qs, [], options).");
    return liveView(qs, [], options); // Pass empty array placeholder
}

// --------------------
// Axios Interceptor & QuerySet Override
// --------------------
axios.interceptors.request.use((config) => {
    // Attempt to find the most specific operationId from the query data first
    let operationId = config.data?.ast?.query?.operationId || config.data?.operationId;

    // If not found in data, check if there's an active one globally
    if (!operationId && activeOperationIds.size > 0) {
        // Use the most recently added one (convert Set to Array)
        operationId = Array.from(activeOperationIds).pop();
    }

    // If an operationId was found or generated, add it to headers
    if (operationId) {
        config.headers = config.headers || {};
        // Use standard 'X-Operation-ID' or a custom header if needed
        config.headers["X-Operation-ID"] = operationId;
    }
    return config;
});

const originalExecuteQuery = QuerySet.prototype.executeQuery;
QuerySet.prototype.executeQuery = async function (query) {
    // If query doesn't have an operationId, try to assign one from the active set
    if (!query.operationId && activeOperationIds.size > 0) {
        // Use the most recently added one
         query.operationId = Array.from(activeOperationIds).pop();
    }
    // If still no operationId, the backend might assign one or it proceeds without one

    return originalExecuteQuery.call(this, query);
};