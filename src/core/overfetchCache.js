import { EventType } from './eventReceivers'

/**
 * OverfetchCache - Maintains a synchronized cache of items that don't exist in the main view
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
    this.cacheSize = cacheSize || this.limit; // Default to same as limit
    this.ModelClass = qs.ModelClass;
    this.primaryKeyField = this.ModelClass.primaryKeyField || 'id';
    this.isFetching = false;
    this.mainDataArray = null; // Will be set externally
  }

  /**
   * Set reference to the main data array
   * @param {Array} dataArray - The main data array
   */
  setMainDataArray(dataArray) {
    this.mainDataArray = dataArray;
  }

  /**
   * Initialize the cache by fetching items not in the main data array
   * @returns {Promise<void>}
   */
  async initialize() {
    if (!this.limit) {
      console.warn('OverfetchCache: No limit set in serializer options, caching disabled');
      return;
    }
    
    if (!this.mainDataArray) {
      console.warn('OverfetchCache: No main data array set, caching disabled');
      return;
    }
    
    // Fetch items not in the main data array
    await this.refreshCache();
  }

  /**
   * Refresh the cache by fetching items not in the main data array
   * @returns {Promise<void>}
   */
  async refreshCache() {
    if (!this.limit || this.isFetching || !this.mainDataArray) return;
    
    try {
      this.isFetching = true;
      
      // Get IDs of all items in the main data array
      const existingIds = this.mainDataArray.map(item => item[this.primaryKeyField]);
      
      // Build a query to exclude existing IDs
      let queryToUse = this.qs;
      
      if (existingIds.length > 0) {
        // Only exclude if there are existing IDs
        queryToUse = queryToUse.exclude({ [`${this.primaryKeyField}__in`]: existingIds });
      }
      
      // Apply limit for cache size
      const fetchOptions = {
        ...this.serializerOptions,
        limit: this.cacheSize,
        // No offset needed
      };
      
      // Fetch new items
      const newItems = await queryToUse.fetch(fetchOptions);
      
      // Replace the entire cache
      this.cacheItems = newItems;
      
    } catch (error) {
      console.error('OverfetchCache: Error refreshing cache:', error);
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Handle external model events in the OverfetchCache class
   * @param {EventType} eventType - The type of event ('create', 'update', 'delete', etc.)
   * @param {Array|string|number} pkValues - Primary key(s) of the affected items
   * @returns {void}
   */
  handleModelEvent(eventType, pkValues) {
    // Always check if we have a cache to work with
    if (!this.mainDataArray || !this.limit) return;
    
    // Normalize pkValues to an array
    const pkArray = Array.isArray(pkValues) ? pkValues : [pkValues];
    
    // For create events, refresh if cache isn't full
    if (eventType === EventType.CREATE) {
      if (this.cacheItems.length < this.cacheSize) {
        // Refresh the cache to potentially include the new items
        setTimeout(() => this.refreshCache(), 0);
      }
      return;
    }
    
    // For update or delete events, check if they affect our cached items
    if (eventType === EventType.UPDATE || eventType === EventType.DELETE) {
      // Check if any of our cached items are affected
      const isCacheAffected = this.cacheItems.some(item => 
        pkArray.includes(item[this.primaryKeyField])
      );

      // If its a delete, remove immediately
      if (eventType === EventType.DELETE){
        // Immediately filter out the deleted items from the cache
        this.cacheItems = this.cacheItems.filter(
          item => !new Set(pkSet).has(item[this.primaryKeyField])
        );
      }
      
      // If cache is affected, refresh it
      if (isCacheAffected) {
        setTimeout(() => this.refreshCache(), 0);
      }
      
      return;
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
   * @returns {Array} Replacement items from cache
   */
  getReplacements(count) {
    if (count <= 0) return [];
    
    // Take items from the cache
    const itemsToReturn = Math.min(count, this.cacheItems.length);
    const replacements = this.cacheItems.splice(0, itemsToReturn);
    
    // If cache is now low, trigger a refresh
    if (this.cacheItems.length < this.cacheSize / 2 && !this.isFetching) {
      // Use setTimeout to avoid blocking the current operation
      setTimeout(() => this.refreshCache(), 0);
    }
    
    return replacements;
  }
  
  /**
   * Get current cache status
   * @returns {Object} The cache status
   */
  getStatus() {
    return {
      cacheItemCount: this.cacheItems.length,
      targetSize: this.cacheSize,
      mainArraySize: this.mainDataArray ? this.mainDataArray.length : 0,
      isFetching: this.isFetching
    };
  }
}