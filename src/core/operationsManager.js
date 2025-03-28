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
   * Inserts items into the array with position and size constraints
   *
   * @param {string} operationId - Caller-supplied ID for the operation
   * @param {Array|Object} items - Item(s) to insert
   * @param {Object} options - Insert options
   * @param {string} [options.position='append'] - Where to insert ('prepend'|'append')
   * @param {number} [options.limit] - Maximum array size
   * @param {boolean} [options.fixedPageSize] - Whether to maintain fixed size
   * @returns {boolean} Whether items were inserted
   */
  insert(operationId, items, { position = 'append', limit, fixedPageSize } = {}) {
    const itemsToInsert = (Array.isArray(items) ? items : [items]).map(item =>
      this.ModelClass && !(item instanceof this.ModelClass) ? new this.ModelClass(item) : item
    );

    if (!itemsToInsert.length) return false;

    return this.applyMutation(operationId, draft => {
      if (position === "append") {
        if (fixedPageSize && limit !== undefined && draft.length >= limit) return;
        draft.push(...itemsToInsert);
        if (!fixedPageSize && limit !== undefined && draft.length > limit) draft.splice(limit);
      } else {
        if (fixedPageSize && limit !== undefined && draft.length >= limit) {
          draft.splice(-Math.min(itemsToInsert.length, draft.length));
        }
        draft.unshift(...itemsToInsert);
        if (!fixedPageSize && limit !== undefined && draft.length > limit) draft.splice(limit);
      }
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
   * @returns {number} Count of removed items
   */
  remove(operationId, filterFn) {
    let removeCount = 0;
  
    const success = this.applyMutation(operationId, draft => {
      for (let i = draft.length - 1; i >= 0; i--) {
        if (filterFn(draft[i])) {
          draft.splice(i, 1);
          removeCount++;
        }
      }
    }, "delete");
  
    // If items were removed and we have a cache, get replacements
    if (success && removeCount > 0 && this.overfetchCache) {
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
}