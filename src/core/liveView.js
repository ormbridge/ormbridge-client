import { QuerySet } from "../flavours/django/querySet.js";
import { Model } from "../flavours/django/model.js";
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import * as arrayDiff from 'fast-array-diff';
import { EventType, getEventReceiver, setEventReceiver, setNamespaceResolver,
// NamespaceResolver is a function type
 } from './eventReceivers.js';
import { initializeEventReceiver } from '../config.js';
import { MultipleObjectsReturned, DoesNotExist } from "../flavours/django/errors.js";
import MetricsManager from './MetricsManager';

/**
 * Updates an array in place to match the target array with minimal operations
 * Based on comparing items by a primary key
 * 
 * @param {Array} sourceArray - The array to update in place
 * @param {Array} targetArray - The target array with new/updated data
 * @param {string|Function} primaryKey - Primary key field name or comparison function
 * @returns {Array} - The updated sourceArray (same reference)
 */
function updateArrayInPlace(sourceArray, targetArray, primaryKey = 'id') {
    // Handle empty arrays
    if (targetArray.length === 0) {
    sourceArray.length = 0;
    return sourceArray;
    }
    
    if (sourceArray.length === 0) {
    sourceArray.push(...targetArray);
    return sourceArray;
    }
    
    // Create comparison function
    const compareFunc = typeof primaryKey === 'function' 
    ? primaryKey 
    : (a, b) => a[primaryKey] === b[primaryKey];
    
    // Get the patch operations
    const patch = arrayDiff.getPatch(sourceArray, targetArray, compareFunc);
    
    // Apply patches to update the array in place
    for (const op of patch) {
    if (op.type === 'remove') {
        sourceArray.splice(op.oldPos, op.items.length);
    } else if (op.type === 'add') {
        sourceArray.splice(op.oldPos, 0, ...op.items);
    }
    }
    return sourceArray;
}

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
 * @property {boolean} [strictMode] - @deprecated Use fixedPageSize instead.
 * @property {boolean} [fixedPageSize] - Fixed page size keeps the page size constant by removing items when new ones are added.
 * @property {function(): string} [operationIdGenerator] - Custom operation ID generator function.
 * @property {string} [customNamespace] - Custom namespace to append to the model name.
 * @property {SerializerOptions} [serializer] - Serializer options.
 */
/**
 * @typedef {Object} MetricResult
 * @property {number|any} value - The metric value.
 */
// --------------------
// Global Variables
// --------------------
/**
 * Default namespace resolver.
 * @param {string} modelName - The model name.
 * @returns {string} The resolved namespace.
 */
export const defaultNamespaceResolver = (modelName) => modelName;
/**
 * A mutable set to track all active operation IDs.
 * @type {Set<string>}
 */
export const activeOperationIds = new Set();
/**
 * Generates a new operation ID.
 * @returns {string} The generated operation ID.
 */
export function generateOperationId() {
    return 'op_' + uuidv4();
}
/**
 * Wrap an async function with a generated operationId.
 * The operationId is added to the global set and removed once the operation completes.
 *
 * @template T
 * @param {function(string): Promise<T>} fn - An async function that accepts an operationId.
 * @returns {Promise<T>} The result of the function.
 */
export async function withOperationId(fn) {
    const operationId = generateOperationId();
    activeOperationIds.add(operationId);
    try {
        return await fn(operationId);
    }
    finally {
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
    /**
     * Registers a LiveQuerySet under the given namespace.
     * @param {string} namespace
     * @param {LiveQuerySet} liveQuerySet
     */
    register(namespace, liveQuerySet) {
        if (!this.namespaceRegistry.has(namespace)) {
            this.namespaceRegistry.set(namespace, new Set());
        }
        this.namespaceRegistry.get(namespace).add(liveQuerySet);
    }
    /**
     * Unregisters a LiveQuerySet from the given namespace.
     * @param {string} namespace
     * @param {LiveQuerySet} liveQuerySet
     */
    unregister(namespace, liveQuerySet) {
        if (this.namespaceRegistry.has(namespace)) {
            this.namespaceRegistry.get(namespace).delete(liveQuerySet);
            if (this.namespaceRegistry.get(namespace).size === 0) {
                this.namespaceRegistry.delete(namespace);
            }
        }
    }
    /**
     * Gets all LiveQuerySets registered for the namespace.
     * @param {string} namespace
     * @returns {Set<LiveQuerySet>} The set of LiveQuerySets.
     */
    getForNamespace(namespace) {
        return this.namespaceRegistry.get(namespace) || new Set();
    }
}
export const liveQueryRegistry = new LiveQueryRegistry();
// --------------------
// Event Handling
// --------------------
/**
 * Handles a model event coming from the backend.
 *
 * @param {Object} event - The model event.
 * @returns {Promise<void>}
 */
export const handleModelEvent = async (event) => {
    // Normalize operation ID naming.
    event.operationId = event.operationId || event.operation_id;
    const eventType = event.type || event.event;
    if (!eventType) {
        console.error('Event received with no type/event field:', event);
        return;
    }
    /** @type {string|null} */
    let normalizedEventType = null;
    switch (eventType) {
        case 'create':
        case EventType.CREATE:
            normalizedEventType = EventType.CREATE;
            break;
        case 'update':
        case EventType.UPDATE:
            normalizedEventType = EventType.UPDATE;
            break;
        case 'delete':
        case EventType.DELETE:
            normalizedEventType = EventType.DELETE;
            break;
        case 'bulk_update':
        case EventType.BULK_UPDATE:
            normalizedEventType = EventType.BULK_UPDATE;
            break;
        case 'bulk_delete':
        case EventType.BULK_DELETE:
            normalizedEventType = EventType.BULK_DELETE;
            break;
        default:
            console.warn(`Unknown event type: ${eventType}`);
            return;
    }
    if (!event.namespace) {
        console.warn('Event received with no namespace:', event);
        return;
    }
    const liveQuerySets = liveQueryRegistry.getForNamespace(event.namespace);
    if (liveQuerySets.size === 0) {
        return;
    }
    for (const lqs of liveQuerySets) {
        if (event.model && lqs.ModelClass && lqs.ModelClass.modelName !== event.model) {
            continue;
        }
        lqs.refreshMetrics().catch(error => {
            console.error('Error refreshing metrics:', error);
        });
        if (event.operationId && activeOperationIds.has(event.operationId)) {
            continue;
        }
        const pkField = lqs.ModelClass.primaryKeyField;
        const isBulkEvent = normalizedEventType === EventType.BULK_UPDATE ||
            normalizedEventType === EventType.BULK_DELETE;
        if (isBulkEvent) {
            if (!event.instances || !Array.isArray(event.instances) || event.instances.length === 0) {
                console.error("Invalid bulk event: missing or empty instances array", event);
                continue;
            }
        }
        else {
            const pkValue = event[pkField];
            if (pkValue == null) {
                console.error("Null primary key value in non-bulk event", event);
                continue;
            }
        }
        try {
            switch (normalizedEventType) {
                case EventType.CREATE:
                    {
                        const pkValue = event[pkField];
                        const createModel = await lqs.qs.get({ [pkField]: pkValue });
                        lqs.handleExternalCreateEvent(createModel, event.operationId);
                    }
                    break;
                case EventType.UPDATE:
                    {
                        const updatePkValue = event[pkField];
                        const updateModel = await lqs.qs.get({ [pkField]: updatePkValue });
                        lqs.handleExternalUpdateEvent(updateModel, event.operationId);
                    }
                    break;
                case EventType.DELETE:
                    {
                        const deletePkValue = event[pkField];
                        lqs.handleExternalDeleteEvent(deletePkValue, event.operationId);
                    }
                    break;
                case EventType.BULK_UPDATE:
                    {
                        const updatePkFieldName = event.pk_field_name || pkField;
                        await lqs.handleExternalBulkUpdateEvent(event.instances || [], updatePkFieldName, event.operationId);
                    }
                    break;
                case EventType.BULK_DELETE:
                    {
                        const deletePkFieldName = event.pk_field_name || pkField;
                        lqs.handleExternalBulkDeleteEvent(event.instances || [], deletePkFieldName, event.operationId);
                    }
                    break;
            }
        }
        catch (err) {
            console.error(`Error processing ${normalizedEventType} event:`, err);
        }
    }
};
// --------------------
// LiveQuerySet Class
// --------------------

/**
 * LiveQuerySet implementation for live views.
 */
import { OperationsManager } from './operationsManager'; // Import the new OperationsManager

export class LiveQuerySet {
    /**
     * @typedef {Object} LiveQuerySetOptions
     * @property {boolean} [strictMode] - @deprecated Use fixedPageSize instead.
     * @property {boolean} [fixedPageSize] - Fixed page size keeps the page size constant by removing items when new ones are added.
     * @property {function(): string} [operationIdGenerator] - Custom operation ID generator function.
     * @property {string} [customNamespace] - Custom namespace to append to the model name.
     * @property {SerializerOptions} [serializer] - Serializer options.
     * @property {Object} [insertBehavior] - Configuration for insertion behavior
     * @property {'prepend'|'append'} [insertBehavior.local='prepend'] - Where to insert locally created items
     * @property {'prepend'|'append'} [insertBehavior.remote='append'] - Where to insert remotely created items
     * @property {LiveQuerySet} - Parent live queryset from which this is derrived (if any)
     */

    // Update to the constructor to initialize these new options
    constructor(qs, dataArray, options, filterFn, filterConditions, createMetricFn, parent) {
        this.qs = qs;
        this.dataArray = dataArray;
        this.filterFn = filterFn || (() => true);
        this.options = options || {};
        this._serializerOptions = this.options.serializer || {};
        this.originalFilterConditions = filterConditions;
        this.ModelClass = this.qs.ModelClass;
        this.createMetricFn = createMetricFn ? createMetricFn : (value) => ({ value });
        this.parent = parent;
        this.optimisticMetricsApplied = new Set();
        
        // Initialize insertion behavior with defaults
        this.insertBehavior = {
            local: 'prepend', // Default local insertion to prepend (beginning)
            remote: 'append'  // Default remote insertion to append (end)
        };
        
        // Override with user-specified values if provided
        if (this.options.insertBehavior) {
            if (this.options.insertBehavior.local) {
                this.insertBehavior.local = this.options.insertBehavior.local;
            }
            if (this.options.insertBehavior.remote) {
                this.insertBehavior.remote = this.options.insertBehavior.remote;
            }
        }
        
        const modelName = this.ModelClass.modelName;
        const namespaceResolver = defaultNamespaceResolver;
        this.namespace = namespaceResolver(modelName);
        liveQueryRegistry.register(this.namespace, this);
        const eventReceiver = getEventReceiver();
        if (eventReceiver) {
            eventReceiver.subscribe(this.namespace);
        }
        this.activeMetrics = new Map();
        this.callbacks = [];
        this.errorCallbacks = [];

        // Initialize the OperationsManager
        this.operationsManager = new OperationsManager(
            this.dataArray, 
            this._notify.bind(this),
            this.ModelClass
        );
    }

    handleOptimisticMetricUpdates(eventType, updatedArray, originalArray, operationId) {
        // Calculate optimistic updates
        console.log("handleOptimisticMetricUpdate called", eventType, updatedArray, originalArray)
        const metricUpdates = MetricsManager.optimisticUpdate(
            eventType,
            updatedArray,
            originalArray,
            this.activeMetrics,
            operationId
        );

        console.log("metric updates:", metricUpdates)
        
        // Apply the updates if there are any
        if (Object.keys(metricUpdates).length > 0) {
            this.applyOptimisticMetrics(metricUpdates, operationId);
        }
    }

    applyOptimisticMetrics(metricUpdates, operationId) {
        // Skip if this operation has already been processed
        console.log("Apply metrics called", metricUpdates, operationId)
        if (operationId && this.optimisticMetricsApplied.has(operationId)) {
            return;
        }
        
        // Apply updates to this instance
        MetricsManager.applyOptimisticUpdates(metricUpdates, this.activeMetrics);

        console.log("metrics after update", this.activeMetrics)
        
        // Mark this operation as processed
        if (operationId) {
            this.optimisticMetricsApplied.add(operationId);
        }
        
        // Propagate to parent if exists
        if (this.parent) {
            this.parent.applyOptimisticMetrics(metricUpdates, operationId);
        }
    }

    /**
     * Refreshes the LiveQuerySet with a new QuerySet and/or options
     * @param {Object} params - Refresh parameters
     * @param {QuerySet} [params.newQs] - New QuerySet to use
     * @param {LiveQuerySetOptions} [params.newOptions] - New options to use
     * @param {boolean} [params.clearData=true] - Whether to clear the reactive array before refreshing
     * @returns {Promise<void>}
     * @throws {Error} If attempting to refresh with a different model class
     */
    async refresh({ newQs, newOptions, clearData = true } = {}) {
        // Validate model consistency
        if (newQs && newQs.ModelClass !== this.ModelClass) {
            throw new Error('Cannot refresh LiveQuerySet with a different model class');
        }        
        // Clean up other resources
        liveQueryRegistry.unregister(this.namespace, this);
        const eventReceiver = getEventReceiver();
        if (eventReceiver) {
            eventReceiver.unsubscribe(this.namespace);
        }
        
        // Update instance properties
        if (newQs) {
            this.qs = newQs;
            // ModelClass remains the same as validated above
        }
        
        if (newOptions) {
            this.options = { ...this.options, ...newOptions };
            this._serializerOptions = this.options.serializer || {};

            // Update insertion behavior if provided
            if (newOptions.insertBehavior) {
                if (newOptions.insertBehavior.local) {
                    this.insertBehavior.local = newOptions.insertBehavior.local;
                }
                if (newOptions.insertBehavior.remote) {
                    this.insertBehavior.remote = newOptions.insertBehavior.remote;
                }
            }
        }
        
        // Re-calculate namespace and register
        const modelName = this.ModelClass.modelName;
        const namespaceResolver = defaultNamespaceResolver;
        this.namespace = namespaceResolver(modelName);
        liveQueryRegistry.register(this.namespace, this);
        
        // Re-subscribe to events
        const newEventReceiver = getEventReceiver();
        if (newEventReceiver) {
            newEventReceiver.subscribe(this.namespace);
        }
        
        // Refresh filter conditions
        const queryState = this.qs.build();
        this.originalFilterConditions = queryState.filter && queryState.filter.conditions;
        
        if (clearData) {
            // Fetch new data
            const newData = await this.qs.fetch(this._serializerOptions);
            
            // Get primary key field name
            const pkField = this.ModelClass.primaryKeyField || 'id';
            
            // Use the operations manager to completely replace the data
            // Generate a unique operation ID for this refresh
            const refreshOpId = `refresh_${Date.now()}`;
            this.operationsManager.applyMutation(
                refreshOpId,
                (draft) => {
                    draft.length = 0;
                    draft.push(...newData);
                },
                'create'
            );
        }
        
        // Refresh metrics if there were any active
        await this.refreshMetrics();
    }

    /**
     * Register a callback function to be called when the data changes
     * @param {function(string)} callback - Function to call with event type
     * @returns {function()} - Unsubscribe function
     */
    subscribe(callback) {
        this.callbacks.push(callback);
        return () => {
            this.callbacks = this.callbacks.filter(cb => cb !== callback);
        };
    }

    /**
     * Notify all callbacks about a data change event
     * @param {string} eventType - Type of event ('create', 'update', or 'delete')
     * @returns {void} - No longer returns a promise
     */
    _notify(eventType, updatedArray, originalArray, operationId) {
        // Call all callbacks immediately without waiting for refresh to complete
        for (const callback of this.callbacks) {
            callback(eventType, updatedArray, originalArray, operationId);
        }
        // Optimistically update the metrics
        this.handleOptimisticMetricUpdates(eventType, updatedArray, originalArray, operationId);
    }

    /**
     * Register an error handler for any operations on this LiveQuerySet
     * @param {function(Error, string)} errorCallback - Function to call with error and operation type
     * @returns {function()} - Unsubscribe function
     */
    onError(errorCallback) {
        this.errorCallbacks.push(errorCallback);
        return () => {
            this.errorCallbacks = this.errorCallbacks.filter(cb => cb !== errorCallback);
        };
    }

    /**
     * Notify all error callbacks about an error
     * @param {Error} error - The error that occurred
     * @param {string} operation - Type of operation ('create', 'update', 'delete', etc.)
     */
    _notifyError(error, operation) {
        for (const callback of this.errorCallbacks) {
            callback(error, operation);
        }
    }

    /**
     * Returns the current reactive data array.
     * @returns {Array} The data array.
     */
    get data() {
        return this.dataArray;
    }

    /**
     * Destroys this live query by unregistering event handlers.
     */
    destroy() {
        this.activeMetrics.clear();
        this.callbacks = [];
        liveQueryRegistry.unregister(this.namespace, this);
        const eventReceiver = getEventReceiver();
        if (eventReceiver) {
            eventReceiver.unsubscribe(this.namespace);
        }
    }

    /**
     * Fetches the current data based on filter and pagination.
     * @returns {Promise<Array>} A promise resolving to the filtered data array.
     */
    async fetch() {
        let result = this.dataArray.filter(this.filterFn);
        return result;
    }

    /**
     * Filters the LiveQuerySet with additional conditions.
     * @param {Object} conditions - Filter conditions.
     * @returns {LiveQuerySet} A new LiveQuerySet instance with relayed events.
     */
    filter(conditions) {
        // Build a filter function based solely on the new conditions.
        const newFilter = (item) => {
            return Object.entries(conditions).every(([key, value]) => {
                return item[key] === value;
            });
        };
        
        // Create a new QuerySet that is already filtered on the server side.
        const newQs = this.qs.filter(conditions);
        
        // Create the filtered LiveQuerySet
        const filteredLiveQs = new LiveQuerySet(
            newQs, 
            this.dataArray, 
            this.options, 
            newFilter, 
            conditions,
            this.createMetricFn
        );
        
        // Store reference to the original LiveQuerySet
        const originalLiveQs = this;
        
        // Subscribe to the filtered instance's notifications and relay them to the original
        filteredLiveQs.subscribe(eventType => {
            // Directly call the original's _notify method
            originalLiveQs._notify(eventType);
        });
        
        // Also relay error events
        filteredLiveQs.onError((error, operation) => {
            // Directly call the original's _notifyError method
            originalLiveQs._notifyError(error, operation);
        });
        
        return filteredLiveQs;
    }

    /**
     * Deletes items matching the filter.
     * @returns {Promise<void>}
     */
    async delete() {
        if (arguments.length > 0) {
            throw new Error('delete() does not accept arguments and will delete the entire queryset. Use filter() before calling delete() to select elements.');
        }
        
        try {
            return await withOperationId(async (operationId) => {
                // Get the items to be deleted for proper rollback
                const itemsToDelete = this.dataArray.filter(this.filterFn);
                
                if (itemsToDelete.length === 0) {
                    return 0; // Nothing to delete
                }
                
                // Use the operations manager to remove all items matching the filter
                const deletedCount = this.operationsManager.remove(
                    operationId,
                    this.filterFn
                );
                
                // If nothing was deleted, we're done
                if (deletedCount === 0) {
                    return 0;
                }
                
                try {
                    // Execute delete operation on the server and ensure we await it
                    const result = await this.qs.executeQuery(Object.assign({}, this.qs.build(), {
                        type: 'delete',
                        operationId,
                        namespace: this.namespace
                    }));
                    
                    // Verify the delete was successful
                    if (!result || result.error) {
                        throw new Error(result?.error || 'Delete failed');
                    }
                    
                    return deletedCount;
                } catch (error) {
                    // Rollback using the operations manager
                    this._notifyError(error, 'delete');
                    this.operationsManager.rollback(operationId);
                    
                    // Re-throw to be caught by the outer try/catch
                    throw error;
                }
            });
        } catch (error) {
            // Re-throw for anyone awaiting
            throw error;
        }
    }

    /**
     * Creates a new item.
     * @param {Object} item - The item data.
     * @returns {Promise<Object>} The created item.
     */
    async create(item) {
        return await withOperationId(async (operationId) => {
            const optimisticItem = Object.assign({}, item, { id: operationId });
            
            // Use operations manager to insert the optimistic item
            this.operationsManager.insert(
                operationId, 
                optimisticItem, 
                {
                    position: this.insertBehavior.local,
                    limit: this._serializerOptions?.limit,
                    fixedPageSize: this.options.fixedPageSize || this.options.strictMode
                }
            );
            
            try {
                const result = await this.qs.executeQuery({
                    type: 'create',
                    data: item,
                    operationId,
                    namespace: this.namespace
                });
                
                const createdItem = new this.ModelClass(result.data);
                const pkField = this.ModelClass.primaryKeyField || 'id';
                
                // Update the temporary item with the real one
                const updateSuccess = this.operationsManager.update(
                    `${operationId}_update`,
                    item => item[pkField] === operationId,
                    createdItem
                );
                
                return createdItem;
            }
            catch (error) {
                this._notifyError(error, 'create');
                
                // Roll back the optimistic update
                this.operationsManager.rollback(operationId);
                
                throw error;
            }
        });
    }

    /**
 * Updates items matching the filter.
 * @param {Object} updates - Update data.
 * @returns {Promise<Array>} The updated items.
 */
async update(updates) {    
    if (arguments.length > 1) {
        throw new Error('Update accepts only accepts an object of the updates to apply. Use filter() before calling update() to select elements.');
    }
    
    return await withOperationId(async (operationId) => {        
        // Log current state before update
        const preUpdateItems = this.dataArray.filter(this.filterFn);
        const updateCount = this.operationsManager.update(
            operationId,
            this.filterFn,
            updates
        );
        
        // If no items were updated, we can return early
        if (updateCount === 0) {
            return [];
        }
        try {
            // Build the query
            const queryParams = Object.assign({}, this.qs.build(), {
                type: 'update',
                data: updates,
                operationId,
                namespace: this.namespace
            });
            
            // Execute the query
            const result = await this.qs.executeQuery(queryParams);
            
            // Ensure the update was successful
            if (!result || result.error) {
                throw new Error(result?.error || 'Update failed');
            }
            
            // Get the final updated items
            const updatedItems = this.dataArray.filter(this.filterFn);
            
            return updatedItems;
        }
        catch (error) {
            this._notifyError(error, 'update');
            const rollbackResult = this.operationsManager.rollback(operationId);            
            throw error;
        }
    });
}

/**
     * Returns a single object matching the filter conditions from the cached data.
     * If not found, fetches from the backend.
     * @param {Object} [filters] - Filter conditions.
     * @returns {Promise<Object>} The matching object.
     * @throws {MultipleObjectsReturned} If more than one object is found.
     */
async get(filters) {
    let results = await this.fetch();
    if (filters) {
        results = results.filter(item => Object.entries(filters).every(([key, value]) => item[key] === value));
    }
    if (results.length === 1) {
        return results[0];
    }
    else if (results.length > 1) {
        throw new MultipleObjectsReturned('get() returned more than one object.');
    }
    
    const freshItem = await this.qs.get(filters);
    const pkField = this.ModelClass.primaryKeyField || 'id';
    
    if (this.filterFn(freshItem)) {
        const exists = this.dataArray.find(item => item[pkField] === freshItem[pkField]);
        if (!exists) {
            // Use the operations manager to add the item
            const operationId = `get_${Date.now()}`;
            this.operationsManager.insert(
                operationId,
                freshItem,
                {
                    position: this.insertBehavior.remote,
                    limit: this._serializerOptions?.limit,
                    fixedPageSize: this.options.fixedPageSize || this.options.strictMode
                }
            );
        }
    }
    
    return freshItem;
}

/**
 * Handles a bulk update event from the server.
 * @param {Array<string|number>} instanceIds - Array of primary key values.
 * @param {string} [pkField] - Primary key field name.
 * @returns {Promise<void>}
 */
async handleExternalBulkUpdateEvent(instanceIds, pkField = this.ModelClass.primaryKeyField, operationId) {
    if (!instanceIds || instanceIds.length === 0) {
      return;
    }
    
    try {
      // Fetch all updated instances
      const filterCondition = {};
      filterCondition[`${pkField}__in`] = instanceIds;
      const updatedInstances = await this.qs.filter(filterCondition).fetch();
      
      if (!updatedInstances || updatedInstances.length === 0) {
        console.warn('No instances found for bulk update event with IDs:', instanceIds);
        return;
      }
      
      const updatedMap = new Map(updatedInstances.map(instance => [instance[pkField], instance]));
      
      // Update existing items
      this.operationsManager.applyMutation(
        operationId,
        (draft) => {
          // Update existing items and collect PKs of items not found in the draft
          const notFoundPKs = new Set(updatedMap.keys());
          
          for (let i = 0; i < draft.length; i++) {
            const pkValue = draft[i][pkField];
            const updatedInstance = updatedMap.get(pkValue);
            
            if (updatedInstance) {
              Object.assign(draft[i], updatedInstance);
              notFoundPKs.delete(pkValue);
            }
          }
          
          // Get instances that weren't found in the draft
          const newInstances = Array.from(notFoundPKs).map(pk => updatedMap.get(pk));
          
          // If we have new instances, handle them as a bulk create
          if (newInstances.length > 0) {
            this.handleExternalBulkCreateEvent(newInstances);
          }
        },
        'update'
      );
    }
    catch (err) {
      console.error('Error handling bulk update event:', err);
    }
  }

    /**
     * Handles a bulk create event from the server.
     * @param {Array} items - Array of new items.
     */
    handleExternalBulkCreateEvent(items, operationId) {
        if (!items || items.length === 0) {
            return;
        }
        
        // Filter items that match the filter function
        const filteredItems = items.filter(this.filterFn);
        
        if (filteredItems.length === 0) {
            return; // No items match the filter
        }
        
        // Use the operations manager to insert the items
        this.operationsManager.insert(
            operationId,
            filteredItems,
            {
                position: this.insertBehavior.remote,
                limit: this._serializerOptions?.limit,
                fixedPageSize: this.options.fixedPageSize || this.options.strictMode
            }
        );
    }

    /**
     * Handles a bulk delete event from the server.
     * @param {Array<string|number>} instanceIds - Array of primary key values.
     * @param {string} [pkField] - Primary key field name.
     */
    handleExternalBulkDeleteEvent(instanceIds, pkField = this.ModelClass.primaryKeyField, operationId) {
        if (!instanceIds || instanceIds.length === 0) {
            return;
        }
        
        const deletedIdsSet = new Set(instanceIds);
        
        // Use the operations manager to remove items with matching IDs
        this.operationsManager.remove(
            operationId,
            item => deletedIdsSet.has(item[pkField])
        );
    }

    /**
     * Handles an external create event.
     * @param {Object} item - The created item.
     */
    handleExternalCreateEvent(item, operationId) {
        // Skip if the item was created by an active operation
        if (item.operationId && activeOperationIds.has(item.operationId)) {
            return;
        }
        
        // Skip if the item doesn't match our filter
        if (!this.filterFn(item)) {
            return;
        }
        
        const pkField = this.ModelClass.primaryKeyField || 'id';
        
        // Check if item already exists (could be an update)
        const existingIndex = this.dataArray.findIndex(x => x[pkField] === item[pkField]);
        
        if (existingIndex !== -1) {
            // If already exists, treat as an update
            this.handleExternalUpdateEvent(item);
            return;
        }
        
        // Insert the new item
        this.operationsManager.insert(
            operationId,
            item,
            {
                position: this.insertBehavior.remote,
                limit: this._serializerOptions?.limit,
                fixedPageSize: this.options.fixedPageSize || this.options.strictMode
            }
        );
    }

    /**
     * Handles an external update event.
     * @param {Object} item - The updated item.
     */
    handleExternalUpdateEvent(item, operationId) {
        if (item.operationId && activeOperationIds.has(item.operationId)) {
            return;
        }
        
        const pkField = this.ModelClass.primaryKeyField || 'id';
        
        // Check if the item exists in our collection
        const index = this.dataArray.findIndex(x => x[pkField] === item[pkField]);
        
        if (index !== -1) {
            // Update the existing item
            this.operationsManager.update(
                operationId,
                x => x[pkField] === item[pkField],
                item
            );
        } else if (this.filterFn(item)) {
            // Item doesn't exist but matches our filter, add it
            this.handleExternalCreateEvent(item);
        }
    }

    /**
     * Handles an external delete event.
     * @param {number|string} itemId - The primary key value of the deleted item.
     */
    handleExternalDeleteEvent(itemId, operationId) {
        if (activeOperationIds.has(itemId)) {
            return;
        }
        
        const pkField = this.ModelClass.primaryKeyField || 'id';

        // Remove the item with the given ID
        this.operationsManager.remove(
            operationId,
            item => item[pkField] === itemId
        );
    }

    /**
     * Returns the first object from the live view.
     * @returns {Promise<Object|null>} The first object or null.
     */
        async first() {
            const results = await this.fetch();
            return results.length > 0 ? results[0] : null;
        }

    /**
     * Returns the last object from the live view.
     * @returns {Promise<Object|null>} The last object or null.
     */
    async last() {
        const results = await this.fetch();
        return results.length > 0 ? results[results.length - 1] : null;
    }

    /**
     * Refreshes all active metrics.
     * @returns {Promise<void>}
     */
    async refreshMetrics() {
        return MetricsManager.refreshMetrics(this.qs, this.activeMetrics);
    }

    /**
     * Returns the count metric.
     * @param {string} [field] - Field to count.
     * @returns {Promise<MetricResult>} The count metric.
     */
    async count(field) {
        return MetricsManager.count(this.qs, this.activeMetrics, this.createMetricFn, field);
    }

    /**
     * Returns the sum metric.
     * @param {string} field - Field to sum.
     * @returns {Promise<MetricResult>} The sum metric.
     */
    async sum(field) {
        return MetricsManager.sum(this.qs, this.activeMetrics, this.createMetricFn, field);
    }

    /**
     * Returns the average metric.
     * @param {string} field - Field to average.
     * @returns {Promise<MetricResult>} The average metric.
     */
    async avg(field) {
        return MetricsManager.avg(this.qs, this.activeMetrics, this.createMetricFn, field);
    }

    /**
     * Returns the minimum metric.
     * @param {string} field - Field to find the minimum.
     * @returns {Promise<MetricResult>} The minimum metric.
     */
    async min(field) {
        return MetricsManager.min(this.qs, this.activeMetrics, this.createMetricFn, field);
    }

    /**
     * Returns the maximum metric.
     * @param {string} field - Field to find the maximum.
     * @returns {Promise<MetricResult>} The maximum metric.
     */
    async max(field) {
        return MetricsManager.max(this.qs, this.activeMetrics, this.createMetricFn, field);
    }
}
// --------------------
// Live QuerySet Factory Functions
// --------------------
/**
 * Creates a LiveQuerySet with the given reactive array.
 * @param {QuerySet} qs - The QuerySet.
 * @param {Array} reactiveArray - Reactive array for data.
 * @param {LiveQuerySetOptions} [options] - Options for live view.
 * @param {function(value: any): MetricResult} [createMetricFn] - Function to create metric results.
 * @returns {Promise<LiveQuerySet>} A promise resolving to a LiveQuerySet.
 */
export async function liveView(qs, reactiveArray, options, createMetricFn) {
    qs = qs;
    const backendKey = qs.modelClass.configKey;
    if (!backendKey) {
        throw new Error(`No configKey found on model class ${qs.modelClass.modelName}`);
    }
    const customNamespace = options && options.customNamespace;
    const namespaceResolver = (modelName) => customNamespace ? `${modelName}::${customNamespace}` : modelName;
    const eventReceiver = getEventReceiver();
    if (!eventReceiver) {
        const receiver = initializeEventReceiver(backendKey);
        if (receiver) {
            receiver.setNamespaceResolver(namespaceResolver);
            receiver.addEventHandler(handleModelEvent);
        }
    }
    else {
        setNamespaceResolver(namespaceResolver);
    }
    const queryState = qs.build();
    const initialData = await qs.fetch(options?.serializer || {});
    if (reactiveArray.length === 0 && initialData.length > 0) {
        reactiveArray.push(...initialData);
    }
    return new LiveQuerySet(qs, reactiveArray, options, undefined, queryState.filter && queryState.filter.conditions, createMetricFn);
}
/**
 * Backward compatibility function for existing code.
 * @deprecated Use liveView with an explicit array instead.
 * @param {QuerySet} qs - The QuerySet.
 * @param {LiveQuerySetOptions} [options] - Options.
 * @returns {Promise<LiveQuerySet>} A promise resolving to a LiveQuerySet.
 */
export async function legacyLiveView(qs, options) {
    const dataArray = [];
    return liveView(qs, dataArray, options);
}
// --------------------
// Axios Interceptor & QuerySet Override
// --------------------
// Axios interceptor for operation IDs
axios.interceptors.request.use((config) => {
    if (activeOperationIds.size > 0) {
        let operationId = config.data && config.data.ast && config.data.ast.query && config.data.ast.query.operationId;
        if (!operationId) {
            operationId = activeOperationIds.values().next().value;
        }
        config.headers = config.headers || {};
        config.headers['X-Operation-ID'] = operationId;
    }
    return config;
});
// Override QuerySet.prototype.executeQuery to add an operationId if one does not exist.
const originalExecuteQuery = QuerySet.prototype.executeQuery;
QuerySet.prototype.executeQuery = async function (query) {
    if (activeOperationIds.size > 0 && !query.operationId) {
        query.operationId = activeOperationIds.values().next().value;
    }
    return originalExecuteQuery.call(this, query);
};