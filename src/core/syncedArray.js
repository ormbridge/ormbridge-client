import { create } from 'mutative';
import { nanoid } from 'nanoid';
import { arrayBuffer } from 'stream/consumers';

/**
 * A simplified manager for array state with optimistic updates
 * Focused solely on synchronization and optimistic updates
 * with separate methods for optimistic and direct operations
 * 
 * Enhanced to provide idempotent behavior for duplicate primary keys
 */
export class SyncedArray {
  /**
   * @param {Object} options
   * @param {Array} options.initialData - Initial ground truth data
   * @param {string} options.primaryKey - Field to use as primary key (default: 'id')
   * @param {Function} [options.onChange] - Callback for when view data changes (newData, prevData)
   * @param {Class} [options.ItemClass] - Class constructor to use for creating instances
   */
  constructor({
    initialData = [],
    primaryKey = 'id',
    onChange = () => {},
    ItemClass = null,
    maxSize = null
  }) {
    this.primaryKey = primaryKey;
    this.onChange = onChange;
    this.ItemClass = ItemClass;
    
    // Main data stores
    this.groundTruth = [...initialData];
    this.optimisticOps = new Map();
    
    // Cache of latest computed view
    this._viewCache = null;
  }

  /**
   * Get the current view of data (computed from ground truth + optimistic ops)
   * @returns {Array} The current view data
   */
  get data() {
    if (!this._viewCache) {
      this._viewCache = this._computeView();
    }
    return this._viewCache;
  }

  /**
   * Slice the array to limit it to the max size
   */
  applySizeLimit(arr){
    if (!this.maxSize) return arr;
    return arr.slice(0, this.maxSize)
  }

  /**
   * Applies all operations to produce the current view
   * @private
   */
  _computeView() {
    const finalResult = create(
      this.groundTruth, 
      draft => {
        // Track items created optimistically by operation ID
        const optimisticItems = new Map();
        
        // Process all operations in timestamp order
        const sortedOps = [...this.optimisticOps.values()]
          .sort((a, b) => a.timestamp - b.timestamp);
        
        for (const op of sortedOps) {
          const { type, id, data, key } = op;
          
          switch (type) {
            case 'create': {
              // Create a new item with operation ID as temp key
              const newItem = this._copyData(data);
              // Assign the primary key
              newItem[this.primaryKey] = id;
              
              // Check if an item with this ID already exists in the draft
              const existingIdx = draft.findIndex(item => item[this.primaryKey] === id);
              if (existingIdx === -1) {
                // Only insert if it doesn't exist already
                this._insertAtPosition(draft, newItem, op.position);
                optimisticItems.set(id, newItem);
              }
              break;
            }
            
            case 'update': {
              const pk = key;
              // First check if it's an optimistic item we created
              if (optimisticItems.has(pk)) {
                const idx = draft.findIndex(item => item[this.primaryKey] === pk);
                if (idx !== -1) {
                  // Use our helper method for consistent copying
                  draft[idx] = this._copyData(draft[idx]);
                  // Then apply the updates
                  Object.assign(draft[idx], data);
                }
              } else {
                // Otherwise look for it in the regular items
                const idx = draft.findIndex(item => item[this.primaryKey] === pk);
                if (idx !== -1) {
                  // Use our helper method for consistent copying
                  draft[idx] = this._copyData(draft[idx]);
                  // Then apply the updates
                  Object.assign(draft[idx], data);
                }
              }
              break;
            }
            
            case 'delete': {
              const pk = key;
              const idx = draft.findIndex(item => item[this.primaryKey] === pk);
              if (idx !== -1) {
                draft.splice(idx, 1);
                if (optimisticItems.has(pk)) {
                  optimisticItems.delete(pk);
                }
              }
              break;
            }
          }
        }
      },
      { enableAutoFreeze: false }
    );
    
    return finalResult;
  }
  
  /**
   * Updates the cache and triggers change notifications
   * @private
   */
  _updateView() {
    const prevView = this._viewCache;
    this._viewCache = null; // Clear cache to force recomputation
    
    const newView = this.data;
    
    // Check if the data actually changed
    const hasChanged = !prevView || 
      prevView.length !== newView.length ||
      !this._areArraysEqual(prevView, newView);
    
    if (hasChanged && prevView) {
      this.onChange(newView, prevView);
    }
  }
  
  /**
   * Check if arrays have the same items by comparing serialized versions
   * @private
   */
  _areArraysEqual(arr1, arr2) {
    if (arr1.length !== arr2.length) return false;
    
    for (let i = 0; i < arr1.length; i++) {
      // Use serialize if available, otherwise use JSON.stringify
      const str1 = arr1[i].serialize ? arr1[i].serialize() : JSON.stringify(arr1[i]);
      const str2 = arr2[i].serialize ? arr2[i].serialize() : JSON.stringify(arr2[i]);
      
      if (str1 !== str2) {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Helper method to create a copy of an item using the ItemClass constructor
   * @private
   * @param {Object} data - The data to copy
   * @returns {Object} A new instance of ItemClass or plain object copy
   */
  _copyData(data) {
    // For null/undefined, return an empty object
    if (data == null) return {};
    
    // If ItemClass is provided, use it to create a new instance
    if (this.ItemClass) {
      return new this.ItemClass(data);
    }
    
    // Fallback to plain object copy for backward compatibility
    return Object.assign({}, data);
  }
  
  /**
   * Helper method to determine insertion index from a position
   * @private
   * @param {number|Function} position - Position value or function
   * @param {Object} item - The item being positioned
   * @param {Array} array - The array to position within
   * @returns {number|undefined} The calculated index or undefined for append
   */
  _getInsertionIndex(position, item, array) {
    if (typeof position === 'function') {
      return position(item, array);
    } else if (typeof position === 'number') {
      return position;
    }
    return undefined; // Default: append
  }
  
  /**
   * Helper method to insert an item into an array at a given position
   * @private
   * @param {Array} array - The array to modify
   * @param {Object} item - The item to insert
   * @param {number|Function} position - Position value or function
   * @returns {void}
   */
  _insertAtPosition(array, item, position) {
    const index = this._getInsertionIndex(position, item, array);
    
    if (index !== undefined && index >= 0 && index <= array.length) {
      array.splice(index, 0, item);
    } else {
      array.push(item);
    }
  }
  
  /**
   * Check if an item with the given primary key already exists in the array
   * @private
   * @param {Array} array - The array to check
   * @param {string|number} pk - The primary key to look for
   * @returns {boolean} Whether the key exists
   */
  _hasPrimaryKey(array, pk) {
    return array.some(item => item[this.primaryKey] === pk);
  }
  
  /**
   * Safely add an item to the array, preventing primary key duplication
   * If an item with the same PK already exists, it will be updated instead
   * @private
   * @param {Array} array - The array to modify
   * @param {Object} item - The item to insert or update
   * @param {number|Function} position - Position for new items only
   * @returns {boolean} Whether a new item was added (false if updated existing)
   */
  _safeAddToArray(array, item, position) {
    const pk = item[this.primaryKey];
    
    // If no primary key is defined, just add normally
    if (pk === undefined) {
      this._insertAtPosition(array, item, position);
      return true;
    }
    
    // Check for existing item with the same primary key
    const existingIdx = array.findIndex(existing => existing[this.primaryKey] === pk);
    
    if (existingIdx === -1) {
      // Item doesn't exist yet, add it
      this._insertAtPosition(array, item, position);
      return true;
    } else {
      // Item already exists, update it
      array[existingIdx] = this._copyData({ ...array[existingIdx], ...item });
      return false;
    }
  }
  
  // --- OPTIMISTIC OPERATIONS ---
  
  /**
   * Create a new item optimistically 
   * @param {Object} options - Operation options
   * @param {string} options.id - Operation ID (required)
   * @param {number|Function} [options.position] - Insertion position
   * @param {Object} data - Item data to create
   * @returns {string} The operation ID
   */
  createOptimistic(options, data) {
    const { id, position } = options;
    
    if (!id) {
      throw new Error('Operation ID is required for optimistic create operations');
    }
    
    this.optimisticOps.set(id, { 
      type: 'create',
      id,
      data,
      position,
      timestamp: Date.now()
    });
    
    this._updateView();
    return id;
  }
  
  /**
   * Update an existing item optimistically
   * @param {Object} options - Operation options
   * @param {string} options.id - Operation ID (required)
   * @param {string|number} options.key - Primary key of item to update
   * @param {Object} data - Update data
   * @returns {string} The operation ID
   */
  updateOptimistic(options, data) {
    const { id, key } = options;
    
    if (!id) {
      throw new Error('Operation ID is required for optimistic update operations');
    }
    
    this.optimisticOps.set(id, {
      type: 'update',
      id,
      key,
      data,
      timestamp: Date.now()
    });
    
    this._updateView();
    return id;
  }
  
  /**
   * Delete an item optimistically
   * @param {Object} options - Operation options
   * @param {string} options.id - Operation ID (required)
   * @param {string|number} options.key - Primary key of item to delete
   * @returns {string} The operation ID
   */
  deleteOptimistic(options) {
    const { id, key } = options;
    
    if (!id) {
      throw new Error('Operation ID is required for optimistic delete operations');
    }
    
    this.optimisticOps.set(id, {
      type: 'delete',
      id,
      key,
      timestamp: Date.now()
    });
    
    this._updateView();
    return id;
  }
  
  /**
   * Create multiple items optimistically at once
   * @param {Array<{id: string, position?: number|Function, data: Object}>} items - Items to create
   * @returns {Array<string>} The operation IDs
   */
  bulkCreateOptimistic(items) {
    if (!items || items.length === 0) {
      return [];
    }
    
    // Validate that all items have IDs
    const missingIds = items.filter(item => !item.id);
    if (missingIds.length > 0) {
      throw new Error(`Operation IDs are required for all items in optimistic bulk create (${missingIds.length} missing)`);
    }
    
    const operationIds = [];
    const timestamp = Date.now();
    
    // Create optimistic operations for all items
    items.forEach(item => {
      const { id, position, data } = item;
      
      this.optimisticOps.set(id, {
        type: 'create',
        id,
        data,
        position,
        timestamp
      });
      
      operationIds.push(id);
    });
    
    this._updateView();
    return operationIds;
  }
  
  /**
   * Update multiple items optimistically at once
   * @param {Array<{id: string, key: string|number, data: Object}>} items - Items to update
   * @returns {Array<string>} The operation IDs
   */
  bulkUpdateOptimistic(items) {
    if (!items || items.length === 0) {
      return [];
    }
    
    // Validate that all items have IDs
    const missingIds = items.filter(item => !item.id);
    if (missingIds.length > 0) {
      throw new Error(`Operation IDs are required for all items in optimistic bulk update (${missingIds.length} missing)`);
    }
    
    const operationIds = [];
    const timestamp = Date.now();
    
    // Create optimistic operations for all updates
    items.forEach(item => {
      const { id, key, data } = item;
      
      this.optimisticOps.set(id, {
        type: 'update',
        id,
        key,
        data,
        timestamp
      });
      
      operationIds.push(id);
    });
    
    this._updateView();
    return operationIds;
  }
  
  /**
   * Delete multiple items optimistically at once
   * @param {Array<{id: string, key: string|number}>} items - Items to delete
   * @returns {Array<string>} The operation IDs
   */
  bulkDeleteOptimistic(items) {
    if (!items || items.length === 0) {
      return [];
    }
    
    // Validate that all items have IDs
    const missingIds = items.filter(item => !item.id);
    if (missingIds.length > 0) {
      throw new Error(`Operation IDs are required for all items in optimistic bulk delete (${missingIds.length} missing)`);
    }
    
    const operationIds = [];
    const timestamp = Date.now();
    
    // Create optimistic operations for all deletions
    items.forEach(item => {
      const { id, key } = item;
      
      this.optimisticOps.set(id, {
        type: 'delete',
        id,
        key,
        timestamp
      });
      
      operationIds.push(id);
    });
    
    this._updateView();
    return operationIds;
  }
  
  // --- DIRECT GROUND TRUTH OPERATIONS ---
  
  /**
   * Create a new item directly in ground truth
   * @param {Object} options - Operation options
   * @param {number|Function} [options.position] - Insertion position
   * @param {Object} data - Item data to create
   * @returns {boolean} Whether a new item was created (false if existing was updated)
   */
  createDirect(options, data) {
    const { position } = options;
    
    const newItem = this._copyData(data);
    const wasAdded = this._safeAddToArray(this.groundTruth, newItem, position);
    
    this._updateView();
    return wasAdded;
  }
  
  /**
   * Update an existing item directly in ground truth
   * @param {Object} options - Operation options
   * @param {string|number} options.key - Primary key of item to update
   * @param {Object} data - Update data
   * @returns {boolean} Whether the item was found and updated
   */
  updateDirect(options, data) {
    const { key } = options;
    
    const idx = this.groundTruth.findIndex(item => item[this.primaryKey] === key);
    if (idx !== -1) {
      // Make a copy first, then apply updates
      const itemCopy = this._copyData(this.groundTruth[idx]);
      this.groundTruth[idx] = Object.assign(itemCopy, data);
      this._updateView();
      return true;
    }
    
    return false;
  }
  
  /**
   * Delete an item directly from ground truth
   * @param {Object} options - Operation options
   * @param {string|number} options.key - Primary key of item to delete
   * @returns {boolean} Whether the item was found and deleted
   */
  deleteDirect(options) {
    const { key } = options;
    
    const initialLength = this.groundTruth.length;
    this.groundTruth = this.groundTruth.filter(
      item => item[this.primaryKey] !== key
    );
    
    const deleted = this.groundTruth.length < initialLength;
    if (deleted) {
      this._updateView();
    }
    
    return deleted;
  }
  
  /**
   * Create multiple items directly in ground truth
   * @param {Array<{position?: number|Function, data: Object}>} items - Items to create
   * @returns {number} Number of new items created (not counting updates to existing items)
   */
  bulkCreateDirect(items) {
    if (!items || items.length === 0) {
      return 0;
    }
    
    let newItemCount = 0;
    
    // Process each item individually to handle positions and uniqueness
    items.forEach(item => {
      const newItem = this._copyData(item.data);
      const wasAdded = this._safeAddToArray(this.groundTruth, newItem, item.position);
      if (wasAdded) {
        newItemCount++;
      }
    });
    
    this._updateView();
    return newItemCount;
  }
  
  /**
   * Update multiple items directly in ground truth
   * @param {Array<{key: string|number, data: Object}>} items - Items to update
   * @returns {number} Number of items updated
   */
  bulkUpdateDirect(items) {
    if (!items || items.length === 0) {
      return 0;
    }
    
    let updateCount = 0;
    
    // Update each item
    items.forEach(item => {
      const idx = this.groundTruth.findIndex(gtItem => gtItem[this.primaryKey] === item.key);
      if (idx !== -1) {
        // Make a copy first, then apply updates
        const itemCopy = this._copyData(this.groundTruth[idx]);
        this.groundTruth[idx] = Object.assign(itemCopy, item.data);
        updateCount++;
      }
    });
    
    if (updateCount > 0) {
      this._updateView();
    }
    
    return updateCount;
  }
  
  /**
   * Delete multiple items directly from ground truth
   * @param {Array<{key: string|number}>} items - Items to delete (or array of keys)
   * @returns {number} Number of items deleted
   */
  bulkDeleteDirect(items) {
    if (!items || items.length === 0) {
      return 0;
    }
    
    const initialLength = this.groundTruth.length;
    
    // Extract keys to delete
    const keys = items.map(item => typeof item === 'object' ? item.key : item);
    const keySet = new Set(keys);
    
    // Filter out deleted items
    this.groundTruth = this.groundTruth.filter(
      item => !keySet.has(item[this.primaryKey])
    );
    
    const deleteCount = initialLength - this.groundTruth.length;
    if (deleteCount > 0) {
      this._updateView();
    }
    
    return deleteCount;
  }
  
  /**
   * Remove an optimistic operation (e.g., after server confirms or rejects)
   * @param {string} id - The operation ID to remove
   * @returns {boolean} Whether the operation was found and removed
   */
  removeOptimisticOp(id) {
    const removed = this.optimisticOps.delete(id);
    if (removed) {
      this._updateView();
    }
    return removed;
  }

  // --- OPTIMISTIC OPERATION MANAGEMENT --- (Includes Confirmation)

  /**
   * Confirm an optimistic operation: attempts to apply the change to ground truth
   * using provided serverData or fallback to original op data, and ALWAYS removes
   * the optimistic op if found. Assumes input/state is generally trustworthy.
   *
   * @param {string} id - The operation ID to confirm.
   * @param {Object} [serverData] - Optional: Data confirmed by the server.
   * @returns {boolean} Whether the operation was found (and thus removed/processed).
   */
  confirmOptimisticOp(id, serverData = null) {
    const op = this.optimisticOps.get(id);
    if (!op) {
      return false; // Operation not found
    }

    // Preserve the location for create events to avoid jumping
    let currentIndex;
    if (op.type === 'create'){
      currentIndex = this.data.findIndex(item => item[this.primaryKey] === id);
    }

    // ALWAYS remove the optimistic operation once found.
    this.optimisticOps.delete(id);

    // Determine the data to apply to ground truth.
    // For create, ensure primary key exists, potentially falling back to op.id if serverData lacks it.
    // For update/delete, serverData takes precedence if provided.
    const dataToApply = serverData || op.data;

    // Attempt to apply the change to ground truth
    switch (op.type) {
      case 'create': {
        const newItem = this._copyData(dataToApply);
        // Ensure PK exists: Use server data's PK > op data's PK > optimistic ID
        if (newItem[this.primaryKey] === undefined) {
           newItem[this.primaryKey] = op.data?.[this.primaryKey] || id;
           if(newItem[this.primaryKey] === id) {
               console.warn(`Confirm 'create' op ${id}: Used optimistic ID as primary key fallback.`);
           }
        }
        
        // Instead of appending, use the safe add method to handle duplicates
        this._safeAddToArray(this.groundTruth, newItem, currentIndex);
        break;
      }
      case 'update': {
        const idx = this.groundTruth.findIndex(item => item[this.primaryKey] === op.key);
        if (idx !== -1) {
          // Use dataToApply, merging onto existing item
          this.groundTruth[idx] = this._copyData({ ...this.groundTruth[idx], ...dataToApply });
        }
        // If idx === -1, item was likely deleted - do nothing for update confirmation.
        break;
      }
      case 'delete': {
        this.groundTruth = this.groundTruth.filter(
          item => item[this.primaryKey] !== op.key
        );
        break;
      }
    }

    // Update the view since an optimistic operation was removed (and GT may have changed)
    this._updateView();

    return true; // Operation was found and removed.
  }

  /**
   * Confirm multiple optimistic operations at once efficiently.
   * Assumes input/state is generally trustworthy.
   *
   * @param {Array<{id: string, serverData?: Object}>} items - Ops to confirm.
   * @returns {number} Number of operations that were found (and thus removed/processed).
   */
  bulkConfirmOptimisticOps(items) {
    if (!items || items.length === 0) {
      return 0;
    }

    let processedCount = 0;
    let needsViewUpdate = false;
    const keysToDelete = new Set();
    const updatesToApply = new Map(); // Map key -> final data to merge
    const itemsToCreate = [];
    const originalOps = new Map(); // Store original op for fallback data

    // --- Stage 1: Find ops, remove them, stage ground truth changes ---
    for (const { id, serverData } of items) {
      const op = this.optimisticOps.get(id);
      if (!op) {
        continue; // Skip if op not found
      }

      // Always remove if found
      this.optimisticOps.delete(id);
      processedCount++;
      needsViewUpdate = true;
      originalOps.set(id, op); // Store op for data fallback if needed

      const dataToApply = serverData || op.data;

      switch (op.type) {
        case 'create': {
          const newItem = this._copyData(dataToApply);
           if (newItem[this.primaryKey] === undefined) {
             newItem[this.primaryKey] = op.data?.[this.primaryKey] || id;
             if(newItem[this.primaryKey] === id) {
                 console.warn(`Bulk confirm 'create' op ${id}: Used optimistic ID as primary key fallback.`);
             }
          }
          itemsToCreate.push(newItem);
          break;
        }
        case 'update':
          // Stage the final data to merge for this key
          updatesToApply.set(op.key, dataToApply);
          break;
        case 'delete':
          keysToDelete.add(op.key);
          break;
      }
    }

    // --- Stage 2: Apply staged ground truth changes efficiently ---
    // Apply Deletes first (potentially removes items targeted by updates)
    if (keysToDelete.size > 0) {
      this.groundTruth = this.groundTruth.filter(
        item => !keysToDelete.has(item[this.primaryKey])
      );
    }

    // Apply Updates (iterate through remaining ground truth)
    if (updatesToApply.size > 0) {
      this.groundTruth.forEach((item, index) => {
        const pk = item[this.primaryKey];
        if (updatesToApply.has(pk)) {
          const updateData = updatesToApply.get(pk);
          this.groundTruth[index] = this._copyData({ ...item, ...updateData });
        }
      });
    }

    // Apply Creates (using the idempotent approach to handle duplicates)
    if (itemsToCreate.length > 0) {
      // Check each item for duplicates and only add new ones
      const existingPKs = new Set(this.groundTruth.map(item => item[this.primaryKey]));
      
      for (const newItem of itemsToCreate) {
        const pk = newItem[this.primaryKey];
        
        if (pk !== undefined && !existingPKs.has(pk)) {
          this.groundTruth.push(newItem);
          existingPKs.add(pk); // Update our tracking set
        } else if (pk !== undefined) {
          // If it exists, update it instead
          const idx = this.groundTruth.findIndex(item => item[this.primaryKey] === pk);
          if (idx !== -1) {
            this.groundTruth[idx] = this._copyData({ ...this.groundTruth[idx], ...newItem });
          }
        }
      }
    }

    // --- Stage 3: Trigger view update once if needed ---
    if (needsViewUpdate) {
      this._updateView();
    }

    return processedCount;
  }
  
  /**
   * Remove multiple optimistic operations at once
   * @param {Array<string>} ids - Array of operation IDs to remove
   * @returns {number} Number of operations that were removed
   */
  bulkRemoveOptimisticOps(ids) {
    if (!ids || ids.length === 0) {
      return 0;
    }
    
    let removedCount = 0;
    
    ids.forEach(id => {
      if (this.optimisticOps.delete(id)) {
        removedCount++;
      }
    });
    
    if (removedCount > 0) {
      this._updateView();
    }
    
    return removedCount;
  }
  
  /**
   * Clear all optimistic operations
   * @returns {number} Number of operations that were cleared
   */
  clearOptimisticOps() {
    const count = this.optimisticOps.size;
    if (count > 0) {
      this.optimisticOps.clear();
      this._updateView();
    }
    return count;
  }
  
  // --- GROUND TRUTH MANAGEMENT ---
  
  /**
   * Replace the entire ground truth data set
   * @param {Array} data - New data array
   * @param {boolean} [clearOptimistic=true] - Whether to clear optimistic operations
   */
  resetGroundTruth(data, clearOptimistic = true) {
    this.groundTruth = [...data];
    
    if (clearOptimistic) {
      this.optimisticOps.clear();
    }
    
    this._updateView();
  }
  
  /**
   * Get a direct reference to the ground truth array
   * @returns {Array} The ground truth array
   */
  getGroundTruth() {
    return this.groundTruth;
  }
  
  /**
   * Get all current optimistic operations
   * @returns {Map<string, Object>} The optimistic operations map (returning a copy)
   */
  getOptimisticOps() {
    return new Map(this.optimisticOps);
  }
}