import { nanoid } from 'nanoid';

/**
 * A specialized manager for numerical metrics with optimistic updates
 * Focused on handling incremental changes (additions/subtractions)
 * Provides a computed view that combines ground truth with pending optimistic operations
 */
export class SyncedNumber {
  /**
   * @param {Object} options
   * @param {number} options.initialValue - Initial ground truth value
   * @param {Function} [options.onChange] - Callback for when view value changes (newValue, prevValue)
   */
  constructor({
    initialValue = 0,
    onChange = () => {}
  }) {
    this.onChange = onChange;
    
    // Main data stores
    this.groundTruth = initialValue;
    this.optimisticOps = new Map();
    
    // Cache of latest computed view
    this._viewCache = null;
  }

  /**
   * Get the current view value (computed from ground truth + optimistic ops)
   * @returns {number} The current computed value
   */
  get value() {
    if (this._viewCache === null) {
      this._viewCache = this._computeView();
    }
    return this._viewCache;
  }

  /**
   * Applies all operations to produce the current view value
   * @private
   */
  _computeView() {
    let finalValue = this.groundTruth;
    
    // Process all operations in timestamp order
    const sortedOps = [...this.optimisticOps.values()]
      .sort((a, b) => a.timestamp - b.timestamp);
    
    // Apply all deltas
    for (const op of sortedOps) {
      finalValue += op.delta;
    }
    
    return finalValue;
  }
  
  /**
   * Updates the cache and triggers change notifications
   * @private
   */
  _updateView() {
    const prevView = this._viewCache;
    this._viewCache = null; // Clear cache to force recomputation
    
    const newView = this.value;
    
    // Check if the value actually changed
    if (prevView !== newView) {
      this.onChange(newView, prevView);
    }
  }
  
  // --- OPTIMISTIC OPERATIONS ---
  
  /**
   * Apply an optimistic increment/decrement
   * @param {string} id - Operation ID
   * @param {number} delta - The amount to change (positive for increment, negative for decrement)
   * @returns {string} The operation ID
   */
  updateOptimistic(id, delta) {
    if (!id) {
      throw new Error('Operation ID is required for optimistic operations');
    }
    
    // Ensure delta is a number
    const numericDelta = Number(delta);
    if (isNaN(numericDelta)) {
      throw new Error('Delta must be a valid number');
    }
    
    this.optimisticOps.set(id, { 
      id,
      delta: numericDelta,
      timestamp: Date.now()
    });
    
    this._updateView();
    return id;
  }
  
  // --- DIRECT GROUND TRUTH OPERATIONS ---
  
  /**
   * Update the ground truth value directly
   * @param {number} newValue - The new ground truth value
   * @returns {number} The previous ground truth value
   */
  setDirect(newValue) {
    // Ensure new value is a number
    const numericValue = Number(newValue);
    if (isNaN(numericValue)) {
      throw new Error('Value must be a valid number');
    }
    
    const prevValue = this.groundTruth;
    this.groundTruth = numericValue;
    
    this._updateView();
    return prevValue;
  }
  
  /**
   * Increment/decrement the ground truth value directly
   * @param {number} delta - Amount to change (positive for increment, negative for decrement)
   * @returns {number} The new ground truth value
   */
  updateDirect(delta) {
    // Ensure delta is a number
    const numericDelta = Number(delta);
    if (isNaN(numericDelta)) {
      throw new Error('Delta must be a valid number');
    }
    
    this.groundTruth += numericDelta;
    
    this._updateView();
    return this.groundTruth;
  }
  
  // --- OPTIMISTIC OPERATION MANAGEMENT ---
  
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
  
  /**
   * Confirm an optimistic operation by applying it to ground truth and removing the op
   * @param {string} id - The operation ID to confirm
   * @param {number} [serverDelta=null] - Optional server-confirmed delta value
   * @returns {boolean} Whether the operation was found and confirmed
   */
  confirmOptimisticOp(id, serverDelta = null) {
    const op = this.optimisticOps.get(id);
    if (!op) {
      return false; // Operation not found
    }
    
    // Remove the optimistic operation
    this.optimisticOps.delete(id);
    
    // Apply the delta to ground truth
    // Use serverDelta if provided, otherwise use the original op delta
    const deltaToApply = serverDelta !== null ? Number(serverDelta) : op.delta;
    if (!isNaN(deltaToApply)) {
      this.groundTruth += deltaToApply;
    }
    
    this._updateView();
    return true;
  }
  
  /**
   * Clear all optimistic operations
   * @returns {number} Number of operations cleared
   */
  clearOptimisticOps() {
    const count = this.optimisticOps.size;
    
    if (count > 0) {
      this.optimisticOps.clear();
      this._updateView();
    }
    
    return count;
  }
  
  /**
   * Get the current ground truth value
   * @returns {number} The ground truth value
   */
  getGroundTruth() {
    return this.groundTruth;
  }
  
  /**
   * Get all current optimistic operations
   * @returns {Map} The optimistic operations map
   */
  getOptimisticOps() {
    return this.optimisticOps;
  }

  /**
   * Resets the ground truth and optionally clears optimistic operations.
   * Useful when completely refreshing data.
   * @param {number} newValue - The new ground truth value.
   * @param {boolean} [clearOptimistic=true] - Whether to clear optimistic ops.
   */
  resetGroundTruth(newValue, clearOptimistic = true) {
    const numericValue = Number(newValue);
    if (isNaN(numericValue)) {
      throw new Error('Value must be a valid number');
    }
    this.groundTruth = numericValue;

    if (clearOptimistic) {
      this.optimisticOps.clear();
    }
    this._updateView(); // Update the view based on new ground truth + remaining ops
  }
}