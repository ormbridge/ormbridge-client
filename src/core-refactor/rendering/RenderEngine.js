/**
 * RenderEngine processes and combines groundTruth with pending operations
 * to produce the current view of data with pagination and sorting.
 */
export class RenderEngine {
    /**
     * Create a new RenderEngine
     * @param {QueryState} queryState - The QueryState instance to bind to
     */
    constructor(queryState) {
      this.queryState = queryState;
      this.pkField = queryState.pkField;
      
      // Cache the last rendered result to optimize repeated fetches with same params
      this._cache = {
        queryStateVersion: -1,
        processedData: null
      };
    }
  
    /**
     * Get rendered data with pagination and optional sorting
     * @param {Object} params - Rendering parameters
     * @param {number} params.offset - Starting index (0-based)
     * @param {number} params.limit - Maximum number of items to return
     * @param {Function} [params.sortFn] - Optional custom sort function (a, b) => number
     * @returns {Array} Rendered data subset
     */
    render(params) {
      // Ensure defaults
      const { offset = 0, limit, sortFn } = params;

      let processedData;

      // Check if cache is valid based *only* on the queryState version
      if (this._cache.processedData !== null &&
          this._cache.queryStateVersion === this.queryState.version) {
        // Cache HIT: Use the cached processed data
        processedData = this._cache.processedData;
      } else {
        // Cache MISS or INVALID: Recalculate the processed data
        processedData = this._processOperations();
        // Update the cache
        this._cache.processedData = processedData;
        this._cache.queryStateVersion = this.queryState.version;
      }

      // Sort the data obtained from cache or recalculation
      const sortedData = this._applySorting(processedData, sortFn);

      // Calculate the end index for slicing
      const end = limit !== undefined ? offset + limit : sortedData.length;
      // Slice the *sorted* data
      const paginatedData = sortedData.slice(offset, end);

      return paginatedData;
    }
  
    /**
     * Update the cache with new result
     * @private
     */
    _updateCache(params, fullResult) {
      this._cache = {
        queryStateVersion: this.queryState.version,
        params: { ...params },
        result: fullResult
      };
    }
  
    /**
     * Process all operations on top of ground truth to build current state
     * @private
     * @returns {Array} Current state after applying all operations
     */
    _processOperations() {
      // Start with a copy of ground truth
      const result = new Map();
      
      // Add ground truth items to the map
      this.queryState.getGroundTruth().forEach(item => {
        result.set(item[this.pkField], { ...item });
      });
      
      // Apply operations in order
      const operations = Array.from(this.queryState.operations.values())
        .filter(op => op.status !== 'rejected')
        .sort((a, b) => a.operationId.localeCompare(b.operationId));
      
      for (const operation of operations) {
        this._applyOperation(operation, result);
      }
      
      // Convert map back to array
      return Array.from(result.values());
    }
  
    /**
     * Apply a single operation to the result map
     * @private
     */
    _applyOperation(operation, resultMap) {
        const { type, instances } = operation;
        
        instances.forEach(instance => {
            const id = instance[this.pkField] || instance; // allow pks or instances (deletes);
            
            switch (type) {
            case 'create':
                if (!resultMap.has(id)) {
                resultMap.set(id, instance);
                }
                break;
                
            case 'update':
                if (resultMap.has(id)) {
                Object.assign(resultMap.get(id), instance);
                }
                break;
                
            case 'delete':
                resultMap.delete(id);
                break;
            }
        });
    }
  
    /**
     * Apply sorting to the data
     * @private
     * @param {Array} data - Data to sort
     * @param {Function} sortFn - Custom sort function (a, b) => number
     * @returns {Array} Sorted data
     */
    _applySorting(data, sortFn) {
      if (!sortFn || typeof sortFn !== 'function') {
        return [...data]; // Return a copy without sorting
      }
      
      return [...data].sort(sortFn);
    }
  
    /**
     * Subscribe to changes in queryState to invalidate cache
     */
    subscribeToChanges() {
      return this.queryState.subscribe(() => {
        // Invalidate cache when queryState changes
        this._cache.queryStateVersion = -1;
        this._cache.processedData = null;
      });
    }
  
    /**
     * Clean up resources
     */
    destroy() {
      this._cache = null;
    }
  }