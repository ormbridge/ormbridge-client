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
import { updateArrayInPlace } from './utils.js';
import { OperationsManager } from "./operationsManager";
import { OverfetchCache } from "./overfetchCache.js";

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
  return "op_" + uuidv4();
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

export const handleModelEvent = async (event) => {
  // Destructure and normalize event properties
  const {
    operationId,
    operation_id,
    type,
    event: evt,
    namespace,
    model,
    pk_field_name,
    instances,
  } = event;
  event.operationId = operationId || operation_id;
  const eventType = type || evt;

  // Validate essential properties
  if (!eventType) {
    console.error("Event received with no type/event field:", event);
    return;
  }
  if (!namespace) {
    console.warn("Event received with no namespace:", event);
    return;
  }

  // Normalize the event type using a mapping
  const typeMap = {
    create: EventType.CREATE,
    update: EventType.UPDATE,
    delete: EventType.DELETE,
    bulk_update: EventType.BULK_UPDATE,
    bulk_delete: EventType.BULK_DELETE,
  };
  const normalizedEventType = typeMap[eventType] || eventType;
  if (!Object.values(EventType).includes(normalizedEventType)) {
    console.warn(`Unknown event type: ${eventType}`);
    return;
  }

  // Retrieve LiveQuerySets for the given namespace
  const liveQuerySets = liveQueryRegistry.getForNamespace(namespace);
  if (liveQuerySets.size === 0) return;

  // Ensure an operation ID exists for deduplication
  if (!event.operationId) {
    event.operationId = generateOperationId();
  }

  // Process the event for each relevant LiveQuerySet
  for (const lqs of liveQuerySets) {
    if (lqs.ModelClass.modelName !== model) continue;

    // Refresh metrics in every queryset, because they are usually different; log errors if any
    lqs.refreshMetrics(event.operationId).catch((error) =>
      console.error("Error refreshing metrics:", error)
    );

    // Notify the overfetch cache about this event first
    if (lqs.overfetchCache) {
      try {        
        // Get the relevant primary key(s)
        const pkField = lqs.ModelClass.primaryKeyField;
        const pkValues = instances || event[pkField];
        
        // Handle the event in the cache
        lqs.overfetchCache.handleModelEvent(event.type, pkValues);
      } catch (error) {
        console.error("Error handling model event in overfetch cache:", error);
      }
    }

    // Skip handling if this event was initiated by this operation
    if (activeOperationIds.has(event.operationId)) continue;

    // Skip handling if this is not the root liveqs
    if (lqs.parent) continue;

    const pkField = lqs.ModelClass.primaryKeyField;
    const isBulkEvent = [EventType.BULK_UPDATE, EventType.BULK_DELETE].includes(
      normalizedEventType
    );

    // Validate bulk events have a proper instances array
    if (isBulkEvent && (!instances || !Array.isArray(instances))) {
      console.error(
        `Invalid ${normalizedEventType} event: missing instances array`,
        event
      );
      continue;
    }

    try {
      switch (normalizedEventType) {
        case EventType.CREATE: {
          const pkValue = event[pkField];
          const createModel = await lqs.qs.get({ [pkField]: pkValue });
          lqs.handleExternalCreateEvent(createModel, event.operationId);
          break;
        }
        case EventType.UPDATE: {
          const pkValue = event[pkField];
          const updateModel = await lqs.qs.first({ [pkField]: pkValue });
          lqs.handleExternalUpdateEvent(updateModel, event.operationId, pkValue);
          break;
        }
        case EventType.DELETE: {
          const pkValue = event[pkField];
          lqs.handleExternalDeleteEvent(pkValue, event.operationId);
          break;
        }
        case EventType.BULK_UPDATE: {
          const fieldName = pk_field_name || pkField;
          await lqs.handleExternalBulkUpdateEvent(instances, fieldName, event.operationId);
          break;
        }
        case EventType.BULK_DELETE: {
          const fieldName = pk_field_name || pkField;
          lqs.handleExternalBulkDeleteEvent(instances, fieldName, event.operationId);
          break;
        }
      }
    } catch (err) {
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
  constructor(
    qs,
    dataArray,
    options,
    filterFn,
    filterConditions,
    createMetricFn,
    parent,
    createdItems,

  ) {
    this.qs = qs;
    this.dataArray = dataArray;
    this.createdItems = createdItems || new Set();
    this.filterFn = filterFn || (() => true);
    this.options = options || {};
    this._serializerOptions = this.options.serializer || {};
    this.originalFilterConditions = filterConditions;
    this.ModelClass = this.qs.ModelClass;
    this.createMetricFn = createMetricFn
      ? createMetricFn
      : (value) => ({ value });
    this.parent = parent;
    this.optimisticMetricsApplied = new Set();

    // Initialize insertion behavior with defaults
    this.insertBehavior = {
      local: "prepend", // Default local insertion to prepend (beginning)
      remote: "append", // Default remote insertion to append (end)
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

    if (this.parent){
      this.overfetchCache = this.parent.overfetchCache
      this.operationsManager = this.parent.operationsManager
    } else {
      // Initialize the OverfetchCache if overfetchSize is > 0 and pagination is enabled
      this.overfetchCache = null;
      
      // Set default overfetchSize if not specified
      if (this.options.overfetchSize === undefined && this._serializerOptions.limit) {
        this.options.overfetchSize = Math.min(this._serializerOptions.limit, 10);
      }
      
      if (this.options.overfetchSize > 0 && this._serializerOptions.limit) {
        this.overfetchCache = new OverfetchCache(
          this._findRootQuerySet(),
          this.options,
          this.options.overfetchSize
        );

        // Set the main data array reference
        this.overfetchCache.setMainDataArray(this.dataArray);
        
        // Initialize the cache
        this.overfetchCache.initialize().catch(err => {
          console.error("Error initializing overfetch cache:", err);
        });
      }

      // Initialize the OperationsManager
      this.operationsManager = new OperationsManager(
        this.dataArray,
        this._notify.bind(this),
        this.ModelClass,
        this.overfetchCache
      );
    }
  }

  /**
   * Helper method to find the root queryset
   * Traverses the parent chain to find the top-level LiveQuerySet
   * @returns {QuerySet} The root queryset
   * @private
   */
  _findRootQuerySet() {
    let current = this;
    // Traverse up the parent chain until we reach the root
    while (current.parent) {
      current = current.parent;
    }
    return current.qs;
  }

  handleOptimisticMetricUpdates(
    eventType,
    updatedArray,
    originalArray,
    operationId
  ) {
    // This is a local clean up    
    if (eventType === 'clean') return;

    // Calculate optimistic updates
    const metricUpdates = MetricsManager.optimisticUpdate(
      eventType,
      updatedArray,
      originalArray,
      this.activeMetrics,
      operationId
    );

    // Apply the updates if there are any
    if (Object.keys(metricUpdates).length > 0) {
      this.applyOptimisticMetrics(metricUpdates, operationId);
    }
  }

  applyOptimisticMetrics(metricUpdates, operationId) {
    // Skip if this operation has already been processed
    if (operationId && this.optimisticMetricsApplied.has(operationId)) {
      return;
    }

    // Apply updates to this instance
    MetricsManager.applyOptimisticUpdates(metricUpdates, this.activeMetrics);

    // Mark this operation as processed
    if (operationId) {
      this.optimisticMetricsApplied.add(operationId);
    }
  }
  
  /**
   * Removes local items that no longer exist in the remote dataset.
   * @param {string} operationId - Unique identifier for this removal operation
   * @returns {Promise<Array>} Array of removed ghost items
   */
  async removeGhosts(operationId) {
    const pkField = this.ModelClass.primaryKeyField || "id";
    if (this.dataArray.length === 0) return [];
    
    // Fetch only the primary key field from the remote items
    const remoteItems = await this._findRootQuerySet().fetch({ fields: [pkField], limit: null });
    const remotePkSet = new Set(remoteItems.map(item => item[pkField]));
    
    // Find items that don't exist in the remote dataset and aren't newly created
    const ghostItems = this.dataArray.filter(item => 
      !remotePkSet.has(item[pkField]) && !this.createdItems.has(item[pkField])
    );
    
    if (ghostItems.length > 0) {
      // Use the operations manager to remove ghost items
      this.operationsManager.remove(
        operationId,
        (item) => !remotePkSet.has(item[pkField]) && !this.createdItems.has(item[pkField]),
        false,
        'clean'
      );
    }
    
    return ghostItems;
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
      throw new Error(
        "Cannot refresh LiveQuerySet with a different model class"
      );
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
    this.originalFilterConditions =
      queryState.filter && queryState.filter.conditions;

    if (clearData) {
      // Fetch new data
      const newData = await this.qs.fetch(this._serializerOptions);

      // Get primary key field name
      const pkField = this.ModelClass.primaryKeyField || "id";

      // Use the operations manager to completely replace the data
      // Generate a unique operation ID for this refresh
      const refreshOpId = `refresh_${Date.now()}`;
      this.operationsManager.applyMutation(
        refreshOpId,
        (draft) => {
          draft.length = 0;
          draft.push(...newData);
        },
        "create"
      );
    }

    // Refresh metrics if there were any active
    await this.refreshMetrics();

    // Finally, refresh the overfetch cache
    const overfetchSize = this.options.overfetchSize !== undefined ? 
      this.options.overfetchSize : 
      (this._serializerOptions.limit ? Math.min(this._serializerOptions.limit, 10) : 0);

    const shouldHaveCache = overfetchSize > 0 && this._serializerOptions.limit != null;

    // 2. Reset or create or remove cache as needed
    if (shouldHaveCache) {
      if (this.overfetchCache) {
        // Reset existing cache
        this.overfetchCache.reset({
          newQs: this._findRootQuerySet(),
          newOptions: this.options,
          newCacheSize: overfetchSize
        });
      } else {
        // Create new cache
        this.overfetchCache = new OverfetchCache(
          this._findRootQuerySet(),
          this.options,
          overfetchSize
        );
        this.overfetchCache.initialize();
      }
    } else {
      // No cache needed
      this.overfetchCache = null;
    }
  }

  /**
   * Register a callback function to be called when the data changes
   * @param {function(string)} callback - Function to call with event type
   * @returns {function()} - Unsubscribe function
   */
  subscribe(callback) {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter((cb) => cb !== callback);
    };
  }

  /**
   * Notify all callbacks about a data change event
   * @param {string} eventType - Type of event ('create', 'update', or 'delete')
   * @param {Array} updatedArray - The updated data array
   * @param {Array} originalArray - The original data array
   * @param {string} operationId - The operation ID
   * @param {boolean} isPropagated - Whether this notification is propagated from a child
   * @returns {void}
   */
  _notify(
    eventType,
    updatedArray,
    originalArray,
    operationId,
    isPropagated = false
  ) {
    // Call all callbacks immediately without waiting for refresh to complete
    for (const callback of this.callbacks) {
      callback(eventType, updatedArray, originalArray, operationId);
    }
    this.handleOptimisticMetricUpdates(
      eventType,
      updatedArray,
      originalArray,
      operationId
    );
  }

  /**
   * Register an error handler for any operations on this LiveQuerySet
   * @param {function(Error, string)} errorCallback - Function to call with error and operation type
   * @returns {function()} - Unsubscribe function
   */
  onError(errorCallback) {
    this.errorCallbacks.push(errorCallback);
    return () => {
      this.errorCallbacks = this.errorCallbacks.filter(
        (cb) => cb !== errorCallback
      );
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
    const filterFn = (item) => Object.entries(conditions).every(([k, v]) => item[k] === v);
    const filteredLiveQs = new LiveQuerySet(
      this.qs.filter(conditions),
      this.dataArray,
      this.options,
      filterFn,
      conditions,
      this.createMetricFn,
      this,
      this.createdItems
    );

    filteredLiveQs.subscribe((eventType, updated, original, opId) => {
      this._notify(eventType, updated, original, opId, true);
    });
    filteredLiveQs.onError((err, op) => this._notifyError(err, op));

    return filteredLiveQs;
  }

  /**
   * Deletes items matching the filter.
   * @returns {Promise<void>}
   */
  async delete() {
    if (arguments.length > 0) {
      throw new Error(
        "delete() does not accept arguments and will delete the entire queryset. Use filter() before calling delete() to select elements."
      );
    }

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
        const result = await this.qs.executeQuery(
          Object.assign({}, this.qs.build(), {
            type: "delete",
            operationId,
            namespace: this.namespace,
          })
        );

        // Verify the delete was successful
        if (!result || result.error) {
          throw new Error(result?.error || "Delete failed");
        }

      } catch (error) {
        // Rollback using the operations manager
        this._notifyError(error, "delete");
        this.operationsManager.rollback(operationId);

        // Re-throw to be caught by the outer try/catch
        throw error;
      }

      // In case there were ghost items in the overfetch cache
      if (deletedCount > 1) {
        setTimeout(() => {
          this.removeGhosts().catch(err => 
            console.error("Error removing ghosts after bulk delete:", err)
          );
        }, 500);
      }

      return deletedCount;
    });
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
      this.operationsManager.insert(operationId, optimisticItem, {
        position: this.insertBehavior.local,
        limit: this._serializerOptions?.limit,
        fixedPageSize: this.options.fixedPageSize || this.options.strictMode,
      });

      try {
        const result = await this.qs.executeQuery({
          type: "create",
          data: item,
          operationId,
          namespace: this.namespace,
        });

        const createdItem = new this.ModelClass(result.data);
        const pkField = this.ModelClass.primaryKeyField || "id";

        // Update the temporary item with the real one
        const updateSuccess = this.operationsManager.update(
          `${operationId}_update`,
          (item) => item[pkField] === operationId,
          createdItem
        );
        this.createdItems.add(createdItem[pkField])

        return createdItem;
      } catch (error) {
        this._notifyError(error, "create");

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
      throw new Error(
        "Update accepts only accepts an object of the updates to apply. Use filter() before calling update() to select elements."
      );
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
          type: "update",
          data: updates,
          operationId,
          namespace: this.namespace,
        });

        // Execute the query
        const result = await this.qs.executeQuery(queryParams);

        // Ensure the update was successful
        if (!result || result.error) {
          throw new Error(result?.error || "Update failed");
        }

        // Get the final updated items
        const updatedItems = this.dataArray.filter(this.filterFn);

        return updatedItems;
      } catch (error) {
        this._notifyError(error, "update");
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
      results = results.filter((item) =>
        Object.entries(filters).every(([key, value]) => item[key] === value)
      );
    }
    if (results.length === 1) {
      return results[0];
    } else if (results.length > 1) {
      throw new MultipleObjectsReturned("get() returned more than one object.");
    }

    const freshItem = await this.qs.get(filters);
    const pkField = this.ModelClass.primaryKeyField || "id";

    if (this.filterFn(freshItem)) {
      const exists = this.dataArray.find(
        (item) => item[pkField] === freshItem[pkField]
      );
      if (!exists) {
        const operationId = `get_${Date.now()}`;
        this.operationsManager.insert(operationId, freshItem, {
          position: this.insertBehavior.remote,
          limit: this._serializerOptions?.limit,
          fixedPageSize: this.options.fixedPageSize || this.options.strictMode,
        });
      }
    }

    return freshItem;
  }

  /**
   * Handles a bulk update event from the server.
   * @param {Array<string|number>} instanceIds - Array of primary key values.
   * @param {string} [pkField] - Primary key field name.
   * @param {string} operationId - Operation identifier.
   * @returns {Promise<void>}
   */
  async handleExternalBulkUpdateEvent(
    instanceIds,
    pkField = this.ModelClass.primaryKeyField,
    operationId
  ) {
    if (!instanceIds?.length) return;
    
    try {
      // Fetch all updated instances that match our filter
      const updatedInstances = await this.qs
        .filter({ [`${pkField}__in`]: instanceIds })
        .fetch();
      
      // Create map for O(1) lookups of updated instances that match the filter
      const updatedMap = new Map(
        updatedInstances.map(instance => [instance[pkField], instance])
      );
      
      // Get all items in our data array that are in the instanceIds list
      const existingItemsToRemove = [];
      const existingItemIds = new Set();
      
      for (const item of this.dataArray) {
        const pkValue = item[pkField];
        if (instanceIds.includes(pkValue)) {
          existingItemIds.add(pkValue);
          
          // If item exists in our array but not in updatedMap,
          // it was updated but no longer matches the filter
          if (!updatedMap.has(pkValue) && !this.createdItems.has(pkValue)) {
            existingItemsToRemove.push(pkValue);
          }
        }
      }
      
      // Track items not found in draft for potential creation
      const notFoundPKs = new Set(updatedMap.keys());
      
      // Update existing items
      this.operationsManager.applyMutation(
        operationId,
        (draft) => {
          for (let i = 0; i < draft.length; i++) {
            const pkValue = draft[i][pkField];
            const updatedInstance = updatedMap.get(pkValue);
            
            if (updatedInstance) {
              draft[i] = updatedInstance;
              notFoundPKs.delete(pkValue);
            }
          }
        },
        "update"
      );
      
      // Remove items that no longer match the filter
      if (existingItemsToRemove.length > 0) {
        this.operationsManager.remove(
          operationId,
          (x) => existingItemsToRemove.includes(x[pkField])
        );
      }
      
      // Handle new instances (that weren't in the draft)
      if (notFoundPKs.size > 0) {
        const newInstances = Array.from(notFoundPKs)
          .map(pk => updatedMap.get(pk))
          .filter(this.filterFn); // Apply filter only for new instances
          
        if (newInstances.length > 0) {
          this.handleExternalBulkCreateEvent(newInstances, operationId);
        }
      }
    } catch (err) {
      console.error("Error handling bulk update event:", err);
    }
  }

  /**
   * Handles a bulk create event from the server.
   * @param {Array} items - Array of new items.
   * @param {Number} operationId - Unique id of the operation for deduping
   */
  async handleExternalBulkCreateEvent(items, operationId) {
    if (!items?.length) return;
    
    const filteredItems = items.filter(this.filterFn);
    if (!filteredItems.length) return;
    
    const pkField = this.ModelClass.primaryKeyField;
    const results = await this.fetch();
    const existingIds = new Set(results.map(item => item[pkField]));
    const newItems = filteredItems.filter(item => !existingIds.has(item[pkField]));
    
    if (newItems.length > 0) {
      this.operationsManager.insert(operationId, newItems, {
        position: this.insertBehavior.remote,
        limit: this._serializerOptions?.limit,
        fixedPageSize: this.options.fixedPageSize || this.options.strictMode,
      });
    }
  }

  /**
   * Handles a bulk delete event from the server.
   * @param {Array<string|number>} instanceIds - Array of primary key values.
   * @param {string} [pkField] - Primary key field name.
   */
  handleExternalBulkDeleteEvent(
    instanceIds,
    pkField = this.ModelClass.primaryKeyField,
    operationId
  ) {
    if (!instanceIds || instanceIds.length === 0) {
      return;
    }

    const deletedIdsSet = new Set(instanceIds);

    // Use the operations manager to remove items with matching IDs
    const deletedCount = this.operationsManager.remove(operationId, (item) =>
      deletedIdsSet.has(item[pkField])
    );

    // In case there were ghost items in the overfetch cache
    if (deletedCount > 1) {
      setTimeout(() => {
        this.removeGhosts().catch(err => 
          console.error("Error removing ghosts after bulk delete:", err)
        );
      }, 500);
    }
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

    const pkField = this.ModelClass.primaryKeyField || "id";

    // Check if item already exists (could be an update)
    const existingIndex = this.dataArray.findIndex(
      (x) => x[pkField] === item[pkField]
    );

    if (existingIndex !== -1) {
      // If already exists, treat as an update
      this.handleExternalUpdateEvent(item);
      return;
    }

    // Insert the new item
    this.operationsManager.insert(operationId, item, {
      position: this.insertBehavior.remote,
      limit: this._serializerOptions?.limit,
      fixedPageSize: this.options.fixedPageSize || this.options.strictMode,
    });
  }

  /**
   * Handles an external update event.
   * @param {Object|null} item - The updated item, or null if it no longer matches the filter.
   * @param {string} operationId - The operation identifier.
   * @param {string|number} primaryKey - The primary key of the item.
   */
  handleExternalUpdateEvent(item, operationId, primaryKey) {
    const pkField = this.ModelClass.primaryKeyField || "id";
    
    // Get the primary key value either from the item or from the parameter
    const pkValue = item ? item[pkField] : primaryKey;
    
    // Check if the item exists in our collection
    const index = this.dataArray.findIndex((x) => x[pkField] === pkValue);
    
    if (index !== -1) {
      if (item) {
        // Item exists and we have the updated version, update it
        this.operationsManager.update(
          operationId,
          (x) => x[pkField] === pkValue,
          item
        );
      } else {
        // If it was created in this lqs - item gets a stay of execution
        if (!this.createdItems.has(pkValue)){
          this.operationsManager.remove(
            operationId,
            (x) => x[pkField] === pkValue
          );
        }
      }
    } else if (item && this.filterFn(item)) {
      // Item doesn't exist in our collection but matches our filter, add it
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

    const pkField = this.ModelClass.primaryKeyField || "id";

    // Remove the item with the given ID
    this.operationsManager.remove(
      operationId,
      (item) => item[pkField] === itemId
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
    return MetricsManager.scheduleRefresh(this.qs, this.activeMetrics);
  }

  /**
   * Returns the count metric.
   * @param {string} [field] - Field to count.
   * @returns {Promise<MetricResult>} The count metric.
   */
  async count(field) {
    return MetricsManager.count(
      this.qs,
      this.activeMetrics,
      this.createMetricFn,
      field
    );
  }

  /**
   * Returns the sum metric.
   * @param {string} field - Field to sum.
   * @returns {Promise<MetricResult>} The sum metric.
   */
  async sum(field) {
    return MetricsManager.sum(
      this.qs,
      this.activeMetrics,
      this.createMetricFn,
      field
    );
  }

  /**
   * Returns the average metric.
   * @param {string} field - Field to average.
   * @returns {Promise<MetricResult>} The average metric.
   */
  async avg(field) {
    return MetricsManager.avg(
      this.qs,
      this.activeMetrics,
      this.createMetricFn,
      field
    );
  }

  /**
   * Returns the minimum metric.
   * @param {string} field - Field to find the minimum.
   * @returns {Promise<MetricResult>} The minimum metric.
   */
  async min(field) {
    return MetricsManager.min(
      this.qs,
      this.activeMetrics,
      this.createMetricFn,
      field
    );
  }

  /**
   * Returns the maximum metric.
   * @param {string} field - Field to find the maximum.
   * @returns {Promise<MetricResult>} The maximum metric.
   */
  async max(field) {
    return MetricsManager.max(
      this.qs,
      this.activeMetrics,
      this.createMetricFn,
      field
    );
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
    throw new Error(
      `No configKey found on model class ${qs.modelClass.modelName}`
    );
  }
  const customNamespace = options && options.customNamespace;
  const namespaceResolver = (modelName) =>
    customNamespace ? `${modelName}::${customNamespace}` : modelName;
  const eventReceiver = getEventReceiver();
  if (!eventReceiver) {
    const receiver = initializeEventReceiver(backendKey);
    if (receiver) {
      receiver.setNamespaceResolver(namespaceResolver);
      receiver.addEventHandler(handleModelEvent);
    }
  } else {
    setNamespaceResolver(namespaceResolver);
  }
  const queryState = qs.build();
  const initialData = await qs.fetch(options?.serializer || {});
  if (reactiveArray.length === 0 && initialData.length > 0) {
    reactiveArray.push(...initialData);
  }
  return new LiveQuerySet(
    qs,
    reactiveArray,
    options,
    undefined,
    queryState.filter && queryState.filter.conditions,
    createMetricFn
  );
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
    let operationId =
      config.data &&
      config.data.ast &&
      config.data.ast.query &&
      config.data.ast.query.operationId;
    if (!operationId) {
      operationId = activeOperationIds.values().next().value;
    }
    config.headers = config.headers || {};
    config.headers["X-Operation-ID"] = operationId;
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
