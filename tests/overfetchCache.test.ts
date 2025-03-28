import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { OverfetchCache } from '../src/core/overfetchCache'

// Mock dependencies
const mockModelClass = {
  primaryKeyField: 'id',
  modelName: 'TestModel'
};

// Create mock query set
const createMockQs = (items = []) => ({
  ModelClass: mockModelClass,
  fetch: vi.fn().mockImplementation(async (options) => {
    const { offset = 0, limit = 10 } = options;
    // Generate items based on offset and limit
    return Array.from({ length: Math.min(limit, items.length - offset) }, (_, i) => ({
      id: offset + i + 1,
      name: `Item ${offset + i + 1}`
    }));
  })
});

// Helper to wait for microtasks to complete
const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

describe('OverfetchCache', () => {
  let mockQs;
  let cache;
  let mockItems;
  
  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();
    
    // Create an array of 100 mock items
    mockItems = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `Item ${i + 1}`
    }));
    
    // Create mock QuerySet
    mockQs = createMockQs(mockItems);
    mockQs.fetch.mockImplementation(async (options) => {
      const { offset = 0, limit = 10 } = options;
      return mockItems.slice(offset, offset + limit);
    });
    
    // Create cache instance with standard options
    cache = new OverfetchCache(mockQs, {
      serializer: {
        offset: 0,
        limit: 10
      }
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('should initialize with correct default values', () => {
    expect(cache.limit).toBe(10);
    expect(cache.offset).toBe(0);
    expect(cache.cacheSize).toBe(10);
    expect(cache.cacheItems).toEqual([]);
    expect(cache.isFetching).toBe(false);
    expect(cache.primaryKeyField).toBe('id');
  });

  test('should fetch next page of items during initialization', async () => {
    await cache.initialize();
    
    // Check that fetch was called with correct parameters
    expect(mockQs.fetch).toHaveBeenCalledWith({
      offset: 10, // Next page after current view (offset 0 + limit 10)
      limit: 10
    });
    
    // Check that cache items were set correctly
    expect(cache.cacheItems.length).toBe(10);
    expect(cache.cacheItems[0].id).toBe(11); // First item of next page
  });

  test('should not fetch if limit is not set', async () => {
    cache = new OverfetchCache(mockQs, {});
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    await cache.initialize();
    
    expect(consoleSpy).toHaveBeenCalledWith('OverfetchCache: No limit set in serializer options, caching disabled');
    expect(mockQs.fetch).not.toHaveBeenCalled();
    
    consoleSpy.mockRestore();
  });

  test('should update offset and refresh cache', async () => {
    await cache.initialize();
    
    // Reset mock call count
    mockQs.fetch.mockClear();
    
    // Update offset
    cache.updateOffset(20);
    
    // Offset should be updated
    expect(cache.offset).toBe(20);
    
    // Should trigger a refresh
    expect(mockQs.fetch).toHaveBeenCalledWith({
      offset: 30, // New offset (20) + limit (10)
      limit: 10
    });
  });

  test('should not update offset or refresh if same offset', async () => {
    await cache.initialize();
    
    // Reset mock call count
    mockQs.fetch.mockClear();
    
    // Update with same offset
    cache.updateOffset(0);
    
    // Should not trigger a refresh
    expect(mockQs.fetch).not.toHaveBeenCalled();
  });

  test('should get replacements from cache without waiting for refresh', async () => {
    // Initialize with 10 items
    await cache.initialize();
    
    // Get 5 replacements
    const replacements = await cache.getReplacements(5);
    
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
    const replacements = await cache.getReplacements(15);
    
    // Should return only 10 items (all that are available)
    expect(replacements.length).toBe(10);
    
    // Cache should be empty
    expect(cache.cacheItems.length).toBe(0);
  });

  test('should return empty array when cache is empty', async () => {
    // Initialize with 10 items
    await cache.initialize();
    
    // Empty the cache
    await cache.getReplacements(10);
    
    // Reset mock
    mockQs.fetch.mockClear();
    
    // Try to get more replacements
    const replacements = await cache.getReplacements(5);
    
    // Should return empty array
    expect(replacements).toEqual([]);
    
    // Cache remains empty
    expect(cache.cacheItems.length).toBe(0);
    
    // getReplacements does not trigger refreshCache
    expect(mockQs.fetch).not.toHaveBeenCalled();
  });

  test('should not wait for ongoing fetch when getting replacements', async () => {
    // Set up a delayed fetch response
    let resolvePromise;
    const fetchPromise = new Promise(resolve => {
      resolvePromise = resolve;
    });
    
    mockQs.fetch.mockImplementationOnce(() => fetchPromise);
    
    // Start initialization (which will trigger a fetch)
    const initPromise = cache.initialize();
    
    // Cache should be in fetching state
    expect(cache.isFetching).toBe(true);
    
    // Try to get replacements while fetch is in progress
    const replacements = await cache.getReplacements(5);
    
    // Should return empty array immediately since cache is empty and fetching
    expect(replacements).toEqual([]);
    
    // Resolve the fetch
    resolvePromise(mockItems.slice(10, 20));
    
    // Wait for initialization to complete
    await initPromise;
    
    // Now the cache should be populated
    expect(cache.cacheItems.length).toBe(10);
    expect(cache.isFetching).toBe(false);
  });

  test('should handle data change by refreshing cache', async () => {
    await cache.initialize();
    
    // Reset mock call count
    mockQs.fetch.mockClear();
    
    // Create some IDs that are in the cache
    const affectedIds = [11, 12]; // These IDs should be in the cache after initialization
    
    // Handle data change with these IDs
    cache.handleDataChange(affectedIds);
    
    // Should trigger a refresh
    expect(mockQs.fetch).toHaveBeenCalledWith({
      offset: 10,
      limit: 10
    });
  });

  test('should not refresh cache if affected IDs are not in cache', async () => {
    await cache.initialize();
    
    // Reset mock call count
    mockQs.fetch.mockClear();
    
    // Create IDs that are not in the cache
    const affectedIds = [1, 2]; // These IDs should not be in the cache
    
    // Handle data change with these IDs
    cache.handleDataChange(affectedIds);
    
    // Should not trigger a refresh
    expect(mockQs.fetch).not.toHaveBeenCalled();
  });

  test('should return empty array when requesting 0 replacements', async () => {
    await cache.initialize();
    
    const replacements = await cache.getReplacements(0);
    
    expect(replacements).toEqual([]);
    expect(cache.cacheItems.length).toBe(10); // Should not modify cache
  });

  test('should return correct status object', async () => {
    await cache.initialize();
    
    const status = cache.getStatus();
    
    expect(status).toEqual({
      cacheItemCount: 10,
      targetSize: 10,
      currentOffset: 0,
      isFetching: false
    });
  });

  test('should handle fetch errors gracefully', async () => {
    // Make fetch throw an error
    const error = new Error('Fetch error');
    mockQs.fetch.mockRejectedValueOnce(error);
    
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
    
    // Should only call fetch once
    expect(mockQs.fetch).toHaveBeenCalledTimes(1);
    
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
    newMockQs.fetch.mockImplementation(async (options) => {
      const { offset = 0, limit = 10 } = options;
      return newMockItems.slice(offset, offset + limit);
    });
    
    // Create new options
    const newOptions = {
      serializer: {
        offset: 15,
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
    expect(cache.offset).toBe(15);
    expect(cache.limit).toBe(20);
    expect(cache.cacheSize).toBe(25);
    
    // Check that fetch was called with correct parameters
    expect(newMockQs.fetch).toHaveBeenCalledWith({
      offset: 35, // New offset (15) + new limit (20)
      limit: 25  // New cache size
    });
    
    // Check that cache items were updated with new data
    expect(cache.cacheItems.length).toBe(25);
    expect(cache.cacheItems[0].id).toBe(1035); // First item of next page from new data
  });
  
  test('should throw error when resetting with incompatible model class', async () => {
    // Create a new query set with different model class
    const incompatibleQs = {
      ModelClass: {
        primaryKeyField: 'uuid',
        modelName: 'IncompatibleModel'
      },
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
    
    // Fetch should use updated cache size but same offset
    expect(mockQs.fetch).toHaveBeenCalledWith({
      offset: 10, // Original offset (0) + original limit (10)
      limit: 15   // New cache size
    });
    
    // Reset only options
    const newOptions = {
      serializer: {
        offset: 25,
        limit: 5
      }
    };
    
    await cache.reset({ newOptions });
    
    // Options should be updated
    expect(cache.options).toBe(newOptions);
    expect(cache.offset).toBe(25);
    expect(cache.limit).toBe(5);
    
    // Cache size should remain the same from previous reset
    expect(cache.cacheSize).toBe(15);
    
    // Fetch should use updated offset and limit
    expect(mockQs.fetch).toHaveBeenCalledWith({
      offset: 30, // New offset (25) + new limit (5)
      limit: 15   // Cache size from previous reset
    });
  });
  
  test('should clear cache items during reset before fetching new ones', async () => {
    await cache.initialize();
    
    // Cache should have items after initialization
    expect(cache.cacheItems.length).toBe(10);
    
    // Create a delayed fetch implementation
    let resolvePromise;
    const fetchPromise = new Promise(resolve => {
      resolvePromise = resolve;
    });
    
    mockQs.fetch.mockImplementationOnce(() => fetchPromise);
    
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
    expect(cache.cacheItems.length).toBe(10);
    expect(cache.isFetching).toBe(false);
  });
});