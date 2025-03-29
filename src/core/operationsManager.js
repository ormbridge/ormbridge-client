import { create, apply } from "mutative";
import PQueue from 'p-queue'; // Import p-queue

/**
 * Manages array operations with sequential execution, patching, and rollback.
 * Errors are indicated by Promise rejection. Successful operations resolve with
 * a count of affected items (where applicable) or null/undefined.
 */
export class OperationsManager {
  /**
   * @param {Array} dataArray - Reference to the array to be managed
   * @param {Function} notifyCallback - Function to call on data changes
   * @param {Function} [modelClass] - Constructor function for the model class
   * @param {Object} [overfetchCache] - Reference to the overfetch cache
   */
  constructor(dataArray, notifyCallback, modelClass = null, overfetchCache = null) {
    this.dataArray = dataArray;
    this.notify = notifyCallback;
    this.operationPatches = new Map();
    this.ModelClass = modelClass;
    this.overfetchCache = overfetchCache;
    this._queue = new PQueue({ concurrency: 1 });

    this.cacheManager = null;
    if (this.overfetchCache && this.ModelClass) {
      this.cacheManager = new OperationsManager(
        this.overfetchCache.cacheItems,
        () => {},
        this.ModelClass,
        null
      );
    }
  }

  // --- Private Methods (Executed by the Queue) ---

  /**
   * Performs the actual state mutation. Resolves with the count of affected items.
   * Throws an error on failure, causing the Promise to reject.
   * @private
   */
  _performMutation(operationId, mutator, eventType) {
    const originalSerializedArray = this.dataArray.map(m => typeof m?.serialize === 'function' ? m.serialize() : m);
    let mutationResult = 0; // Default count to 0

    // No try...catch here; let errors propagate to reject the promise
    const [newState, patches, inversePatches] = create(
      this.dataArray,
      draft => {
        mutationResult = mutator(draft) ?? 0; // Capture result, default to 0
        // Ensure mutationResult is a number
        if(typeof mutationResult !== 'number') {
            console.warn(`Mutator for OpID ${operationId} did not return a number. Defaulting count to 0.`);
            mutationResult = 0;
        }
      },
      { enablePatches: true }
    );

    // If no patches were generated, no change occurred. Resolve with 0 count.
    if (patches.length === 0) {
      return 0;
    }

    // Store inverse patches *before* modifying the live array
    const opRecord = { inversePatches, eventType, timestamp: Date.now() };
    if (this.operationPatches.has(operationId)) {
      this.operationPatches.get(operationId).push(opRecord);
    } else {
      this.operationPatches.set(operationId, [opRecord]);
    }

    // Update the managed array *in place*
    this.dataArray.length = 0;
    newState.forEach(item => {
      this.dataArray.push(
        this.ModelClass && !(item instanceof this.ModelClass) && typeof item === 'object' && item !== null
          ? new this.ModelClass(item)
          : item
      );
    });

    // Notify listeners *after* state change
    const updatedSerializedArray = this.dataArray.map(m => typeof m?.serialize === 'function' ? m.serialize() : m);
    if (eventType !== 'cache') {
      this.notify(eventType, updatedSerializedArray, originalSerializedArray, operationId);
    }

    // Resolve the promise with the count returned by the mutator
    return mutationResult;
  }

  /**
   * Performs the actual rollback. Resolves with `true` if patches were found and processed
   * (even if they had no effect), `false` otherwise.
   * Throws an error on failure, causing the Promise to reject.
   * @private
   */
  _performRollback(operationId) {
    const operations = this.operationPatches.get(operationId);
    if (!operations || operations.length === 0) {
      console.warn(`Rollback requested for ${operationId}, but no patches found or already processed.`);
      return false; // Indicate no rollback attempted/needed
    }

    // No try...catch here; let errors propagate to reject the promise
    let hadEffect = false;
    for (const op of operations.slice().reverse()) {
      const beforeStateSerialized = this.dataArray.map(m => typeof m?.serialize === 'function' ? m.serialize() : m);
      let rolledBackState;
      let appliedPatches;

      // Use create again to track actual changes from inverse patches
       try {
            [rolledBackState, appliedPatches] = create(this.dataArray, draft => {
               apply(draft, op.inversePatches)
            }, {enablePatches: true });
        } catch(applyError) {
             console.error(`Error applying inverse patch for ${operationId}:`, applyError, op.inversePatches);
             // Treat this as a rollback failure? For now, re-throw.
             throw applyError;
        }


      if (appliedPatches && appliedPatches.length > 0) {
        hadEffect = true;
        // Update the managed array in place
        this.dataArray.length = 0;
        rolledBackState.forEach(item => {
          this.dataArray.push(
            this.ModelClass && !(item instanceof this.ModelClass) && typeof item === 'object' && item !== null
              ? new this.ModelClass(item)
              : item
          );
        });

        // Notify about the change
        const updatedStateSerialized = this.dataArray.map(m => typeof m?.serialize === 'function' ? m.serialize() : m);
        const inverseEvent = { create: "delete", delete: "create" }[op.eventType] || "update";
        if (op.eventType !== 'cache') {
          this.notify(inverseEvent, updatedStateSerialized, beforeStateSerialized, operationId);
        }
      }
    }

    // Successfully processed rollback, remove the patches
    this.operationPatches.delete(operationId);
    // Resolve indicating rollback was processed. Maybe return hadEffect? Resolve just true for now.
    return true;
  }

  // --- Public API Methods (Enqueue Operations - ASYNC, return Promise<number|boolean|void>) ---

  /**
   * Applies a mutation by enqueueing it.
   * Returns a Promise resolving to the count returned by the mutator, or rejecting on error.
   */
  async applyMutation(operationId, mutator, eventType) {
    return this._queue.add(() => this._performMutation(operationId, mutator, eventType));
  }

  /**
   * Inserts items by enqueueing the mutation.
   * Returns Promise<number> (count of items effectively added). Rejects on error.
   */
  async insert(operationId, items, { position = 'append', limit, fixedPageSize } = {}) {
    const itemsToInsert = (Array.isArray(items) ? items : [items]).map(item =>
      this.ModelClass && !(item instanceof this.ModelClass) && typeof item === 'object' && item !== null
        ? new this.ModelClass(item)
        : item
    );

    if (!itemsToInsert.length) return 0; // Resolve immediately with 0 count

    const mutator = (draft) => {
      const initialLength = draft.length;
      // --- Insert logic ---
        if (position === "append") {
            if (fixedPageSize && limit !== undefined && draft.length >= limit) return 0;
            draft.push(...itemsToInsert);
            if (!fixedPageSize && limit !== undefined && draft.length > limit) draft.splice(limit);
        } else { // prepend
            let removedCount = 0;
            if (fixedPageSize && limit !== undefined && draft.length >= limit) {
                 removedCount = Math.min(itemsToInsert.length, draft.length);
                 draft.splice(-removedCount);
            }
            draft.unshift(...itemsToInsert);
             if (!fixedPageSize && limit !== undefined && draft.length > limit) {
                 // Simpler trim logic
                 draft.splice(limit);
            }
        }
      // --- End insert logic ---
      return draft.length - initialLength; // Return the actual change in length
    };

    return this.applyMutation(operationId, mutator, "create");
  }

  /**
   * Updates items by enqueueing the mutation.
   * Returns Promise<number> (count of items updated). Rejects on error.
   */
  async update(operationId, filterFn, updates) {
     // Optimization: check if any items match *before* queueing
     const itemsToUpdateExist = this.dataArray.some(filterFn);
     if (!itemsToUpdateExist) {
         return 0; // Resolve immediately with 0 count
     }

    const mutator = (draft) => {
      let updateCount = 0;
      draft.forEach((item, idx) => {
        if (filterFn(item)) {
          draft[idx] = new this.ModelClass({ ...item, ...updates });
          updateCount++;
        }
      });
      return updateCount; // Return count
    };

    return this.applyMutation(operationId, mutator, "update");
  }

  /**
   * Removes items by enqueueing the mutation. Handles replenishment.
   * Returns Promise<number> for the count of items removed. Rejects on error.
   */
  async remove(operationId, filterFn, replenish = true, operation = "delete") {
    // Optimization: check if any items match *before* queueing
     const itemsToRemove = this.dataArray.filter(filterFn);
     if (itemsToRemove.length === 0) {
         return 0; // Resolve immediately with 0 count
     }

     const mutator = (draft) => {
       let actualRemovedCount = 0;
       for (let i = draft.length - 1; i >= 0; i--) {
         if (filterFn(draft[i])) {
           draft.splice(i, 1);
           actualRemovedCount++;
         }
       }
       return actualRemovedCount; // Return count
     };

     // Enqueue the removal task and get its promise
     const removalPromise = this.applyMutation(operationId, mutator, operation);

     // Handle replenishment *after* the removal task completes successfully
     if (replenish && this.overfetchCache) {
       removalPromise.then(removedCount => { // Access the resolved count
         if (removedCount > 0) {
           const replacements = this.overfetchCache.getReplacements(removedCount);
           if (replacements.length > 0) {
             const replenishMutator = draft => {
               const pkField = this.ModelClass?.primaryKeyField || 'id';
               const existingIds = new Set(draft.map(item => item[pkField]));
               const uniqueReplacements = replacements.filter(item => !existingIds.has(item[pkField]));
               let addedCount = 0;
               if (uniqueReplacements.length > 0) {
                 draft.push(...uniqueReplacements);
                 addedCount = uniqueReplacements.length;
               }
               return addedCount;
             };
             const replenishOpId = `${operationId}_replenish`;
             // Enqueue replenishment but don't await it here or link its outcome
             // to the original removal promise's resolution.
             this._queue.add(() => this._performMutation(replenishOpId, replenishMutator, 'create'))
                      .catch(err => console.error(`Error during replenishment for ${operationId}:`, err)); // Log replenishment errors separately
           }
         }
       }).catch(err => {
         // Log removal error, but maybe replenishment should still be attempted?
         // For now, it won't run if removalPromise rejects.
         console.error(`Removal failed for OpID ${operationId}, replenishment skipped:`, err);
       });
     }

     // Return the promise associated *only* with the removal operation
     return removalPromise;
   }


  /**
   * Rolls back an operation by enqueueing the rollback action.
   * Returns Promise<boolean> indicating if rollback was attempted (found patches). Rejects on error.
   */
  async rollback(operationId) {
     // Check patch existence before queueing
     if (!this.operationPatches.has(operationId)) {
         return false; // Resolve immediately indicating no rollback needed/possible
     }
     // If patches exist, queue the rollback. The promise resolves with true if processed, rejects on error.
     return this._queue.add(() => this._performRollback(operationId));
  }

  // --- Cache methods proxy to cacheManager's queue ---

  async applyMutationToCache(operationId, mutator) {
    if (!this.cacheManager) return 0; // Indicate 0 count
    return this.cacheManager.applyMutation(operationId, mutator, "cache");
  }

  async insertToCache(operationId, items) {
    if (!this.cacheManager) return 0;
    return this.cacheManager.insert(operationId, items, { position: 'append' });
  }

  async removeFromCache(operationId, filterFn) {
     if (!this.cacheManager) return 0;
    return this.cacheManager.remove(operationId, filterFn, false, "delete");
  }

  async rollbackCache(operationId) {
    if (!this.cacheManager) return false; // Indicate rollback not possible
    return this.cacheManager.rollback(operationId);
  }

  /**
   * Cleans up old operation records (synchronous is fine).
   */
   cleanupOperations(maxAgeMs = 60000) {
       const cutoff = Date.now() - maxAgeMs;
       for (const [id, operations] of this.operationPatches.entries()) {
           if (operations.length > 0 && operations[0].timestamp < cutoff) {
               this.operationPatches.delete(id);
           } else if (operations.length === 0) {
               this.operationPatches.delete(id);
           }
       }
    }
}