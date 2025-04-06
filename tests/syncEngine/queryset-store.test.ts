import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto'; // This sets up the IndexedDB environment
import { QuerysetStore, Operation, OperationType } from '../../src/syncEngine/stores/QuerysetStore';
import { IndexedDBStorage } from '../../src/syncEngine/persistence/IndexedDBStorage';
import { deleteDB } from 'idb';
import hash from 'object-hash';

// Simple in-memory database for QuerysetStore comparison
// Since QuerysetStore only manages sets of primary keys, this is simpler than the ModelStore version
class SimpleQuerysetDB {
  constructor(initialPks = [], pkField = 'id') {
    this.pks = new Set(initialPks); // Store just the primary keys, not full objects
    this.pkField = pkField;
  }

  create(items) {
    const newItems = Array.isArray(items) ? items : [items];
    newItems.forEach(item => {
      this.pks.add(item[this.pkField]);
    });
  }

  update(items) {
    const updates = Array.isArray(items) ? items : [items];
    updates.forEach(update => {
      const pk = update[this.pkField];
      if (this.pks.has(pk)) {
        // For queryset, update doesn't change anything if the item exists
        return;
      } else {
        // Implement upsert behavior with delete check
        // For our simple test DB, we'll just simulate this
        if (!this.deletedPks.has(pk)) {
          this.pks.add(pk);
        }
      }
    });
  }

  delete(items) {
    const toDelete = Array.isArray(items) ? items : [items];
    toDelete.forEach(item => {
      const pk = typeof item === 'object' ? item[this.pkField] : item;
      this.pks.delete(pk);
      this.deletedPks.add(pk);
    });
  }

  getAllPks() {
    return Array.from(this.pks);
  }

  // Track deleted PKs to implement the same upsert behavior as QuerysetStore
  deletedPks = new Set();
}

// Test data
interface TestItem {
  id: string;
  name: string;
  value: number;
}

// Mock ModelClass
const TestModelClass = {
  primaryKeyField: 'id' as keyof TestItem,
  configKey: 'test-config',
  modelName: 'test-model'
};

// Helper function to sort results for consistent comparison
const sortById = (a, b) => a.localeCompare(b);

describe('QuerysetStore', () => {
  let store;
  let modelClass = TestModelClass;
  let storage;
  let simpleDb;
  let fetchMock;
  let testAst;
  let storeKey;
  let operationsKey;
  let groundTruthKey;
  const TEST_DB_NAME = 'test_queryset_cache';
  
  // Initial test data
  const initialItems = [
    { id: 'item1', name: 'Item 1', value: 100 },
    { id: 'item2', name: 'Item 2', value: 200 },
    { id: 'item3', name: 'Item 3', value: 300 }
  ];
  
  // Extract just the primary keys for QuerysetStore
  const initialPks = initialItems.map(item => item.id);

  beforeEach(async () => {
    // Clear any existing test database
    try {
      await deleteDB(TEST_DB_NAME);
    } catch (e) {
      console.warn('Error cleaning up test database:', e);
    }
    
    // Set up a simple AST object for testing
    testAst = { field: 'name', operator: 'contains', value: 'Test' };
    
    // Create a mock fetch function
    fetchMock = vi.fn().mockResolvedValue(initialPks);
    
    // Calculate store keys for test model
    storeKey = `${TestModelClass.modelName}::${TestModelClass.configKey}::querysetstore::${hash(testAst)}`;
    operationsKey = `${storeKey}::operations`;
    groundTruthKey = `${storeKey}::groundtruth`;
    
    // Create a real IndexedDBStorage instance
    storage = new IndexedDBStorage({
      dbName: TEST_DB_NAME,
      storeName: 'test_store',
      version: 1
    });
    
    // Initialize QuerysetStore with real storage
    store = new QuerysetStore(TestModelClass, fetchMock, testAst, storage);
    
    // Initialize SimpleDB with just the primary keys
    simpleDb = new SimpleQuerysetDB(initialPks, 'id');

    // We'll need to manually set the ground truth since _hydrate won't have anything in IndexedDB yet
    store.groundTruth = [...initialPks];
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
      expect(store.groundTruth).toHaveLength(3);
      expect(store.operations).toHaveLength(0);
      expect(store.isReady).toBe(true);
    });

    it('should render initial data correctly', () => {
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAllPks().sort(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(3);
    });

    it('should add a create operation', async () => {
      // Create a new item
      const newItem = { id: 'item4', name: 'Item 4', value: 400 };
      
      // Add to QuerysetStore via operation
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
      const simpleDbData = simpleDb.getAllPks().sort(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(4);
      expect(renderedData[3]).toBe('item4');
    });

    it('should add an update operation with upsert behavior', async () => {
      // Update a non-existent item (should be upserted)
      const updateItem = { id: 'item4', name: 'Item 4', value: 400 };
      
      // Add to QuerysetStore via operation
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
      const simpleDbData = simpleDb.getAllPks().sort(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(4);
      expect(renderedData[3]).toBe('item4');
      
      // Now update an existing item (should have no effect beyond what already exists)
      const existingUpdateItem = { id: 'item1', name: 'Updated Item 1' };
      
      // Add to QuerysetStore via operation
      store.addOperation(new Operation({
        type: 'update',
        instances: existingUpdateItem
      }));
      
      // Add to SimpleDB
      simpleDb.update(existingUpdateItem);
      
      // Small delay
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Compare results again
      const renderedData2 = store.render().sort(sortById);
      const simpleDbData2 = simpleDb.getAllPks().sort(sortById);
      
      expect(renderedData2).toEqual(simpleDbData2);
      expect(renderedData2).toHaveLength(4); // Still 4, no new items added
      expect(renderedData2.includes('item1')).toBe(true);
    });

    it('should add a delete operation', async () => {
      // Delete an item
      const deleteItem = { id: 'item3' };
      
      // Add to QuerysetStore via operation
      store.addOperation(new Operation({
        type: 'delete',
        instances: deleteItem
      }));
      
      // Delete from SimpleDB
      simpleDb.delete(deleteItem);
      
      // Small delay to allow IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAllPks().sort(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(2);
      expect(renderedData.includes('item3')).toBe(false);
    });
  });

  describe('Persistence and Hydration', () => {
    it('should save data to storage and allow subsequent hydration', async () => {
      // Helper function to add a delay
      const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      
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
      
      // Create first store and add data
      const initialStore = new QuerysetStore(modelClass, fetchMock, testAst, storage1);
      
      // Make sure store is initialized
      await initialStore._hydrate();
      expect(initialStore.isReady).toBe(true);
      
      // Create test data
      const opData = {
        type: 'create' as OperationType,
        instances: [{ id: 'op1', name: 'Op Instance 1' }]
      };
      const op = new Operation(opData);
      const gtData = ['gt1', 'gt2']; // Primary keys only
      
      // Add data to the store
      initialStore.addOperation(op);
      initialStore.setGroundTruth(gtData);
      
      // Wait for operations to complete
      await delay(100);
      
      // Verify data was saved to IndexedDB
      const savedOps = await storage1.load(operationsKey);
      const savedGT = await storage1.load(groundTruthKey);
      
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
      expect(savedGT?.data).toHaveLength(2);
      expect(savedGT?.data[0]).toBe('gt1');
      
      // Close first store's connection
      await storage1.close();
      
      // Create a new storage instance and store
      const storage2 = new IndexedDBStorage({
        dbName: TEST_DB_NAME,
        storeName: 'test_store',
        version: 1
      });
      
      const hydratedStore = new QuerysetStore(modelClass, fetchMock, testAst, storage2);
      
      // Hydrate the new store from IndexedDB
      await hydratedStore._hydrate();
      
      // Verify hydration worked correctly
      expect(hydratedStore.isReady).toBe(true);
      expect(hydratedStore.operations).toHaveLength(1);
      expect(hydratedStore.operations[0].operationId).toBe(op.operationId);
      expect(hydratedStore.operations[0].instances[0].id).toBe('op1');
      
      expect(hydratedStore.groundTruth).toHaveLength(2);
      expect(hydratedStore.groundTruth[0]).toBe('gt1');
      
      // Cleanup
      await storage2.close();
    });
  });
  
  describe('Sync Functionality', () => {
    it('should sync with the server', async () => {
      // Add some operations
      store.addOperation(new Operation({
        type: 'create',
        instances: { id: 'item4', name: 'Item 4', value: 400 }
      }));
      
      store.addOperation(new Operation({
        type: 'update',
        instances: { id: 'item5', name: 'Item 5' }
      }));
      
      // Simulate a server update with new data
      const updatedServerPks = ['item1', 'item2', 'item6']; // item3 gone, item6 added
      
      fetchMock.mockResolvedValueOnce(updatedServerPks);
      
      // Perform sync
      await store.sync();
      
      // Small delay to allow IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Update simpleDb to match what we expect after sync
      simpleDb = new SimpleQuerysetDB(updatedServerPks, 'id');
      
      // Add back the operations that should be retained
      simpleDb.create({ id: 'item4' });
      simpleDb.update({ id: 'item5' });
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAllPks().sort(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(5);
      // Should have item1, item2, item4, item5, item6
      expect(renderedData.includes('item3')).toBe(false);
      expect(renderedData.includes('item6')).toBe(true);
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
        fetchMock.mockResolvedValueOnce([...initialPks]);
        
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
      store.groundTruth = [];
      
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
      expect(renderedData[0]).toBe('new1');
      expect(renderedData[1]).toBe('new2');
    });
    
    it('should handle operations with multiple instances - create', () => {
      // Create multiple items in a single operation
      const newItems = [
        { id: 'batch1', name: 'Batch Item 1', value: 1000 },
        { id: 'batch2', name: 'Batch Item 2', value: 2000 },
        { id: 'batch3', name: 'Batch Item 3', value: 3000 }
      ];
      
      // Add to QuerysetStore via single operation with multiple instances
      store.addOperation(new Operation({
        type: 'create',
        instances: newItems
      }));
      
      // Add to SimpleDB
      simpleDb.create(newItems);
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAllPks().sort(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(6); // 3 original + 3 batch
      expect(renderedData.filter(item => item.startsWith('batch'))).toHaveLength(3);
    });
    
    it('should handle operations with multiple instances - delete', () => {
      // Delete multiple items in a single operation
      const deleteItems = [
        { id: 'item1' },
        { id: 'item2' }
      ];
      
      // Add to QuerysetStore via single operation with multiple instances
      store.addOperation(new Operation({
        type: 'delete',
        instances: deleteItems
      }));
      
      // Add to SimpleDB
      simpleDb.delete(deleteItems);
      
      // Compare results
      const renderedData = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAllPks().sort(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData).toHaveLength(1); // Only item3 should remain
      expect(renderedData[0]).toBe('item3');
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
      const simpleDbData = simpleDb.getAllPks().sort(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.length).toBe(3);
      expect(renderedData.includes('item4')).toBe(false);
    });
    
    it('should handle conditional upsert behavior', () => {
      // Test 1: Basic upsert behavior for item with no delete operation
      const updateNonExistent1 = { id: 'upsert1', name: 'Upserted Item', value: 999 };
      
      store.addOperation(new Operation({
        type: 'update',
        instances: updateNonExistent1
      }));
      
      simpleDb.update(updateNonExistent1);
      
      // Compare results for basic upsert
      let renderedData = store.render().sort(sortById);
      let simpleDbData = simpleDb.getAllPks().sort(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.length).toBe(4); // 3 original + 1 upserted
      expect(renderedData.includes('upsert1')).toBe(true);
      
      // Test 2: Add a delete operation for an item, then try to upsert it
      // First delete an item that doesn't exist yet
      const deleteNonExistent = { id: 'preventUpsert' };
      store.addOperation(new Operation({
        type: 'delete',
        instances: deleteNonExistent
      }));
      
      simpleDb.delete('preventUpsert');
      
      // Now try to upsert the deleted item
      const updateDeletedItem = { id: 'preventUpsert', name: 'Should Not Appear', value: 555 };
      store.addOperation(new Operation({
        type: 'update',
        instances: updateDeletedItem
      }));
      
      simpleDb.update(updateDeletedItem);
      
      // Compare results after attempting to upsert a deleted item
      renderedData = store.render().sort(sortById);
      simpleDbData = simpleDb.getAllPks().sort(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      // Should still have only 4 items, not 5
      expect(renderedData.length).toBe(4);
      // The preventUpsert item should not exist
      expect(renderedData.includes('preventUpsert')).toBe(false);
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
      const simpleDbData = simpleDb.getAllPks().sort(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.length).toBe(3);
    });
  });
  
  describe('QuerysetStore-specific features', () => {
    it('should handle the setGroundTruth method with primary keys or full objects', () => {
      // Test with primary keys
      const pkOnly = ['pk1', 'pk2', 'pk3'];
      store.setGroundTruth(pkOnly);
      expect(store.groundTruth).toEqual(pkOnly);
      
      // Test with full objects - should extract just the PKs
      const fullObjects = [
        { id: 'obj1', name: 'Object 1' },
        { id: 'obj2', name: 'Object 2' }
      ];
      
      store.setGroundTruth(fullObjects);
      expect(store.groundTruth).toEqual(['obj1', 'obj2']);
      
      // Test with mixed input
      const mixedInput = [
        'mixPk1',
        { id: 'mixObj2', name: 'Mixed Object 2' }
      ];
      
      store.setGroundTruth(mixedInput);
      expect(store.groundTruth).toEqual(['mixPk1', 'mixObj2']);
      
      // Render the current state to verify
      const renderedData = store.render().sort(sortById);
      expect(renderedData).toEqual(['mixObj2', 'mixPk1']);
    });
    
    it('should handle AST hash generation', () => {
      // Test different AST objects produce different hashes
      const ast1 = { field: 'name', operator: 'equals', value: 'Test' };
      const ast2 = { field: 'name', operator: 'contains', value: 'Test' };
      
      const hash1 = store.getASTHash(ast1);
      const hash2 = store.getASTHash(ast2);
      
      expect(hash1).not.toBe(hash2);
      
      // Test same object structure but different values produce different hashes
      const ast3 = { field: 'name', operator: 'equals', value: 'Different' };
      const hash3 = store.getASTHash(ast3);
      
      expect(hash1).not.toBe(hash3);
      
      // Test identical objects produce same hash
      const ast4 = { field: 'name', operator: 'equals', value: 'Test' };
      const hash4 = store.getASTHash(ast4);
      
      expect(hash1).toBe(hash4);
    });
    
    it('should correctly convert ground truth to a Set', () => {
      store.groundTruth = ['set1', 'set2', 'set3'];
      
      const groundTruthSet = store.groundTruthSet;
      
      expect(groundTruthSet instanceof Set).toBe(true);
      expect(groundTruthSet.size).toBe(3);
      expect(groundTruthSet.has('set1')).toBe(true);
      expect(groundTruthSet.has('set2')).toBe(true);
      expect(groundTruthSet.has('set3')).toBe(true);
    });
    
    it('should call fetchFn with the correct AST during sync', async () => {
      // Set up fetch mock
      fetchMock.mockResolvedValueOnce(['server1', 'server2']);
      
      // Call sync
      await store.sync();
      
      // Verify fetchFn was called with the AST
      expect(fetchMock).toHaveBeenCalledWith({ ast: testAst });
      
      // Verify ground truth was updated
      expect(store.groundTruth).toEqual(['server1', 'server2']);
    });
  });
});