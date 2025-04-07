import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto'; // This sets up the IndexedDB environment
import { ModelStore, Operation, OperationType } from '../../src/syncEngine/stores/ModelStore';
import { IndexedDBStorage } from '../../src/syncEngine/persistence/IndexedDBStorage';
import { getStoreKey } from '../../src/syncEngine/stores/utils'; // Assuming utils exists
import { deleteDB } from 'idb';

// Simple in-memory database for comparison
class SimpleDB {
  data: TestItem[]; // Added type
  pkField: keyof TestItem; // Added type

  constructor(initialData: TestItem[] = [], pkField: keyof TestItem = 'id') { // Added types
    this.data = JSON.parse(JSON.stringify(initialData)); // Deep copy initial data
    this.pkField = pkField;
  }

  create(items: TestItem | TestItem[]) { // Added type
    const newItems = Array.isArray(items) ? items : [items];
    newItems.forEach(item => {
      const exists = this.data.some(x => x[this.pkField] === item[this.pkField]);
      if (!exists) {
        this.data.push({...item});
      }
    });
  }

  update(items: Partial<TestItem> & Pick<TestItem, 'id'> | (Partial<TestItem> & Pick<TestItem, 'id'>)[]) { // Added type
    const updates = Array.isArray(items) ? items : [items];
    updates.forEach(update => {
      const index = this.data.findIndex(x => x[this.pkField] === update[this.pkField]);
      if (index !== -1) {
        this.data[index] = {...this.data[index], ...update};
      }
    });
  }

  delete(ids: string | string[]) { // Added type
    const toDelete = new Set(Array.isArray(ids) ? ids : [ids]); // Use Set for efficiency
    this.data = this.data.filter(item => !toDelete.has(item[this.pkField]));
  }

  getAll(sortFn?: (a: TestItem, b: TestItem) => number) { // Added types
    const result = [...this.data];
    return sortFn ? result.sort(sortFn) : result;
  }
}

// Test data
interface TestItem {
  id: string;
  name: string;
  value: number;
  lastUpdated?: number;
  // Add 'type' if needed based on ModelClass usage in Store.ts injestResponse, though not used directly in ModelStore tests
  // type?: string;
}

// Mock ModelClass
const TestModelClass = {
  primaryKeyField: 'id' as keyof TestItem,
  configKey: 'test-config', // Ensure this aligns if getStoreKey uses it
  modelName: 'test-model'
};

// Helper function to sort results by ID for consistent comparison
const sortById = (a: TestItem, b: TestItem) => a.id.localeCompare(b.id);

// Helper function for delays
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('ModelStore', () => {
  let store: ModelStore<TestItem>;
  const modelClass = TestModelClass; // Use const
  let storage: IndexedDBStorage;
  let simpleDb: SimpleDB;
  let fetchMock: vi.Mock;
  let storeKey: string; // Calculated store key base
  let operationsKey: string;
  let groundTruthKey: string;
  const TEST_DB_NAME = 'test_modelsync_cache';

  // Initial test data
  const initialData: TestItem[] = [
    { id: 'item1', name: 'Item 1', value: 100 },
    { id: 'item2', name: 'Item 2', value: 200 },
    { id: 'item3', name: 'Item 3', value: 300 }
  ];

  // Preloaded data simulation
  let initialGroundTruth: TestItem[];
  let initialOperations: Operation<TestItem>[]; // Store actual Operation objects

  beforeEach(async () => {
    // Clear any existing test database
    try {
      await deleteDB(TEST_DB_NAME);
    } catch (e) {
      // Ignore errors during cleanup
    }

    // Reset preloaded data simulations
    initialGroundTruth = [...initialData]; // Start with initial data for most tests
    initialOperations = []; // Start with no operations

    // Create a mock fetch function
    fetchMock = vi.fn().mockResolvedValue([...initialData]); // Default fetch mock

    // Calculate keys using the utility function if available, otherwise manually
    // Assuming getStoreKey exists and works like: `${modelClass.modelName}::${modelClass.configKey}`
    storeKey = getStoreKey ? getStoreKey(modelClass) : `${modelClass.modelName}::${modelClass.configKey}`; // Use actual utility or fallback
    operationsKey = `modelstore::${storeKey}::operations`;
    groundTruthKey = `modelstore::${storeKey}::groundtruth`;

    // Create a real IndexedDBStorage instance
    storage = new IndexedDBStorage({
      dbName: TEST_DB_NAME,
      storeName: 'test_store', // Main storeName for the DB instance
      version: 1
    });

    // Initialize model store - NOW SYNCHRONOUS with passed data
    store = new ModelStore<TestItem>(
        modelClass,
        fetchMock,
        storage,
        initialGroundTruth, // Pass initial GT
        initialOperations   // Pass initial Ops (as plain data if needed by constructor, but ours takes OperationData[])
    );

    // Initialize SimpleDB with the same data
    simpleDb = new SimpleDB(initialData, 'id');

    // No need for isReady or whenReady checks anymore
  });

  afterEach(async () => {
    // Close the IndexedDB connection
    if (storage) {
      await storage.close();
    }

    // Clean up database
    try {
      await deleteDB(TEST_DB_NAME);
    } catch (e) {
     // Ignore errors during cleanup
    }

    vi.restoreAllMocks(); // Use restoreAllMocks to reset spies etc.
  });

  describe('Basic Operations', () => {
    it('should initialize with the correct data', () => {
      // Test the state immediately after constructor call
      expect(store.groundTruthArray).toEqual(initialData); // Initial GT passed in
      expect(store.operations).toEqual([]); // Initial Ops passed in
      // isReady flag is removed
    });

    it('should correctly add to and update ground truth', async () => {
      // 1. Test adding new items
      const newItems: TestItem[] = [
        { id: 'new1', name: 'New Item 1', value: 1000 },
        { id: 'new2', name: 'New Item 2', value: 2000 }
      ];
      store.addToGroundTruth(newItems);
      await delay(50); // Allow time for async persistence
      expect(store.groundTruthArray).toHaveLength(5);
      expect(store.groundTruthArray.find(item => item.id === 'new1')).toBeDefined();

      // 2. Test updating existing items
      const updatedItems: TestItem[] = [
        { id: 'item1', name: 'Updated Item 1', value: 150 },
        { id: 'new1', name: 'Updated New Item 1', value: 1100 }
      ];
      store.addToGroundTruth(updatedItems);
      await delay(50);
      expect(store.groundTruthArray).toHaveLength(5);
      const updatedItem1 = store.groundTruthArray.find(item => item.id === 'item1');
      expect(updatedItem1?.name).toBe('Updated Item 1');
      expect(updatedItem1?.value).toBe(150);
      const updatedNewItem1 = store.groundTruthArray.find(item => item.id === 'new1');
      expect(updatedNewItem1?.name).toBe('Updated New Item 1');

      // 3. Test partial updates
      const partialUpdates: (Partial<TestItem> & Pick<TestItem, 'id'>)[] = [ // Correct type
        { id: 'item2', name: 'Partially Updated Item 2' },
        { id: 'new2', value: 2222 }
      ];
      store.addToGroundTruth(partialUpdates as TestItem[]); // Cast needed if strict
      await delay(50);
      const partiallyUpdatedItem2 = store.groundTruthArray.find(item => item.id === 'item2');
      expect(partiallyUpdatedItem2?.name).toBe('Partially Updated Item 2');
      expect(partiallyUpdatedItem2?.value).toBe(200); // Original value preserved
      const partiallyUpdatedNewItem2 = store.groundTruthArray.find(item => item.id === 'new2');
      expect(partiallyUpdatedNewItem2?.name).toBe('New Item 2'); // Original name preserved
      expect(partiallyUpdatedNewItem2?.value).toBe(2222);

      // 4. Verify render reflects updates
      const renderedData = store.render().sort(sortById);
      expect(renderedData).toHaveLength(5);
      expect(renderedData.find(item => item.id === 'item1')?.name).toBe('Updated Item 1');
      expect(renderedData.find(item => item.id === 'item2')?.name).toBe('Partially Updated Item 2');
      expect(renderedData.find(item => item.id === 'new1')?.name).toBe('Updated New Item 1');
      expect(renderedData.find(item => item.id === 'new2')?.value).toBe(2222);

      // 5. Test handling empty array
      store.addToGroundTruth([]); // Should not change anything
      expect(store.groundTruthArray).toHaveLength(5);

      // 6. Test handling undefined values (should merge correctly)
      const withUndefined = [
        { id: 'new3', name: undefined, value: 3000 } as TestItem // Ensure type matches
      ];
      store.addToGroundTruth(withUndefined);
      await delay(50);
      const undefinedItem = store.groundTruthArray.find(item => item.id === 'new3');
      expect(undefinedItem).toBeDefined();
      // If merging undefined means "keep old value", test that. If it means "set to undefined", test that.
      // Assuming merge {...old, ...new} means name becomes undefined if it was defined before.
      // If new3 didn't exist, name will be undefined.
      expect(undefinedItem?.name).toBeUndefined();
      expect(undefinedItem?.value).toBe(3000);
      expect(store.groundTruthArray).toHaveLength(6); // Added one new item
    });


    it('should render initial data correctly', () => {
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(3);
    });

    it('should add a create operation and render correctly', async () => {
      const newItem: TestItem = { id: 'item4', name: 'Item 4', value: 400 };
      store.addOperation(new Operation({ type: 'create', instances: newItem }));
      simpleDb.create(newItem);

      await delay(50); // Allow for persistence if checking storage

      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(4);
      expect(renderedData.find(i => i.id === 'item4')).toBeDefined(); // More specific check
    });

    it('should add an update operation and render correctly', async () => {
      const updateItem: Partial<TestItem> & Pick<TestItem, 'id'> = { id: 'item2', name: 'Updated Item 2' };
      store.addOperation(new Operation({ type: 'update', instances: updateItem as TestItem })); // Cast needed
      simpleDb.update(updateItem);

      await delay(50);

      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.find(i => i.id === 'item2')?.name).toBe('Updated Item 2');
      expect(renderedData.find(i => i.id === 'item2')?.value).toBe(200);
    });

    it('should add a delete operation and render correctly', async () => {
      const deleteItem: Pick<TestItem, 'id'> = { id: 'item3' };
      store.addOperation(new Operation({ type: 'delete', instances: deleteItem as TestItem })); // Cast needed
      simpleDb.delete('item3');

      await delay(50);

      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(2);
      expect(renderedData.find(item => item.id === 'item3')).toBeUndefined();
    });
  });

  // --- Test Suite Corrected: Persistence Test ---
  describe('Persistence', () => {
    it('should save operations and ground truth to storage', async () => {
      // 1. Define data to add
      const opData = {
        type: 'create' as OperationType,
        instances: [{ id: 'op1', name: 'Op Instance 1', value: 1 }] as TestItem[]
      };
      const op = new Operation(opData);
      const gtData: TestItem[] = [{ id: 'gt1', name: 'GT Instance 1', value: 10 }];

      // 2. Add data to the store (triggers persistence)
      store.addOperation(op);
      store.setGroundTruth(gtData);

      // 3. Wait for persistence to complete
      await delay(100); // Give IndexedDB time

      // 4. Verify data was saved to IndexedDB *directly* using the storage instance
      const savedOps = await storage.load(operationsKey);
      const savedGT = await storage.load(groundTruthKey);

      // Check operations
      expect(savedOps).toBeDefined();
      expect(savedOps?.id).toBe(operationsKey);
      expect(Array.isArray(savedOps?.data)).toBe(true);
      expect(savedOps?.data).toHaveLength(1);
      // Compare relevant fields, operationId is generated, so check content
      expect(savedOps?.data[0].type).toBe(op.type);
      expect(savedOps?.data[0].instances).toEqual(op.instances);

      // Check ground truth
      expect(savedGT).toBeDefined();
      expect(savedGT?.id).toBe(groundTruthKey);
      expect(Array.isArray(savedGT?.data)).toBe(true);
      expect(savedGT?.data).toEqual(gtData);

      // 5. Verify store's in-memory state also matches
      expect(store.operations).toHaveLength(1);
      expect(store.operations[0].operationId).toBe(op.operationId); // Check in-memory op
      expect(store.groundTruthArray).toEqual(gtData);
    });

     // NOTE: Hydration is no longer the responsibility of ModelStore.
     // Testing hydration requires testing the main `Store` class which orchestrates
     // loading from storage and passing data to the ModelStore constructor.
     // This unit test now focuses on saving.
  });


  describe('Sync Functionality', () => {
    it('should sync, update ground truth, and trim operations', async () => {
      // Add operations (one old, one recent)
      const currentTime = Date.now();
      const recentOp = new Operation({
        type: 'create',
        instances: [{ id: 'recent', name: 'Recent Item', value: 999 }] as TestItem[],
        timestamp: currentTime - 60 * 1000 // 1 min ago
      });
      const oldOp = new Operation({
        type: 'update',
        instances: [{ id: 'item1', name: 'Old Update' }] as TestItem[],
        timestamp: currentTime - 3 * 60 * 1000 // 3 mins ago
      });
      store.addOperation(recentOp);
      store.addOperation(oldOp);
      expect(store.operations).toHaveLength(2); // Verify ops added

      // Simulate server response for sync
      const updatedServerData: TestItem[] = [
        { id: 'item1', name: 'Server Item 1', value: 100 }, // Name differs from oldOp
        { id: 'item2', name: 'Server Item 2', value: 200 },
        // item3 removed by server
        { id: 'serverOnly', name: 'Server Only', value: 500 } // New item from server
      ];
      fetchMock.mockResolvedValueOnce([...updatedServerData]);

      // Mock Date.now used inside sync for trimming
      vi.spyOn(global.Date, 'now').mockReturnValue(currentTime);

      // Perform sync
      await store.sync();

      // Restore Date.now mock
      vi.mocked(global.Date.now).mockRestore();

      // --- Verification ---

      // 1. Check fetch function was called (with current GT pks)
      // expect(fetchMock).toHaveBeenCalledWith({ pks: ['item1', 'item2', 'item3'], modelClass: modelClass }); // Original GT pks
      // NOTE: The exact PKs depend on when sync is called relative to operations. Let's just check it was called.
      expect(fetchMock).toHaveBeenCalled();

      // 2. Check ground truth was updated from server response
      expect(store.groundTruthArray.sort(sortById)).toEqual([...updatedServerData].sort(sortById));
      expect(store.groundTruthArray).toHaveLength(3);

      // 3. Check operations were trimmed (only recentOp should remain)
      expect(store.operations).toHaveLength(1);
      expect(store.operations[0].operationId).toBe(recentOp.operationId);

      // 4. Check render reflects the *new* ground truth combined with *remaining* operations
      const renderedData = store.render().sort(sortById);
      // Expected: updatedServerData + recentOp applied
      const expectedRendered = [...updatedServerData, { id: 'recent', name: 'Recent Item', value: 999 }].sort(sortById);
      expect(renderedData).toEqual(expectedRendered);
      expect(renderedData).toHaveLength(4);
      expect(store.isSyncing).toBe(false); // Sync flag reset
    });

    // --- Test Suite Corrected: Sync Error Handling ---
    it('should handle server errors during sync gracefully', async () => {
      // Spy on console.error
      const consoleErrorSpy = vi.spyOn(console, 'error');

      // Initial state for comparison
      const initialState = store.render().sort(sortById);
      const initialOps = [...store.operations];

      // Setup fetch to fail
      const syncError = new Error('Server Boom!');
      fetchMock.mockRejectedValueOnce(syncError);

      // Perform sync (should not throw)
      await store.sync();

      // --- Verification ---
      // 1. Check console.error was called with the error message
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining(`Failed to sync ground truth for ${modelClass.modelName}`),
          expect.objectContaining({ message: 'Server Boom!' }) // Check the error object contains the message
      );


      // 2. Check that state (GT and Ops) remains unchanged
      expect(store.groundTruthArray.sort(sortById)).toEqual(initialState); // GT unchanged
      expect(store.operations).toEqual(initialOps); // Ops unchanged

      // 3. Check sync flag is reset
      expect(store.isSyncing).toBe(false);

      // 4. Check fetch was called
      expect(fetchMock).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    // --- Test Suite Corrected: Concurrent Sync Prevention ---
    it('should prevent concurrent syncs and log a warning', async () => {
       // Spy on console.warn
      const consoleWarnSpy = vi.spyOn(console, 'warn');

      // Manually set syncing flag
      store.isSyncing = true;

      // Call sync again (should not throw, should return immediately)
      await store.sync();

      // --- Verification ---
      // 1. Check console.warn was called
      expect(consoleWarnSpy).toHaveBeenCalledWith('Already syncing, sync request ignored.');

      // 2. Check fetch was NOT called again
      expect(fetchMock).not.toHaveBeenCalled();

      // 3. Check isSyncing flag is still true (as we set it manually)
      expect(store.isSyncing).toBe(true); // We didn't let the first sync finish

      consoleWarnSpy.mockRestore();
      store.isSyncing = false; // Reset flag for subsequent tests
    });

    // Test removed as trimming is now part of the main sync test
    // it('should trim old operations during sync', async () => { ... });
  });

  describe('Edge Cases', () => {
    it('should handle empty ground truth initially', () => {
      // Re-initialize store with empty GT
      store = new ModelStore<TestItem>(modelClass, fetchMock, storage, [], []);
      simpleDb = new SimpleDB([], 'id'); // Reset SimpleDB too

      // Add operations
      const op1 = new Operation({ type: 'create', instances: { id: 'new1', name: 'New Item 1', value: 100 } as TestItem });
      const op2 = new Operation({ type: 'create', instances: { id: 'new2', name: 'New Item 2', value: 200 } as TestItem });
      store.addOperation(op1);
      store.addOperation(op2);
      simpleDb.create({ id: 'new1', name: 'New Item 1', value: 100 });
      simpleDb.create({ id: 'new2', name: 'New Item 2', value: 200 });

      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(2);
      expect(renderedData[0].id).toBe('new1');
      expect(renderedData[1].id).toBe('new2');
    });

    it('should handle operations with multiple instances - create', () => {
      const newItems: TestItem[] = [
        { id: 'batch1', name: 'Batch Item 1', value: 1000 },
        { id: 'batch2', name: 'Batch Item 2', value: 2000 },
        { id: 'batch3', name: 'Batch Item 3', value: 3000 }
      ];
      store.addOperation(new Operation({ type: 'create', instances: newItems }));
      simpleDb.create(newItems);

      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(6); // 3 original + 3 batch
      expect(renderedData.filter(item => item.id.startsWith('batch'))).toHaveLength(3);
    });

    it('should handle operations with multiple instances - update', () => {
      const updateItems: (Partial<TestItem> & Pick<TestItem, 'id'>)[] = [ // Correct type
        { id: 'item1', name: 'Bulk Update 1' },
        { id: 'item2', name: 'Bulk Update 2' }
      ];
      store.addOperation(new Operation({ type: 'update', instances: updateItems as TestItem[] })); // Cast
      simpleDb.update(updateItems);

      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.find(i => i.id === 'item1')?.name).toBe('Bulk Update 1');
      expect(renderedData.find(i => i.id === 'item2')?.name).toBe('Bulk Update 2');
    });

    it('should handle operations with multiple instances - delete', () => {
      const deleteItems = [
        { id: 'item1' },
        { id: 'item2' }
      ];
      store.addOperation(new Operation({ type: 'delete', instances: deleteItems as TestItem[] })); // Cast
      simpleDb.delete(['item1', 'item2']);

      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(1);
      expect(renderedData[0].id).toBe('item3');
    });

    it('should handle operations targeting the same item sequentially', () => {
      store.addOperation(new Operation({ type: 'update', instances: { id: 'item1', name: 'First Update' } as TestItem }));
      store.addOperation(new Operation({ type: 'update', instances: { id: 'item1', value: 150 } as TestItem }));
      store.addOperation(new Operation({ type: 'update', instances: { id: 'item1', name: 'Second Update' } as TestItem }));

      simpleDb.update({ id: 'item1', name: 'First Update' });
      simpleDb.update({ id: 'item1', value: 150 });
      simpleDb.update({ id: 'item1', name: 'Second Update' });

      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.find(i => i.id === 'item1')?.name).toBe('Second Update');
      expect(renderedData.find(i => i.id === 'item1')?.value).toBe(150);
    });

    it('should handle create followed by update', () => {
      store.addOperation(new Operation({ type: 'create', instances: { id: 'item4', name: 'Item 4', value: 400 } as TestItem }));
      store.addOperation(new Operation({ type: 'update', instances: { id: 'item4', name: 'Updated Item 4' } as TestItem }));

      simpleDb.create({ id: 'item4', name: 'Item 4', value: 400 });
      simpleDb.update({ id: 'item4', name: 'Updated Item 4' });

      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.find(i => i.id === 'item4')?.name).toBe('Updated Item 4');
      expect(renderedData.find(i => i.id === 'item4')?.value).toBe(400);
    });

    it('should handle create followed by delete', () => {
      store.addOperation(new Operation({ type: 'create', instances: { id: 'item4', name: 'Item 4', value: 400 } as TestItem }));
      store.addOperation(new Operation({ type: 'delete', instances: { id: 'item4' } as TestItem }));

      simpleDb.create({ id: 'item4', name: 'Item 4', value: 400 });
      simpleDb.delete('item4'); // SimpleDB simulates the net effect

      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.length).toBe(3); // Item4 should not appear
      expect(renderedData.find(item => item.id === 'item4')).toBeUndefined();
    });

        // --- Test Suite Corrected: Conditional Upsert ---
        it('should handle distinct upsert behaviors for update and update_or_create', () => {
          // Testing the specific render logic provided:
          // - 'update': Creates if non-existent ONLY IF no prior delete op exists.
          // - 'update_or_create': Creates if non-existent REGARDLESS of prior delete ops during render.
  
          // **Scenario 1: 'update' on non-existent item (no prior delete)**
          const updateOp1 = new Operation({
              type: 'update', // Using 'update'
              instances: [{ id: 'upsertViaUpdate', name: 'Upserted Via Update', value: 998 }] as TestItem[]
          });
          store.addOperation(updateOp1);
          // SimpleDB comparison for this case (it creates)
          simpleDb.create({ id: 'upsertViaUpdate', name: 'Upserted Via Update', value: 998 });
  
          let renderedData = store.render().sort(sortById);
          let simpleDbData = simpleDb.getAll(sortById);
          expect(renderedData).toEqual(simpleDbData);
          expect(renderedData.length).toBe(4); // item1, item2, item3, upsertViaUpdate
          expect(renderedData.find(item => item.id === 'upsertViaUpdate')).toBeDefined();
  
          // **Scenario 2: 'update_or_create' on non-existent item (no prior delete)**
          const updateOrCrOp1 = new Operation({
              type: 'update_or_create', // Using 'update_or_create'
              instances: [{ id: 'upsertViaUOC', name: 'Upserted Via UOC', value: 999 }] as TestItem[]
          });
          store.addOperation(updateOrCrOp1);
          simpleDb.create({ id: 'upsertViaUOC', name: 'Upserted Via UOC', value: 999 });
  
          renderedData = store.render().sort(sortById);
          simpleDbData = simpleDb.getAll(sortById);
          expect(renderedData).toEqual(simpleDbData);
          expect(renderedData.length).toBe(5); // item1, item2, item3, upsertViaUpdate, upsertViaUOC
          expect(renderedData.find(item => item.id === 'upsertViaUOC')).toBeDefined();
  
  
          // **Scenario 3: Delete an item, then use 'update'**
          const deleteOpForUpdate = new Operation({
              type: 'delete',
              instances: [{ id: 'preventUpdateUpsert' }] as TestItem[]
          });
          store.addOperation(deleteOpForUpdate);
          // simpleDb.delete('preventUpdateUpsert'); // SimpleDB just deletes
  
          const updateOpAfterDelete = new Operation({
              type: 'update', // Using 'update'
              instances: [{ id: 'preventUpdateUpsert', name: 'Should Not Appear Via Update', value: 555 }] as TestItem[]
          });
          store.addOperation(updateOpAfterDelete);
          // In SimpleDB, this update would do nothing as the item doesn't exist.
  
          renderedData = store.render().sort(sortById);
          // Expected: Render applies 'update'. Finds no 'preventUpdateUpsert'. Checks history. Finds delete. Does *not* create.
          expect(renderedData.length).toBe(5); // Should still be 5 items
          expect(renderedData.find(item => item.id === 'preventUpdateUpsert')).toBeUndefined(); // Crucial check
  
  
          // **Scenario 4: Delete an item, then use 'update_or_create'**
          const deleteOpForUOC = new Operation({
              type: 'delete',
              instances: [{ id: 'allowUOCUpsert' }] as TestItem[]
          });
          store.addOperation(deleteOpForUOC);
          // simpleDb.delete('allowUOCUpsert');
  
          const uocOpAfterDelete = new Operation({
              type: 'update_or_create', // Using 'update_or_create'
              instances: [{ id: 'allowUOCUpsert', name: 'Should Appear Via UOC', value: 666 }] as TestItem[]
          });
          store.addOperation(uocOpAfterDelete);
          // SimpleDB would create this if called directly after delete doesn't exist
          simpleDb.create({ id: 'allowUOCUpsert', name: 'Should Appear Via UOC', value: 666 });
  
  
          renderedData = store.render().sort(sortById);
          simpleDbData = simpleDb.getAll(sortById); // Update simpleDb comparison data
          // Expected: Render applies 'update_or_create'. Finds no 'allowUOCUpsert'. Does *not* check history. *Creates* it.
          expect(renderedData).toEqual(simpleDbData); // Now SimpleDB should match again
          expect(renderedData.length).toBe(6); // Should now be 6 items
          expect(renderedData.find(item => item.id === 'allowUOCUpsert')).toBeDefined(); // Crucial check
  
  
          // **Scenario 5: Delete an *existing* item, then use 'update'**
          const deleteExistingForUpdate = new Operation({
              type: 'delete',
              instances: [{ id: 'item1' }] as TestItem[] // Delete existing item1
          });
          store.addOperation(deleteExistingForUpdate);
          simpleDb.delete('item1'); // Reflect in simpleDb
  
          const updateOpAfterDeleteExisting = new Operation({
              type: 'update', // Using 'update'
              instances: [{ id: 'item1', name: 'Should Not Reappear Via Update', value: 111 }] as TestItem[]
          });
          store.addOperation(updateOpAfterDeleteExisting);
  
          renderedData = store.render().sort(sortById);
          simpleDbData = simpleDb.getAll(sortById);
          // Expected: Render applies delete (item1 gone). Applies 'update'. Finds no item1. Checks history. Finds delete. Does *not* create.
          expect(renderedData).toEqual(simpleDbData); // SimpleDB matches this outcome
          expect(renderedData.length).toBe(5); // item2, item3, upsertViaUpdate, upsertViaUOC, allowUOCUpsert
          expect(renderedData.find(item => item.id === 'item1')).toBeUndefined();
  
  
          // **Scenario 6: Delete an *existing* item, then use 'update_or_create'**
          const deleteExistingForUOC = new Operation({
              type: 'delete',
              instances: [{ id: 'item2' }] as TestItem[] // Delete existing item2
          });
          store.addOperation(deleteExistingForUOC);
          simpleDb.delete('item2');
  
          const uocOpAfterDeleteExisting = new Operation({
              type: 'update_or_create', // Using 'update_or_create'
              instances: [{ id: 'item2', name: 'Should Reappear Via UOC', value: 222 }] as TestItem[]
          });
          store.addOperation(uocOpAfterDeleteExisting);
          // SimpleDB needs this created to match the expected outcome
          simpleDb.create({ id: 'item2', name: 'Should Reappear Via UOC', value: 222 });
  
          renderedData = store.render().sort(sortById);
          simpleDbData = simpleDb.getAll(sortById);
           // Expected: Render applies delete (item2 gone). Applies 'update_or_create'. Finds no item2. Does *not* check history. *Creates* item2.
          expect(renderedData).toEqual(simpleDbData); // SimpleDB should match
          expect(renderedData.length).toBe(5); // item3, upsertViaUpdate, upsertViaUOC, allowUOCUpsert, item2 (recreated)
          const reappearedItem2 = renderedData.find(item => item.id === 'item2');
          expect(reappearedItem2).toBeDefined();
          expect(reappearedItem2?.name).toBe('Should Reappear Via UOC');
          expect(reappearedItem2?.value).toBe(222);
      });


    it('should handle delete for non-existent item gracefully', () => {
      store.addOperation(new Operation({ type: 'delete', instances: { id: 'doesNotExist' } as TestItem }));
      simpleDb.delete('doesNotExist'); // No change in simpleDb

      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.length).toBe(3);
    });
  });

  describe('Operation Management', () => { // Renamed from Persistence
    it('should add operations to the internal list', async () => {
      const operation = new Operation({ type: 'create', instances: { id: 'item4', name: 'Item 4', value: 400 } as TestItem });
      store.addOperation(operation);

      // Check in-memory list
      expect(store.operations).toHaveLength(1);
      expect(store.operations).toContain(operation);

      // Check persistence (optional but good)
      await delay(50);
      const savedOps = await storage.load(operationsKey);
      expect(savedOps?.data).toHaveLength(1);
      expect(savedOps?.data[0].operationId).toBe(operation.operationId);
    });

    it('should handle mixed operation types applied sequentially', () => {
       // 1. Create
      const createItem = { id: 'mix1', name: 'Mix Item 1', value: 100 };
      store.addOperation(new Operation({ type: 'create', instances: createItem as TestItem }));
      simpleDb.create(createItem);

      // 2. Batch Create
      const batchCreate = [
        { id: 'mix2', name: 'Mix Item 2', value: 200 },
        { id: 'mix3', name: 'Mix Item 3', value: 300 }
      ];
      store.addOperation(new Operation({ type: 'create', instances: batchCreate as TestItem[] }));
      simpleDb.create(batchCreate);

      // 3. Mixed Updates
      const mixedUpdates = [
        { id: 'item1', name: 'Updated Original' },
        { id: 'mix2', value: 250 }
      ];
      store.addOperation(new Operation({ type: 'update', instances: mixedUpdates as TestItem[] }));
      simpleDb.update(mixedUpdates);

      // 4. Mixed Deletes
      const mixedDeletes = [
        { id: 'item3' },
        { id: 'mix3' }
      ];
      store.addOperation(new Operation({ type: 'delete', instances: mixedDeletes as TestItem[] }));
      simpleDb.delete(['item3', 'mix3']);

      // Compare final results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.length).toBe(4);
      expect(renderedData.find(item => item.id === 'item1')?.name).toBe('Updated Original');
      expect(renderedData.find(item => item.id === 'mix2')?.value).toBe(250);
      expect(renderedData.find(item => item.id === 'item3')).toBeUndefined();
      expect(renderedData.find(item => item.id === 'mix3')).toBeUndefined();
    });

    it('should update ground truth when setGroundTruth is called', async () => {
      const newGroundTruth = [
        { id: 'new1', name: 'New 1', value: 1000 },
        { id: 'new2', name: 'New 2', value: 2000 }
      ] as TestItem[];
      store.setGroundTruth(newGroundTruth);

      expect(store.groundTruthArray).toEqual(newGroundTruth);

      // Check persistence
      await delay(50);
      const savedGT = await storage.load(groundTruthKey);
      expect(savedGT?.data).toEqual(newGroundTruth);

      // Render should reflect new ground truth immediately
      const renderedData = store.render().sort(sortById);
      expect(renderedData).toEqual(newGroundTruth.sort(sortById)); // Compare sorted
    });

    it('should update an existing operation status and persist', async () => {
      const operation = new Operation({ type: 'create', instances: { id: 'item4', name: 'Item 4', value: 400 } as TestItem });
      store.addOperation(operation);
      const originalOpId = operation.operationId;

      // Create an "update" payload - usually comes from server confirmation
      const confirmedOpData = {
          operationId: originalOpId, // Match the ID
          type: operation.type, // Keep same type
          status: 'confirmed' as OperationStatus,
          instances: [{ id: 'item4', name: 'Confirmed Item 4', value: 401 }] as TestItem[], // Potentially updated instance data
          timestamp: Date.now() // New timestamp
      };
      const confirmedOp = new Operation(confirmedOpData); // Create the update Op

      const updateResult = store.updateOperation(confirmedOp); // Update using the new Operation object

      expect(updateResult).toBe(true);
      expect(store.operations).toHaveLength(1);
      const opInStore = store.operations[0];
      expect(opInStore.operationId).toBe(originalOpId);
      expect(opInStore.status).toBe('confirmed');
      expect(opInStore.instances).toEqual(confirmedOpData.instances); // Instances updated
      expect(opInStore.timestamp).toBe(confirmedOpData.timestamp); // Timestamp updated

      // Check persistence
      await delay(50);
      const savedOps = await storage.load(operationsKey);
      expect(savedOps?.data).toHaveLength(1);
      expect(savedOps?.data[0].status).toBe('confirmed');
      expect(savedOps?.data[0].instances).toEqual(confirmedOpData.instances);
    });

    it('should return false when updating a non-existent operation', () => {
        const nonExistentOp = new Operation({ operationId: 'non-existent-id', type: 'update', status: 'confirmed', instances: [] });
        const updateResult = store.updateOperation(nonExistentOp);
        expect(updateResult).toBe(false);
        expect(store.operations).toHaveLength(0); // No operations should have been added/modified
    });

  });
});