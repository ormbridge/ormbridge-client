import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { OverfetchCache } from '../src/core/overfetchCache'

// Mock dependencies
const mockModelClass = {
  primaryKeyField: 'id',
  modelName: 'TestModel'
};

// Create mock query set with exclude support
const createMockQs = (items = []) => ({
  ModelClass: mockModelClass,
  fetch: vi.fn().mockImplementation(async (options) => {
    const { limit = 10 } = options;
    return items.slice(0, limit);
  }),
  exclude: vi.fn().mockImplementation((excludeParams) => {
    // Create a new QuerySet that filters out items based on excludeParams
    const excludedIds = excludeParams['id__in'] || [];
    const filteredItems = items.filter(item => !excludedIds.includes(item.id));
    
    return {
      ...createMockQs(filteredItems),
      // Return the filtered items when fetched
      fetch: vi.fn().mockImplementation(async (options) => {
        const { limit = 10 } = options;
        return filteredItems.slice(0, limit);
      })
    };
  })
});

// Helper to wait for microtasks to complete
const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

describe('OverfetchCache', () => {
  let mockQs;
  let cache;
  let mockItems;
  let mockMainDataArray;
  
  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();
    
    // Create an array of 100 mock items
    mockItems = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `Item ${i + 1}`
    }));
    
    // Create a mock main data array with the first 10 items
    mockMainDataArray = mockItems.slice(0, 10);
    
    // Create mock QuerySet
    mockQs = createMockQs(mockItems);
    
    // Create cache instance with standard options
    cache = new OverfetchCache(mockQs, {
      serializer: {
        limit: 10
      }
    }, 10);
    
    // Set main data array reference
    cache.setMainDataArray(mockMainDataArray);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('should initialize with correct default values', () => {
    expect(cache.limit).toBe(10);
    expect(cache.cacheSize).toBe(10);
    expect(cache.cacheItems).toEqual([]);
    expect(cache.isFetching).toBe(false);
    expect(cache.primaryKeyField).toBe('id');
    expect(cache.mainDataArray).toBe(mockMainDataArray);
  });

  test('should fetch excluded items during initialization', async () => {
    await cache.initialize();
    
    // Check that exclude was called with IDs from the main array
    const mainIds = mockMainDataArray.map(item => item.id);
    expect(mockQs.exclude).toHaveBeenCalledWith({ 'id__in': mainIds });
    
    // Check that fetch was called with correct parameters (just the limit)
    expect(mockQs.exclude.mock.results[0].value.fetch).toHaveBeenCalledWith({
      limit: 10,
      ...cache.serializerOptions
    });
    
    // Check that cache items contain the next 10 items (not in the main array)
    expect(cache.cacheItems.length).toBe(10);
    expect(cache.cacheItems[0].id).toBe(11); // First item after the main array
  });

  test('should not fetch if limit is not set', async () => {
    cache = new OverfetchCache(mockQs, {});
    cache.setMainDataArray(mockMainDataArray);
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    await cache.initialize();
    
    expect(consoleSpy).toHaveBeenCalledWith('OverfetchCache: No limit set in serializer options, caching disabled');
    expect(mockQs.exclude).not.toHaveBeenCalled();
    
    consoleSpy.mockRestore();
  });

  test('should not fetch if main data array is not set', async () => {
    cache = new OverfetchCache(mockQs, {
      serializer: { limit: 10 }
    });
    
    // Don't set main data array
    cache.mainDataArray = null;
    
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    await cache.initialize();
    
    expect(consoleSpy).toHaveBeenCalledWith('OverfetchCache: No main data array set, caching disabled');
    expect(mockQs.exclude).not.toHaveBeenCalled();
    
    consoleSpy.mockRestore();
  });

  test('should get replacements from cache without waiting for refresh', async () => {
    // Initialize with 10 items
    await cache.initialize();
    
    // Get 5 replacements
    const replacements = cache.getReplacements(5);
    
    // Should return 5 items
    expect(replacements.length).toBe(5);
    expect(replacements[0].id).toBe(11);
    expect(replacements[4].id).toBe(15);
    
    // Cache should have 5 items left
    expect(cache.cacheItems.length).toBe(5);
    expect(cache.cacheItems[0].id).toBe(16);
  });

  test('should only return available replacements if requesting more than available', async () => {
    // Initialize with 10 items
    await cache.initialize();
    
    // Get 15 replacements (more than available)
    const replacements = cache.getReplacements(15);
    
    // Should return only 10 items (all that are available)
    expect(replacements.length).toBe(10);
    
    // Cache should be empty
    expect(cache.cacheItems.length).toBe(0);
  });

  test('should return empty array when cache is empty', async () => {
    // Initialize with 10 items
    await cache.initialize();
    
    // Empty the cache
    cache.getReplacements(10);
    
    // Reset mocks
    mockQs.exclude.mockClear();
    
    // Try to get more replacements
    const replacements = cache.getReplacements(5);
    
    // Should return empty array
    expect(replacements).toEqual([]);
    
    // Cache remains empty
    expect(cache.cacheItems.length).toBe(0);
    
    // Check that a refresh was scheduled with setTimeout
    // We need to spy on setTimeout for this
    const timeoutSpy = vi.spyOn(global, 'setTimeout');
    
    // Call getReplacements again to trigger the refresh
    cache.getReplacements(1);
    
    // Check that setTimeout was called
    expect(timeoutSpy).toHaveBeenCalled();
    
    timeoutSpy.mockRestore();
  });

  test('should handle data change by refreshing cache', async () => {
    await cache.initialize();
    
    // Reset mock call count
    mockQs.exclude.mockClear();
    
    // Update main data array (simulate data changing)
    mockMainDataArray.push(...mockItems.slice(10, 15));
    
    // Force a refresh cache
    await cache.refreshCache();
    
    // Should exclude the updated main array items
    const updatedMainIds = mockMainDataArray.map(item => item.id);
    expect(mockQs.exclude).toHaveBeenCalledWith({ 'id__in': updatedMainIds });
    
    // Check that fetch was called with the limit
    expect(mockQs.exclude.mock.results[0].value.fetch).toHaveBeenCalled();
  });

  test('should return empty array when requesting 0 replacements', async () => {
    await cache.initialize();
    
    const replacements = cache.getReplacements(0);
    
    expect(replacements).toEqual([]);
    expect(cache.cacheItems.length).toBe(10); // Should not modify cache
  });

  test('should return correct status object', async () => {
    await cache.initialize();
    
    const status = cache.getStatus();
    
    expect(status).toEqual({
      cacheItemCount: 10,
      targetSize: 10,
      mainArraySize: 10,
      isFetching: false
    });
  });

  test('should handle fetch errors gracefully', async () => {
    // Make exclude throw an error
    const error = new Error('Fetch error');
    mockQs.exclude.mockImplementationOnce(() => {
      throw error;
    });
    
    // Spy on console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Initialize should not throw
    await expect(cache.initialize()).resolves.not.toThrow();
    
    // Should log error
    expect(consoleSpy).toHaveBeenCalledWith('OverfetchCache: Error refreshing cache:', error);
    
    // Cache should not be in fetching state
    expect(cache.isFetching).toBe(false);
    
    // Cache should be empty
    expect(cache.cacheItems).toEqual([]);
    
    consoleSpy.mockRestore();
  });

  test('should not trigger multiple concurrent refreshes', async () => {
    // Start a refresh
    const refreshPromise = cache.refreshCache();
    
    // Try to start another refresh
    cache.refreshCache();
    
    // Should only call exclude once
    expect(mockQs.exclude).toHaveBeenCalledTimes(1);
    
    await refreshPromise;
  });

  test('should reset cache with new query set, options and cache size', async () => {
    // Initialize with default options
    await cache.initialize();
    
    // Create a new query set with different items
    const newMockItems = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1000, // Different IDs from original items
      name: `New Item ${i + 1000}`
    }));
    
    const newMockQs = createMockQs(newMockItems);
    
    // Create new options
    const newOptions = {
      serializer: {
        limit: 20
      }
    };
    
    // New cache size
    const newCacheSize = 25;
    
    // Reset the cache with new values
    await cache.reset({
      newQs: newMockQs,
      newOptions,
      newCacheSize
    });
    
    // Check that cache properties were updated
    expect(cache.qs).toBe(newMockQs);
    expect(cache.options).toBe(newOptions);
    expect(cache.serializerOptions).toBe(newOptions.serializer);
    expect(cache.limit).toBe(20);
    expect(cache.cacheSize).toBe(25);
    
    // Check that exclude and fetch were called on the new query set
    // This is hard to verify since we reset everything, but the cache should be empty
    // Initially and then should be refilled after initialize() is called during reset()
    expect(cache.cacheItems.length).toBeGreaterThan(0);
  });
  
  test('should throw error when resetting with incompatible model class', async () => {
    // Create a new query set with different model class
    const incompatibleQs = {
      ModelClass: {
        primaryKeyField: 'uuid',
        modelName: 'IncompatibleModel'
      },
      exclude: vi.fn(),
      fetch: vi.fn()
    };
    
    // Should throw error when resetting with incompatible model class
    await expect(cache.reset({ newQs: incompatibleQs }))
      .rejects.toThrow("Cannot reset OverfetchCache with a different model class");
  });
  
  test('should reset correctly with partial parameters', async () => {
    await cache.initialize();
    
    // Reset only the cache size
    await cache.reset({ newCacheSize: 15 });
    
    // QuerySet should remain the same
    expect(cache.qs).toBe(mockQs);
    
    // Cache size should be updated
    expect(cache.cacheSize).toBe(15);
    
    // Reset only options
    const newOptions = {
      serializer: {
        limit: 5
      }
    };
    
    await cache.reset({ newOptions });
    
    // Options should be updated
    expect(cache.options).toBe(newOptions);
    expect(cache.limit).toBe(5);
    
    // Cache size should remain the same from previous reset
    expect(cache.cacheSize).toBe(15);
  });
  
  test('should clear cache items during reset before fetching new ones', async () => {
    await cache.initialize();
    
    // Cache should have items after initialization
    expect(cache.cacheItems.length).toBe(10);
    
    // Create a delayed exclude implementation
    let resolvePromise;
    const excludePromise = new Promise(resolve => {
      resolvePromise = resolve;
    });
    
    mockQs.exclude.mockImplementationOnce(() => {
      return {
        fetch: vi.fn().mockImplementationOnce(() => excludePromise)
      };
    });
    
    // Start reset (this will clear cache and start fetch)
    const resetPromise = cache.reset();
    
    // Cache should be cleared immediately, even before fetch completes
    expect(cache.cacheItems).toEqual([]);
    expect(cache.isFetching).toBe(true);
    
    // Resolve the fetch
    resolvePromise(mockItems.slice(10, 20));
    
    // Wait for reset to complete
    await resetPromise;
    
    // Now the cache should be populated again
    expect(cache.isFetching).toBe(false);
  });
});