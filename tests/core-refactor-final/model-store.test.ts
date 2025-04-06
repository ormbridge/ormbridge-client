/**
 * ModelStore tests using Vitest (updated for simplified ModelStore)
 */
import 'fake-indexeddb/auto';
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
// Import the simplified ModelStore class
import { ModelStore } from '../../src/core-refactor-final/store/modelstore/ModelStore.js';

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
describe('ModelStore Basic Operations', () => {
  let directDB;
  let store; // Use simplified ModelStore instance

  beforeEach(() => {
    // Reset direct DB for each test
    directDB = new SimpleDB(initialData, 'id');

    // Set up ModelStore
    store = new ModelStore({
      primaryKey: 'id',
      // Provide a mock fetch, though we'll manually set ground truth for sync tests
      fetchGroundTruth: () => Promise.resolve(JSON.parse(JSON.stringify(initialData)))
    });

    // Initialize ground truth manually for simplicity
    // This avoids needing async setup (like sync) in beforeEach
    store._setGroundTruth(JSON.parse(JSON.stringify(initialData)));
  });

  afterEach(async () => {
    if (store) {
      await store.destroy(); // Clean up store resources
    }
    vi.restoreAllMocks(); // Restore any mocks/spies
  });

  test('should render initial ground truth correctly', () => {
    const directData = directDB.getAll(sortByName);
    const renderedData = store.render({ sortFn: sortByName });
    expect(renderedData).toEqual(directData);
  });

  test('should render correctly after create operation', () => {
    // Direct operation
    directDB.create({ id: 4, name: 'Dave', role: 'manager' });

    // ModelStore operation (using add method)
    store.add({
      type: 'create',
      instances: [{ id: 4, name: 'Dave', role: 'manager' }]
    });

    // Compare results using render
    const directData = directDB.getAll(sortByName);
    const renderedData = store.render({ sortFn: sortByName });

    expect(renderedData).toEqual(directData);
  });

  test('should render correctly after update operation', () => {
    // Direct operation
    directDB.update({ id: 2, role: 'admin' });

    // ModelStore operation
    store.add({
      type: 'update',
      instances: [{ id: 2, role: 'admin' }]
    });

    // Compare results
    const directData = directDB.getAll(sortByName);
    const renderedData = store.render({ sortFn: sortByName });

    expect(renderedData).toEqual(directData);
  });

  test('should render correctly after delete operation', () => {
    // Direct operation
    directDB.delete(3);

    // ModelStore operation
    store.add({
      type: 'delete',
      instances: [3]
    });

    // Compare results
    const directData = directDB.getAll(sortByName);
    const renderedData = store.render({ sortFn: sortByName });

    expect(renderedData).toEqual(directData);
  });

  test('should handle complex sequence of operations', () => {
    // Direct operations
    directDB.create({ id: 4, name: 'Dave', role: 'manager' });
    directDB.create({ id: 5, name: 'Eve', role: 'user' });
    directDB.update({ id: 4, role: 'admin' });
    directDB.delete(1);

    // ModelStore operations
    store.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    store.add({ type: 'create', instances: [{ id: 5, name: 'Eve', role: 'user' }] });
    store.add({ type: 'update', instances: [{ id: 4, role: 'admin' }] });
    store.add({ type: 'delete', instances: [1] });

    // Compare results
    const directData = directDB.getAll(sortByName);
    const renderedData = store.render({ sortFn: sortByName });

    expect(renderedData).toEqual(directData);
  });

  test('should handle sorting', () => {
    // Add more data for sorting test
    directDB.create([
      { id: 4, name: 'Dave', role: 'manager' },
      { id: 5, name: 'Eve', role: 'user' }
    ]);

    store.add({
      type: 'create',
      instances: [
        { id: 4, name: 'Dave', role: 'manager' },
        { id: 5, name: 'Eve', role: 'user' }
      ]
    });

    // Test with sorting
    const directData = directDB.getAll(sortByName);
    const renderedData = store.render({ sortFn: sortByName });

    expect(renderedData).toEqual(directData);
  });

  test('should handle empty results after delete all', () => {
    // Delete all records directly
    directDB.delete([1, 2, 3]);

    // Delete all via ModelStore operations
    store.add({ type: 'delete', instances: [1] });
    store.add({ type: 'delete', instances: [2] });
    store.add({ type: 'delete', instances: [3] });

    // Compare results
    const directData = directDB.getAll();
    const renderedData = store.render();

    expect(renderedData).toEqual(directData);
    expect(renderedData.length).toBe(0);
  });

  test('should handle operation status (reject)', () => {
    // Add an operation but reject it
    const opId = store.add({
      type: 'create',
      instances: [{ id: 4, name: 'Dave', role: 'manager' }]
    });
    store.reject(opId); // Use reject method

    // Direct DB should be unchanged
    const directData = directDB.getAll(sortByName);
    const renderedData = store.render({ sortFn: sortByName });

    // Rendered data should not include the rejected operation
    expect(renderedData).toEqual(directData);
  });

  test('should handle operation status (confirm)', () => {
    const opId = store.add({
      type: 'create',
      instances: [{ id: 5, name: 'Eve', role: 'user' }]
    });
    store.confirm(opId); // Use confirm method

    // Direct DB needs to be updated to match the confirmed state
    directDB.create({ id: 5, name: 'Eve', role: 'user' });

    const updatedDirectData = directDB.getAll(sortByName);
    const updatedRenderedData = store.render({ sortFn: sortByName });

    // Rendered data should include the confirmed operation
    expect(updatedRenderedData).toEqual(updatedDirectData);
  });
});

// --- Test Suite 2: High Frequency & Edge Cases ---
describe('ModelStore High Frequency & Edge Cases', () => {
  let directDB;
  let store; // Use simplified ModelStore instance
  let fetchMock;
  const testMaxOperationAge = 15 * 1000; // Match default or set lower for faster tests

  beforeEach(() => {
    vi.useFakeTimers(); // Enable fake timers

    // Reset direct DB
    directDB = new SimpleDB(initialData, 'id');

    // Mock fetch function
    fetchMock = vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(initialData)));

    // Set up ModelStore
    store = new ModelStore({
      primaryKey: 'id',
      fetchGroundTruth: fetchMock,
      maxOperationAge: testMaxOperationAge // Use defined age
    });

    // Initialize ground truth manually
    store._setGroundTruth(JSON.parse(JSON.stringify(initialData)));
  });

  afterEach(async () => {
    vi.useRealTimers(); // Restore real timers after each test
    if (store) {
      await store.destroy(); // Clean up store resources
    }
    vi.restoreAllMocks();
  });

  // --- Basic Tests (Redundant but kept for quick check) ---
  test('basic create', () => {
    directDB.create({ id: 4, name: 'Dave', role: 'manager' });
    store.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    expect(store.render()).toEqual(directDB.getAll());
  });

  test('basic update', () => {
    directDB.update({ id: 2, role: 'admin' });
    store.add({ type: 'update', instances: [{ id: 2, role: 'admin' }] });
    expect(store.render()).toEqual(directDB.getAll());
  });

  test('basic delete', () => {
    directDB.delete(3);
    store.add({ type: 'delete', instances: [3] });
    expect(store.render()).toEqual(directDB.getAll());
  });

  test('basic complex sequence', () => {
    directDB.create([{ id: 4, name: 'Dave', role: 'manager' }, { id: 5, name: 'Eve', role: 'user' }]);
    directDB.update({ id: 4, role: 'admin' });
    directDB.delete(1);

    store.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    store.add({ type: 'create', instances: [{ id: 5, name: 'Eve', role: 'user' }] });
    store.add({ type: 'update', instances: [{ id: 4, role: 'admin' }] });
    store.add({ type: 'delete', instances: [1] });

    expect(store.render({ sortFn: sortByName })).toEqual(directDB.getAll(sortByName));
  });

  // --- New/Modified Edge Case Tests ---

  test('should handle inflight operations added *during* sync', async () => {
    let resolveFetch;
    const slowFetch = new Promise(resolve => { resolveFetch = resolve; });
    fetchMock.mockReturnValueOnce(slowFetch);

    // Use sync
    const syncPromise = store.sync();

    expect(store.isSyncing).toBe(true);
    const opId = store.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });

    resolveFetch(JSON.parse(JSON.stringify(initialData)));
    await syncPromise;

    expect(store.isSyncing).toBe(false);
    expect(store.operations.has(opId)).toBe(true);
    expect(store.operations.get(opId)?.status).toBe('inflight');
    expect(store.getGroundTruth()).toEqual(initialData);

    directDB.create({ id: 4, name: 'Dave', role: 'manager' });
    // Use render method
    expect(store.render({ sortFn: sortByName })).toEqual(directDB.getAll(sortByName));
  });

  test('should clear confirmed operations only after maxOperationAge', async () => {
    const opId = store.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    store.confirm(opId);
    expect(store.operations.get(opId)?.status).toBe('confirmed');

    // Sync (fetch returns original data)
    await store.sync();

    expect(store.operations.has(opId)).toBe(true);
    expect(store.getGroundTruth()).toEqual(initialData);

    directDB.create({ id: 4, name: 'Dave', role: 'manager' });
    expect(store.render()).toEqual(directDB.getAll());

    vi.advanceTimersByTime(testMaxOperationAge + 1);

    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(initialData)));
    await store.sync(); // Sync again to trigger trim

    expect(store.operations.has(opId)).toBe(false);
    expect(store.getGroundTruth()).toEqual(initialData);

    directDB = new SimpleDB(initialData, 'id'); // Reset directDB
    expect(store.render()).toEqual(directDB.getAll());
  });

  test('should clear rejected operations only after maxOperationAge', async () => {
    const opId = store.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    store.reject(opId);
    expect(store.operations.get(opId)?.status).toBe('rejected');

    await store.sync();

    expect(store.operations.has(opId)).toBe(true);
    expect(store.getGroundTruth()).toEqual(initialData);

    directDB = new SimpleDB(initialData, 'id');
    expect(store.render()).toEqual(directDB.getAll());

    vi.advanceTimersByTime(testMaxOperationAge + 1);

    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(initialData)));
    await store.sync(); // Sync again

    expect(store.operations.has(opId)).toBe(false);
    expect(store.getGroundTruth()).toEqual(initialData);

    directDB = new SimpleDB(initialData, 'id');
    expect(store.render()).toEqual(directDB.getAll());
  });

  test('should handle conflicting inflight operations (create then delete)', () => {
    store.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
    store.add({ type: 'delete', instances: [4] });
    const renderedData = store.render({ sortFn: sortByName });
    expect(renderedData).toEqual(directDB.getAll(sortByName));
    expect(renderedData.find(item => item.id === 4)).toBeUndefined();
  });

  test('should handle conflicting inflight operations (update then delete)', () => {
    store.add({ type: 'update', instances: [{ id: 1, name: 'Alicia' }] });
    store.add({ type: 'delete', instances: [1] });
    directDB.delete(1);
    const renderedData = store.render({ sortFn: sortByName });
    expect(renderedData).toEqual(directDB.getAll(sortByName));
    expect(renderedData.find(item => item.id === 1)).toBeUndefined();
  });

  test('should handle inflight operation on item deleted by subsequent sync', async () => {
    const opId = store.add({ type: 'update', instances: [{ id: 1, name: 'Alicia' }] });
    expect(store.render().find(i => i.id === 1)?.name).toBe('Alicia');

    const dataWithoutItem1 = initialData.filter(item => item.id !== 1);
    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(dataWithoutItem1)));
    await store.sync();

    expect(store.getGroundTruth()).toEqual(dataWithoutItem1);
    expect(store.operations.has(opId)).toBe(true);
    expect(store.operations.get(opId)?.status).toBe('inflight');

    directDB = new SimpleDB(dataWithoutItem1, 'id');
    const renderedData = store.render({ sortFn: sortByName });
    expect(renderedData).toEqual(directDB.getAll(sortByName));
    expect(renderedData.find(item => item.id === 1)).toBeUndefined();
  });

  test('should handle delete operation for non-existent item gracefully', () => {
    const initialRender = store.render();
    store.add({ type: 'delete', instances: [99] }); // Item 99 doesn't exist
    const afterDeleteRender = store.render();

    expect(afterDeleteRender).toEqual(initialRender);
    expect(store.operations.size).toBe(1);
  });

  test('should handle update operation for non-existent item gracefully', () => {
    const initialRender = store.render();
    store.add({ type: 'update', instances: [{ id: 99, name: 'Ghost' }] }); // Item 99 doesn't exist
    const afterUpdateRender = store.render();

    expect(afterUpdateRender).toEqual(initialRender);
    expect(store.operations.size).toBe(1);
  });

  // --- Confirmation/Rejection describe blocks ---
  describe('Operation Confirmation', () => {
    test('should change operation status to confirmed', () => {
      const opId = store.add({ type: 'create', instances: [{ id: 4, name: 'Dave' }] });
      expect(store.operations.get(opId)?.status).toBe('inflight');
      const result = store.confirm(opId);
      expect(result).toBe(true);
      expect(store.operations.get(opId)?.status).toBe('confirmed');
    });

    test('should reflect confirmed create operation in render', () => {
      const opId = store.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'new' }] });
      store.confirm(opId);
      directDB.create({ id: 4, name: 'Dave', role: 'new' });
      expect(store.render()).toEqual(directDB.getAll());
      expect(store.render().find(i => i.id === 4)).toBeDefined();
    });

    test('should reflect confirmed update operation in render', () => {
      const opId = store.add({ type: 'update', instances: [{ id: 1, name: 'Alice V2' }] });
      store.confirm(opId);
      directDB.update({ id: 1, name: 'Alice V2' });
      expect(store.render()).toEqual(directDB.getAll());
      expect(store.render().find(i => i.id === 1)?.name).toBe('Alice V2');
    });

    test('should reflect confirmed delete operation in render', () => {
      const opId = store.add({ type: 'delete', instances: [1] });
      store.confirm(opId);
      directDB.delete(1);
      expect(store.render()).toEqual(directDB.getAll());
      expect(store.render().find(i => i.id === 1)).toBeUndefined();
    });

    test('should update instances on confirm if provided and reflect in render', () => {
      const opId = store.add({ type: 'create', instances: [{ id: 'temp_id', name: 'Dave Temp' }] });
      const finalInstance = { id: 4, name: 'Dave Final', role: 'confirmed' };
      store.confirm(opId, [finalInstance]); // Confirm with final data

      const confirmedOp = store.operations.get(opId);
      expect(confirmedOp?.status).toBe('confirmed');
      expect(confirmedOp?.instances).toEqual([finalInstance]);

      directDB.create(finalInstance);
      const rendered = store.render({ sortFn: sortByName });
      expect(rendered).toEqual(directDB.getAll(sortByName));
      expect(rendered.find(i => i.id === 'temp_id')).toBeUndefined();
      expect(rendered.find(i => i.id === 4)).toEqual(finalInstance);
    });

    test('confirm should return false for non-existent operation ID', () => {
      const result = store.confirm('invalid-op-id');
      expect(result).toBe(false);
      expect(store.operations.size).toBe(0);
      expect(store.render()).toEqual(directDB.getAll());
    });
  });

  describe('Operation Rejection', () => {
    test('should change operation status to rejected', () => {
      const opId = store.add({ type: 'create', instances: [{ id: 4, name: 'Dave' }] });
      expect(store.operations.get(opId)?.status).toBe('inflight');
      const result = store.reject(opId);
      expect(result).toBe(true);
      expect(store.operations.get(opId)?.status).toBe('rejected');
    });

    test('should remove effect of rejected create operation from render', () => {
      const opId = store.add({ type: 'create', instances: [{ id: 4, name: 'Dave' }] });
      store.reject(opId);
      const rendered = store.render();
      expect(rendered.find(i => i.id === 4)).toBeUndefined();
      expect(rendered).toEqual(directDB.getAll());
    });

    test('should revert effect of rejected update operation in render', () => {
      const originalAlice = JSON.parse(JSON.stringify(initialData.find(i => i.id === 1)));
      const opId = store.add({ type: 'update', instances: [{ id: 1, name: 'Alice V2' }] });
      store.reject(opId);
      const rendered = store.render();
      expect(rendered.find(i => i.id === 1)).toEqual(originalAlice);
      expect(rendered).toEqual(directDB.getAll());
    });

    test('should revert effect of rejected delete operation in render', () => {
      const originalAlice = JSON.parse(JSON.stringify(initialData.find(i => i.id === 1)));
      const opId = store.add({ type: 'delete', instances: [1] });
      store.reject(opId);
      const rendered = store.render();
      expect(rendered.find(i => i.id === 1)).toEqual(originalAlice);
      expect(rendered).toEqual(directDB.getAll());
    });

    test('reject should return false for non-existent operation ID', () => {
      const result = store.reject('invalid-op-id');
      expect(result).toBe(false);
      expect(store.operations.size).toBe(0);
      expect(store.render()).toEqual(directDB.getAll());
    });

    test('rejected operations should be ignored even if added after other ops', () => {
      store.add({ type: 'update', instances: [{ id: 1, name: 'Alice V2' }] });
      const opIdCreate = store.add({ type: 'create', instances: [{ id: 4, name: 'Dave' }] });
      store.reject(opIdCreate);
      store.add({ type: 'update', instances: [{ id: 2, name: 'Bob V2' }] });

      directDB.update({ id: 1, name: 'Alice V2' });
      directDB.update({ id: 2, name: 'Bob V2' });

      const rendered = store.render({ sortFn: sortByName });
      expect(rendered).toEqual(directDB.getAll(sortByName));
      expect(rendered.find(i => i.id === 4)).toBeUndefined();
    });
  });

  describe('ModelStore Partial Rendering (pks option)', () => {
    let directDB;
    let store;
  
    beforeEach(() => {
      // Reset direct DB for each test
      directDB = new SimpleDB(initialData, 'id');
  
      // Set up ModelStore
      store = new ModelStore({
        primaryKey: 'id',
        fetchGroundTruth: () => Promise.resolve(JSON.parse(JSON.stringify(initialData)))
      });
  
      // Initialize ground truth manually
      store._setGroundTruth(JSON.parse(JSON.stringify(initialData)));
    });
  
    afterEach(async () => {
      if (store) {
        await store.destroy();
      }
      vi.restoreAllMocks();
    });
  
    test('should render only items specified by pks', () => {
      const pksToRender = [1, 3];
      const expectedData = directDB.getAll().filter(item => pksToRender.includes(item.id));
      const renderedData = store.render({ pks: pksToRender });
  
      // Order might not be guaranteed without sortFn, so compare contents flexibly
      expect(renderedData).toHaveLength(expectedData.length);
      expect(renderedData).toEqual(expect.arrayContaining(expectedData));
      expect(expectedData).toEqual(expect.arrayContaining(renderedData));
    });
  
    test('should render single item specified by pk', () => {
      const pksToRender = [2];
      const expectedData = directDB.getAll().filter(item => pksToRender.includes(item.id));
      const renderedData = store.render({ pks: pksToRender });
  
      expect(renderedData).toHaveLength(1);
      expect(renderedData).toEqual(expectedData);
    });
  
     test('should render empty array if no pks match', () => {
      const pksToRender = [99, 100];
      const renderedData = store.render({ pks: pksToRender });
  
      expect(renderedData).toHaveLength(0);
      expect(renderedData).toEqual([]);
    });
  
    test('should render empty array if pks list is empty', () => {
      const pksToRender = [];
      const renderedData = store.render({ pks: pksToRender });
  
      expect(renderedData).toHaveLength(0);
      expect(renderedData).toEqual([]);
    });
  
    test('should render full data if pks is null or undefined', () => {
      const expectedData = directDB.getAll();
  
      const renderedDataNull = store.render({ pks: null });
      const renderedDataUndefined = store.render({ pks: undefined });
      const renderedDataOmitted = store.render(); // No pks option
  
      // Use flexible comparison due to potential order differences
      expect(renderedDataNull).toHaveLength(expectedData.length);
      expect(renderedDataNull).toEqual(expect.arrayContaining(expectedData));
  
      expect(renderedDataUndefined).toHaveLength(expectedData.length);
      expect(renderedDataUndefined).toEqual(expect.arrayContaining(expectedData));
  
      expect(renderedDataOmitted).toHaveLength(expectedData.length);
      expect(renderedDataOmitted).toEqual(expect.arrayContaining(expectedData));
    });
  
    test('should include newly created item if its pk is requested', () => {
      const newItem = { id: 4, name: 'Dave', role: 'manager' };
      store.add({ type: 'create', instances: [newItem] });
  
      const pksToRender = [1, 4]; // Request existing and new
      const expectedData = [
        directDB.getAll().find(i => i.id === 1), // Alice
        newItem
      ];
      const renderedData = store.render({ pks: pksToRender });
  
      expect(renderedData).toHaveLength(2);
      expect(renderedData).toEqual(expect.arrayContaining(expectedData));
      expect(expectedData).toEqual(expect.arrayContaining(renderedData));
    });
  
    test('should exclude newly created item if its pk is not requested', () => {
      const newItem = { id: 4, name: 'Dave', role: 'manager' };
      store.add({ type: 'create', instances: [newItem] });
  
      const pksToRender = [1, 2]; // Request only existing items
      const expectedData = directDB.getAll().filter(i => pksToRender.includes(i.id));
      const renderedData = store.render({ pks: pksToRender });
  
      expect(renderedData).toHaveLength(expectedData.length);
      expect(renderedData).toEqual(expect.arrayContaining(expectedData));
      expect(expectedData).toEqual(expect.arrayContaining(renderedData));
      expect(renderedData.find(i => i.id === 4)).toBeUndefined();
    });
  
    test('should reflect update on item if its pk is requested', () => {
      const updateData = { id: 2, role: 'admin' };
      store.add({ type: 'update', instances: [updateData] });
  
      const pksToRender = [1, 2]; // Request updated item and another
      const expectedItem1 = directDB.getAll().find(i => i.id === 1);
      const expectedItem2 = { ...directDB.getAll().find(i => i.id === 2), ...updateData }; // Updated Bob
      const expectedData = [expectedItem1, expectedItem2];
  
      const renderedData = store.render({ pks: pksToRender });
  
      expect(renderedData).toHaveLength(2);
      expect(renderedData).toEqual(expect.arrayContaining(expectedData));
      expect(expectedData).toEqual(expect.arrayContaining(renderedData));
      expect(renderedData.find(i => i.id === 2)?.role).toBe('admin');
    });
  
    test('should not reflect update on item if its pk is NOT requested', () => {
      const updateData = { id: 2, role: 'admin' };
      store.add({ type: 'update', instances: [updateData] });
  
      const pksToRender = [1, 3]; // Request items other than the updated one
      const expectedData = directDB.getAll().filter(i => pksToRender.includes(i.id));
  
      const renderedData = store.render({ pks: pksToRender });
  
      expect(renderedData).toHaveLength(expectedData.length);
      expect(renderedData).toEqual(expect.arrayContaining(expectedData));
      expect(expectedData).toEqual(expect.arrayContaining(renderedData));
      // Check role of item 2 hasn't somehow leaked in (it shouldn't be present)
      expect(renderedData.find(i => i.id === 2)).toBeUndefined();
    });
  
    test('should exclude deleted item even if its pk is requested', () => {
      store.add({ type: 'delete', instances: [3] }); // Delete Charlie
  
      const pksToRender = [1, 3]; // Request existing and deleted
      const expectedData = directDB.getAll().filter(i => i.id === 1); // Only Alice expected
  
      const renderedData = store.render({ pks: pksToRender });
  
      expect(renderedData).toHaveLength(1);
      expect(renderedData).toEqual(expectedData);
      expect(renderedData.find(i => i.id === 3)).toBeUndefined();
    });
  
    test('should ignore deleted item if its pk is not requested', () => {
      store.add({ type: 'delete', instances: [3] }); // Delete Charlie
  
      const pksToRender = [1, 2]; // Request items other than the deleted one
      const expectedData = directDB.getAll().filter(i => pksToRender.includes(i.id));
  
      const renderedData = store.render({ pks: pksToRender });
  
      expect(renderedData).toHaveLength(expectedData.length);
      expect(renderedData).toEqual(expect.arrayContaining(expectedData));
      expect(expectedData).toEqual(expect.arrayContaining(renderedData));
    });
  
    test('should apply sortFn correctly to partially rendered data', () => {
      // Add Dave to mix up default order
      store.add({ type: 'create', instances: [{ id: 4, name: 'Dave', role: 'manager' }] });
      directDB.create({ id: 4, name: 'Dave', role: 'manager' });
  
      const pksToRender = [3, 1, 4]; // Request Charlie(3), Alice(1), Dave(4)
      const expectedUnsorted = directDB.getAll().filter(i => pksToRender.includes(i.id));
      const expectedSorted = [...expectedUnsorted].sort(sortByName); // Alice, Charlie, Dave
  
      const renderedData = store.render({ pks: pksToRender, sortFn: sortByName });
  
      expect(renderedData).toHaveLength(3);
      expect(renderedData).toEqual(expectedSorted); // Order matters here due to sortFn
    });
  
    test('render cache should work with partial renders', () => {
      const pks1 = [1, 2];
      const pks2 = [2, 3];
  
      // Spy on the internal processing method
      const processSpy = vi.spyOn(store, '_processOperations');
  
      // First render (full) - should call process
      store.render();
      expect(processSpy).toHaveBeenCalledTimes(1);
  
      // Second render (partial) - should use cache, filter externally
      const rendered1 = store.render({ pks: pks1 });
      expect(processSpy).toHaveBeenCalledTimes(1); // No new call
      expect(rendered1).toHaveLength(2);
      expect(rendered1.map(i => i.id).sort()).toEqual(pks1.sort());
  
      // Third render (different partial) - should use cache, filter externally
      const rendered2 = store.render({ pks: pks2 });
      expect(processSpy).toHaveBeenCalledTimes(1); // Still no new call
      expect(rendered2).toHaveLength(2);
      expect(rendered2.map(i => i.id).sort()).toEqual(pks2.sort());
  
      // Modify state to invalidate cache
      store.add({ type: 'create', instances: [{ id: 5, name: 'Eve' }] });
  
      // Fourth render (partial) - should call process again
      const rendered3 = store.render({ pks: [1, 5] });
      expect(processSpy).toHaveBeenCalledTimes(2); // Cache was invalidated
      expect(rendered3).toHaveLength(2);
      expect(rendered3.map(i => i.id).sort()).toEqual([1, 5]);
  
      // Fifth render (full) - should use the new cache
      store.render();
      expect(processSpy).toHaveBeenCalledTimes(2); // No new call
  
      processSpy.mockRestore();
    });
    
  });
});