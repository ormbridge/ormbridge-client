import { create, apply } from 'mutative';

/**
 * Manages array operations with automatic patching and rollback capabilities
 * using Mutative's JSON patch functionality.
 */
export class OperationsManager {
  /**
   * @param {Array} dataArray - Reference to the array to be managed
   * @param {Function} notifyCallback - Function to call on data changes (type: 'create'|'update'|'delete')
   */
  constructor(dataArray, notifyCallback) {
    this.dataArray = dataArray;
    this.notify = notifyCallback;
    this.operationPatches = new Map();
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
    
    try {
        // Use Mutative's create function with enablePatches to get patches and inverse patches
        const [newState, patches, inversePatches] = create(
            this.dataArray,
            (draft) => {
                // Execute mutator but don't return its result
                mutator(draft);
                // No explicit return
            },
            { enablePatches: true }
        );
        
        // No changes were made
        if (patches.length === 0) {
            return false;
        }
        
        // Store inverse patches for potential rollback
        this.operationPatches.set(operationId, {
            inversePatches,
            eventType,
            timestamp: Date.now()
        });
        this.dataArray.length = 0;

        // Use push.apply for better performance with large arrays
        Array.prototype.push.apply(this.dataArray, newState);
        this.notify(eventType);
        
        return true;
    } catch (error) {
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
  insert(operationId, items, options = {}) {
    const itemsArray = Array.isArray(items) ? items : [items];
    if (itemsArray.length === 0) {
      return false;
    }
    
    const position = options.position || 'append';
    const limit = options.limit;
    const fixedPageSize = options.fixedPageSize;
    
    return this.applyMutation(
      operationId,
      (draft) => {
        if (position === 'append') {
          // When appending with a limit and fixed size
          if (limit !== undefined && fixedPageSize && draft.length >= limit) {
            return; // No changes when at limit with fixed size
          }
          
          // Add items
          draft.push(...itemsArray);
          
          // Trim to limit if needed and not fixed size
          if (limit !== undefined && !fixedPageSize && draft.length > limit) {
            draft.splice(limit);
          }
        } else { // prepend
          if (limit !== undefined && fixedPageSize && draft.length >= limit) {
            // Remove from end to make room
            draft.splice(draft.length - Math.min(itemsArray.length, draft.length));
          }
          
          // Add to beginning
          draft.unshift(...itemsArray);
          
          // Trim to limit if needed and not fixed size
          if (limit !== undefined && !fixedPageSize && draft.length > limit) {
            draft.splice(limit);
          }
        }
      },
      'create'
    );
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
    const result = this.applyMutation(
        operationId,
        (draft) => {
            for (let i = 0; i < draft.length; i++) {
                if (filterFn(draft[i])) {
                    // Instead of Object.assign, create a completely new object
                    const oldItem = draft[i];
                    const newItem = { ...oldItem, ...updates };
                    
                    // Replace the old item with the new one
                    draft[i] = newItem;
                    updateCount++;
                }
            }
        },
        'update'
    );
    return result ? updateCount : 0;
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
    
    const result = this.applyMutation(
        operationId,
        (draft) => {            
            // Log the items that match the filter
            const toRemove = [];
            for (let i = 0; i < draft.length; i++) {
                if (filterFn(draft[i])) {
                    toRemove.push({index: i, item: draft[i]});
                }
            }            
            // Important: iterate backwards to avoid index issues when removing items
            for (let i = draft.length - 1; i >= 0; i--) {
                if (filterFn(draft[i])) {
                    draft.splice(i, 1);
                    removeCount++;
                }
            }
            // Don't return anything here
        },
        'delete'
    );
    
    return result ? removeCount : 0;
}

  /**
   * Rolls back an operation by applying its inverse patches
   * 
   * @param {string} operationId - ID of the operation to roll back
   * @returns {boolean} Whether the rollback was successful
   */
  rollback(operationId) {
    const operation = this.operationPatches.get(operationId);
    if (!operation) {
      return false;
    }
    
    try {
      // Apply inverse patches to revert changes
      const restoredState = apply(this.dataArray, operation.inversePatches);
      
      // Update array reference
      this.dataArray.length = 0;
      this.dataArray.push(...restoredState);
      
      // Determine inverse event type for notification
      let notifyEventType;
      switch (operation.eventType) {
        case 'create':
          notifyEventType = 'delete';
          break;
        case 'delete':
          notifyEventType = 'create';
          break;
        default:
          notifyEventType = 'update';
          break;
      }
      
      // Notify about the rollback
      this.notify(notifyEventType);
      
      // Remove the operation record
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
    
    for (const [id, operation] of this.operationPatches.entries()) {
      if (operation.timestamp < cutoff) {
        this.operationPatches.delete(id);
      }
    }
  }
}