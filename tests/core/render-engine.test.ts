/**
 * RenderEngine and QueryState tests using Vitest
 */
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { QueryState } from '../../src/core-refactor/state/QueryState.js';
import { RenderEngine } from '../../src/core-refactor/rendering/RenderEngine.js';

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

describe('RenderEngine', () => {
  let directDB;
  let queryState;
  let renderEngine;

  beforeEach(() => {
    // Reset direct DB for each test
    directDB = new SimpleDB(initialData, 'id');

    // Set up QueryState and RenderEngine
    queryState = new QueryState({
      primaryKey: 'id',
      fetchGroundTruth: () => Promise.resolve([...initialData])
    });

    // Initialize ground truth
    queryState._setGroundTruth([...initialData]);

    // Create RenderEngine
    renderEngine = new RenderEngine(queryState);
  });

  test('should create records correctly', () => {
    // Direct operation
    directDB.create({ id: 4, name: 'Dave', role: 'manager' });

    // QueryState operation
    queryState.add({
      type: 'create',
      instances: [{ id: 4, name: 'Dave', role: 'manager' }]
    });

    // Compare results
    const directData = directDB.getAll();
    const renderedData = renderEngine.render({ offset: 0, limit: 1000 });

    expect(renderedData).toEqual(directData);
  });

  test('should update records correctly', () => {
    // Direct operation
    directDB.update({ id: 2, role: 'admin' });

    // QueryState operation
    queryState.add({
      type: 'update',
      instances: [{ id: 2, role: 'admin' }]
    });

    // Compare results
    const directData = directDB.getAll();
    const renderedData = renderEngine.render({ offset: 0, limit: 1000 });

    expect(renderedData).toEqual(directData);
  });

  test('should delete records correctly', () => {
    // Direct operation
    directDB.delete(3);

    // QueryState operation
    queryState.add({
      type: 'delete',
      instances: [3]
    });

    // Compare results
    const directData = directDB.getAll();
    const renderedData = renderEngine.render({ offset: 0, limit: 1000 });

    expect(renderedData).toEqual(directData);
  });

  test('should handle complex sequence of operations', () => {
    // Direct operations
    directDB.create({ id: 4, name: 'Dave', role: 'manager' });
    directDB.create({ id: 5, name: 'Eve', role: 'user' });
    directDB.update({ id: 4, role: 'admin' });
    directDB.delete(1);

    // QueryState operations
    queryState.add({
      type: 'create',
      instances: [{ id: 4, name: 'Dave', role: 'manager' }]
    });

    queryState.add({
      type: 'create',
      instances: [{ id: 5, name: 'Eve', role: 'user' }]
    });

    queryState.add({
      type: 'update',
      instances: [{ id: 4, role: 'admin' }]
    });

    queryState.add({
      type: 'delete',
      instances: [1]
    });

    // Compare results
    const directData = directDB.getAll();
    const renderedData = renderEngine.render({ offset: 0, limit: 1000 });

    expect(renderedData).toEqual(directData);
  });

  test('should handle pagination and sorting', () => {
    // Add more data for pagination test
    directDB.create([
      { id: 4, name: 'Dave', role: 'manager' },
      { id: 5, name: 'Eve', role: 'user' }
    ]);

    queryState.add({
      type: 'create',
      instances: [
        { id: 4, name: 'Dave', role: 'manager' },
        { id: 5, name: 'Eve', role: 'user' }
      ]
    });

    // Define sorting function
    const sortFn = (a, b) => a.name.localeCompare(b.name);

    // Test different pagination parameters
    const testCases = [
      { offset: 0, limit: 2 },
      { offset: 2, limit: 2 },
      { offset: 0, limit: 5 }
    ];

    testCases.forEach(params => {
      const directData = directDB.getPaginated(params.offset, params.limit, sortFn);
      const renderedData = renderEngine.render({
        ...params,
        sortFn
      });

      expect(renderedData).toEqual(directData);
    });
  });

  test('should handle empty results', () => {
    // Delete all records
    directDB.delete([1, 2, 3]);

    queryState.add({
      type: 'delete',
      instances: [1, 2, 3]
    });

    // Compare results
    const directData = directDB.getAll();
    const renderedData = renderEngine.render({ offset: 0, limit: 1000 });

    expect(renderedData).toEqual(directData);
    expect(renderedData.length).toBe(0);
  });

  test('should handle operation status (confirm/reject)', () => {
    // Add an operation but don't confirm it
    const opId = queryState.add({
      type: 'create',
      instances: [{ id: 4, name: 'Dave', role: 'manager' }]
    });

    // Reject the operation
    queryState.reject(opId);

    // Direct DB should be unchanged
    const directData = directDB.getAll();
    const renderedData = renderEngine.render({ offset: 0, limit: 1000 });

    expect(renderedData).toEqual(directData);

    // Now add and confirm an operation
    const opId2 = queryState.add({
      type: 'create',
      instances: [{ id: 5, name: 'Eve', role: 'user' }]
    });

    queryState.confirm(opId2);

    // Direct DB needs to be updated to match
    directDB.create({ id: 5, name: 'Eve', role: 'user' });

    const updatedDirectData = directDB.getAll();
    const updatedRenderedData = renderEngine.render({ offset: 0, limit: 1000 });

    expect(updatedRenderedData).toEqual(updatedDirectData);
  });
});

const sortByName = (a, b) => a.name.localeCompare(b.name);

describe('RenderEngine High Frequency & Edge Cases', () => {
  let directDB;
  let queryState;
  let renderEngine;
  let fetchMock;
  // Define testMaxOperationAge for easier control if needed
  const testMaxOperationAge = 15 * 1000; // Match default or set lower for faster tests

  // Use fake timers for tests involving maxOperationAge
  beforeEach(() => {
    vi.useFakeTimers(); // Enable fake timers

    // Reset direct DB
    directDB = new SimpleDB(initialData, 'id');

    // Mock fetch function
    fetchMock = vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(initialData)));

    // Set up QueryState and RenderEngine
    queryState = new QueryState({
      primaryKey: 'id',
      fetchGroundTruth: fetchMock,
      syncInterval: 0, // Disable automatic periodic sync for tests
      maxOperationAge: testMaxOperationAge // Use defined age
    });

    // Initialize ground truth manually
    queryState._setGroundTruth(JSON.parse(JSON.stringify(initialData)));

    renderEngine = new RenderEngine(queryState);
    renderEngine.subscribeToChanges(); // Subscribe for cache invalidation tests
  });

  afterEach(() => {
     vi.useRealTimers(); // Restore real timers after each test
  });

  // --- Basic Tests (Keep existing ones for regression) ---
  test('basic create records correctly', () => {
    directDB.create({ id: 4, name: 'Dave', role: 'manager' });
    queryState.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    expect(renderEngine.render({ offset: 0, limit: 1000 })).toEqual(directDB.getAll());
  });

  test('basic update records correctly', () => {
    directDB.update({ id: 2, role: 'admin' });
    queryState.add({ type: 'update', instances: [{ id: 2, role: 'admin' }] });
    expect(renderEngine.render({ offset: 0, limit: 1000 })).toEqual(directDB.getAll());
  });

  test('basic delete records correctly', () => {
    directDB.delete(3);
    queryState.add({ type: 'delete', instances: [3] });
    expect(renderEngine.render({ offset: 0, limit: 1000 })).toEqual(directDB.getAll());
  });

  test('basic complex sequence of operations', () => {
    directDB.create([{ id: 4, name: 'Dave', role: 'manager' }, { id: 5, name: 'Eve', role: 'user' }]);
    directDB.update({ id: 4, role: 'admin' });
    directDB.delete(1);

    queryState.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    queryState.add({ type: 'create', instances: [{ id: 5, name: 'Eve', role: 'user' }] });
    queryState.add({ type: 'update', instances: [{ id: 4, role: 'admin' }] });
    queryState.add({ type: 'delete', instances: [1] });

    expect(renderEngine.render({ offset: 0, limit: 1000, sortFn: sortByName })).toEqual(directDB.getAll(sortByName));
  });

  test('basic pagination and sorting', () => {
     directDB.create([ { id: 4, name: 'Dave', role: 'manager' }, { id: 5, name: 'Eve', role: 'user' }]);
     queryState.add({ type: 'create', instances: [ { id: 4, name: 'Dave', role: 'manager' }, { id: 5, name: 'Eve', role: 'user' } ] });

    const testCases = [ { offset: 0, limit: 2 }, { offset: 2, limit: 2 }, { offset: 0, limit: 5 } ];
    testCases.forEach(params => {
      expect(renderEngine.render({...params, sortFn: sortByName})).toEqual(directDB.getPaginated(params.offset, params.limit, sortByName));
    });
  });

  // --- New/Modified Edge Case Tests ---

  test('should handle inflight operations added *during* sync', async () => {
    let resolveFetch;
    const slowFetch = new Promise(resolve => { resolveFetch = resolve; });
    fetchMock.mockReturnValueOnce(slowFetch);

    const syncPromise = queryState.sync();

    expect(queryState.isSyncing).toBe(true);
    const opId = queryState.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });

    resolveFetch(JSON.parse(JSON.stringify(initialData)));
    await syncPromise;

    expect(queryState.isSyncing).toBe(false);
    expect(queryState.operations.has(opId)).toBe(true);
    expect(queryState.operations.get(opId)?.status).toBe('inflight');
    expect(queryState.getGroundTruth()).toEqual(initialData);

    directDB.create({ id: 4, name: 'Dave', role: 'manager' });
    expect(renderEngine.render({ offset: 0, limit: 1000, sortFn: sortByName })).toEqual(directDB.getAll(sortByName));
  });

  // --- *** UPDATED TEST *** ---
  test('should clear confirmed operations only after maxOperationAge', async () => {
    // Add and confirm an operation
    const opId = queryState.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    queryState.confirm(opId);
    expect(queryState.operations.get(opId)?.status).toBe('confirmed');

    // Sync (fetch returns original data)
    await queryState.sync();

    // The confirmed operation should *still exist* immediately after sync (it's new)
    expect(queryState.operations.has(opId)).toBe(true);
    expect(queryState.getGroundTruth()).toEqual(initialData);

    // Rendered result includes the (recent) confirmed op applied to ground truth
    directDB.create({ id: 4, name: 'Dave', role: 'manager' }); // Apply op for comparison
    expect(renderEngine.render({ offset: 0, limit: 1000 })).toEqual(directDB.getAll());

    // Advance time beyond maxOperationAge
    vi.advanceTimersByTime(testMaxOperationAge + 1); // Advance clock

    // Sync again - this sync *should* trigger the trim
    // Make fetchMock return initial data again for consistency
    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(initialData)));
    await queryState.sync();

    // Now the confirmed operation should be removed
    expect(queryState.operations.has(opId)).toBe(false);
    expect(queryState.getGroundTruth()).toEqual(initialData); // Ground truth is still initial

    // Rendered result should now match the synced ground truth *without* the old op
    directDB = new SimpleDB(initialData, 'id'); // Reset directDB to reflect final state
    expect(renderEngine.render({ offset: 0, limit: 1000 })).toEqual(directDB.getAll());
  });

  // --- *** UPDATED TEST *** ---
   test('should clear rejected operations only after maxOperationAge', async () => {
    // Add and reject an operation
    const opId = queryState.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    queryState.reject(opId);
    expect(queryState.operations.get(opId)?.status).toBe('rejected');

    // Sync
    await queryState.sync();

    // The rejected operation should *still exist* immediately after sync (it's new)
    expect(queryState.operations.has(opId)).toBe(true);
    expect(queryState.getGroundTruth()).toEqual(initialData);

    // Rendered result matches ground truth (rejected op has no effect on render)
    directDB = new SimpleDB(initialData, 'id'); // Reset directDB to reflect sync
    expect(renderEngine.render({ offset: 0, limit: 1000 })).toEqual(directDB.getAll());

    // Advance time beyond maxOperationAge
    vi.advanceTimersByTime(testMaxOperationAge + 1);

    // Sync again - this sync should trigger the trim
    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(initialData)));
    await queryState.sync();

    // Now the rejected operation should be removed
    expect(queryState.operations.has(opId)).toBe(false);
    expect(queryState.getGroundTruth()).toEqual(initialData);

    // Rendered result still matches the synced ground truth
    directDB = new SimpleDB(initialData, 'id');
    expect(renderEngine.render({ offset: 0, limit: 1000 })).toEqual(directDB.getAll());
  });

  test('should handle conflicting inflight operations (create then delete)', () => {
    queryState.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    queryState.add({ type: 'delete', instances: [4] });
    const renderedData = renderEngine.render({ offset: 0, limit: 1000, sortFn: sortByName });
    expect(renderedData).toEqual(directDB.getAll(sortByName));
    expect(renderedData.find(item => item.id === 4)).toBeUndefined();
  });

  test('should handle conflicting inflight operations (update then delete)', () => {
    queryState.add({ type: 'update', instances: [{ id: 1, name: 'Alicia' }] });
    queryState.add({ type: 'delete', instances: [1] });
    directDB.delete(1);
    const renderedData = renderEngine.render({ offset: 0, limit: 1000, sortFn: sortByName });
    expect(renderedData).toEqual(directDB.getAll(sortByName));
    expect(renderedData.find(item => item.id === 1)).toBeUndefined();
  });

   test('should handle inflight operation on item deleted by subsequent sync', async () => {
    const opId = queryState.add({ type: 'update', instances: [{ id: 1, name: 'Alicia' }] });
    expect(renderEngine.render({ offset: 0, limit: 10 }).find(i => i.id === 1)?.name).toBe('Alicia');

    const dataWithoutItem1 = initialData.filter(item => item.id !== 1);
    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(dataWithoutItem1)));
    await queryState.sync();

    expect(queryState.getGroundTruth()).toEqual(dataWithoutItem1);
    expect(queryState.operations.has(opId)).toBe(true);
    expect(queryState.operations.get(opId)?.status).toBe('inflight');

    directDB = new SimpleDB(dataWithoutItem1, 'id');
    const renderedData = renderEngine.render({ offset: 0, limit: 1000, sortFn: sortByName });
    expect(renderedData).toEqual(directDB.getAll(sortByName));
    expect(renderedData.find(item => item.id === 1)).toBeUndefined();
  });

  test('should correctly paginate and sort with mixed ground truth and inflight operations', () => {
    queryState.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    queryState.add({ type: 'update', instances: [{ id: 1, name: 'Alicia The Admin' }] });
    queryState.add({ type: 'delete', instances: [2] });
    queryState.add({ type: 'create', instances: [{ id: 5, name: 'Eve', role: 'tester' }] });

    directDB.create([{ id: 4, name: 'Dave', role: 'manager' }, { id: 5, name: 'Eve', role: 'tester' }]);
    directDB.update({ id: 1, name: 'Alicia The Admin' });
    directDB.delete(2);
    const expectedFullSorted = directDB.getAll(sortByName);

    let rendered = renderEngine.render({ offset: 0, limit: 2, sortFn: sortByName });
    expect(rendered).toEqual(expectedFullSorted.slice(0, 2));

    rendered = renderEngine.render({ offset: 2, limit: 2, sortFn: sortByName });
    expect(rendered).toEqual(expectedFullSorted.slice(2, 4));

    rendered = renderEngine.render({ offset: 0, limit: 3 });
    expect(rendered.length).toBe(3);
    const renderedIds = rendered.map(i => i.id);
    expect(renderedIds).toEqual(expect.arrayContaining([1, 3]));
    expect(renderedIds).not.toContain(2);

     rendered = renderEngine.render({ offset: 0, limit: 10, sortFn: sortByName });
     expect(rendered).toEqual(expectedFullSorted);
  });

  test('render cache should invalidate and reflect operation trimming', async () => {
    const params = { offset: 0, limit: 10, sortFn: sortByName };

    // Spy on _processOperations to check cache hits/misses
    const processOpsSpy = vi.spyOn(renderEngine, '_processOperations');

    // --- Setup: Initial Render (Cache Miss) ---
    const initialRenderSorted = renderEngine.render(params); // Get the sorted, paginated output
    const initialVersion = queryState.version;

    // Verify cache content after initial render
    expect(processOpsSpy).toHaveBeenCalledTimes(1); // Should have been called once
    expect(renderEngine._cache.queryStateVersion).toBe(initialVersion);
    expect(renderEngine._cache.processedData).toBeInstanceOf(Array);
    expect(renderEngine._cache.processedData.length).toBe(initialData.length);
    // Check if processedData contains the initial items (order doesn't matter here)
    expect(renderEngine._cache.processedData.map(i => i.id).sort()).toEqual(initialData.map(i => i.id).sort());
    // Check the final rendered output is correct
    expect(initialRenderSorted).toEqual([...initialData].sort(sortByName));

    processOpsSpy.mockClear(); // Reset spy counter

    // --- Second Render (Cache Hit) ---
    const cachedRenderSorted = renderEngine.render(params);
    expect(processOpsSpy).not.toHaveBeenCalled(); // Cache hit, should NOT call _processOperations
    expect(queryState.version).toBe(initialVersion); // Version unchanged
    expect(renderEngine._cache.queryStateVersion).toBe(initialVersion); // Cache version still the same
    expect(cachedRenderSorted).toEqual(initialRenderSorted); // Output should be identical

    processOpsSpy.mockClear();

    // --- Add Operation (Cache Invalidated by QueryState update) ---
    const opId = queryState.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    const versionAfterAdd = queryState.version;
    expect(versionAfterAdd).toBeGreaterThan(initialVersion); // Version bumped by add

    // No need to manually simulate stale cache here, subscribeToChanges should handle it
    // The renderEngine cache version is now -1 because queryState notified it.
    expect(renderEngine._cache.queryStateVersion).toBe(-1); // Verify invalidation happened

    const renderAfterAddSorted = renderEngine.render(params);
    expect(processOpsSpy).toHaveBeenCalledTimes(1); // Cache miss, _processOperations called
    directDB.create({ id: 4, name: 'Dave', role: 'manager' }); // Update directDB for comparison
    expect(renderAfterAddSorted).toEqual(directDB.getAll(sortByName)); // Expect new data, sorted
    expect(renderEngine._cache.queryStateVersion).toBe(versionAfterAdd); // Cache updated to new version
    expect(renderEngine._cache.processedData.length).toBe(4); // Check cache content
    expect(renderEngine._cache.processedData.map(i => i.id).sort()).toEqual([1, 2, 3, 4]);

    processOpsSpy.mockClear();

    // --- Confirm Operation (Cache Invalidated by QueryState update) ---
    queryState.confirm(opId);
    const versionAfterConfirm = queryState.version;
    expect(versionAfterConfirm).toBeGreaterThan(versionAfterAdd); // Version bumped by confirm

    // Cache automatically invalidated by subscription
    expect(renderEngine._cache.queryStateVersion).toBe(-1);

    const renderAfterConfirmSorted = renderEngine.render(params);
    expect(processOpsSpy).toHaveBeenCalledTimes(1); // Cache miss
    // State visually same, but cache re-evaluated
    expect(renderAfterConfirmSorted).toEqual(directDB.getAll(sortByName)); // Still 4 items, sorted
    expect(renderEngine._cache.queryStateVersion).toBe(versionAfterConfirm); // Cache updated
    expect(renderEngine._cache.processedData.length).toBe(4);
    expect(renderEngine._cache.processedData.map(i => i.id).sort()).toEqual([1, 2, 3, 4]); // Cache content unchanged visually

    processOpsSpy.mockClear();

    // --- Sync 1 (Op too new to trim, Cache Invalidated) ---
    const versionBeforeSync1 = queryState.version;
    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(initialData))); // Fetch returns 3 items
    await queryState.sync();
    const versionAfterSync1 = queryState.version;
    expect(versionAfterSync1).toBeGreaterThan(versionBeforeSync1); // Version bumped

    // Cache automatically invalidated by subscription (due to _setGroundTruth or notifications)
    expect(renderEngine._cache.queryStateVersion).toBe(-1);

    // Render after first sync - includes ground truth (3) + recent confirmed op 'Dave' (1) = 4 items
    const renderAfterSync1Sorted = renderEngine.render(params);
    expect(processOpsSpy).toHaveBeenCalledTimes(1); // Cache miss
    // directDB still has Dave from before sync, which is the expected *rendered* state
    expect(renderAfterSync1Sorted).toEqual(directDB.getAll(sortByName)); // Expect 4 items, sorted
    expect(queryState.operations.has(opId)).toBe(true); // Operation still present
    expect(renderEngine._cache.queryStateVersion).toBe(versionAfterSync1); // Cache updated
    expect(renderEngine._cache.processedData.length).toBe(4); // Cache reflects GT + op
    expect(renderEngine._cache.processedData.map(i => i.id).sort()).toEqual([1, 2, 3, 4]);

    processOpsSpy.mockClear();

    // --- Sync 2 (Op trimmed, Cache Invalidated) ---
    vi.advanceTimersByTime(testMaxOperationAge + 1); // Advance clock past expiry time
    const versionBeforeSync2 = queryState.version;
    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(initialData))); // Fetch returns 3 items again
    await queryState.sync(); // This sync will trigger the trim internally in QueryState
    const versionAfterSync2 = queryState.version;
    expect(versionAfterSync2).toBeGreaterThan(versionBeforeSync2); // Version bumped by op removal notification

    // Cache automatically invalidated by subscription (due to op removal)
    expect(renderEngine._cache.queryStateVersion).toBe(-1);

    // Render after second sync - confirmed op 'Dave' should be gone
    const renderAfterSync2Sorted = renderEngine.render(params);
    expect(processOpsSpy).toHaveBeenCalledTimes(1); // Cache miss
    directDB = new SimpleDB(initialData, 'id'); // Reset directDB to reflect final state (3 items)
    expect(renderAfterSync2Sorted).toEqual(directDB.getAll(sortByName)); // Expect 3 items, sorted
    expect(queryState.operations.has(opId)).toBe(false); // Operation trimmed from QueryState
    expect(renderEngine._cache.queryStateVersion).toBe(versionAfterSync2); // Cache updated
    expect(renderEngine._cache.processedData.length).toBe(3); // Cache reflects only ground truth
    expect(renderEngine._cache.processedData.map(i => i.id).sort()).toEqual([1, 2, 3]);

    // Restore spy
    processOpsSpy.mockRestore();
 });

  test('should handle delete operation for non-existent item gracefully', () => {
    const initialRender = renderEngine.render({ offset: 0, limit: 10 });
    queryState.add({ type: 'delete', instances: [99] }); // Item 99 doesn't exist
    const afterDeleteRender = renderEngine.render({ offset: 0, limit: 10 });

    // Rendered output should be unchanged
    expect(afterDeleteRender).toEqual(initialRender);
    expect(queryState.operations.size).toBe(1); // Operation is still tracked
  });

  test('should handle update operation for non-existent item gracefully', () => {
    const initialRender = renderEngine.render({ offset: 0, limit: 10 });
    queryState.add({ type: 'update', instances: [{ id: 99, name: 'Ghost' }] }); // Item 99 doesn't exist
    const afterUpdateRender = renderEngine.render({ offset: 0, limit: 10 });

    // Rendered output should be unchanged
    expect(afterUpdateRender).toEqual(initialRender);
    expect(queryState.operations.size).toBe(1); // Operation is still tracked
  });

  // --- Keep Confirmation/Rejection describe blocks as they are ---
  describe('Operation Confirmation', () => {
    test('should change operation status to confirmed', () => {
      const opId = queryState.add({ type: 'create', instances: [{ id: 4, name: 'Dave' }] });
      expect(queryState.operations.get(opId)?.status).toBe('inflight');

      const result = queryState.confirm(opId);

      expect(result).toBe(true);
      expect(queryState.operations.get(opId)?.status).toBe('confirmed');
    });

    test('should reflect confirmed create operation in render', () => {
      const opId = queryState.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'new' }] });

      // Render includes inflight op
      let rendered = renderEngine.render({ offset: 0, limit: 10 });
      expect(rendered.find(i => i.id === 4)).toMatchObject({ name: 'Dave', role: 'new' });

      queryState.confirm(opId);

      // Render still includes the op, now confirmed
      rendered = renderEngine.render({ offset: 0, limit: 10 });
      expect(rendered.find(i => i.id === 4)).toMatchObject({ name: 'Dave', role: 'new' });

      // Direct DB comparison
      directDB.create({ id: 4, name: 'Dave', role: 'new' });
      expect(rendered).toEqual(directDB.getAll());
    });

    test('should reflect confirmed update operation in render', () => {
      const opId = queryState.add({ type: 'update', instances: [{ id: 1, name: 'Alice V2' }] });

      // Render includes inflight update
      expect(renderEngine.render({ offset: 0, limit: 10 }).find(i => i.id === 1)?.name).toBe('Alice V2');

      queryState.confirm(opId);

      // Render still includes the update, now confirmed
      expect(renderEngine.render({ offset: 0, limit: 10 }).find(i => i.id === 1)?.name).toBe('Alice V2');

      directDB.update({ id: 1, name: 'Alice V2' });
      expect(renderEngine.render({ offset: 0, limit: 10 })).toEqual(directDB.getAll());
    });

    test('should reflect confirmed delete operation in render', () => {
      const opId = queryState.add({ type: 'delete', instances: [1] }); // Delete Alice

      // Render reflects inflight delete
      expect(renderEngine.render({ offset: 0, limit: 10 }).find(i => i.id === 1)).toBeUndefined();

      queryState.confirm(opId);

      // Render still reflects the delete, now confirmed
      expect(renderEngine.render({ offset: 0, limit: 10 }).find(i => i.id === 1)).toBeUndefined();

      directDB.delete(1);
      expect(renderEngine.render({ offset: 0, limit: 10 })).toEqual(directDB.getAll());
    });

    test('should update instances on confirm if provided and reflect in render', () => {
      const opId = queryState.add({ type: 'create', instances: [{ id: 'temp_id', name: 'Dave Temp' }] });

      // Render shows temporary data
      expect(renderEngine.render({ offset: 0, limit: 10 }).find(i => i.id === 'temp_id')?.name).toBe('Dave Temp');

      const finalInstance = { id: 4, name: 'Dave Final', role: 'confirmed' };
      queryState.confirm(opId, [finalInstance]); // Confirm with final data from server

      // Check internal state
      const confirmedOp = queryState.operations.get(opId);
      expect(confirmedOp?.status).toBe('confirmed');
      expect(confirmedOp?.instances).toEqual([finalInstance]);

      // Render should now show the final data
      const rendered = renderEngine.render({ offset: 0, limit: 10, sortFn: sortByName });
      expect(rendered.find(i => i.id === 'temp_id')).toBeUndefined(); // Temp ID gone
      expect(rendered.find(i => i.id === 4)).toEqual(finalInstance); // Final data present

      // Direct DB comparison
      directDB.create(finalInstance);
      expect(rendered).toEqual(directDB.getAll(sortByName));
    });

    test('confirm should return false for non-existent operation ID', () => {
      const result = queryState.confirm('invalid-op-id');
      expect(result).toBe(false);
      // Ensure no operations were accidentally added or changed
      expect(queryState.operations.size).toBe(0);
      expect(renderEngine.render({ offset: 0, limit: 10 })).toEqual(directDB.getAll());
    });
  });

  describe('Operation Rejection', () => {
     test('should change operation status to rejected', () => {
      const opId = queryState.add({ type: 'create', instances: [{ id: 4, name: 'Dave' }] });
      expect(queryState.operations.get(opId)?.status).toBe('inflight');

      const result = queryState.reject(opId);

      expect(result).toBe(true);
      expect(queryState.operations.get(opId)?.status).toBe('rejected');
    });

    test('should remove effect of rejected create operation from render', () => {
      const opId = queryState.add({ type: 'create', instances: [{ id: 4, name: 'Dave' }] });

      // Render includes inflight create
      expect(renderEngine.render({ offset: 0, limit: 10 }).find(i => i.id === 4)).toBeDefined();

      queryState.reject(opId);

      // Render should NOT include the rejected create
      const rendered = renderEngine.render({ offset: 0, limit: 10 });
      expect(rendered.find(i => i.id === 4)).toBeUndefined();

      // Should match original data
      expect(rendered).toEqual(directDB.getAll());
    });

    test('should revert effect of rejected update operation in render', () => {
      const originalAlice = initialData.find(i => i.id === 1);
      const opId = queryState.add({ type: 'update', instances: [{ id: 1, name: 'Alice V2' }] });

      // Render includes inflight update
      expect(renderEngine.render({ offset: 0, limit: 10 }).find(i => i.id === 1)?.name).toBe('Alice V2');

      queryState.reject(opId);

      // Render should show original data for Alice
      const rendered = renderEngine.render({ offset: 0, limit: 10 });
      expect(rendered.find(i => i.id === 1)).toEqual(originalAlice);

      // Should match original data
      expect(rendered).toEqual(directDB.getAll());
    });

     test('should revert effect of rejected delete operation in render', () => {
      const originalAlice = initialData.find(i => i.id === 1);
      const opId = queryState.add({ type: 'delete', instances: [1] }); // Delete Alice

      // Render reflects inflight delete
      expect(renderEngine.render({ offset: 0, limit: 10 }).find(i => i.id === 1)).toBeUndefined();

      queryState.reject(opId);

      // Render should show Alice again
      const rendered = renderEngine.render({ offset: 0, limit: 10 });
      expect(rendered.find(i => i.id === 1)).toEqual(originalAlice);

      // Should match original data
      expect(rendered).toEqual(directDB.getAll());
    });

     test('reject should return false for non-existent operation ID', () => {
      const result = queryState.reject('invalid-op-id');
      expect(result).toBe(false);
      // Ensure no operations were accidentally added or changed
      expect(queryState.operations.size).toBe(0);
      expect(renderEngine.render({ offset: 0, limit: 10 })).toEqual(directDB.getAll());
    });

    test('rejected operations should be ignored even if added after other ops', () => {
        // Add a valid update
        queryState.add({ type: 'update', instances: [{ id: 1, name: 'Alice V2' }] });
        // Add a create, then reject it
        const opIdCreate = queryState.add({ type: 'create', instances: [{ id: 4, name: 'Dave' }] });
        queryState.reject(opIdCreate);
        // Add another valid update
        queryState.add({ type: 'update', instances: [{ id: 2, name: 'Bob V2' }] });

        // Direct DB has updates, but not the rejected create
        directDB.update({ id: 1, name: 'Alice V2' });
        directDB.update({ id: 2, name: 'Bob V2' });

        const rendered = renderEngine.render({ offset: 0, limit: 10, sortFn: sortByName });

        // Check rendered output matches direct DB (no Dave)
        expect(rendered).toEqual(directDB.getAll(sortByName));
        expect(rendered.find(i => i.id === 4)).toBeUndefined();
        expect(rendered.find(i => i.id === 1)?.name).toBe('Alice V2');
        expect(rendered.find(i => i.id === 2)?.name).toBe('Bob V2');
    });
  });
});