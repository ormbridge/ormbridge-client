// modelsync-client/src/core/liveView/liveQuerySet.js
import { MultipleObjectsReturned, DoesNotExist } from "../../flavours/django/errors.js";
import { getEventReceiver } from '../eventReceivers.js';
import { liveQueryRegistry, defaultNamespaceResolver } from './registry.js';
import { updateArrayInPlace, handleItemInsertion, withOperationId, activeOperationIds } from './utils.js';
import { MetricsManager } from './metricsManager.js';

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
   * @property {Object} [serializer] - Serializer options.
   * @property {Object} [insertBehavior] - Configuration for insertion behavior
   * @property {'prepend'|'append'} [insertBehavior.local='prepend'] - Where to insert locally created items
   * @property {'prepend'|'append'} [insertBehavior.remote='append'] - Where to insert remotely created items
   */

  /**
   * Create a new LiveQuerySet
   * @param {QuerySet} qs - The QuerySet to live monitor
   * @param {Array} dataArray - Reactive array that will be kept in sync
   * @param {LiveQuerySetOptions} options - Configuration options
   * @param {Function} filterFn - Function to filter items
   * @param {Object} filterConditions - Filter conditions
   * @param {Function} createMetricFn - Function to create metric objects
   */
  constructor(qs, dataArray, options, filterFn, filterConditions, createMetricFn, parent) {
    this.qs = qs;
    this.dataArray = dataArray;
    this.filterFn = filterFn || (() => true);
    this.options = options || {};
    this._serializerOptions = this.options.serializer || {};
    this.originalFilterConditions = filterConditions;
    this.ModelClass = this.qs.ModelClass;
    this.parent = parent;
    
    // Create the metrics manager
    this.metricsManager = new MetricsManager(this.qs, createMetricFn);
    
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
    this.namespace = defaultNamespaceResolver(modelName);
    liveQueryRegistry.register(this.namespace, this);
    
    const eventReceiver = getEventReceiver();
    if (eventReceiver) {
      eventReceiver.subscribe(this.namespace);
    }
    
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
    
    // Update instance properties
    if (newQs) {
      this.qs = newQs;
      // Update the query set in the metrics manager
      this.metricsManager.updateQuerySet(newQs);
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
    this.namespace = defaultNamespaceResolver(modelName);
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
      
      // Update the array in place using the imported utility function
      updateArrayInPlace(this.dataArray, newData, pkField);
      
      // Notify of changes
      this._notify('refresh');
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
   * @private
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
   * @private
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
    this.metricsManager.clear();
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
   * @returns {LiveQuerySet} A new LiveQuerySet instance with relayed events.
   */
  filter(conditions) {
    // Build a filter function based solely on the new conditions
    const newFilter = (item) => {
      return Object.entries(conditions).every(([key, value]) => {
        return item[key] === value;
      });
    };
    
    // Create a new QuerySet that is already filtered on the server side
    const newQs = this.qs.filter(conditions);
    
    // Create the filtered LiveQuerySet
    const filteredLiveQs = new LiveQuerySet(
      newQs, 
      this.dataArray, 
      this.options, 
      newFilter, 
      conditions,
      this.metricsManager.createMetricFn,
      this
    );
    
    // Store reference to the original LiveQuerySet
    const originalLiveQs = this;
    
    // Subscribe to the filtered instance's notifications and relay them
    filteredLiveQs.subscribe(eventType => {
      originalLiveQs._notify(eventType);
    });
    
    // Also relay error events
    filteredLiveQs.onError((error, operation) => {
      originalLiveQs._notifyError(error, operation);
    });
    
    return filteredLiveQs;
  }

  /**
   * Gets configuration options for data manipulation
   * @returns {Object} Configuration options
   * @private
   */
  _getDataOptions() {
    return {
      limit: this._serializerOptions?.limit,
      fixedPageSize: this.options.fixedPageSize,
      strictMode: this.options.strictMode
    };
  }

  /**
   * Process a single item (create or update)
   * @param {Object} item - The item to process
   * @param {boolean} isLocal - Whether this is a local operation
   * @param {string} operation - 'create' or 'update'
   * @param {string} [tempId] - Temporary ID for optimistic creates
   * @returns {Object} The processed item or updateState (for updates)
   * @private
   */
  _processSingleItem(item, isLocal, operation, tempId = null) {
    const pkField = this.ModelClass.primaryKeyField || 'id';
    
    if (operation === 'create') {
      const insertionMode = isLocal ? this.insertBehavior.local : this.insertBehavior.remote;
      const dataOptions = this._getDataOptions();
      
      // Add temporary ID for optimistic updates if needed
      const processedItem = isLocal && tempId ? { ...item, id: tempId } : item;
      
      // Skip items that don't match our filter for external events
      if (!isLocal && !this.filterFn(processedItem)) {
        return null;
      }
      
      // Insert the item
      handleItemInsertion(
        this.dataArray,
        processedItem,
        insertionMode,
        dataOptions,
        this._notify.bind(this)
      );
      
      return processedItem;
    } 
    else if (operation === 'update') {
      // External update (full item)
      if (!isLocal) {
        const index = this.dataArray.findIndex(x => x[pkField] === item[pkField]);
        
        if (index !== -1) {
          // Update existing item
          Object.assign(this.dataArray[index], item);
          this._notify('update');
          return item;
        } else if (this.filterFn(item)) {
          // Insert as new if it matches our filter
          return this._processSingleItem(item, false, 'create');
        }
        
        return null;
      }
      
      // Local update (partial updates to multiple items)
      const updates = item; // For local updates, 'item' is actually the updates object
      const affectedItems = tempId || this.dataArray.filter(this.filterFn);
      const affectedIndexes = [];
      const originals = new Map();
      
      // Apply updates and track originals for potential rollback
      for (let i = 0; i < this.dataArray.length; i++) {
        const dataItem = this.dataArray[i];
        if (Array.isArray(affectedItems) ? affectedItems.includes(dataItem) : true) {
          affectedIndexes.push(i);
          originals.set(i, { ...dataItem }); // Store original for potential rollback
          Object.assign(this.dataArray[i], updates);
        }
      }
      
      if (affectedIndexes.length > 0) {
        this._notify('update');
      }
      
      return { affectedIndexes, originals };
    }
    
    return null;
  }

  /**
   * Process multiple items (create, update or delete)
   * @param {Array} items - Items to process for create/update, or IDs for delete
   * @param {boolean} isLocal - Whether this is a local operation
   * @param {string} operation - 'create', 'update', or 'delete'
   * @returns {Array|Object} The processed items or deleteState (for delete)
   * @private
   */
  _processMultipleItems(items, isLocal, operation) {
    if (!items || items.length === 0) {
      return operation === 'delete' ? { deletedItems: [], deletedIndexes: [] } : [];
    }
    
    const pkField = this.ModelClass.primaryKeyField || 'id';
    
    if (operation === 'create') {
      // Filter items if needed (for external events)
      const filteredItems = isLocal ? items : items.filter(this.filterFn);
      if (filteredItems.length === 0) return [];
      
      const insertionMode = isLocal ? this.insertBehavior.local : this.insertBehavior.remote;
      const dataOptions = this._getDataOptions();
      
      // Insert all items at once
      handleItemInsertion(
        this.dataArray,
        filteredItems,
        insertionMode,
        dataOptions,
        this._notify.bind(this)
      );
      
      return filteredItems;
    }
    else if (operation === 'update') {
      const updatedMap = new Map();
      
      // Build a map of updated items by primary key
      for (const item of items) {
        const pkValue = item[pkField];
        updatedMap.set(pkValue, item);
      }
      
      let anyUpdated = false;
      
      // Update existing items
      for (let i = 0; i < this.dataArray.length; i++) {
        const currentItem = this.dataArray[i];
        const pkValue = currentItem[pkField];
        const updatedItem = updatedMap.get(pkValue);
        
        if (updatedItem) {
          Object.assign(this.dataArray[i], updatedItem);
          anyUpdated = true;
          updatedMap.delete(pkValue);
        }
      }
      
      if (anyUpdated) {
        this._notify('update');
      }
      
      // Add new items that match our filter
      const newItems = [];
      for (const [_, item] of updatedMap.entries()) {
        if (this.filterFn(item)) {
          newItems.push(item);
        }
      }
      
      if (newItems.length > 0) {
        this._processMultipleItems(newItems, false, 'create');
      }
      
      return items;
    }
    else if (operation === 'delete') {
      // For delete, items is an array of IDs
      const itemIdsSet = new Set(items);
      const pkField = this.ModelClass.primaryKeyField || 'id';
      const deletedItems = [];
      const deletedIndexes = [];

      // Filter the array to keep only non-deleted items, while tracking deleted ones
      const remainingItems = this.dataArray.filter((item, index) => {
        const pkValue = item[pkField];
        if (!itemIdsSet.has(pkValue)) {
          return true; // Keep this item
        }
        // This item will be removed, track it first
        deletedItems.push(item);
        deletedIndexes.push(index);
        return false;
      });
      
      if (deletedItems.length > 0) {
        // Replace contents of dataArray with remaining items
        updateArrayInPlace(this.dataArray, remainingItems, pkField);
        this._notify('delete');
      }
      
      return { deletedItems, deletedIndexes };
    }
    
    return [];
  }

  /**
   * Rollback a local update
   * @param {Object} updateState - State returned from _processSingleItem
   * @private
   */
  _rollbackUpdate(updateState) {
    const { affectedIndexes, originals } = updateState;
    
    for (const index of affectedIndexes) {
      const originalItem = originals.get(index);
      if (originalItem && index < this.dataArray.length) {
        this.dataArray[index] = originalItem;
      }
    }
    
    if (affectedIndexes.length > 0) {
      this._notify('update');
    }
  }

  /**
   * Rollback a local delete
   * @param {Object} deleteState - State returned from _processMultipleItems for delete
   * @private
   */
  _rollbackDelete(deleteState) {
    const { deletedItems, deletedIndexes } = deleteState;
    
    for (let i = 0; i < deletedItems.length; i++) {
      const index = deletedIndexes[i];
      // If index is beyond current array length, simply push to end
      if (index >= this.dataArray.length) {
        this.dataArray.push(deletedItems[i]);
      } else {
        // Otherwise, insert at original position
        this.dataArray.splice(index, 0, deletedItems[i]);
      }
    }
    
    if (deletedItems.length > 0) {
      this._notify('create'); // Notify about the restored items
    }
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
      // Get affected items
      const affectedItems = this.dataArray.filter(this.filterFn);
      if (affectedItems.length === 0) return;
      
      return await withOperationId(async (operationId) => {
        // Optimistically delete matching items
        const deleteState = this._processMultipleItems(
          affectedItems.map(item => item[this.ModelClass.primaryKeyField || 'id']),
          true,
          'delete'
        );
        
        try {
          // Execute delete operation on the server
          await this.qs.executeQuery(Object.assign({}, this.qs.build(), {
            type: 'delete',
            operationId,
            namespace: this.namespace
          }));
        } catch (error) {
          // Rollback: restore deleted items
          this._notifyError(error, 'delete');
          this._rollbackDelete(deleteState);
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
      
      // Apply optimistic update
      this._processSingleItem(item, true, 'create', tempId);
      
      try {
        const result = await this.qs.executeQuery({
          type: 'create',
          data: item,
          operationId,
          namespace: this.namespace
        });
        
        // Update the optimistic item with the real data
        const createdItem = new this.ModelClass(result.data);
        const pkField = this.ModelClass.primaryKeyField || 'id';
        const index = this.dataArray.findIndex(x => x[pkField] === tempId);
        
        if (index !== -1) {
          this.dataArray[index] = createdItem;
          this._notify('update');
        }
        
        return createdItem;
      }
      catch (error) {
        this._notifyError(error, 'create');
        
        // Rollback: remove the temporary item
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
    if (arguments.length > 1) {
      throw new Error('Update only accepts an object of the updates to apply. Use filter() before calling update() to select elements.');
    }
    
    return await withOperationId(async (operationId) => {
      // Find affected items
      const affectedItems = this.dataArray.filter(this.filterFn);
      
      // Apply optimistic updates
      const updateState = this._processSingleItem(updates, true, 'update', affectedItems);
      
      try {
        await this.qs.executeQuery(Object.assign({}, this.qs.build(), {
          type: 'update',
          data: updates,
          operationId,
          namespace: this.namespace
        }));
        
        return this.dataArray.filter(this.filterFn);
      }
      catch (error) {
        this._notifyError(error, 'update');
        
        // Rollback updates
        this._rollbackUpdate(updateState);
        
        throw error;
      }
    });
  }

  /**
   * Refreshes all active metrics.
   * @returns {Promise<void>}
   */
  async refreshMetrics() {
    return this.metricsManager.refreshMetrics();
  }

  /**
   * Returns the count metric.
   * @param {string} [field] - Field to count.
   * @returns {Promise<Object>} The count metric.
   */
  async count(field) {
    return this.metricsManager.count(field);
  }

  /**
   * Returns the sum metric.
   * @param {string} field - Field to sum.
   * @returns {Promise<Object>} The sum metric.
   */
  async sum(field) {
    return this.metricsManager.sum(field);
  }

  /**
   * Returns the average metric.
   * @param {string} field - Field to average.
   * @returns {Promise<Object>} The average metric.
   */
  async avg(field) {
    return this.metricsManager.avg(field);
  }

  /**
   * Returns the minimum metric.
   * @param {string} field - Field to find the minimum.
   * @returns {Promise<Object>} The minimum metric.
   */
  async min(field) {
    return this.metricsManager.min(field);
  }

  /**
   * Returns the maximum metric.
   * @param {string} field - Field to find the maximum.
   * @returns {Promise<Object>} The maximum metric.
   */
  async max(field) {
    return this.metricsManager.max(field);
  }
  
  /**
   * Data query methods
   */
  
  async get(filters) {
    let results = await this.fetch();
    
    if (filters) {
      results = results.filter(item => 
        Object.entries(filters).every(([key, value]) => item[key] === value)
      );
    }
    
    if (results.length === 1) {
      return results[0];
    } else if (results.length > 1) {
      throw new MultipleObjectsReturned('get() returned more than one object.');
    }
    
    // Not found in local cache, fetch from server
    const freshItem = await this.qs.get(filters);
    
    // If the item matches our filter, add it to the local array
    if (this.filterFn(freshItem)) {
      this._processSingleItem(freshItem, false, 'create');
    }
    
    return freshItem;
  }

  async first() {
    const results = await this.fetch();
    return results.length > 0 ? results[0] : null;
  }

  async last() {
    const results = await this.fetch();
    return results.length > 0 ? results[results.length - 1] : null;
  }
}