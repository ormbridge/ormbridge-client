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
   */
  constructor(dataArray, notifyCallback, modelClass = null) {
    this.dataArray = dataArray;
    this.notify = notifyCallback;
    this.operationPatches = new Map();
    this.ModelClass = modelClass;
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

      this.operationPatches.set(operationId, {
        inversePatches,
        eventType,
        timestamp: Date.now(),
      });

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

    return success ? removeCount : 0;
  }

  /**
   * Rolls back an operation by applying its inverse patches
   *
   * @param {string} operationId - ID of the operation to roll back
   * @returns {boolean} Whether the rollback was successful
   */
  rollback(operationId) {
    const operation = this.operationPatches.get(operationId);
    if (!operation) return false;

    try {
      const restoredState = apply(this.dataArray, operation.inversePatches);
      this.dataArray.length = 0;
      restoredState.forEach(item => {
        this.dataArray.push(this.ModelClass && !(item instanceof this.ModelClass)
          ? new this.ModelClass(item)
          : item);
      });

      const inverseEvent = { create: "delete", delete: "create" }[operation.eventType] || "update";
      this.notify(inverseEvent);
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