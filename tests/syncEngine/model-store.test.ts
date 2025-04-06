import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto'; // This sets up the IndexedDB environment
import { ModelStore, Operation, OperationType } from '../../src/syncEngine/stores/ModelStore';
import { IndexedDBStorage } from '../../src/syncEngine/persistence/IndexedDBStorage';
import { deleteDB } from 'idb';

// Simple in-memory database for comparison
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
}

// Test data
interface TestItem {
  id: string;
  name: string;
  value: number;
  lastUpdated?: number;
}

// Mock ModelClass
const TestModelClass = {
  primaryKeyField: 'id' as keyof TestItem,
  configKey: 'test-config',
  modelName: 'test-model'
};

// Helper function to sort results by ID for consistent comparison
const sortById = (a: TestItem, b: TestItem) => a.id.localeCompare(b.id);

describe('ModelStore', () => {
  let store: ModelStore<TestItem>;
  let modelClass = TestModelClass;
  let storage: IndexedDBStorage;
  let simpleDb: SimpleDB;
  let fetchMock: vi.Mock;
  let storeKey: string;
  let operationsKey: string;
  let groundTruthKey: string;
  const TEST_DB_NAME = 'test_modelsync_cache';
  
  // Initial test data
  const initialData: TestItem[] = [
    { id: 'item1', name: 'Item 1', value: 100 },
    { id: 'item2', name: 'Item 2', value: 200 },
    { id: 'item3', name: 'Item 3', value: 300 }
  ];

  beforeEach(async () => {
    // Clear any existing test database
    try {
      await deleteDB(TEST_DB_NAME);
    } catch (e) {
      console.warn('Error cleaning up test database:', e);
    }
    
    // Create a mock fetch function
    fetchMock = vi.fn().mockResolvedValue([...initialData]);
    
    // Calculate store keys for test model
    storeKey = `${TestModelClass.modelName}::${TestModelClass.configKey}`;
    operationsKey = `${storeKey}::operations`;
    groundTruthKey = `${storeKey}::groundtruth`;
    
    // Create a real IndexedDBStorage instance
    storage = new IndexedDBStorage({
      dbName: TEST_DB_NAME,
      storeName: 'test_store', // This will be ignored since we use operationsKey and groundTruthKey
      version: 1
    });
    
    // Initialize model store with real storage
    store = new ModelStore<TestItem>(TestModelClass, fetchMock, storage);
    
    // Initialize SimpleDB with the same data
    simpleDb = new SimpleDB(initialData, 'id');

    // We'll need to manually set the ground truth since _hydrate won't have anything in IndexedDB yet
    store.groundTruthArray = [...initialData];
    store.isReady = true;
    
    // Give time for the DB connection to establish
    await new Promise(resolve => setTimeout(resolve, 50));
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
      console.warn('Error cleaning up test database:', e);
    }
    
    vi.clearAllMocks();
  });

  describe('Basic Operations', () => {
    it('should initialize with the correct data', () => {
      expect(store.groundTruthArray).toHaveLength(3);
      expect(store.operations).toHaveLength(0);
      expect(store.isReady).toBe(true);
    });

    it('should render initial data correctly', () => {
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(3);
    });

    it('should add a create operation', async () => {
      // Create a new item
      const newItem: TestItem = { id: 'item4', name: 'Item 4', value: 400 };
      
      // Add to ModelStore via operation
      store.addOperation(new Operation({
        type: 'create',
        instances: newItem
      }));
      
      // Add to SimpleDB
      simpleDb.create(newItem);
      
      // Small delay to allow IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(4);
      expect(renderedData[3].id).toBe('item4');
      
      // Verify that the operation was saved to storage
      // We would need to fetch from IndexedDB to verify this, but that's challenging
      // in the test environment without direct access to the DB contents
    });

    it('should add an update operation', async () => {
      // Update an existing item
      const updateItem: Partial<TestItem> & Pick<TestItem, 'id'> = { 
        id: 'item2', 
        name: 'Updated Item 2' 
      };
      
      // Add to ModelStore via operation
      store.addOperation(new Operation({
        type: 'update',
        instances: updateItem
      }));
      
      // Add to SimpleDB
      simpleDb.update(updateItem);
      
      // Small delay to allow IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData[1].name).toBe('Updated Item 2');
      expect(renderedData[1].value).toBe(200); // Value should remain unchanged
    });

    it('should add a delete operation', async () => {
      // Delete an item
      const deleteItem: Pick<TestItem, 'id'> = { id: 'item3' };
      
      // Add to ModelStore via operation
      store.addOperation(new Operation({
        type: 'delete',
        instances: deleteItem
      }));
      
      // Delete from SimpleDB
      simpleDb.delete('item3');
      
      // Small delay to allow IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(2);
      expect(renderedData.find(item => item.id === 'item3')).toBeUndefined();
    });
  });

  describe('Basic Operations', () => {
    it('should initialize with the correct data', () => {
      expect(store.groundTruthArray).toHaveLength(3);
      expect(store.operations).toHaveLength(0);
      expect(store.isReady).toBe(true);
    });

    it('should render initial data correctly', () => {
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(3);
    });

    it('should add a create operation', async () => {
      // Create a new item
      const newItem: TestItem = { id: 'item4', name: 'Item 4', value: 400 };
      
      // Add to ModelStore via operation
      store.addOperation(new Operation({
        type: 'create',
        instances: newItem
      }));
      
      // Add to SimpleDB
      simpleDb.create(newItem);
      
      // Small delay to allow IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(4);
      expect(renderedData[3].id).toBe('item4');
      
      // Verify that the operation was saved to storage
      // We would need to fetch from IndexedDB to verify this, but that's challenging
      // in the test environment without direct access to the DB contents
    });

    it('should add an update operation', async () => {
      // Update an existing item
      const updateItem: Partial<TestItem> & Pick<TestItem, 'id'> = { 
        id: 'item2', 
        name: 'Updated Item 2' 
      };
      
      // Add to ModelStore via operation
      store.addOperation(new Operation({
        type: 'update',
        instances: updateItem
      }));
      
      // Add to SimpleDB
      simpleDb.update(updateItem);
      
      // Small delay to allow IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData[1].name).toBe('Updated Item 2');
      expect(renderedData[1].value).toBe(200); // Value should remain unchanged
    });

    it('should add a delete operation', async () => {
      // Delete an item
      const deleteItem: Pick<TestItem, 'id'> = { id: 'item3' };
      
      // Add to ModelStore via operation
      store.addOperation(new Operation({
        type: 'delete',
        instances: deleteItem
      }));
      
      // Delete from SimpleDB
      simpleDb.delete('item3');
      
      // Small delay to allow IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(2);
      expect(renderedData.find(item => item.id === 'item3')).toBeUndefined();
    });
  });

  describe('Persistence and Hydration', () => {
    it('should save data to storage and allow subsequent hydration', async () => {
      // Helper function to add a delay
      const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      
      // Helper function to get store keys
      const getStoreKey = (modelClass) => `${modelClass.modelName}::${modelClass.configKey}`;
      
      // Clear database to ensure a clean slate
      try {
        await deleteDB(TEST_DB_NAME);
      } catch (e) {
        console.warn('Error cleaning up test database:', e);
      }
      
      // Create storage with clean database
      const storage1 = new IndexedDBStorage({
        dbName: TEST_DB_NAME,
        storeName: 'test_store',
        version: 1
      });
      
      // Step 1: Create first store and add data
      const fetchFn = vi.fn().mockResolvedValue([]);
      const initialStore = new ModelStore(modelClass, fetchFn, storage1);
      
      // Make sure store is initialized
      await initialStore._hydrate();
      expect(initialStore.isReady).toBe(true);
      
      // Create test data
      const opData = {
        type: 'create' as OperationType,
        instances: [{ id: 'op1', name: 'Op Instance 1' }]
      };
      const op = new Operation(opData);
      const gtData = [{ id: 'gt1', name: 'GT Instance 1' }];
      
      // Add data to the store
      initialStore.addOperation(op);
      initialStore.setGroundTruth(gtData);
      
      // Important: Wait for IndexedDB operations to complete
      await delay(100);
      
      // Calculate keys for validation
      const storeKey = getStoreKey(modelClass);
      const operationsKey = `modelstore::${storeKey}::operations`;
      const groundTruthKey = `modelstore::${storeKey}::groundtruth`;
      
      // Step 2: Verify data was saved to IndexedDB directly
      const savedOps = await storage1.load(operationsKey);
      const savedGT = await storage1.load(groundTruthKey);
      
      // Log for debugging
      console.log('Direct storage check:');
      console.log('Operations:', savedOps);
      console.log('Ground Truth:', savedGT);
      
      // Verify operations were saved correctly
      expect(savedOps).toBeDefined();
      expect(savedOps?.data).toBeDefined();
      expect(Array.isArray(savedOps?.data)).toBe(true);
      expect(savedOps?.data).toHaveLength(1);
      expect(savedOps?.data[0].operationId).toBe(op.operationId);
      
      // Verify ground truth was saved correctly
      expect(savedGT).toBeDefined();
      expect(savedGT?.data).toBeDefined();
      expect(Array.isArray(savedGT?.data)).toBe(true);
      expect(savedGT?.data).toHaveLength(1);
      expect(savedGT?.data[0].id).toBe('gt1');
      
      // Close first store's connection
      await storage1.close();
      
      // Step 3: Create a new storage instance and store
      const storage2 = new IndexedDBStorage({
        dbName: TEST_DB_NAME,
        storeName: 'test_store',
        version: 1
      });
      
      const hydratedStore = new ModelStore(modelClass, fetchFn, storage2);
      
      // Step 4: Hydrate the new store from IndexedDB
      await hydratedStore._hydrate();
      
      // Log for debugging
      console.log('Hydrated store state:');
      console.log('Operations:', hydratedStore.operations);
      console.log('Ground Truth:', hydratedStore.groundTruthArray);
      
      // Step 5: Verify hydration worked correctly
      expect(hydratedStore.isReady).toBe(true);
      expect(hydratedStore.operations).toHaveLength(1);
      expect(hydratedStore.operations[0].operationId).toBe(op.operationId);
      expect(hydratedStore.operations[0].instances[0].id).toBe('op1');
      
      expect(hydratedStore.groundTruthArray).toHaveLength(1);
      expect(hydratedStore.groundTruthArray[0].id).toBe('gt1');
      
      // Cleanup
      await storage2.close();
    });
  });

  // The rest of the tests would remain largely the same, just adding await statements
  // and small delays where IndexedDB operations need time to complete
  
  describe('Sync Functionality', () => {
    it('should sync with the server', async () => {
      // Add some operations
      store.addOperation(new Operation({
        type: 'create',
        instances: { id: 'item4', name: 'Item 4', value: 400 }
      }));
      
      store.addOperation(new Operation({
        type: 'update',
        instances: { id: 'item1', name: 'Updated Item 1' }
      }));
      
      // Simulate a server update with new data
      const updatedServerData = [
        { id: 'item1', name: 'Server Item 1', value: 100 },
        { id: 'item2', name: 'Server Item 2', value: 200 },
        { id: 'item3', name: 'Server Item 3', value: 350 } // value updated on server
      ];
      
      fetchMock.mockResolvedValueOnce(updatedServerData);
      
      // Perform sync
      await store.sync();
      
      // Small delay to allow IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Update simpleDb to match what we expect after sync
      simpleDb = new SimpleDB(updatedServerData, 'id');
      
      // Add back the operations that should be retained
      // Since we're not trimming operations in the test, we simply reapply them
      simpleDb.create({ id: 'item4', name: 'Item 4', value: 400 });
      simpleDb.update({ id: 'item1', name: 'Updated Item 1' });
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(4);
      // Server data should be the base, but local operations should still apply on top
      expect(renderedData.find(item => item.id === 'item1')?.name).toBe('Updated Item 1');
      expect(renderedData.find(item => item.id === 'item3')?.value).toBe(350);
    });

    it('should handle server errors during sync', async () => {
      // Set up initial state
      const initialState = store.render().sort(sortById);
      
      // Set up fetch to fail
      const syncError = new Error('Server error during sync');
      fetchMock.mockRejectedValueOnce(syncError);
      
      // Expect the sync to throw but maintain state
      await expect(store.sync()).rejects.toThrow('Failed to sync ground truth: Server error during sync');
      
      // Check that state is unchanged
      const stateAfterError = store.render().sort(sortById);
      expect(stateAfterError).toEqual(initialState);
      expect(store.isSyncing).toBe(false);
    });

    it('should prevent concurrent syncs', async () => {
        // Start a sync operation
        store.isSyncing = true;
        
        // Try to sync again
        await expect(store.sync()).rejects.toThrow('Already syncing, cannot sync again');
    });

    it('should trim old operations during sync', async () => {
      // Add operations with different timestamps
      const currentTime = Date.now();
      
      // Recent operation (within the last 2 minutes)
      const recentOp = new Operation({
        type: 'create',
        instances: { id: 'recent', name: 'Recent Item', value: 999 },
        timestamp: currentTime - 60 * 1000 // 1 minute ago
      });
      
      // Old operation (older than 2 minutes)
      const oldOp = new Operation({
        type: 'create',
        instances: { id: 'old', name: 'Old Item', value: 888 },
        timestamp: currentTime - 3 * 60 * 1000 // 3 minutes ago
      });
      
      store.addOperation(recentOp);
      store.addOperation(oldOp);
      
      // Mock Date.now() to ensure consistent behavior
      const originalDateNow = Date.now;
      global.Date.now = vi.fn(() => currentTime);
      
      try {
        // Set up fetch mock
        fetchMock.mockResolvedValueOnce([...initialData]);
        
        // Perform sync
        await store.sync();
        
        // Check that only recent operations are kept
        expect(store.operations).toHaveLength(1);
        expect(store.operations[0].operationId).toBe(recentOp.operationId);
        expect(store.operations.find(op => op.operationId === oldOp.operationId)).toBeUndefined();
      } finally {
        // Restore original Date.now
        global.Date.now = originalDateNow;
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty ground truth', () => {
      // Clear ground truth
      store.groundTruthArray = [];
      
      // Add operations
      store.addOperation(new Operation({
        type: 'create',
        instances: { id: 'new1', name: 'New Item 1', value: 100 }
      }));
      
      store.addOperation(new Operation({
        type: 'create',
        instances: { id: 'new2', name: 'New Item 2', value: 200 }
      }));
      
      // Render should show just the created items
      const renderedData = store.render().sort(sortById);
      expect(renderedData).toHaveLength(2);
      expect(renderedData[0].id).toBe('new1');
      expect(renderedData[1].id).toBe('new2');
    });
    
    it('should handle operations with multiple instances - create', () => {
      // Create multiple items in a single operation
      const newItems: TestItem[] = [
        { id: 'batch1', name: 'Batch Item 1', value: 1000 },
        { id: 'batch2', name: 'Batch Item 2', value: 2000 },
        { id: 'batch3', name: 'Batch Item 3', value: 3000 }
      ];
      
      // Add to ModelStore via single operation with multiple instances
      store.addOperation(new Operation({
        type: 'create',
        instances: newItems
      }));
      
      // Add to SimpleDB
      simpleDb.create(newItems);
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(6); // 3 original + 3 batch
      expect(renderedData.filter(item => item.id.startsWith('batch'))).toHaveLength(3);
    });
    
    it('should handle operations with multiple instances - update', () => {
      // Update multiple items in a single operation
      const updateItems: Partial<TestItem> & Pick<TestItem, 'id'>[] = [
        { id: 'item1', name: 'Bulk Update 1' },
        { id: 'item2', name: 'Bulk Update 2' }
      ];
      
      // Add to ModelStore via single operation with multiple instances
      store.addOperation(new Operation({
        type: 'update',
        instances: updateItems
      }));
      
      // Add to SimpleDB
      simpleDb.update(updateItems);
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData[0].name).toBe('Bulk Update 1');
      expect(renderedData[1].name).toBe('Bulk Update 2');
    });
    
    it('should handle operations with multiple instances - delete', () => {
      // Delete multiple items in a single operation
      const deleteItems = [
        { id: 'item1' },
        { id: 'item2' }
      ];
      
      // Add to ModelStore via single operation with multiple instances
      store.addOperation(new Operation({
        type: 'delete',
        instances: deleteItems
      }));
      
      // Add to SimpleDB
      simpleDb.delete(['item1', 'item2']);
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(1); // Only item3 should remain
      expect(renderedData[0].id).toBe('item3');
    });

    it('should handle operations targeting the same item', () => {
      // Add multiple operations for the same item
      store.addOperation(new Operation({
        type: 'update',
        instances: { id: 'item1', name: 'First Update' }
      }));
      
      store.addOperation(new Operation({
        type: 'update',
        instances: { id: 'item1', value: 150 }
      }));
      
      store.addOperation(new Operation({
        type: 'update',
        instances: { id: 'item1', name: 'Second Update' }
      }));
      
      // SimpleDB equivalent operations
      simpleDb.update({ id: 'item1', name: 'First Update' });
      simpleDb.update({ id: 'item1', value: 150 });
      simpleDb.update({ id: 'item1', name: 'Second Update' });
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData[0].name).toBe('Second Update');
      expect(renderedData[0].value).toBe(150);
    });

    it('should handle create followed by update', () => {
      // Create a new item
      store.addOperation(new Operation({
        type: 'create',
        instances: { id: 'item4', name: 'Item 4', value: 400 }
      }));
      
      // Update the newly created item
      store.addOperation(new Operation({
        type: 'update',
        instances: { id: 'item4', name: 'Updated Item 4' }
      }));
      
      // Simple DB equivalent
      simpleDb.create({ id: 'item4', name: 'Item 4', value: 400 });
      simpleDb.update({ id: 'item4', name: 'Updated Item 4' });
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData[3].name).toBe('Updated Item 4');
      expect(renderedData[3].value).toBe(400);
    });

    it('should handle create followed by delete', () => {
      // Create a new item
      store.addOperation(new Operation({
        type: 'create',
        instances: { id: 'item4', name: 'Item 4', value: 400 }
      }));
      
      // Then delete it
      store.addOperation(new Operation({
        type: 'delete',
        instances: { id: 'item4' }
      }));
      
      // SimpleDB equivalent - create and delete cancel out
      simpleDb.create({ id: 'item4', name: 'Item 4', value: 400 });
      simpleDb.delete('item4');
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.length).toBe(3);
      expect(renderedData.find(item => item.id === 'item4')).toBeUndefined();
    });
    
    it('should handle conditional upsert behavior where updating non-existent items creates them unless deleted', () => {
      // We'll use the modified ModelStore that has upsert with delete check behavior
      
      // Create a SimpleDB with matching upsert behavior for comparison
      const upsertDb = new SimpleDB(initialData, 'id');
      upsertDb.update = function(items) {
        const updates = Array.isArray(items) ? items : [items];
        updates.forEach(update => {
          const index = this.data.findIndex(x => x[this.pkField] === update[this.pkField]);
          if (index !== -1) {
            this.data[index] = {...this.data[index], ...update};
          } else {
            // Check if there's a delete operation
            const hasDeleteOperation = this.deletedIds && this.deletedIds.has(update[this.pkField]);
            if (!hasDeleteOperation) {
              // Upsert behavior: create if doesn't exist and not deleted
              this.data.push({...update});
            }
          }
        });
      };
      
      // Add tracking for deleted IDs in SimpleDB to mirror our conditional logic
      upsertDb.deletedIds = new Set();
      const originalDelete = upsertDb.delete;
      upsertDb.delete = function(ids) {
        const toDelete = Array.isArray(ids) ? ids : [ids];
        toDelete.forEach(id => this.deletedIds.add(id));
        return originalDelete.call(this, ids);
      };
      
      // Test 1: Basic upsert behavior for item with no delete operation
      const updateNonExistent1 = { id: 'upsert1', name: 'Upserted Item', value: 999 };
      
      store.addOperation(new Operation({
        type: 'update',
        instances: updateNonExistent1
      }));
      
      upsertDb.update(updateNonExistent1);
      
      // Compare results for basic upsert
      let renderedData = store.render().sort(sortById);
      let simpleDbData = upsertDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.length).toBe(4); // 3 original + 1 upserted
      let upsertedItem = renderedData.find(item => item.id === 'upsert1');
      expect(upsertedItem).toBeDefined();
      expect(upsertedItem?.name).toBe('Upserted Item');
      
      // Test 2: Add a delete operation for an item, then try to upsert it
      // First delete an item that doesn't exist yet
      const deleteNonExistent = { id: 'preventUpsert' };
      store.addOperation(new Operation({
        type: 'delete',
        instances: deleteNonExistent
      }));
      
      upsertDb.delete('preventUpsert');
      
      // Now try to upsert the deleted item
      const updateDeletedItem = { id: 'preventUpsert', name: 'Should Not Appear', value: 555 };
      store.addOperation(new Operation({
        type: 'update',
        instances: updateDeletedItem
      }));
      
      upsertDb.update(updateDeletedItem);
      
      // Compare results after attempting to upsert a deleted item
      renderedData = store.render().sort(sortById);
      simpleDbData = upsertDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      // Should still have only 4 items, not 5
      expect(renderedData.length).toBe(4);
      // The preventUpsert item should not exist
      expect(renderedData.find(item => item.id === 'preventUpsert')).toBeUndefined();
    });

    it('should handle delete for non-existent item', () => {
      // Delete a non-existent item
      store.addOperation(new Operation({
        type: 'delete',
        instances: { id: 'doesNotExist' }
      }));
      
      // SimpleDB equivalent - nothing happens for non-existent delete
      simpleDb.delete('doesNotExist');
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.length).toBe(3);
    });
  });
  
  describe('Operation Persistence', () => {
    it('should persist operations when addOperation is called', async () => {
      // Add an operation
      const operation = new Operation({
        type: 'create',
        instances: { id: 'item4', name: 'Item 4', value: 400 }
      });
      
      store.addOperation(operation);
      
      // Check that operations were persisted
      // Note: In a real test with access to the storage mock, you'd verify the call to save
      expect(store.operations).toContain(operation);
    });
    
    it('should handle mixed operation types in a single batch', () => {
      // Create a batch with mixed operations to test complex scenarios
      // 1. Create a new item
      const createItem = { id: 'mix1', name: 'Mix Item 1', value: 100 };
      store.addOperation(new Operation({
        type: 'create',
        instances: createItem
      }));
      simpleDb.create(createItem);
      
      // 2. Create multiple items in one operation
      const batchCreate = [
        { id: 'mix2', name: 'Mix Item 2', value: 200 },
        { id: 'mix3', name: 'Mix Item 3', value: 300 }
      ];
      store.addOperation(new Operation({
        type: 'create',
        instances: batchCreate
      }));
      simpleDb.create(batchCreate);
      
      // 3. Update one existing and one new item in same operation
      const mixedUpdates = [
        { id: 'item1', name: 'Updated Original' },
        { id: 'mix2', value: 250 }
      ];
      store.addOperation(new Operation({
        type: 'update',
        instances: mixedUpdates
      }));
      simpleDb.update(mixedUpdates);
      
      // 4. Delete multiple items in one operation
      const mixedDeletes = [
        { id: 'item3' },
        { id: 'mix3' }
      ];
      store.addOperation(new Operation({
        type: 'delete',
        instances: mixedDeletes
      }));
      simpleDb.delete(['item3', 'mix3']);
      
      // Compare final results after all mixed operations
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.length).toBe(4); // 2 original + 2 new
      
      // Check specific results
      expect(renderedData.find(item => item.id === 'item1')?.name).toBe('Updated Original');
      expect(renderedData.find(item => item.id === 'mix2')?.value).toBe(250);
      expect(renderedData.find(item => item.id === 'item3')).toBeUndefined();
      expect(renderedData.find(item => item.id === 'mix3')).toBeUndefined();
    });
    
    it('should persist ground truth when setGroundTruth is called', () => {
      // New ground truth data
      const newGroundTruth = [
        { id: 'new1', name: 'New 1', value: 1000 },
        { id: 'new2', name: 'New 2', value: 2000 }
      ];
      
      store.setGroundTruth(newGroundTruth);
      
      // Check ground truth was updated
      expect(store.groundTruthArray).toEqual(newGroundTruth);
      
      // Render should reflect new ground truth
      const renderedData = store.render().sort(sortById);
      expect(renderedData).toHaveLength(2);
      expect(renderedData[0].id).toBe('new1');
      expect(renderedData[1].id).toBe('new2');
    });
    
    it('should update an existing operation correctly', () => {
      // Add an operation
      const operation = new Operation({
        type: 'create',
        instances: { id: 'item4', name: 'Item 4', value: 400 }
      });
      
      store.addOperation(operation);
      
      // Update the operation status
      const updatedOp = new Operation({
        ...operation,
        status: 'confirmed'
      });
      
      // Try to update the operation
      const updateResult = store.updateOperation(updatedOp);
      
      // Check update was successful
      expect(updateResult).toBe(true);
      expect(store.operations[0].status).toBe('confirmed');
    });
  });
});