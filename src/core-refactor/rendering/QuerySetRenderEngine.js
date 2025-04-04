/**
 * QuerySetRenderEngine processes and combines groundTruth IDs with pending operations
 * to produce the current view of IDs with pagination and sorting.
 * 
 * This is completely decoupled and only works with IDs, not models.
 */
export class QuerySetRenderEngine {
  /**
   * Create a new QuerySetRenderEngine
   * @param {QuerySetStore} querySetStore - The QuerySetStore instance to bind to
   */
  constructor(querySetStore) {
    this.querySetStore = querySetStore;
    
    // Cache the last rendered result to optimize repeated fetches with same params
    this._cache = {
      queryStateVersion: -1,
      processedIds: null
    };
  }

  /**
   * Get rendered IDs with pagination and optional sorting
   * 
   * @param {Object} params - Rendering parameters
   * @param {number} params.offset - Starting index (0-based)
   * @param {number} params.limit - Maximum number of items to return
   * @param {Function} [params.sortFn] - Optional sort function for IDs (a, b) => number
   * @returns {Array} Rendered IDs subset
   */
  render(params) {
    // Ensure defaults
    const { offset = 0, limit, sortFn } = params;

    let processedIds;

    // Check if cache is valid based on QuerySetStore version
    if (this._cache.processedIds !== null &&
        this._cache.queryStateVersion === this.querySetStore.version) {
      // Cache HIT: Use the cached processed IDs
      processedIds = this._cache.processedIds;
    } else {
      // Cache MISS or INVALID: Recalculate the processed IDs
      processedIds = this._processOperations();
      // Update the cache
      this._cache.processedIds = processedIds;
      this._cache.queryStateVersion = this.querySetStore.version;
    }

    // Sort IDs if sortFn provided
    const sortedIds = this._applySorting(processedIds, sortFn);
    
    // Apply pagination
    if (limit === null || limit === undefined) {
      return sortedIds.slice(offset);
    }
    return sortedIds.slice(offset, offset + limit);
  }

  /**
   * Process all operations on top of ground truth to build current state (IDs only)
   * @private
   * @returns {Array} Current list of IDs after applying all operations
   */
  _processOperations() {
    // Simply delegate to QuerySetStore's internal method
    return this.querySetStore.getCurrentIds();
  }

  /**
   * Apply sorting to IDs
   * @private
   * @param {Array} ids - IDs to sort
   * @param {Function} sortFn - Custom sort function (a, b) => number
   * @returns {Array} Sorted IDs
   */
  _applySorting(ids, sortFn) {
    if (!sortFn || typeof sortFn !== 'function') {
      return [...ids]; // Return a copy without sorting
    }
    
    return [...ids].sort(sortFn);
  }

  /**
   * Subscribe to changes in querySetStore to invalidate cache
   */
  subscribeToChanges() {
    return this.querySetStore.subscribe(() => {
      // Invalidate cache when querySetStore changes
      this._cache.queryStateVersion = -1;
      this._cache.processedIds = null;
    });
  }

  /**
   * Get count of items after applying operations
   * @returns {number} Current count of items
   */
  getCount() {
    // Process operations to get current IDs
    let processedIds;
    
    if (this._cache.processedIds !== null &&
        this._cache.queryStateVersion === this.querySetStore.version) {
      // Use cached IDs if valid
      processedIds = this._cache.processedIds;
    } else {
      // Recalculate if needed
      processedIds = this._processOperations();
      this._cache.processedIds = processedIds;
      this._cache.queryStateVersion = this.querySetStore.version;
    }
    
    return processedIds.length;
  }

  /**
   * Clean up resources
   */
  destroy() {
    this._cache = null;
  }
}