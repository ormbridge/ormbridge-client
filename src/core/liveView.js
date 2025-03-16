import { QuerySet } from "../flavours/django/querySet.js";
import { Model } from "../flavours/django/model.js";
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { EventType, getEventReceiver, setEventReceiver, setNamespaceResolver,
// NamespaceResolver is a function type
 } from './eventReceivers.js';
import { initializeEventReceiver } from '../config.js';
import { MultipleObjectsReturned, DoesNotExist } from "../flavours/django/errors.js";
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
                        lqs.handleExternalCreateEvent(createModel);
                    }
                    break;
                case EventType.UPDATE:
                    {
                        const updatePkValue = event[pkField];
                        const updateModel = await lqs.qs.get({ [pkField]: updatePkValue });
                        lqs.handleExternalUpdateEvent(updateModel);
                    }
                    break;
                case EventType.DELETE:
                    {
                        const deletePkValue = event[pkField];
                        lqs.handleExternalDeleteEvent(deletePkValue);
                    }
                    break;
                case EventType.BULK_UPDATE:
                    {
                        const updatePkFieldName = event.pk_field_name || pkField;
                        await lqs.handleExternalBulkUpdateEvent(event.instances || [], updatePkFieldName);
                    }
                    break;
                case EventType.BULK_DELETE:
                    {
                        const deletePkFieldName = event.pk_field_name || pkField;
                        lqs.handleExternalBulkDeleteEvent(event.instances || [], deletePkFieldName);
                    }
                    break;
            }
            await lqs.refreshMetrics();
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
 * Helper function to handle item insertion logic consistently across the class
 * 
 * @param {Array} dataArray - The array to insert items into
 * @param {Array|Object} items - Single item or array of items to insert
 * @param {'prepend'|'append'} position - Where to insert items (beginning or end)
 * @param {Object} options - Additional options
 * @param {number} [options.limit] - Maximum number of items
 * @param {boolean} [options.fixedPageSize] - Whether to maintain fixed page size
 * @param {boolean} [options.strictMode] - Legacy option for fixed page size
 * @param {Function} notifyCallback - Function to call to notify of changes
 * @returns {boolean} - Whether any items were actually inserted
 */
function handleItemInsertion(dataArray, items, position, options, notifyCallback) {
    // Convert single item to array for consistent handling
    const itemsArray = Array.isArray(items) ? items : [items];
    if (itemsArray.length === 0) return false;
    
    const limit = options.limit;
    const hasFixedSize = options.fixedPageSize || options.strictMode;
    
    // If we're appending and at limit with fixed size, don't add new items
    if (position === 'append' && limit !== undefined && hasFixedSize && dataArray.length >= limit) {
        return false;
    }
    
    // For prepend with fixed size, make room by removing from the end
    if (position === 'prepend' && limit !== undefined && hasFixedSize) {
        const availableSpace = Math.max(0, limit - dataArray.length);
        
        if (availableSpace === 0) {
            // Remove items from the end to make space for new ones
            const itemsToRemove = Math.min(itemsArray.length, dataArray.length);
            dataArray.splice(dataArray.length - itemsToRemove);
            notifyCallback('delete');
        } else if (itemsArray.length > availableSpace) {
            // Remove just enough items from the end
            dataArray.splice(dataArray.length - (itemsArray.length - availableSpace));
            notifyCallback('delete');
        }
    }
    
    // Insert the items according to position
    if (position === 'prepend') {
        // Add items to the beginning
        dataArray.unshift(...itemsArray);
    } else {
        // Add items to the end, respecting the limit
        if (limit !== undefined && !hasFixedSize) {
            const remainingSpace = limit - dataArray.length;
            if (remainingSpace > 0) {
                // Only add up to the remaining space
                dataArray.push(...itemsArray.slice(0, remainingSpace));
            } else {
                return false; // No space left
            }
        } else {
            // No limit or has fixed size, add all items
            dataArray.push(...itemsArray);
        }
    }
    
    notifyCallback('create');
    return true;
}

/**
 * LiveQuerySet implementation for live views.
 */
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
     */

    // Update to the constructor to initialize these new options
    constructor(qs, dataArray, options, filterFn, filterConditions) {
        this.qs = qs;
        this.dataArray = dataArray;
        this.filterFn = filterFn || (() => true);
        this.options = options || {};
        this._serializerOptions = this.options.serializer || {};
        this.offset = this._serializerOptions.offset || 0;
        this.limit = this._serializerOptions.limit;
        this.originalFilterConditions = filterConditions;
        this.ModelClass = this.qs.ModelClass;
        
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
        
        // Clear the data array if requested
        if (clearData) {
        this.dataArray.length = 0;
        }
        
        // Update instance properties
        if (newQs) {
        this.qs = newQs;
        // ModelClass remains the same as validated above
        }
        
        if (newOptions) {
        this.options = { ...this.options, ...newOptions };
        this._serializerOptions = this.options.serializer || {};
        this.offset = this._serializerOptions.offset || 0;
        this.limit = this._serializerOptions.limit;
        
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
        
        // Fetch and populate data if array was cleared
        if (clearData) {
        const initialData = await this.qs.fetch(this.options || {});
        if (initialData.length > 0) {
            this.dataArray.push(...initialData);
            this._notify('create');
        }
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
     */
    _notify(eventType) {
        for (const callback of this.callbacks) {
            callback(eventType);
        }
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
        return this.dataArray.filter(this.filterFn);
    }
    /**
     * Filters the LiveQuerySet with additional conditions.
     * @param {Object} conditions - Filter conditions.
     * @returns {LiveQuerySet} A new LiveQuerySet instance.
     */
    filter(conditions) {
        const newFilter = (item) => {
            return Object.entries(conditions).every(([key, value]) => {
                if (key.includes("__")) {
                    const parts = key.split("__");
                    let result = item;
                    for (const part of parts) {
                        if (result && part in result) {
                            result = result[part];
                        }
                        else {
                            throw new Error(`LiveQuerySet filter error: Property "${key}" not available on item ${JSON.stringify(item)}.`);
                        }
                    }
                    return result === value;
                }
                return item[key] === value;
            });
        };
        const composedFilter = (item) => this.filterFn(item) && newFilter(item);
        const newQs = this.qs.filter(conditions);
        const combinedFilterConditions = Object.assign({}, this.originalFilterConditions, conditions);
        return new LiveQuerySet(newQs, this.dataArray, this.options, composedFilter, combinedFilterConditions);
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
            await withOperationId(async (operationId) => {
                // Store deleted items for potential rollback
                const deletedItems = [];
                const deletedIndexes = [];
                
                // Remove matching items and keep track of them
                for (let i = this.dataArray.length - 1; i >= 0; i--) {
                    if (this.filterFn(this.dataArray[i])) {
                        deletedItems.unshift(this.dataArray[i]); // Add to front to maintain original order
                        deletedIndexes.unshift(i);               // Store the original index
                        this.dataArray.splice(i, 1);
                        this._notify('delete');
                    }
                }
                
                // If nothing was deleted, we're done
                if (deletedItems.length === 0) {
                    return;
                }
                
                try {
                    // Execute delete operation on the server
                    await this.qs.executeQuery(Object.assign({}, this.qs.build(), {
                        type: 'delete',
                        operationId,
                        namespace: this.namespace
                    }));
                    await this.refreshMetrics();
                } catch (error) {
                    // Rollback: restore deleted items to their original positions
                    this._notifyError(error, 'delete');
                    for (let i = 0; i < deletedItems.length; i++) {
                        const index = deletedIndexes[i];
                        // If index is beyond current array length, simply push to end
                        if (index >= this.dataArray.length) {
                            this.dataArray.push(deletedItems[i]);
                        } else {
                            // Otherwise, insert at original position
                            this.dataArray.splice(index, 0, deletedItems[i]);
                        }
                        this._notify('create'); // Notify about the restored item
                    }
                    
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
            const tempId = `temp_${Date.now()}`;
            const optimisticItem = Object.assign({}, item, { id: tempId });
            
            // Use the helper function for inserting optimistic item
            handleItemInsertion(
                this.dataArray, 
                optimisticItem, 
                this.insertBehavior.local, 
                {
                    limit: this.limit,
                    fixedPageSize: this.options.fixedPageSize,
                    strictMode: this.options.strictMode
                },
                this._notify.bind(this)
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
                const index = this.dataArray.findIndex(x => x[pkField] === tempId);
                if (index !== -1) {
                    this.dataArray[index] = createdItem;
                    this._notify('update');
                }
                await this.refreshMetrics();
                return createdItem;
            }
            catch (error) {
                this._notifyError(error, 'create');
                const tempIndex = this.dataArray.findIndex(x => x.id === tempId);
                if (tempIndex !== -1) {
                    this.dataArray.splice(tempIndex, 1);
                    this._notify('delete');
                }
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
        if (arguments.length > 1){
            throw new Error('Update accepts only accepts an object of the updates to apply. Use filter() before calling update() to select elements.');
        }
        return await withOperationId(async (operationId) => {
            const affectedIndexes = [];
            const originals = new Map();
            for (let i = 0; i < this.dataArray.length; i++) {
                const item = this.dataArray[i];
                if (this.filterFn(item)) {
                    affectedIndexes.push(i);
                    originals.set(i, Object.assign({}, item));
                    Object.assign(this.dataArray[i], updates);
                    this._notify('update');
                }
            }
            try {
                await this.qs.executeQuery(Object.assign({}, this.qs.build(), {
                    type: 'update',
                    data: updates,
                    operationId,
                    namespace: this.namespace
                }));
                await this.refreshMetrics();
            }
            catch (error) {
                this._notifyError(error, 'update');
                for (const i of affectedIndexes) {
                    const originalItem = originals.get(i);
                    if (originalItem) {
                        this.dataArray[i] = originalItem;
                        this._notify('update');
                    }
                }
                throw error;
            }
            return this.dataArray.filter(this.filterFn);
        });
    }
    /**
     * Refreshes all active metrics.
     * @returns {Promise<void>}
     */
    async refreshMetrics() {
        if (this.activeMetrics.size === 0) {
            return;
        }
        const refreshPromises = [];
        for (const [key, metric] of this.activeMetrics.entries()) {
            const [type, field] = key.split(':');
            const refreshPromise = (async () => {
                try {
                    let newValue;
                    const oldValue = metric.value;
                    switch (type) {
                        case 'count':
                            newValue = await this.qs.count(field || undefined);
                            break;
                        case 'sum':
                            newValue = await this.qs.sum(field);
                            break;
                        case 'avg':
                            newValue = await this.qs.avg(field);
                            break;
                        case 'min':
                            newValue = await this.qs.min(field);
                            break;
                        case 'max':
                            newValue = await this.qs.max(field);
                            break;
                    }
                    if (newValue !== undefined) {
                        metric.value = newValue;
                    }
                }
                catch (error) {
                    console.error(`Error refreshing metric ${key}:`, error);
                }
            })();
            refreshPromises.push(refreshPromise);
        }
        await Promise.all(refreshPromises);
    }
    /**
     * Handles a bulk update event from the server.
     * @param {Array<string|number>} instanceIds - Array of primary key values.
     * @param {string} [pkField] - Primary key field name.
     * @returns {Promise<void>}
     */
    async handleExternalBulkUpdateEvent(instanceIds, pkField = this.ModelClass.primaryKeyField) {
        if (!instanceIds || instanceIds.length === 0) {
            return;
        }
        try {
            const filterCondition = {};
            filterCondition[`${pkField}__in`] = instanceIds;
            const updatedInstances = await this.qs.filter(filterCondition).fetch();
            if (!updatedInstances || updatedInstances.length === 0) {
                console.warn('No instances found for bulk update event with IDs:', instanceIds);
                return;
            }
            const updatedMap = new Map();
            for (const instance of updatedInstances) {
                const pkValue = instance[pkField];
                updatedMap.set(pkValue, instance);
            }
            for (let i = 0; i < this.dataArray.length; i++) {
                const item = this.dataArray[i];
                const pkValue = item[pkField];
                const updatedInstance = updatedMap.get(pkValue);
                if (updatedInstance) {
                    Object.assign(this.dataArray[i], updatedInstance);
                    this._notify('update');
                    updatedMap.delete(pkValue);
                }
            }
            const newItems = [];
            for (const [pkValue, instance] of updatedMap.entries()) {
                if (this.filterFn(instance)) {
                    newItems.push(instance);
                }
            }
            if (newItems.length > 0) {
                this.handleExternalBulkCreateEvent(newItems);
            }
        }
        catch (err) {
            console.error('Error handling bulk update event:', err);
        }
    }
    /**
     * Handles a bulk create event from the server.
     * @param {Array} items - Array of new items.
     */
    handleExternalBulkCreateEvent(items) {
        if (!items || items.length === 0) {
            return;
        }
        
        const filteredItems = items.filter(this.filterFn);
        if (filteredItems.length === 0) {
            return;
        }
        
        handleItemInsertion(
            this.dataArray,
            filteredItems,
            this.insertBehavior.remote,
            {
                limit: this.limit,
                fixedPageSize: this.options.fixedPageSize,
                strictMode: this.options.strictMode
            },
            this._notify.bind(this)
        );
    }
    /**
     * Handles a bulk delete event from the server.
     * @param {Array<string|number>} instanceIds - Array of primary key values.
     * @param {string} [pkField] - Primary key field name.
     */
    handleExternalBulkDeleteEvent(instanceIds, pkField = this.ModelClass.primaryKeyField) {
        if (!instanceIds || instanceIds.length === 0) {
            return;
        }
        const deletedIdsSet = new Set(instanceIds);
        const filteredArray = this.dataArray.filter(item => {
            const pkValue = item[pkField];
            return !deletedIdsSet.has(pkValue);
        });
        this.dataArray.length = 0;
        this.dataArray.push(...filteredArray);
        this._notify('delete');;
    }
    /**
     * Handles an external create event.
     * @param {Object} item - The created item.
     * @param {boolean} [shouldApplyFilters=true] - Whether to apply filters.
     */
    handleExternalCreateEvent(item, shouldApplyFilters = true) {
        if (item.operationId && activeOperationIds.has(item.operationId)) {
            return;
        }
        
        if (shouldApplyFilters && this.originalFilterConditions) {
            for (const [key, value] of Object.entries(this.originalFilterConditions)) {
                if (key.includes("__")) {
                    const parts = key.split("__");
                    let result = item;
                    for (const part of parts) {
                        if (result && part in result) {
                            result = result[part];
                        }
                        else {
                            return;
                        }
                    }
                    if (result !== value)
                        return;
                }
                else if (item[key] !== value) {
                    return;
                }
            }
        }
        
        const pkField = this.ModelClass.primaryKeyField;
        const existingIndex = this.dataArray.findIndex(x => x[pkField] === item[pkField]);
        
        if (existingIndex !== -1) {
            this.handleExternalUpdateEvent(item);
            return;
        }
        
        // Check if we're at or beyond our limit and using the append behavior
        // In that case, we don't add the item since it would be beyond the visible range
        if (this.insertBehavior.remote === 'append' && 
            this.limit !== undefined && 
            this.dataArray.length >= (this.limit - this.offset)) {
            return;
        }
        
        handleItemInsertion(
            this.dataArray,
            item,
            this.insertBehavior.remote,
            {
                limit: this.limit,
                fixedPageSize: this.options.fixedPageSize,
                strictMode: this.options.strictMode
            },
            this._notify.bind(this)
        );
    }
    /**
     * Handles an external update event.
     * @param {Object} item - The updated item.
     */
    handleExternalUpdateEvent(item) {
        if (item.operationId && activeOperationIds.has(item.operationId)) {
            return;
        }
        const pkField = this.ModelClass.primaryKeyField || 'id';
        const index = this.dataArray.findIndex(x => x[pkField] === item[pkField]);
        if (index !== -1) {
            Object.assign(this.dataArray[index], item);
            this._notify('update');
        }
        else {
            this.handleExternalCreateEvent(item);
        }
    }
    /**
     * Handles an external delete event.
     * @param {number|string} itemId - The primary key value of the deleted item.
     */
    handleExternalDeleteEvent(itemId) {
        if (activeOperationIds.has(itemId)) {
            return;
        }
        const pkField = this.ModelClass.primaryKeyField || 'id';
        const index = this.dataArray.findIndex(x => x[pkField] === itemId);
        if (index !== -1) {
            this.dataArray.splice(index, 1);
            this._notify('delete');
        }
    }
    /**
     * Returns the count metric.
     * @param {string} [field] - Field to count.
     * @returns {Promise<MetricResult>} The count metric.
     */
    async count(field) {
        const value = await this.qs.count(field);
        const metricKey = `count:${String(field || '')}`;
        const result = { value };
        this.activeMetrics.set(metricKey, result);
        return result;
    }
    /**
     * Returns the sum metric.
     * @param {string} field - Field to sum.
     * @returns {Promise<MetricResult>} The sum metric.
     */
    async sum(field) {
        const value = await this.qs.sum(field);
        const metricKey = `sum:${String(field)}`;
        const result = { value };
        this.activeMetrics.set(metricKey, result);
        return result;
    }
    /**
     * Returns the average metric.
     * @param {string} field - Field to average.
     * @returns {Promise<MetricResult>} The average metric.
     */
    async avg(field) {
        const value = await this.qs.avg(field);
        const metricKey = `avg:${String(field)}`;
        const result = { value };
        this.activeMetrics.set(metricKey, result);
        return result;
    }
    /**
     * Returns the minimum metric.
     * @param {string} field - Field to find the minimum.
     * @returns {Promise<MetricResult>} The minimum metric.
     */
    async min(field) {
        const value = await this.qs.min(field);
        const metricKey = `min:${String(field)}`;
        const result = { value };
        this.activeMetrics.set(metricKey, result);
        return result;
    }
    /**
     * Returns the maximum metric.
     * @param {string} field - Field to find the maximum.
     * @returns {Promise<MetricResult>} The maximum metric.
     */
    async max(field) {
        const value = await this.qs.max(field);
        const metricKey = `max:${String(field)}`;
        const result = { value };
        this.activeMetrics.set(metricKey, result);
        return result;
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
                this.dataArray.push(freshItem);
                this._notify('create');
            }
        }
        return freshItem;
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
}
// --------------------
// Live QuerySet Factory Functions
// --------------------
/**
 * Creates a LiveQuerySet with the given reactive array.
 * @param {QuerySet} qs - The QuerySet.
 * @param {Array} reactiveArray - Reactive array for data.
 * @param {LiveQuerySetOptions} [options] - Options for live view.
 * @returns {Promise<LiveQuerySet>} A promise resolving to a LiveQuerySet.
 */
export async function liveView(qs, reactiveArray, options) {
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
    const initialData = await qs.fetch(options.serializer || {});
    if (reactiveArray.length === 0 && initialData.length > 0) {
        reactiveArray.push(...initialData);
    }
    return new LiveQuerySet(qs, reactiveArray, options, undefined, queryState.filter && queryState.filter.conditions);
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