/**
 * LiveModelStore tests using Vitest (replacing separate ModelStore/RenderEngine tests)
 */
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
// Import the wrapper class
import { LiveModelStore } from '../../src/core-refactor/live/LiveModelStore.js';

// Simple in-memory database for comparison (remains the same)
class SimpleDB {
  constructor(initialData = [], pkField = 'id') {
    this.data = JSON.parse(JSON.stringify(initialData)); // Deep copy initial data
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

  getPaginated(offset = 0, limit = 10, sortFn) {
    const sorted = this.getAll(sortFn);
    const end = limit === null || limit === undefined ? undefined : offset + limit;
    return sorted.slice(offset, end);
  }
}

// Initial test data
const initialData = [
  { id: 1, name: 'Alice', role: 'admin' },
  { id: 2, name: 'Bob', role: 'user' },
  { id: 3, name: 'Charlie', role: 'user' }
];

const sortByName = (a, b) => a.name.localeCompare(b.name);

// --- Test Suite 1: Basic Operations ---
describe('LiveModelStore Basic Operations', () => {
  let directDB;
  let liveStore; // Use LiveModelStore instance

  beforeEach(() => {
    // Reset direct DB for each test
    directDB = new SimpleDB(initialData, 'id');

    // Set up LiveModelStore
    liveStore = new LiveModelStore({
      primaryKey: 'id',
      // Provide a mock fetch, though we'll manually set ground truth for sync tests
      fetchGroundTruth: () => Promise.resolve(JSON.parse(JSON.stringify(initialData))),
      syncInterval: 0 // Disable auto sync for predictable tests
    });

    // Initialize ground truth manually on the underlying store for simplicity
    // This avoids needing async setup (like forceSync) in beforeEach
    liveStore._modelStore._setGroundTruth(JSON.parse(JSON.stringify(initialData)));
  });

   afterEach(async () => {
      if (liveStore) {
         await liveStore.destroy(); // Clean up store resources
      }
       vi.restoreAllMocks(); // Restore any mocks/spies
   });

  test('should render initial ground truth correctly', () => {
    const directData = directDB.getAll(sortByName);
    const renderedData = liveStore.render({ offset: 0, limit: 1000, sortFn: sortByName });
    expect(renderedData).toEqual(directData);
  });

  test('should render correctly after create operation', () => {
    // Direct operation
    directDB.create({ id: 4, name: 'Dave', role: 'manager' });

    // LiveModelStore operation (using add method)
    liveStore.add({
      type: 'create',
      instances: [{ id: 4, name: 'Dave', role: 'manager' }]
    });

    // Compare results using render
    const directData = directDB.getAll(sortByName);
    const renderedData = liveStore.render({ offset: 0, limit: 1000, sortFn: sortByName });

    expect(renderedData).toEqual(directData);
  });

  test('should render correctly after update operation', () => {
    // Direct operation
    directDB.update({ id: 2, role: 'admin' });

    // LiveModelStore operation
    liveStore.add({
      type: 'update',
      instances: [{ id: 2, role: 'admin' }]
    });

    // Compare results
    const directData = directDB.getAll(sortByName);
    const renderedData = liveStore.render({ offset: 0, limit: 1000, sortFn: sortByName });

    expect(renderedData).toEqual(directData);
  });

  test('should render correctly after delete operation', () => {
    // Direct operation
    directDB.delete(3);

    // LiveModelStore operation
    liveStore.add({
      type: 'delete',
      instances: [3]
    });

    // Compare results
    const directData = directDB.getAll(sortByName);
    const renderedData = liveStore.render({ offset: 0, limit: 1000, sortFn: sortByName });

    expect(renderedData).toEqual(directData);
  });

  test('should handle complex sequence of operations', () => {
    // Direct operations
    directDB.create({ id: 4, name: 'Dave', role: 'manager' });
    directDB.create({ id: 5, name: 'Eve', role: 'user' });
    directDB.update({ id: 4, role: 'admin' });
    directDB.delete(1);

    // LiveModelStore operations
    liveStore.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    liveStore.add({ type: 'create', instances: [{ id: 5, name: 'Eve', role: 'user' }] });
    liveStore.add({ type: 'update', instances: [{ id: 4, role: 'admin' }] });
    liveStore.add({ type: 'delete', instances: [1] });

    // Compare results
    const directData = directDB.getAll(sortByName);
    const renderedData = liveStore.render({ offset: 0, limit: 1000, sortFn: sortByName });

    expect(renderedData).toEqual(directData);
  });

  test('should handle pagination and sorting', () => {
    // Add more data for pagination test
    directDB.create([
      { id: 4, name: 'Dave', role: 'manager' },
      { id: 5, name: 'Eve', role: 'user' }
    ]);

    liveStore.add({
      type: 'create',
      instances: [
        { id: 4, name: 'Dave', role: 'manager' },
        { id: 5, name: 'Eve', role: 'user' }
      ]
    });

    // Test different pagination parameters
    const testCases = [
      { offset: 0, limit: 2 },
      { offset: 2, limit: 2 },
      { offset: 0, limit: 5 },
      { offset: 1, limit: 3 } // Added another case
    ];

    testCases.forEach(params => {
      const directData = directDB.getPaginated(params.offset, params.limit, sortByName);
      // Pass params directly to render
      const renderedData = liveStore.render({
        ...params,
        sortFn: sortByName
      });

      expect(renderedData).toEqual(directData);
    });
  });

  test('should handle empty results after delete all', () => {
    // Delete all records directly
    directDB.delete([1, 2, 3]);

    // Delete all via LiveModelStore operations
    liveStore.add({ type: 'delete', instances: [1] });
    liveStore.add({ type: 'delete', instances: [2] });
    liveStore.add({ type: 'delete', instances: [3] });


    // Compare results
    const directData = directDB.getAll();
    const renderedData = liveStore.render({ offset: 0, limit: 1000 });

    expect(renderedData).toEqual(directData);
    expect(renderedData.length).toBe(0);
  });

  test('should handle operation status (reject)', () => {
    // Add an operation but reject it
    const opId = liveStore.add({
      type: 'create',
      instances: [{ id: 4, name: 'Dave', role: 'manager' }]
    });
    liveStore.reject(opId); // Use reject method

    // Direct DB should be unchanged
    const directData = directDB.getAll(sortByName);
    const renderedData = liveStore.render({ offset: 0, limit: 1000, sortFn: sortByName });

    // Rendered data should not include the rejected operation
    expect(renderedData).toEqual(directData);
  });

   test('should handle operation status (confirm)', () => {
     const opId = liveStore.add({
       type: 'create',
       instances: [{ id: 5, name: 'Eve', role: 'user' }]
     });
     liveStore.confirm(opId); // Use confirm method

     // Direct DB needs to be updated to match the confirmed state
     directDB.create({ id: 5, name: 'Eve', role: 'user' });

     const updatedDirectData = directDB.getAll(sortByName);
     const updatedRenderedData = liveStore.render({ offset: 0, limit: 1000, sortFn: sortByName });

     // Rendered data should include the confirmed operation
     expect(updatedRenderedData).toEqual(updatedDirectData);
   });
});


// --- Test Suite 2: High Frequency & Edge Cases ---
describe('LiveModelStore High Frequency & Edge Cases', () => {
  let directDB;
  let liveStore; // Use LiveModelStore instance
  let fetchMock;
  const testMaxOperationAge = 15 * 1000; // Match default or set lower for faster tests

  beforeEach(() => {
    vi.useFakeTimers(); // Enable fake timers

    // Reset direct DB
    directDB = new SimpleDB(initialData, 'id');

    // Mock fetch function
    fetchMock = vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(initialData)));

    // Set up LiveModelStore
    liveStore = new LiveModelStore({
      primaryKey: 'id',
      fetchGroundTruth: fetchMock,
      syncInterval: 0, // Disable automatic periodic sync for tests
      maxOperationAge: testMaxOperationAge // Use defined age
    });

    // Initialize ground truth manually on the underlying store
    liveStore._modelStore._setGroundTruth(JSON.parse(JSON.stringify(initialData)));
    // No need for explicit renderEngine.subscribeToChanges()
  });

  afterEach(async () => {
     vi.useRealTimers(); // Restore real timers after each test
      if (liveStore) {
         await liveStore.destroy(); // Clean up store resources
      }
      vi.restoreAllMocks();
  });

  // --- Basic Tests (Redundant but kept for quick check) ---
  test('basic create', () => {
    directDB.create({ id: 4, name: 'Dave', role: 'manager' });
    liveStore.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    expect(liveStore.render({ offset: 0, limit: 1000 })).toEqual(directDB.getAll());
  });

  test('basic update', () => {
    directDB.update({ id: 2, role: 'admin' });
    liveStore.add({ type: 'update', instances: [{ id: 2, role: 'admin' }] });
    expect(liveStore.render({ offset: 0, limit: 1000 })).toEqual(directDB.getAll());
  });

  test('basic delete', () => {
    directDB.delete(3);
    liveStore.add({ type: 'delete', instances: [3] });
    expect(liveStore.render({ offset: 0, limit: 1000 })).toEqual(directDB.getAll());
  });

  test('basic complex sequence', () => {
    directDB.create([{ id: 4, name: 'Dave', role: 'manager' }, { id: 5, name: 'Eve', role: 'user' }]);
    directDB.update({ id: 4, role: 'admin' });
    directDB.delete(1);

    liveStore.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    liveStore.add({ type: 'create', instances: [{ id: 5, name: 'Eve', role: 'user' }] });
    liveStore.add({ type: 'update', instances: [{ id: 4, role: 'admin' }] });
    liveStore.add({ type: 'delete', instances: [1] });

    expect(liveStore.render({ offset: 0, limit: 1000, sortFn: sortByName })).toEqual(directDB.getAll(sortByName));
  });

  test('basic pagination and sorting', () => {
     directDB.create([ { id: 4, name: 'Dave', role: 'manager' }, { id: 5, name: 'Eve', role: 'user' }]);
     liveStore.add({ type: 'create', instances: [ { id: 4, name: 'Dave', role: 'manager' }, { id: 5, name: 'Eve', role: 'user' } ] });

    const testCases = [ { offset: 0, limit: 2 }, { offset: 2, limit: 2 }, { offset: 0, limit: 5 } ];
    testCases.forEach(params => {
      expect(liveStore.render({...params, sortFn: sortByName})).toEqual(directDB.getPaginated(params.offset, params.limit, sortByName));
    });
  });

  // --- New/Modified Edge Case Tests ---

  test('should handle inflight operations added *during* sync', async () => {
    let resolveFetch;
    const slowFetch = new Promise(resolve => { resolveFetch = resolve; });
    fetchMock.mockReturnValueOnce(slowFetch);

    // Use forceSync on LiveModelStore
    const syncPromise = liveStore.forceSync();

    expect(liveStore.isSyncing).toBe(true);
    const opId = liveStore.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });

    resolveFetch(JSON.parse(JSON.stringify(initialData)));
    await syncPromise;

    expect(liveStore.isSyncing).toBe(false);
    expect(liveStore.operations.has(opId)).toBe(true); // Access operations via getter
    expect(liveStore.operations.get(opId)?.status).toBe('inflight');
    expect(liveStore.getGroundTruth()).toEqual(initialData);

    directDB.create({ id: 4, name: 'Dave', role: 'manager' });
    // Use render method
    expect(liveStore.render({ offset: 0, limit: 1000, sortFn: sortByName })).toEqual(directDB.getAll(sortByName));
  });

  test('should clear confirmed operations only after maxOperationAge', async () => {
    const opId = liveStore.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    liveStore.confirm(opId);
    expect(liveStore.operations.get(opId)?.status).toBe('confirmed');

    // Sync (fetch returns original data)
    await liveStore.forceSync();

    expect(liveStore.operations.has(opId)).toBe(true);
    expect(liveStore.getGroundTruth()).toEqual(initialData);

    directDB.create({ id: 4, name: 'Dave', role: 'manager' });
    expect(liveStore.render({ offset: 0, limit: 1000 })).toEqual(directDB.getAll());

    vi.advanceTimersByTime(testMaxOperationAge + 1);

    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(initialData)));
    await liveStore.forceSync(); // Sync again to trigger trim

    expect(liveStore.operations.has(opId)).toBe(false);
    expect(liveStore.getGroundTruth()).toEqual(initialData);

    directDB = new SimpleDB(initialData, 'id'); // Reset directDB
    expect(liveStore.render({ offset: 0, limit: 1000 })).toEqual(directDB.getAll());
  });

   test('should clear rejected operations only after maxOperationAge', async () => {
    const opId = liveStore.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    liveStore.reject(opId);
    expect(liveStore.operations.get(opId)?.status).toBe('rejected');

    await liveStore.forceSync();

    expect(liveStore.operations.has(opId)).toBe(true);
    expect(liveStore.getGroundTruth()).toEqual(initialData);

    directDB = new SimpleDB(initialData, 'id');
    expect(liveStore.render({ offset: 0, limit: 1000 })).toEqual(directDB.getAll());

    vi.advanceTimersByTime(testMaxOperationAge + 1);

    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(initialData)));
    await liveStore.forceSync(); // Sync again

    expect(liveStore.operations.has(opId)).toBe(false);
    expect(liveStore.getGroundTruth()).toEqual(initialData);

    directDB = new SimpleDB(initialData, 'id');
    expect(liveStore.render({ offset: 0, limit: 1000 })).toEqual(directDB.getAll());
  });

  test('should handle conflicting inflight operations (create then delete)', () => {
    liveStore.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    liveStore.add({ type: 'delete', instances: [4] });
    const renderedData = liveStore.render({ offset: 0, limit: 1000, sortFn: sortByName });
    expect(renderedData).toEqual(directDB.getAll(sortByName));
    expect(renderedData.find(item => item.id === 4)).toBeUndefined();
  });

  test('should handle conflicting inflight operations (update then delete)', () => {
    liveStore.add({ type: 'update', instances: [{ id: 1, name: 'Alicia' }] });
    liveStore.add({ type: 'delete', instances: [1] });
    directDB.delete(1);
    const renderedData = liveStore.render({ offset: 0, limit: 1000, sortFn: sortByName });
    expect(renderedData).toEqual(directDB.getAll(sortByName));
    expect(renderedData.find(item => item.id === 1)).toBeUndefined();
  });

   test('should handle inflight operation on item deleted by subsequent sync', async () => {
    const opId = liveStore.add({ type: 'update', instances: [{ id: 1, name: 'Alicia' }] });
    expect(liveStore.render({ offset: 0, limit: 10 }).find(i => i.id === 1)?.name).toBe('Alicia');

    const dataWithoutItem1 = initialData.filter(item => item.id !== 1);
    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(dataWithoutItem1)));
    await liveStore.forceSync();

    expect(liveStore.getGroundTruth()).toEqual(dataWithoutItem1);
    expect(liveStore.operations.has(opId)).toBe(true);
    expect(liveStore.operations.get(opId)?.status).toBe('inflight');

    directDB = new SimpleDB(dataWithoutItem1, 'id');
    const renderedData = liveStore.render({ offset: 0, limit: 1000, sortFn: sortByName });
    expect(renderedData).toEqual(directDB.getAll(sortByName));
    expect(renderedData.find(item => item.id === 1)).toBeUndefined();
  });

  test('should correctly paginate and sort with mixed ground truth and inflight operations', () => {
    liveStore.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    liveStore.add({ type: 'update', instances: [{ id: 1, name: 'Alicia The Admin' }] });
    liveStore.add({ type: 'delete', instances: [2] });
    liveStore.add({ type: 'create', instances: [{ id: 5, name: 'Eve', role: 'tester' }] });

    directDB.create([{ id: 4, name: 'Dave', role: 'manager' }, { id: 5, name: 'Eve', role: 'tester' }]);
    directDB.update({ id: 1, name: 'Alicia The Admin' });
    directDB.delete(2);
    const expectedFullSorted = directDB.getAll(sortByName);

    let rendered = liveStore.render({ offset: 0, limit: 2, sortFn: sortByName });
    expect(rendered).toEqual(expectedFullSorted.slice(0, 2));

    rendered = liveStore.render({ offset: 2, limit: 2, sortFn: sortByName });
    expect(rendered).toEqual(expectedFullSorted.slice(2, 4));

    rendered = liveStore.render({ offset: 0, limit: 3 }); // No sortFn here
    expect(rendered.length).toBe(3);
    // Order isn't guaranteed without sortFn, just check content
    const renderedIds = rendered.map(i => i.id);
    expect(renderedIds).toEqual(expect.arrayContaining([1, 3])); // 4 or 5 could be present
    expect(renderedIds).not.toContain(2);

    rendered = liveStore.render({ offset: 0, limit: 10, sortFn: sortByName });
    expect(rendered).toEqual(expectedFullSorted);
  });

  // --- Cache Invalidation Test (Updated) ---
  test('render cache should invalidate and reflect operation trimming', async () => {
    const params = { offset: 0, limit: 10, sortFn: sortByName };

    // Spy on the internal render engine's _processOperations
    const processOpsSpy = vi.spyOn(liveStore._renderEngine, '_processOperations');

    // --- Setup: Initial Render (Cache Miss) ---
    const initialRenderSorted = liveStore.render(params);
    const initialVersion = liveStore.version;

    expect(processOpsSpy).toHaveBeenCalledTimes(1);
    expect(liveStore._renderEngine._cache.queryStateVersion).toBe(initialVersion);
    expect(liveStore._renderEngine._cache.processedData.length).toBe(initialData.length);
    expect(initialRenderSorted).toEqual(directDB.getAll(sortByName));

    processOpsSpy.mockClear();

    // --- Second Render (Cache Hit) ---
    const cachedRenderSorted = liveStore.render(params);
    expect(processOpsSpy).not.toHaveBeenCalled(); // Cache hit
    expect(liveStore.version).toBe(initialVersion);
    expect(liveStore._renderEngine._cache.queryStateVersion).toBe(initialVersion);
    expect(cachedRenderSorted).toEqual(initialRenderSorted);

    processOpsSpy.mockClear();

    // --- Add Operation (Cache Invalidated automatically) ---
    const opId = liveStore.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    const versionAfterAdd = liveStore.version;
    expect(versionAfterAdd).toBeGreaterThan(initialVersion);

    // LiveModelStore's internal subscription handles invalidation
    // Check the cache state *before* the next render triggers update
    expect(liveStore._renderEngine._cache.queryStateVersion).toBe(-1); // Should be invalidated

    const renderAfterAddSorted = liveStore.render(params);
    expect(processOpsSpy).toHaveBeenCalledTimes(1); // Cache miss
    directDB.create({ id: 4, name: 'Dave', role: 'manager' });
    expect(renderAfterAddSorted).toEqual(directDB.getAll(sortByName));
    expect(liveStore._renderEngine._cache.queryStateVersion).toBe(versionAfterAdd); // Cache updated
    expect(liveStore._renderEngine._cache.processedData.length).toBe(4);

    processOpsSpy.mockClear();

    // --- Confirm Operation (Cache Invalidated automatically) ---
    liveStore.confirm(opId);
    const versionAfterConfirm = liveStore.version;
    expect(versionAfterConfirm).toBeGreaterThan(versionAfterAdd);
    expect(liveStore._renderEngine._cache.queryStateVersion).toBe(-1); // Invalidated

    const renderAfterConfirmSorted = liveStore.render(params);
    expect(processOpsSpy).toHaveBeenCalledTimes(1); // Cache miss
    expect(renderAfterConfirmSorted).toEqual(directDB.getAll(sortByName));
    expect(liveStore._renderEngine._cache.queryStateVersion).toBe(versionAfterConfirm);
    expect(liveStore._renderEngine._cache.processedData.length).toBe(4);

    processOpsSpy.mockClear();

    // --- Sync 1 (Op too new to trim, Cache Invalidated) ---
    const versionBeforeSync1 = liveStore.version;
    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(initialData))); // Fetch returns 3 items
    await liveStore.forceSync();
    const versionAfterSync1 = liveStore.version;
    expect(versionAfterSync1).toBeGreaterThan(versionBeforeSync1);
    expect(liveStore._renderEngine._cache.queryStateVersion).toBe(-1); // Invalidated

    const renderAfterSync1Sorted = liveStore.render(params);
    expect(processOpsSpy).toHaveBeenCalledTimes(1); // Cache miss
    // directDB still has Dave, matching rendered state (GT + recent op)
    expect(renderAfterSync1Sorted).toEqual(directDB.getAll(sortByName));
    expect(liveStore.operations.has(opId)).toBe(true);
    expect(liveStore._renderEngine._cache.queryStateVersion).toBe(versionAfterSync1);
    expect(liveStore._renderEngine._cache.processedData.length).toBe(4);

    processOpsSpy.mockClear();

    // --- Sync 2 (Op trimmed, Cache Invalidated) ---
    vi.advanceTimersByTime(testMaxOperationAge + 1);
    const versionBeforeSync2 = liveStore.version;
    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(initialData))); // Fetch 3 items again
    await liveStore.forceSync(); // This sync triggers the trim
    const versionAfterSync2 = liveStore.version;
    // Version might not bump if ONLY trim happened without GT change,
    // but internal state changes, invalidating cache due to op removal notification
    expect(liveStore._renderEngine._cache.queryStateVersion).toBe(-1); // Invalidated


    const renderAfterSync2Sorted = liveStore.render(params);
    expect(processOpsSpy).toHaveBeenCalledTimes(1); // Cache miss
    directDB = new SimpleDB(initialData, 'id'); // Reset directDB to final GT (3 items)
    expect(renderAfterSync2Sorted).toEqual(directDB.getAll(sortByName));
    expect(liveStore.operations.has(opId)).toBe(false); // Operation trimmed
    expect(liveStore._renderEngine._cache.queryStateVersion).toBe(versionAfterSync2); // Cache updated
    expect(liveStore._renderEngine._cache.processedData.length).toBe(3); // Cache has only GT

    // Restore spy
    processOpsSpy.mockRestore();
 });

  test('should handle delete operation for non-existent item gracefully', () => {
    const initialRender = liveStore.render({ offset: 0, limit: 10 });
    liveStore.add({ type: 'delete', instances: [99] }); // Item 99 doesn't exist
    const afterDeleteRender = liveStore.render({ offset: 0, limit: 10 });

    expect(afterDeleteRender).toEqual(initialRender);
    expect(liveStore.operations.size).toBe(1);
  });

  test('should handle update operation for non-existent item gracefully', () => {
    const initialRender = liveStore.render({ offset: 0, limit: 10 });
    liveStore.add({ type: 'update', instances: [{ id: 99, name: 'Ghost' }] }); // Item 99 doesn't exist
    const afterUpdateRender = liveStore.render({ offset: 0, limit: 10 });

    expect(afterUpdateRender).toEqual(initialRender);
    expect(liveStore.operations.size).toBe(1);
  });

  // --- Confirmation/Rejection describe blocks (Updated) ---
  describe('Operation Confirmation', () => {
    test('should change operation status to confirmed', () => {
      const opId = liveStore.add({ type: 'create', instances: [{ id: 4, name: 'Dave' }] });
      expect(liveStore.operations.get(opId)?.status).toBe('inflight');
      const result = liveStore.confirm(opId); // Use confirm method
      expect(result).toBe(true);
      expect(liveStore.operations.get(opId)?.status).toBe('confirmed');
    });

    test('should reflect confirmed create operation in render', () => {
      const opId = liveStore.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'new' }] });
      liveStore.confirm(opId);
      directDB.create({ id: 4, name: 'Dave', role: 'new' });
      expect(liveStore.render({ offset: 0, limit: 10 })).toEqual(directDB.getAll());
      expect(liveStore.render({ offset: 0, limit: 10 }).find(i => i.id === 4)).toBeDefined();
    });

    test('should reflect confirmed update operation in render', () => {
      const opId = liveStore.add({ type: 'update', instances: [{ id: 1, name: 'Alice V2' }] });
      liveStore.confirm(opId);
      directDB.update({ id: 1, name: 'Alice V2' });
      expect(liveStore.render({ offset: 0, limit: 10 })).toEqual(directDB.getAll());
      expect(liveStore.render({ offset: 0, limit: 10 }).find(i => i.id === 1)?.name).toBe('Alice V2');
    });

    test('should reflect confirmed delete operation in render', () => {
      const opId = liveStore.add({ type: 'delete', instances: [1] });
      liveStore.confirm(opId);
      directDB.delete(1);
      expect(liveStore.render({ offset: 0, limit: 10 })).toEqual(directDB.getAll());
      expect(liveStore.render({ offset: 0, limit: 10 }).find(i => i.id === 1)).toBeUndefined();
    });

    test('should update instances on confirm if provided and reflect in render', () => {
      const opId = liveStore.add({ type: 'create', instances: [{ id: 'temp_id', name: 'Dave Temp' }] });
      const finalInstance = { id: 4, name: 'Dave Final', role: 'confirmed' };
      liveStore.confirm(opId, [finalInstance]); // Confirm with final data

      const confirmedOp = liveStore.operations.get(opId);
      expect(confirmedOp?.status).toBe('confirmed');
      expect(confirmedOp?.instances).toEqual([finalInstance]);

      directDB.create(finalInstance);
      const rendered = liveStore.render({ offset: 0, limit: 10, sortFn: sortByName });
      expect(rendered).toEqual(directDB.getAll(sortByName));
      expect(rendered.find(i => i.id === 'temp_id')).toBeUndefined();
      expect(rendered.find(i => i.id === 4)).toEqual(finalInstance);
    });

    test('confirm should return false for non-existent operation ID', () => {
      const result = liveStore.confirm('invalid-op-id');
      expect(result).toBe(false);
      expect(liveStore.operations.size).toBe(0);
      expect(liveStore.render({ offset: 0, limit: 10 })).toEqual(directDB.getAll());
    });
  });

  describe('Operation Rejection', () => {
     test('should change operation status to rejected', () => {
      const opId = liveStore.add({ type: 'create', instances: [{ id: 4, name: 'Dave' }] });
      expect(liveStore.operations.get(opId)?.status).toBe('inflight');
      const result = liveStore.reject(opId); // Use reject method
      expect(result).toBe(true);
      expect(liveStore.operations.get(opId)?.status).toBe('rejected');
    });

    test('should remove effect of rejected create operation from render', () => {
      const opId = liveStore.add({ type: 'create', instances: [{ id: 4, name: 'Dave' }] });
      liveStore.reject(opId);
      const rendered = liveStore.render({ offset: 0, limit: 10 });
      expect(rendered.find(i => i.id === 4)).toBeUndefined();
      expect(rendered).toEqual(directDB.getAll());
    });

    test('should revert effect of rejected update operation in render', () => {
      const originalAlice = JSON.parse(JSON.stringify(initialData.find(i => i.id === 1)));
      const opId = liveStore.add({ type: 'update', instances: [{ id: 1, name: 'Alice V2' }] });
      liveStore.reject(opId);
      const rendered = liveStore.render({ offset: 0, limit: 10 });
      expect(rendered.find(i => i.id === 1)).toEqual(originalAlice);
      expect(rendered).toEqual(directDB.getAll());
    });

     test('should revert effect of rejected delete operation in render', () => {
      const originalAlice = JSON.parse(JSON.stringify(initialData.find(i => i.id === 1)));
      const opId = liveStore.add({ type: 'delete', instances: [1] });
      liveStore.reject(opId);
      const rendered = liveStore.render({ offset: 0, limit: 10 });
      expect(rendered.find(i => i.id === 1)).toEqual(originalAlice);
      expect(rendered).toEqual(directDB.getAll());
    });

     test('reject should return false for non-existent operation ID', () => {
      const result = liveStore.reject('invalid-op-id');
      expect(result).toBe(false);
      expect(liveStore.operations.size).toBe(0);
      expect(liveStore.render({ offset: 0, limit: 10 })).toEqual(directDB.getAll());
    });

    test('rejected operations should be ignored even if added after other ops', () => {
        liveStore.add({ type: 'update', instances: [{ id: 1, name: 'Alice V2' }] });
        const opIdCreate = liveStore.add({ type: 'create', instances: [{ id: 4, name: 'Dave' }] });
        liveStore.reject(opIdCreate);
        liveStore.add({ type: 'update', instances: [{ id: 2, name: 'Bob V2' }] });

        directDB.update({ id: 1, name: 'Alice V2' });
        directDB.update({ id: 2, name: 'Bob V2' });

        const rendered = liveStore.render({ offset: 0, limit: 10, sortFn: sortByName });
        expect(rendered).toEqual(directDB.getAll(sortByName));
        expect(rendered.find(i => i.id === 4)).toBeUndefined();
    });
  });
});