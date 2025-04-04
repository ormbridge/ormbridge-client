import { create, apply } from "mutative";

/**
 * Manages array operations with automatic patching and rollback capabilities
 * using Mutative's JSON patch functionality.
 */
export class OperationsManager {
  /**
   * @param {Array} dataArray - Reference to the array to be managed
   * @param {Function} notifyCallback - Function to call on data changes (type: 'create'|'update'|'delete')
   * @param {Function} [modelClass] - Constructor function for the model class
   * @param {Object} [overfetchCache] - Reference to the overfetch cache for replacements
   */
  constructor(dataArray, notifyCallback, modelClass = null, overfetchCache = null) {
    this.dataArray = dataArray;
    this.notify = notifyCallback;
    this.operationPatches = new Map();
    this.ModelClass = modelClass;
    this.overfetchCache = overfetchCache;

    // Initialize a cache operations manager if we have a cache
    this.cacheManager = null;
    if (this.overfetchCache) {
      // Create a cache manager with a no-op notify function and no nested cache
      this.cacheManager = new OperationsManager(
        this.overfetchCache.cacheItems,
        () => {}, // No-op notify function, because this isnt seen in the UI
        this.ModelClass,
        null // No nested cache to prevent infinite recursion
      );
    }
  }

  /**
   * Applies a mutation to the data array and stores patches for rollback
   *
   * @param {string} operationId - Caller-supplied ID for the operation
   * @param {Function} mutator - Function that modifies the draft state
   * @param {string} eventType - Event type to notify ('create', 'update', 'delete')
   * @returns {boolean} Whether the operation was successful
   */
  applyMutation(operationId, mutator, eventType) {
    const originalArray = this.dataArray.map(m => m.serialize());

    try {
      const [newState, patches, inversePatches] = create(this.dataArray, draft => {
        mutator(draft);
      }, { enablePatches: true });

      if (!patches.length) return false;

      // Create an operation record.
      const opRecord = {
        inversePatches,
        eventType,
        timestamp: Date.now(),
      };

      // Append this opRecord to the list of operations for the opId.
      if (this.operationPatches.has(operationId)) {
        this.operationPatches.get(operationId).push(opRecord);
      } else {
        this.operationPatches.set(operationId, [opRecord]);
      }

      this.dataArray.length = 0;
      newState.forEach(item => {
        this.dataArray.push(this.ModelClass && !(item instanceof this.ModelClass)
          ? new this.ModelClass(item)
          : item);
      });

      const updatedArray = this.dataArray.map(m => m.serialize());
      this.notify(eventType, updatedArray, originalArray, operationId);

      return true;
    } catch (error) {
      console.error("Mutation error:", error);
      return false;
    }
  }

  /**
   * Helper function to insert items into a draft array.
   *
   * @param {Array} draft - The target array to update.
   * @param {Array} itemsToInsert - Items to be inserted.
   * @param {string} position - Where to insert ('prepend'|'append').
   * @param {number} [limit] - Maximum allowed size of the array.
   */
  _performInsertion(draft, itemsToInsert, position, limit) {
    if (position === "append") {
      draft.push(...itemsToInsert);
    } else {
      draft.unshift(...itemsToInsert);
    }
    // Enforce the limit by trimming the array if necessary.
    if (limit !== undefined && draft.length > limit) {
      draft.splice(limit);
    }
  }

  /**
   * Inserts items into the array with position and size constraints
   *
   * @param {string} operationId - Caller-supplied ID for the operation
   * @param {Array|Object} items - Item(s) to insert
   * @param {Object} options - Insert options
   * @param {string} [options.position='append'] - Where to insert ('prepend'|'append')
   * @param {number} [options.limit] - Maximum array size
   * @returns {boolean} Whether items were inserted
   */
  insert(operationId, items, { position = 'append', limit } = {}) {
    const itemsToInsert = (Array.isArray(items) ? items : [items]).map(item =>
      this.ModelClass && !(item instanceof this.ModelClass)
        ? new this.ModelClass(item)
        : item
    );

    if (!itemsToInsert.length) return false;

    return this.applyMutation(operationId, draft => {
      return this._performInsertion(draft, itemsToInsert, position, limit);
    }, "create");
  }

  /**
   * Updates items in the array based on a filter function
   *
   * @param {string} operationId - Caller-supplied ID for the operation
   * @param {Function} filterFn - Function to determine which items to update
   * @param {Object} updates - Properties to update
   * @returns {number} Count of updated items
   */
  update(operationId, filterFn, updates) {
    let updateCount = 0;

    const success = this.applyMutation(operationId, draft => {
      draft.forEach((item, idx) => {
        if (filterFn(item)) {
          draft[idx] = new this.ModelClass({ ...item, ...updates });
          updateCount++;
        }
      });
    }, "update");

    return success ? updateCount : 0;
  }

  /**
   * Removes items from the array based on a filter function
   *
   * @param {string} operationId - Caller-supplied ID for the operation
   * @param {Function} filterFn - Function to determine which items to remove
   * @param {Boolean} replenish - Optimistically replenish from the overfetch cache
   * @returns {number} Count of removed items
   */
  remove(operationId, filterFn, replenish = true, operation = "delete") {
    let removeCount = 0;
  
    const success = this.applyMutation(operationId, draft => {
      for (let i = draft.length - 1; i >= 0; i--) {
        if (filterFn(draft[i])) {
          draft.splice(i, 1);
          removeCount++;
        }
      }
    }, operation);
  
    // If items were removed and we have a cache, get replacements
    if (success && removeCount > 0 && this.overfetchCache && replenish) {
      // Get replacement items from cache
      const replacements = this.overfetchCache.getReplacements(removeCount);
      if (replacements.length > 0) {
        const createSuccess = this.applyMutation(operationId, draft => {
          // Filter out any replacement items that already exist in the data array
          const pkField = this.ModelClass.primaryKeyField || 'id';
          const existingIds = new Set(draft.map(item => item[pkField]));
          const uniqueReplacements = replacements.filter(item => !existingIds.has(item[pkField]));
          
          // Insert unique replacement items – here we push them at the end.
          if (uniqueReplacements.length > 0) {
            draft.push(...uniqueReplacements);
          }
        }, "create");
      }
    }
  
    return success ? removeCount : 0;
  }
  
  /**
   * Rolls back an operation by applying its inverse patches
   *
   * @param {string} operationId - ID of the operation to roll back
   * @returns {boolean} Whether the rollback was successful
   */
  rollback(operationId) {
    const operations = this.operationPatches.get(operationId);
    if (!operations) return false;
  
    try {
      let currentState = this.dataArray;
      // Roll back each operation in reverse order
      for (const op of operations.slice().reverse()) {
        // Capture a snapshot before applying the inverse patches for this op
        const beforeState = currentState.map(m => m.serialize());
        currentState = apply(currentState, op.inversePatches);
  
        // Replace dataArray with the restored state for this op.
        this.dataArray.length = 0;
        currentState.forEach(item => {
          this.dataArray.push(
            this.ModelClass && !(item instanceof this.ModelClass)
              ? new this.ModelClass(item)
              : item
          );
        });
  
        const updatedArray = this.dataArray.map(m => m.serialize());
        // Compute the inverse event based on the original op event type
        const inverseEvent =
          { create: "delete", delete: "create" }[op.eventType] || "update";
        // Notify using the original rollback logic for this op
        this.notify(inverseEvent, updatedArray, beforeState, operationId);
      }
  
      this.operationPatches.delete(operationId);
      return true;
    } catch (error) {
      console.error(`Error rolling back operation ${operationId}:`, error);
      return false;
    }
  }

  /**
   * Cleans up old operation records
   * @param {number} maxAgeMs - Maximum age in milliseconds
   */
  cleanupOperations(maxAgeMs = 60000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, { timestamp }] of this.operationPatches.entries()) {
      if (timestamp < cutoff) this.operationPatches.delete(id);
    }
  }

  // Cache management methods

  /**
   * Apply a mutation directly to the cache
   * 
   * @param {string} operationId - Operation ID for tracking
   * @param {Function} mutator - Function that modifies the cache draft
   * @returns {boolean} Success status
   */
  applyMutationToCache(operationId, mutator) {
    if (!this.cacheManager || !this.overfetchCache) return false;
    
    // Use the cache manager to apply the mutation
    return this.cacheManager.applyMutation(operationId, mutator, "cache");
  }
  
  /**
   * Insert items directly into the cache
   * 
   * @param {string} operationId - Operation ID for tracking
   * @param {Array|Object} items - Items to insert into the cache
   * @returns {boolean} Success status
   */
  insertToCache(operationId, items) {
    if (!this.cacheManager) return false;
    
    // Use the cache manager to insert items
    return this.cacheManager.insert(operationId, items, {
      position: 'append'
    });
  }
  
  /**
   * Remove items from the cache
   * 
   * @param {string} operationId - Operation ID for tracking
   * @param {Function} filterFn - Filter function to identify items to remove
   * @returns {number} Number of items removed
   */
  removeFromCache(operationId, filterFn) {
    if (!this.cacheManager) return 0;
    
    // Use the cache manager to remove items
    return this.cacheManager.remove(operationId, filterFn, false, "delete");
  }
  
  /**
   * Roll back cache operations specifically
   * 
   * @param {string} operationId - ID of the operation to roll back
   * @returns {boolean} Whether the rollback was successful
   */
  rollbackCache(operationId) {
    if (!this.cacheManager) return false;
    
    // Use the cache manager to roll back operations
    return this.cacheManager.rollback(operationId);
  }
}