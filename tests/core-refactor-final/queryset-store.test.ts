/**
 * Tests for the consolidated QuerySetStore using Vitest
 */
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { QuerySetStore, QuerySetOperation } from '../../src/core-refactor-final/store/querysetstore/QuerySetStore.js';

// Simple in-memory database for comparison
class SimpleDB {
  constructor(initialData = [], pkField = 'id') {
    this.data = [...initialData];
    this.pkField = pkField;
  }

  create(items) {
    const newItems = Array.isArray(items) ? items : [items];

    newItems.forEach(item => {
      const exists = this.data.some(x => x[this.pkField] === item[this.pkField]);
      if (!exists) {
        this.data.push({...item});
      }
    });
  }

  update(items) {
    const updates = Array.isArray(items) ? items : [items];

    updates.forEach(update => {
      const index = this.data.findIndex(x => x[this.pkField] === update[this.pkField]);
      if (index !== -1) {
        this.data[index] = {...this.data[index], ...update};
      }
    });
  }

  delete(ids) {
    const toDelete = Array.isArray(ids) ? ids : [ids];
    this.data = this.data.filter(item => !toDelete.includes(item[this.pkField]));
  }

  getAll(sortFn) {
    const result = [...this.data];
    return sortFn ? result.sort(sortFn) : result;
  }

  getAllIds() {
    return this.data.map(item => item[this.pkField]);
  }

  getById(id) {
    return this.data.find(item => item[this.pkField] === id) || null;
  }

  getPaginated(offset = 0, limit = 10, sortFn) {
    const sorted = this.getAll(sortFn);
    return sorted.slice(offset, offset + limit);
  }
}

// Initial test data
const initialData = [
  { id: 1, name: 'Alice', role: 'admin' },
  { id: 2, name: 'Bob', role: 'user' },
  { id: 3, name: 'Charlie', role: 'user' }
];

// Initial IDs list - matching the initialData
const initialIds = initialData.map(item => item.id);

describe('QuerySetStore', () => {
  let directDB;
  let querySetStore;
  let fetchIdsMock;

  beforeEach(() => {
    // Reset direct DB
    directDB = new SimpleDB(initialData, 'id');

    // Mock fetch function
    fetchIdsMock = vi.fn().mockResolvedValue([...initialIds]);

    // Set up QuerySetStore
    querySetStore = new QuerySetStore({
      queryName: 'test_query',
      fetchQuerySet: fetchIdsMock
    });

    // Initialize ground truth IDs for QuerySetStore
    querySetStore._setGroundTruthIds([...initialIds]);
  });

  test('should initialize with correct ground truth IDs', () => {
    expect(querySetStore.getGroundTruthIds()).toEqual(initialIds);
  });

  test('should add create operation correctly', () => {
    const opId = querySetStore.add({
      type: 'create',
      ids: [4]
    });

    expect(querySetStore.operations.size).toBe(1);
    expect(querySetStore.operations.get(opId).type).toBe('create');
    expect(querySetStore.operations.get(opId).ids).toEqual([4]);
    expect(querySetStore.operations.get(opId).status).toBe('inflight');

    // Check that getCurrentIds includes the new ID
    expect(querySetStore.getCurrentIds()).toContain(4);
    expect(querySetStore.getCurrentIds().length).toBe(4); // 3 original + 1 new
  });

  test('should add delete operation correctly', () => {
    const opId = querySetStore.add({
      type: 'delete',
      ids: [1]
    });

    expect(querySetStore.operations.size).toBe(1);
    expect(querySetStore.operations.get(opId).type).toBe('delete');
    expect(querySetStore.operations.get(opId).ids).toEqual([1]);
    
    // Check that getCurrentIds excludes the deleted ID
    const currentIds = querySetStore.getCurrentIds();
    expect(currentIds).not.toContain(1);
    expect(currentIds.length).toBe(2); // 3 original - 1 deleted
  });

  test('should handle update operation correctly (track but not affect membership)', () => {
    const opId = querySetStore.add({
      type: 'update',
      ids: [1]
    });

    expect(querySetStore.operations.size).toBe(1);
    expect(querySetStore.operations.get(opId).type).toBe('update');
    expect(querySetStore.operations.get(opId).ids).toEqual([1]);
    
    // Check that getCurrentIds still contains all original IDs (update doesn't change membership)
    const currentIds = querySetStore.getCurrentIds();
    expect(currentIds).toContain(1);
    expect(currentIds.length).toBe(3); // All 3 original IDs remain
  });

  test('should confirm operation correctly', () => {
    const opId = querySetStore.add({
      type: 'create',
      ids: [4]
    });

    const result = querySetStore.confirm(opId);
    
    expect(result).toBe(true);
    expect(querySetStore.operations.get(opId).status).toBe('confirmed');
  });

  test('should confirm operation with new IDs', () => {
    const opId = querySetStore.add({
      type: 'create',
      ids: ['temp_id']
    });

    const newIds = [4];
    const result = querySetStore.confirm(opId, newIds);
    
    expect(result).toBe(true);
    expect(querySetStore.operations.get(opId).status).toBe('confirmed');
    expect(querySetStore.operations.get(opId).ids).toEqual(newIds);
    
    // Check that getCurrentIds includes the new confirmed ID and not the temp ID
    const currentIds = querySetStore.getCurrentIds();
    expect(currentIds).toContain(4);
    expect(currentIds).not.toContain('temp_id');
  });

  test('should reject operation correctly', () => {
    const opId = querySetStore.add({
      type: 'create',
      ids: [4]
    });

    const result = querySetStore.reject(opId);
    
    expect(result).toBe(true);
    expect(querySetStore.operations.get(opId).status).toBe('rejected');
    
    // Check that getCurrentIds doesn't include the rejected ID
    const currentIds = querySetStore.getCurrentIds();
    expect(currentIds).not.toContain(4);
    expect(currentIds.length).toBe(3); // Original 3 only
  });

  test('should sync with backend correctly', async () => {
    const newIds = [1, 2, 4]; // Changed IDs: removed 3, added 4
    fetchIdsMock.mockResolvedValueOnce(newIds);
    
    const result = await querySetStore.sync();
    
    expect(result).toBe(true);
    expect(querySetStore.getGroundTruthIds()).toEqual(newIds);
    expect(fetchIdsMock).toHaveBeenCalledTimes(1);
  });

  test('should handle complex operations sequence', () => {
    // Add multiple operations in sequence
    querySetStore.add({
      type: 'create',
      ids: [4]
    });
    
    querySetStore.add({
      type: 'delete',
      ids: [2]
    });
    
    querySetStore.add({
      type: 'create',
      ids: [5]
    });
    
    // Check the final state
    const currentIds = querySetStore.getCurrentIds();
    expect(currentIds).toContain(1);
    expect(currentIds).not.toContain(2); // Deleted
    expect(currentIds).toContain(3);
    expect(currentIds).toContain(4); // Added
    expect(currentIds).toContain(5); // Added
    expect(currentIds.length).toBe(4); // 3 original - 1 deleted + 2 added
  });

  test('should handle conflicting operations', () => {
    // Add and then delete the same ID
    querySetStore.add({
      type: 'create',
      ids: [4]
    });
    
    querySetStore.add({
      type: 'delete',
      ids: [4]
    });
    
    // The delete should win as it's later
    const currentIds = querySetStore.getCurrentIds();
    expect(currentIds).not.toContain(4);
    expect(currentIds.length).toBe(3); // Just the original 3
  });
});

describe('QuerySetStore Rendering', () => {
  let querySetStore;
  let fetchIdsMock;

  beforeEach(() => {
    // Mock fetch function
    fetchIdsMock = vi.fn().mockResolvedValue([...initialIds]);

    // Set up QuerySetStore
    querySetStore = new QuerySetStore({
      queryName: 'test_query',
      fetchQuerySet: fetchIdsMock,
      defaultLimit: 20
    });

    // Initialize ground truth IDs for QuerySetStore
    querySetStore._setGroundTruthIds([...initialIds]);
  });

  test('should render initial IDs correctly', () => {
    const renderedIds = querySetStore.render({ offset: 0, limit: 10 });
    
    expect(renderedIds.length).toBe(3);
    expect(renderedIds).toEqual(initialIds);
  });

  test('should handle create operation in rendering', () => {
    // Add an ID to QuerySetStore
    querySetStore.add({
      type: 'create',
      ids: [4]
    });
    
    // Render
    const renderedIds = querySetStore.render({ offset: 0, limit: 10 });
    
    // Check the result includes the new ID
    expect(renderedIds.length).toBe(4);
    expect(renderedIds).toContain(4);
  });

  test('should handle delete operation in rendering', () => {
    // Remove an ID from QuerySetStore
    querySetStore.add({
      type: 'delete',
      ids: [1]
    });
    
    // Render
    const renderedIds = querySetStore.render({ offset: 0, limit: 10 });
    
    // Check the result excludes the deleted ID
    expect(renderedIds.length).toBe(2);
    expect(renderedIds).not.toContain(1);
  });

  test('should handle pagination correctly', () => {
    // Add more IDs for pagination test
    querySetStore.add({
      type: 'create',
      ids: [4, 5]
    });
    
    // Test different pagination parameters
    const page1 = querySetStore.render({ offset: 0, limit: 2 });
    expect(page1.length).toBe(2);
    
    const page2 = querySetStore.render({ offset: 2, limit: 2 });
    expect(page2.length).toBe(2);
    
    const page3 = querySetStore.render({ offset: 4, limit: 2 });
    expect(page3.length).toBe(1);
    
    // Check that all 5 IDs are returned with sufficient limit
    const allIds = querySetStore.render({ offset: 0, limit: 10 });
    expect(allIds.length).toBe(5);
  });

  test('should handle sorting of IDs correctly', () => {
    // Add more IDs in unsorted order
    querySetStore.add({
      type: 'create',
      ids: [5, 4]
    });
    
    // Sort function that sorts IDs in descending order
    const sortDesc = (a, b) => b - a;
    
    // Render with sorting
    const renderedIds = querySetStore.render({ 
      offset: 0, 
      limit: 10,
      sortFn: sortDesc
    });
    
    // Check the IDs are sorted correctly
    expect(renderedIds).toEqual([5, 4, 3, 2, 1]);
  });

  test('should cache rendered data correctly', () => {
    // Spy on _processOperations to check cache behavior
    const spy = vi.spyOn(querySetStore, '_processOperations');
    
    // First render (cache miss)
    querySetStore.render({ offset: 0, limit: 10 });
    expect(spy).toHaveBeenCalledTimes(1);
    
    // Second render with same parameters (cache hit)
    querySetStore.render({ offset: 0, limit: 10 });
    expect(spy).toHaveBeenCalledTimes(1); // Still just once
    
    // Add an operation to invalidate cache
    querySetStore.add({
      type: 'create',
      ids: [4]
    });
    
    // Next render should be a cache miss
    querySetStore.render({ offset: 0, limit: 10 });
    expect(spy).toHaveBeenCalledTimes(2);
    
    // Clean up
    spy.mockRestore();
  });

  test('should handle operation rejection correctly in rendering', () => {
    // Add an operation
    const opId = querySetStore.add({
      type: 'create',
      ids: [4]
    });
    
    // Verify it appears in the render
    let renderedIds = querySetStore.render({ offset: 0, limit: 10 });
    expect(renderedIds).toContain(4);
    
    // Reject the operation
    querySetStore.reject(opId);
    
    // Verify it no longer appears in the render
    renderedIds = querySetStore.render({ offset: 0, limit: 10 });
    expect(renderedIds).not.toContain(4);
  });

  test('should handle complex operation sequence in rendering', () => {
    // Perform a sequence of operations
    querySetStore.add({
      type: 'create',
      ids: [4]
    });
    
    querySetStore.add({
      type: 'delete',
      ids: [2]
    });
    
    querySetStore.add({
      type: 'create',
      ids: [5]
    });
    
    // Render IDs
    const renderedIds = querySetStore.render({ offset: 0, limit: 10 });
    
    // Should have IDs 1, 3, 4, 5 (after removing 2)
    expect(renderedIds).toEqual(expect.arrayContaining([1, 3, 4, 5]));
    expect(renderedIds.length).toBe(4);
  });

  test('should get correct count', () => {
    expect(querySetStore.getCount()).toBe(3);
    
    // Add an ID
    querySetStore.add({
      type: 'create',
      ids: [4]
    });
    
    expect(querySetStore.getCount()).toBe(4);
    
    // Delete an ID
    querySetStore.add({
      type: 'delete',
      ids: [1]
    });
    
    expect(querySetStore.getCount()).toBe(3);
  });

  test('should handle sync that changes ground truth in rendering', async () => {
    // Setup a new set of IDs
    const newIds = [2, 3, 4];
    fetchIdsMock.mockResolvedValueOnce(newIds);
    
    // Sync QuerySetStore
    await querySetStore.sync();
    
    // Check the rendered result
    const renderedIds = querySetStore.render({ offset: 0, limit: 10 });
    
    // Should have IDs 2, 3, 4 only
    expect(renderedIds).toEqual(expect.arrayContaining([2, 3, 4]));
    expect(renderedIds).not.toContain(1);
    expect(renderedIds.length).toBe(3);
  });

  test('should use default limit when none specified', () => {
    // Add more IDs
    querySetStore.add({
      type: 'create',
      ids: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
    });
    
    // Render without specifying limit
    const renderedIds = querySetStore.render({ offset: 0 });
    
    // Should use the default limit (20)
    expect(renderedIds.length).toBe(20);
  });

  test('should implement getSlice method properly', () => {
    // Add more IDs for slicing test
    querySetStore.add({
      type: 'create',
      ids: [4, 5, 6, 7]
    });
    
    // Get first slice
    const slice1Result = querySetStore.getSlice({ offset: 0, limit: 3 });
    
    expect(slice1Result.ids.length).toBe(3);
    expect(slice1Result.metadata.totalItems).toBe(7);
    expect(slice1Result.metadata.hasMore).toBe(true);
    
    // Get middle slice
    const slice2Result = querySetStore.getSlice({ offset: 3, limit: 3 });
    
    expect(slice2Result.ids.length).toBe(3);
    expect(slice2Result.metadata.hasMore).toBe(true);
    
    // Get last slice
    const slice3Result = querySetStore.getSlice({ offset: 6, limit: 3 });
    
    expect(slice3Result.ids.length).toBe(1);
    expect(slice3Result.metadata.hasMore).toBe(false);
  });

  test('should use default limit when none specified in getSlice', () => {
    // Create a lot of IDs
    const manyIds = Array.from({ length: 30 }, (_, i) => i + 1);
    querySetStore._setGroundTruthIds(manyIds);
    
    // Get slice without specifying limit
    const sliceResult = querySetStore.getSlice({ offset: 0 });
    
    expect(sliceResult.ids.length).toBe(20); // Default limit is 20
    expect(sliceResult.metadata.limit).toBe(20);
    expect(sliceResult.metadata.hasMore).toBe(true);
  });
});

// Test for operation trimming based on maxOperationAge
describe('QuerySetStore Operation Trimming', () => {
  let querySetStore;
  const testMaxOperationAge = 15 * 1000; // 15 seconds
  
  beforeEach(() => {
    vi.useFakeTimers(); // Enable fake timers
    
    // Set up QuerySetStore with maxOperationAge
    querySetStore = new QuerySetStore({
      queryName: 'test_query',
      fetchQuerySet: () => Promise.resolve([...initialIds]),
      maxOperationAge: testMaxOperationAge
    });
    
    // Initialize ground truth IDs for QuerySetStore
    querySetStore._setGroundTruthIds([...initialIds]);
  });
  
  afterEach(() => {
    vi.useRealTimers(); // Restore real timers
  });
  
  test('should trim confirmed operations after maxOperationAge', async () => {
    // Add and confirm an operation
    const opId = querySetStore.add({
      type: 'create',
      ids: [4]
    });
    querySetStore.confirm(opId);
    
    // Sync (should not trim yet as operation is new)
    await querySetStore.sync();
    expect(querySetStore.operations.has(opId)).toBe(true);
    
    // Advance time beyond maxOperationAge
    vi.advanceTimersByTime(testMaxOperationAge + 1);
    
    // Sync again - should trigger trimming
    await querySetStore.sync();
    
    // Operation should be gone
    expect(querySetStore.operations.has(opId)).toBe(false);
  });
  
  test('should trim rejected operations after maxOperationAge', async () => {
    // Add and reject an operation
    const opId = querySetStore.add({
      type: 'create',
      ids: [4]
    });
    querySetStore.reject(opId);
    
    // Sync (should not trim yet as operation is new)
    await querySetStore.sync();
    expect(querySetStore.operations.has(opId)).toBe(true);
    
    // Advance time beyond maxOperationAge
    vi.advanceTimersByTime(testMaxOperationAge + 1);
    
    // Sync again - should trigger trimming
    await querySetStore.sync();
    
    // Operation should be gone
    expect(querySetStore.operations.has(opId)).toBe(false);
  });
  
  test('should not trim inflight operations regardless of age', async () => {
    // Add an operation (it's inflight by default)
    const opId = querySetStore.add({
      type: 'create',
      ids: [4]
    });
    
    // Sync
    await querySetStore.sync();
    expect(querySetStore.operations.has(opId)).toBe(true);
    
    // Advance time beyond maxOperationAge
    vi.advanceTimersByTime(testMaxOperationAge + 1);
    
    // Sync again
    await querySetStore.sync();
    
    // Inflight operation should still exist
    expect(querySetStore.operations.has(opId)).toBe(true);
    expect(querySetStore.operations.get(opId).status).toBe('inflight');
  });
});

// Test caching system
describe('QuerySetStore Cache System', () => {
  let querySetStore;
  
  beforeEach(() => {
    // Mock storage and serializer
    const storageMock = {
      load: vi.fn(),
      save: vi.fn().mockResolvedValue(true),
      delete: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(true)
    };
    
    const serializerMock = {
      serialize: vi.fn().mockReturnValue({ id: 'test_query', groundTruthIds: [], operations: {}, version: 0 }),
      deserialize: vi.fn()
    };
    
    // Set up QuerySetStore with caching enabled
    querySetStore = new QuerySetStore({
      queryName: 'test_query',
      fetchQuerySet: () => Promise.resolve([...initialIds]),
      enableCache: true
    });
    
    // Initialize ground truth IDs for QuerySetStore
    querySetStore._setGroundTruthIds([...initialIds]);
    
    // Replace storage and serializer with mocks
    querySetStore._storage = storageMock;
    querySetStore._serializer = serializerMock;
  });
  
  test('should save to cache during sync', async () => {
    await querySetStore.sync();
    
    // Check that serializer and storage were called
    expect(querySetStore._serializer.serialize).toHaveBeenCalled();
    expect(querySetStore._storage.save).toHaveBeenCalled();
  });
  
  test('should load from cache correctly', async () => {
    // Setup mock cache data
    const mockCacheData = {
      id: 'test_query',
      groundTruthIds: [1, 2, 3],
      operations: {},
      version: 1,
      cachedAt: Date.now() - 1000 // 1 second ago
    };
    
    querySetStore._storage.load.mockResolvedValue(mockCacheData);
    querySetStore._serializer.deserialize.mockReturnValue({
      groundTruthIds: [1, 2, 3],
      operations: new Map(),
      version: 1,
      cachedAt: Date.now() - 1000
    });
    
    // Load from cache
    const loaded = await querySetStore._loadFromCache();
    
    expect(loaded).toBe(true);
    expect(querySetStore.groundTruthIds).toEqual([1, 2, 3]);
  });
  
  test('should clear cache successfully', async () => {
    await querySetStore.clearCache();
    
    expect(querySetStore._storage.delete).toHaveBeenCalledWith(querySetStore._cacheStoreName);
  });
  
  test('should clean up resources on destroy', async () => {
    // Save the mocks before destroy
    const storageMock = querySetStore._storage;
    
    await querySetStore.destroy();
    
    // Check that close was called on the mock
    expect(storageMock.close).toHaveBeenCalled();
    expect(querySetStore._storage).toBeNull();
    expect(querySetStore._serializer).toBeNull();
    expect(querySetStore._renderCache).toBeNull();
  });
});

// Test render cache invalidation
describe('QuerySetStore Render Cache', () => {
  let querySetStore;
  
  beforeEach(() => {
    // Set up QuerySetStore
    querySetStore = new QuerySetStore({
      queryName: 'test_query',
      fetchQuerySet: () => Promise.resolve([...initialIds])
    });
    
    // Initialize ground truth IDs for QuerySetStore
    querySetStore._setGroundTruthIds([...initialIds]);
  });
  
  test('should invalidate render cache when ground truth changes', () => {
    // Spy on _processOperations to check cache behavior
    const spy = vi.spyOn(querySetStore, '_processOperations');
    
    // First render (cache miss)
    querySetStore.getCurrentIds();
    expect(spy).toHaveBeenCalledTimes(1);
    
    // Second render (cache hit)
    querySetStore.getCurrentIds();
    expect(spy).toHaveBeenCalledTimes(1); // Still just once
    
    // Change ground truth IDs
    querySetStore._setGroundTruthIds([1, 2, 4]);
    
    // Next render should be a cache miss
    querySetStore.getCurrentIds();
    expect(spy).toHaveBeenCalledTimes(2);
    
    spy.mockRestore();
  });
  
  test('should invalidate render cache when operations are added', () => {
    // Spy on _processOperations to check cache behavior
    const spy = vi.spyOn(querySetStore, '_processOperations');
    
    // First render (cache miss)
    querySetStore.getCurrentIds();
    expect(spy).toHaveBeenCalledTimes(1);
    
    // Add an operation
    querySetStore.add({
      type: 'create',
      ids: [4]
    });
    
    // Next render should be a cache miss
    querySetStore.getCurrentIds();
    expect(spy).toHaveBeenCalledTimes(2);
    
    spy.mockRestore();
  });
  
  test('should invalidate render cache when operations are updated', () => {
    // Spy on _processOperations to check cache behavior
    const spy = vi.spyOn(querySetStore, '_processOperations');
    
    // Add an operation
    const opId = querySetStore.add({
      type: 'create',
      ids: [4]
    });
    
    // First render (cache miss)
    querySetStore.getCurrentIds();
    expect(spy).toHaveBeenCalledTimes(1);
    
    // Update the operation
    querySetStore.update(opId, { ids: [5] });
    
    // Next render should be a cache miss
    querySetStore.getCurrentIds();
    expect(spy).toHaveBeenCalledTimes(2);
    
    spy.mockRestore();
  });
  
  test('should share render cache between different rendering methods', () => {
    // Spy on _processOperations to check cache behavior
    const spy = vi.spyOn(querySetStore, '_processOperations');
    
    // First render via getCurrentIds (cache miss)
    querySetStore.getCurrentIds();
    expect(spy).toHaveBeenCalledTimes(1);
    
    // Render via render() - should use the existing cache
    querySetStore.render({ offset: 0, limit: 10 });
    expect(spy).toHaveBeenCalledTimes(1); // Still just once
    
    // Render via getCount() - should use the existing cache
    querySetStore.getCount();
    expect(spy).toHaveBeenCalledTimes(1); // Still just once
    
    // Render via getSlice() - should use the existing cache
    querySetStore.getSlice({ offset: 0, limit: 10 });
    expect(spy).toHaveBeenCalledTimes(1); // Still just once
    
    spy.mockRestore();
  });
  
  test('should cache processed IDs but still apply sorting and pagination', () => {
    // Add some IDs to have a larger set
    querySetStore.add({
      type: 'create',
      ids: [4, 5, 6]
    });
    
    // Spy on _processOperations and _applySorting
    const processSpy = vi.spyOn(querySetStore, '_processOperations');
    const sortSpy = vi.spyOn(querySetStore, '_applySorting');
    
    // First render with ascending sort
    const ascResult = querySetStore.render({ 
      offset: 0,
      limit: 10,
      sortFn: (a, b) => a - b
    });
    
    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(sortSpy).toHaveBeenCalledTimes(1);
    expect(ascResult).toEqual([1, 2, 3, 4, 5, 6]);
    
    // Second render with descending sort
    // Should reuse the cached processed IDs but apply new sorting
    const descResult = querySetStore.render({ 
      offset: 0,
      limit: 10,
      sortFn: (a, b) => b - a
    });
    
    expect(processSpy).toHaveBeenCalledTimes(1); // Still once - cached IDs used
    expect(sortSpy).toHaveBeenCalledTimes(2); // New sort function applied
    expect(descResult).toEqual([6, 5, 4, 3, 2, 1]);
    
    // Third render with same sort but different pagination
    const pageResult = querySetStore.render({ 
      offset: 2,
      limit: 2,
      sortFn: (a, b) => b - a
    });
    
    expect(processSpy).toHaveBeenCalledTimes(1); // Still once - cached IDs used
    expect(sortSpy).toHaveBeenCalledTimes(3); // Sort applied again
    expect(pageResult).toEqual([4, 3]); // Just the middle 2 items
    
    processSpy.mockRestore();
    sortSpy.mockRestore();
  });
});

// Test pagination with offset/limit
describe('QuerySetStore Pagination Methods', () => {
  let querySetStore;
  
  beforeEach(() => {
    // Set up QuerySetStore
    querySetStore = new QuerySetStore({
      queryName: 'test_query',
      fetchQuerySet: () => Promise.resolve([...initialIds]),
      defaultLimit: 4
    });
    
    // Initialize ground truth IDs for QuerySetStore
    querySetStore._setGroundTruthIds([...initialIds]);
    
    // Add more IDs for pagination tests
    querySetStore.add({
      type: 'create',
      ids: [4, 5, 6, 7, 8, 9, 10]
    });
  });
  
  test('should use defaultLimit when not specified', () => {
    // Create store with different default limit
    const storeWithDifferentDefault = new QuerySetStore({
      queryName: 'test_query',
      fetchQuerySet: () => Promise.resolve([...initialIds]),
      defaultLimit: 3
    });
    
    storeWithDifferentDefault._setGroundTruthIds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    
    // Get slice without specifying limit
    const result = storeWithDifferentDefault.getSlice({ offset: 0 });
    
    expect(result.ids.length).toBe(3); // Should use default limit
    expect(result.metadata.limit).toBe(3);
    expect(result.metadata.totalItems).toBe(10);
  });
  
  test('should handle empty results in getSlice', () => {
    // Create store with no IDs
    const emptyStore = new QuerySetStore({
      queryName: 'empty_query',
      fetchQuerySet: () => Promise.resolve([]),
      defaultLimit: 10
    });
    
    // Empty getSlice result
    const sliceResult = emptyStore.getSlice({ offset: 0, limit: 10 });
    
    expect(sliceResult.ids).toEqual([]);
    expect(sliceResult.metadata.totalItems).toBe(0);
    expect(sliceResult.metadata.hasMore).toBe(false);
  });
  
  test('should apply sorting in getSlice', () => {
    // Define sort function
    const sortDesc = (a, b) => b - a;
    
    // Get slice with sorting
    const result = querySetStore.getSlice({ 
      offset: 0, 
      limit: 5,
      sortFn: sortDesc
    });
    
    // Verify sorting was applied
    expect(result.ids).toEqual([10, 9, 8, 7, 6]);
  });
  
  test('should return proper metadata for a middle slice', () => {
    // Get middle slice
    const result = querySetStore.getSlice({ offset: 3, limit: 2 });
    
    expect(result.ids.length).toBe(2);
    expect(result.metadata.hasMore).toBe(true);
    expect(result.metadata.offset).toBe(3);
    expect(result.metadata.limit).toBe(2);
    expect(result.metadata.totalItems).toBe(10);
  });
  
  test('should return proper metadata for last slice', () => {
    // Get last slice
    const result = querySetStore.getSlice({ offset: 8, limit: 3 });
    
    expect(result.ids.length).toBe(2);
    expect(result.metadata.hasMore).toBe(false);
    expect(result.metadata.offset).toBe(8);
    expect(result.metadata.totalItems).toBe(10);
  });
  
  test('should handle out of range offset', () => {
    // Get slice with offset beyond data length
    const result = querySetStore.getSlice({ offset: 20, limit: 3 });
    
    expect(result.ids.length).toBe(0);
    expect(result.metadata.hasMore).toBe(false);
    expect(result.metadata.offset).toBe(20);
    expect(result.metadata.totalItems).toBe(10);
  });
});