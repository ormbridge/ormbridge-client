/**
 * OverfetchCache - Maintains a synchronized cache of the "next page" of items
 * When items are deleted from the main view, this provides replacements
 */
export class OverfetchCache {
  /**
   * @param {QuerySet} qs - The QuerySet to use for fetching items
   * @param {Object} options - Options from LiveView
   * @param {number} cacheSize - Number of items to keep in cache (defaults to limit)
   */
  constructor(qs, options, cacheSize = null) {
    this.qs = qs;
    this.options = options;
    this.serializerOptions = options?.serializer || {};
    this.cacheItems = [];
    this.limit = this.serializerOptions.limit || 0;
    this.offset = this.serializerOptions.offset || 0;
    this.cacheSize = cacheSize || this.limit; // Default to same as limit
    this.ModelClass = qs.ModelClass;
    this.primaryKeyField = this.ModelClass.primaryKeyField || 'id';
    this.isFetching = false;
  }

  /**
   * Initialize the cache by fetching the next page of items
   * @returns {Promise<void>}
   */
  async initialize() {
    if (!this.limit) {
      console.warn('OverfetchCache: No limit set in serializer options, caching disabled');
      return;
    }
    
    // Fetch the next page
    await this.refreshCache();
  }

  /**
   * Refresh the cache by fetching the next page beyond the current view
   * @returns {Promise<void>}
   */
  async refreshCache() {
    if (!this.limit || this.isFetching) return;
    
    try {
      this.isFetching = true;
      
      // Calculate the next offset beyond what's visible
      const nextOffset = this.offset + this.limit;
      
      // Clone the serializer options and update for next page
      const fetchOptions = {
        ...this.serializerOptions,
        offset: nextOffset,
        limit: this.cacheSize
      };
      
      // Fetch the next page
      const nextPageItems = await this.qs.fetch(fetchOptions);
      
      // Replace the entire cache
      this.cacheItems = nextPageItems;
      
    } catch (error) {
      console.error('OverfetchCache: Error refreshing cache:', error);
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Reset the cache with a new QuerySet and/or options
   * Use this when the underlying query or pagination options change
   * 
   * @param {Object} params - Reset parameters
   * @param {QuerySet} [params.newQs] - New QuerySet to use
   * @param {Object} [params.newOptions] - New options to use (e.g., serializer)
   * @param {number} [params.newCacheSize] - New cache size
   * @returns {Promise<void>}
   */
  async reset({ newQs, newOptions, newCacheSize } = {}) {
    // Update QuerySet if provided
    if (newQs) {
      // Ensure model consistency
      if (newQs.ModelClass !== this.ModelClass) {
        throw new Error("Cannot reset OverfetchCache with a different model class");
      }
      this.qs = newQs;
    }
    
    // Update options if provided
    if (newOptions) {
      this.options = newOptions;
      this.serializerOptions = newOptions.serializer || {};
      this.limit = this.serializerOptions.limit || 0;
      this.offset = this.serializerOptions.offset || 0;
    }
    
    // Update cache size if provided
    if (newCacheSize !== undefined) {
      this.cacheSize = newCacheSize;
    }
    
    // Clear the current cache
    this.cacheItems = [];
    
    // Fetch fresh data
    return this.initialize();
  }
  
  /**
   * Get replacement items from the cache
   * @param {number} count - Number of items needed
   * @returns {Promise<Array>} Promise resolving to replacement items from cache
   */
  getReplacements(count) {
    if (count <= 0) return [];
    
    // Take items from the cache
    const itemsToReturn = Math.min(count, this.cacheItems.length);
    const replacements = this.cacheItems.splice(0, itemsToReturn);
    
    return replacements;
  }
  
  /**
   * Handle any data change event (update, delete, bulk operations)
   * Only refreshes the cache if affected items are in the cache
   * @param {Array} affectedIds - Array of IDs of affected items
   */
  handleDataChange(affectedIds = []) {
    // Check if any of the affected IDs are in our cache
    const shouldRefresh = affectedIds.some(id => 
      this.cacheItems.some(item => item[this.primaryKeyField] === id)
    );
    
    if (shouldRefresh) {
      this.refreshCache();
    }
  }
    
  /**
   * Get current cache status
   * @returns {Object} The cache status
   */
  getStatus() {
    return {
      cacheItemCount: this.cacheItems.length,
      targetSize: this.cacheSize,
      currentOffset: this.offset,
      isFetching: this.isFetching
    };
  }
}