import { EventType } from './eventReceivers'
import { debounce } from 'lodash-es'

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
    
    // Create a debounced refresh function to prevent multiple refreshes
    this.debouncedRefresh = debounce(this.refreshCache.bind(this), 300);
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
   * Helper method to mutate the cache array in place. This is needed so the cache can be managed by the opsManager
   * @param {Array} newItems - New items to replace the current cache
   * @private
   */
  _resetMutation(newItems) {
    // Clear the array while maintaining the reference
    this.cacheItems.length = 0;
    
    // Add new items if provided
    if (newItems && newItems.length > 0) {
      this.cacheItems.push(...newItems);
    }
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
      this._resetMutation(newItems);
      
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
    if (!this.mainDataArray || !this.limit)
        return;
    
    // Normalize pkValues to an array and convert to a Set for fast lookups
    const pkArray = Array.isArray(pkValues) ? pkValues : [pkValues];
    const pkSet = new Set(pkArray);
    
    // For create events, refresh if cache isn't full
    if (eventType === EventType.CREATE) {
        if (this.cacheItems.length < this.cacheSize) {
            // Refresh the cache to potentially include the new items
            this.debouncedRefresh();
        }
        return;
    }
    
    // For update or delete events, check if they affect our cached items
    if (eventType === EventType.BULK_UPDATE || eventType === EventType.UPDATE || 
        eventType === EventType.DELETE || eventType === EventType.BULK_DELETE) {
        
        // Check if any of our cached items are affected using the set
        const isCacheAffected = this.cacheItems.some(item => 
            pkSet.has(item[this.primaryKeyField]));
        
        // If it's a delete or bulk delete, remove the affected items immediately
        if (eventType === EventType.DELETE || eventType === EventType.BULK_DELETE) {
            this._resetMutation(
              this.cacheItems.filter(item => 
                !pkSet.has(item[this.primaryKeyField]))
            )
        }
        
        // If cache is affected, refresh it
        if (isCacheAffected) {
            this.debouncedRefresh();
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
    this._resetMutation()
    
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
      // Use debounced refresh to avoid too many refreshes
      this.debouncedRefresh();
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