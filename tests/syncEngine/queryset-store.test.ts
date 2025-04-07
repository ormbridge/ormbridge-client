import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto'; // Sets up the IndexedDB environment
import { QuerysetStore, Operation, OperationType } from '../../src/syncEngine/stores/QuerysetStore';
import { IndexedDBStorage } from '../../src/syncEngine/persistence/IndexedDBStorage';
import { getStoreKey } from '../../src/syncEngine/stores/utils';
import { deleteDB } from 'idb';
import hash from 'object-hash';

// Simple in-memory database for comparison
class SimpleDB {
  data: TestItem[];
  pkField: keyof TestItem;
  includedPks: Set<any>;

  constructor(initialPks: any[] = [], pkField: keyof TestItem = 'id') {
    this.data = [];
    this.pkField = pkField;
    this.includedPks = new Set(initialPks);
  }

  create(items: TestItem | TestItem[]) {
    const newItems = Array.isArray(items) ? items : [items];
    newItems.forEach(item => {
      const pk = item[this.pkField];
      if (!this.includedPks.has(pk)) {
        this.includedPks.add(pk);
      }
    });
  }

  delete(ids: any | any[]) {
    const toDelete = Array.isArray(ids) ? ids : [ids];
    toDelete.forEach(id => {
      this.includedPks.delete(id);
    });
  }

  getAll() {
    return Array.from(this.includedPks);
  }
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

// Helper function for delays
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('QuerysetStore', () => {
  let store: QuerysetStore<TestItem>;
  const modelClass = TestModelClass;
  let storage: IndexedDBStorage;
  let simpleDb: SimpleDB;
  let fetchMock: vi.Mock;
  let storeKey: string;
  let operationsKey: string;
  let groundTruthKey: string;
  const TEST_DB_NAME = 'test_querysetstore_cache';
  const mockAST = { filter: { id: { eq: 'test' } } };
  const mockASTHash = hash(mockAST);

  // Initial test data
  const initialPks = ['item1', 'item2', 'item3'];
  const initialItems: TestItem[] = [
    { id: 'item1', name: 'Item 1', value: 100 },
    { id: 'item2', name: 'Item 2', value: 200 },
    { id: 'item3', name: 'Item 3', value: 300 }
  ];

  beforeEach(async () => {
    // Clear any existing test database
    try {
      await deleteDB(TEST_DB_NAME);
    } catch (e) {
      // Ignore errors during cleanup
    }

    // Create a mock fetch function
    fetchMock = vi.fn().mockResolvedValue([...initialItems]);

    // Calculate keys
    storeKey = `${getStoreKey(modelClass)}::querysetstore::${hash(mockAST)}`;
    operationsKey = `${storeKey}::operations`;
    groundTruthKey = `${storeKey}::groundtruth`;

    // Create IndexedDBStorage instance
    storage = new IndexedDBStorage({
      dbName: TEST_DB_NAME,
      storeName: 'test_store',
      version: 1
    });

    // Initialize QuerysetStore
    store = new QuerysetStore<TestItem>(
      modelClass,
      fetchMock,
      mockAST,
      storage,
      initialPks,
      []
    );

    // Initialize SimpleDB with the same data
    simpleDb = new SimpleDB(initialPks, 'id');
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

    vi.restoreAllMocks();
  });

  describe('Basic Functionality', () => {
    it('should initialize with the correct data', () => {
      expect(store.groundTruthPks).toEqual(initialPks);
      expect(store.operations).toEqual([]);
      expect(store.isSyncing).toBe(false);
    });

    it('should render the initial data correctly', () => {
      const renderedPks = store.render();
      const simplePks = simpleDb.getAll();
      expect(renderedPks).toEqual(simplePks);
      expect(renderedPks).toHaveLength(3);
    });

    it('should add a create operation and render correctly', async () => {
      const newItem: TestItem = { id: 'item4', name: 'Item 4', value: 400 };
      store.addOperation(new Operation({ type: 'create', instances: newItem }));
      simpleDb.create(newItem);

      await delay(50); // Allow for persistence

      const renderedPks = store.render();
      const simplePks = simpleDb.getAll();
      expect(renderedPks).toEqual(simplePks);
      expect(renderedPks).toHaveLength(4);
      expect(renderedPks).toContain('item4');
    });

    it('should add a delete operation and render correctly', async () => {
      const deleteItem: Pick<TestItem, 'id'> = { id: 'item3' };
      store.addOperation(new Operation({ type: 'delete', instances: deleteItem as TestItem }));
      simpleDb.delete('item3');

      await delay(50);

      const renderedPks = store.render();
      const simplePks = simpleDb.getAll();
      expect(renderedPks).toEqual(simplePks);
      expect(renderedPks).toHaveLength(2);
      expect(renderedPks).not.toContain('item3');
    });

    it('should handle update_or_create operation for new item', async () => {
      const newItem: TestItem = { id: 'item4', name: 'Item 4', value: 400 };
      store.addOperation(new Operation({ type: 'update_or_create', instances: newItem }));
      simpleDb.create(newItem);

      await delay(50);

      const renderedPks = store.render();
      const simplePks = simpleDb.getAll();
      expect(renderedPks).toEqual(simplePks);
      expect(renderedPks).toHaveLength(4);
      expect(renderedPks).toContain('item4');
    });

    it('should handle get_or_create operation for new item', async () => {
      const newItem: TestItem = { id: 'item4', name: 'Item 4', value: 400 };
      store.addOperation(new Operation({ type: 'get_or_create', instances: newItem }));
      simpleDb.create(newItem);

      await delay(50);

      const renderedPks = store.render();
      const simplePks = simpleDb.getAll();
      expect(renderedPks).toEqual(simplePks);
      expect(renderedPks).toHaveLength(4);
      expect(renderedPks).toContain('item4');
    });
  });

  describe('Persistence', () => {
    it('should save operations and ground truth to storage', async () => {
      // Add an operation
      const op = new Operation({
        type: 'create' as OperationType,
        instances: [{ id: 'op1', name: 'Op Instance 1', value: 1 }] as TestItem[]
      });
      store.addOperation(op);

      // Set new ground truth
      const newGroundTruth = ['gt1', 'gt2', 'gt3'];
      store.setGroundTruth(newGroundTruth);

      // Wait for persistence to complete
      await delay(100);

      // Verify data was saved to IndexedDB
      const savedOps = await storage.load(operationsKey);
      const savedGT = await storage.load(groundTruthKey);

      // Check operations
      expect(savedOps).toBeDefined();
      expect(savedOps?.id).toBe(operationsKey);
      expect(Array.isArray(savedOps?.data)).toBe(true);
      expect(savedOps?.data).toHaveLength(1);
      expect(savedOps?.data[0].type).toBe(op.type);
      expect(savedOps?.data[0].instances).toEqual(op.instances);

      // Check ground truth
      expect(savedGT).toBeDefined();
      expect(savedGT?.id).toBe(groundTruthKey);
      expect(Array.isArray(savedGT?.data)).toBe(true);
      expect(savedGT?.data).toEqual(newGroundTruth);

      // Verify store's in-memory state also matches
      expect(store.operations).toHaveLength(1);
      expect(store.operations[0].operationId).toBe(op.operationId);
      expect(store.groundTruthPks).toEqual(newGroundTruth);
    });
  });

  describe('Operation Management', () => {
    it('should update an existing operation', async () => {
      const operation = new Operation({ 
        type: 'create', 
        instances: { id: 'item4', name: 'Item 4', value: 400 } as TestItem 
      });
      store.addOperation(operation);
      const originalOpId = operation.operationId;

      // Create an update payload
      const confirmedOpData = {
        operationId: originalOpId,
        type: operation.type,
        status: 'confirmed' as const,
        instances: [{ id: 'item4', name: 'Confirmed Item 4', value: 401 }] as TestItem[],
        timestamp: Date.now()
      };
      const confirmedOp = new Operation(confirmedOpData);

      const updateResult = store.updateOperation(confirmedOp);

      expect(updateResult).toBe(true);
      expect(store.operations).toHaveLength(1);
      const opInStore = store.operations[0];
      expect(opInStore.operationId).toBe(originalOpId);
      expect(opInStore.status).toBe('confirmed');
      expect(opInStore.instances).toEqual(confirmedOpData.instances);
      expect(opInStore.timestamp).toBe(confirmedOpData.timestamp);

      // Check persistence
      await delay(50);
      const savedOps = await storage.load(operationsKey);
      expect(savedOps?.data).toHaveLength(1);
      expect(savedOps?.data[0].status).toBe('confirmed');
      expect(savedOps?.data[0].instances).toEqual(confirmedOpData.instances);
    });

    it('should confirm an operation', async () => {
      const operation = new Operation({
        type: 'create',
        instances: { id: 'item4', name: 'Item 4', value: 400 } as TestItem
      });
      store.addOperation(operation);
      const originalOpId = operation.operationId;

      const confirmedInstances = [{ id: 'item4', name: 'Server Item 4', value: 410 }] as TestItem[];
      store.confirm(originalOpId, confirmedInstances);

      expect(store.operations).toHaveLength(1);
      const opInStore = store.operations[0];
      expect(opInStore.operationId).toBe(originalOpId);
      expect(opInStore.status).toBe('confirmed');
      expect(opInStore.instances).toEqual(confirmedInstances);

      // Check persistence
      await delay(50);
      const savedOps = await storage.load(operationsKey);
      expect(savedOps?.data).toHaveLength(1);
      expect(savedOps?.data[0].status).toBe('confirmed');
      expect(savedOps?.data[0].instances).toEqual(confirmedInstances);
    });

    it('should reject an operation', async () => {
      const operation = new Operation({
        type: 'create',
        instances: { id: 'item4', name: 'Item 4', value: 400 } as TestItem
      });
      store.addOperation(operation);
      const originalOpId = operation.operationId;

      store.reject(originalOpId);

      expect(store.operations).toHaveLength(1);
      const opInStore = store.operations[0];
      expect(opInStore.operationId).toBe(originalOpId);
      expect(opInStore.status).toBe('rejected');

      // Check persistence
      await delay(50);
      const savedOps = await storage.load(operationsKey);
      expect(savedOps?.data).toHaveLength(1);
      expect(savedOps?.data[0].status).toBe('rejected');
    });

    it('should log warning when confirming non-existent operation', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn');
      store.confirm('non-existent-id', []);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Attempted to confirm non-existent operation')
      );
      consoleWarnSpy.mockRestore();
    });

    it('should log warning when rejecting non-existent operation', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn');
      store.reject('non-existent-id');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Attempted to reject non-existent operation')
      );
      consoleWarnSpy.mockRestore();
    });
  });

  describe('Apply Operation Logic', () => {
    it('should apply operation to ground truth set correctly', () => {
      let groundTruthSet = new Set(['item1', 'item2', 'item3']);
      
      // Create operation
      const createOp = new Operation({
        type: 'create',
        instances: { id: 'item4', name: 'Item 4', value: 400 } as TestItem
      });
      groundTruthSet = store.applyOperation(createOp, groundTruthSet);
      expect(groundTruthSet.has('item4')).toBe(true);
      expect(groundTruthSet.size).toBe(4);
      
      // Delete operation
      const deleteOp = new Operation({
        type: 'delete',
        instances: { id: 'item2' } as TestItem
      });
      groundTruthSet = store.applyOperation(deleteOp, groundTruthSet);
      expect(groundTruthSet.has('item2')).toBe(false);
      expect(groundTruthSet.size).toBe(3);
      
      // Update operation (existing)
      const updateOp = new Operation({
        type: 'update',
        instances: { id: 'item1', name: 'Updated Item 1', value: 110 } as TestItem
      });
      groundTruthSet = store.applyOperation(updateOp, groundTruthSet);
      expect(groundTruthSet.has('item1')).toBe(true);
      expect(groundTruthSet.size).toBe(3);
      
      // Update operation (non-existing)
      const updateNewOp = new Operation({
        type: 'update',
        instances: { id: 'item5', name: 'Item 5', value: 500 } as TestItem
      });
      groundTruthSet = store.applyOperation(updateNewOp, groundTruthSet);
      expect(groundTruthSet.has('item5')).toBe(true);
      expect(groundTruthSet.size).toBe(4);
    });
    
    it('should handle update after delete correctly', () => {
      let groundTruthSet = new Set(['item1', 'item2', 'item3']);
      
      // Delete operation
      const deleteOp = new Operation({
        type: 'delete',
        instances: { id: 'item2' } as TestItem,
        status: 'inflight'
      });
      store.addOperation(deleteOp);
      
      // Update operation after delete
      const updateOp = new Operation({
        type: 'update',
        instances: { id: 'item2', name: 'Updated Item 2', value: 210 } as TestItem
      });
      
      // Apply update to ground truth
      groundTruthSet = store.applyOperation(updateOp, groundTruthSet);
      
      // The update should not add item2 back because there's a delete operation
      expect(groundTruthSet.has('item2')).toBe(true); // it's already in ground truth
      
      // But the rendered result should not include item2
      const renderedPks = store.render();
      expect(renderedPks).not.toContain('item2');
    });
    
    it('should handle update_or_create after delete correctly', () => {
      let groundTruthSet = new Set(['item1', 'item2', 'item3']);
      
      // Delete operation
      const deleteOp = new Operation({
        type: 'delete',
        instances: { id: 'item2' } as TestItem,
        status: 'inflight'
      });
      store.addOperation(deleteOp);
      
      // update_or_create operation after delete
      const uocOp = new Operation({
        type: 'update_or_create',
        instances: { id: 'item2', name: 'UOC Item 2', value: 220 } as TestItem
      });
      store.addOperation(uocOp);
      
      // The rendered result should include item2 because update_or_create takes precedence
      const renderedPks = store.render();
      expect(renderedPks).toContain('item2');
    });
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
      expect(store.operations).toHaveLength(2);

      // Simulate server response for sync
      const updatedServerItems: TestItem[] = [
        { id: 'item1', name: 'Server Item 1', value: 100 },
        { id: 'item2', name: 'Server Item 2', value: 200 },
        // item3 removed by server
        { id: 'serverOnly', name: 'Server Only', value: 500 }
      ];
      fetchMock.mockResolvedValueOnce([...updatedServerItems]);

      // Mock Date.now used inside sync for trimming
      vi.spyOn(global.Date, 'now').mockReturnValue(currentTime);

      // Perform sync
      await store.sync();

      // Restore Date.now mock
      vi.mocked(global.Date.now).mockRestore();

      // Verification
      expect(fetchMock).toHaveBeenCalledWith({ 
        ast: mockAST, 
        modelClass: modelClass 
      });

      // Check ground truth was updated from server response
      expect(store.groundTruthPks).toEqual(['item1', 'item2', 'serverOnly']);
      expect(store.groundTruthPks).toHaveLength(3);

      // Check operations were trimmed
      expect(store.operations).toHaveLength(1);
      expect(store.operations[0].operationId).toBe(recentOp.operationId);

      // Check render reflects the new ground truth combined with remaining operations
      const renderedPks = store.render();
      expect(renderedPks).toHaveLength(4); // 3 from server + 1 from recent op
      expect(renderedPks).toContain('recent');
      expect(store.isSyncing).toBe(false);
    });

    it('should handle server errors during sync gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error');
      
      // Initial state for comparison
      const initialPks = [...store.groundTruthPks];
      const initialOps = [...store.operations];
      
      // Setup fetch to fail
      const syncError = new Error('Server Boom!');
      fetchMock.mockRejectedValueOnce(syncError);
      
      // Perform sync (should not throw)
      await store.sync();
      
      // Verification
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to sync ground truth'),
        expect.any(Error)
      );
      
      // Check that state remains unchanged
      expect(store.groundTruthPks).toEqual(initialPks);
      expect(store.operations).toEqual(initialOps);
      
      // Check sync flag is reset
      expect(store.isSyncing).toBe(false);
      
      consoleErrorSpy.mockRestore();
    });

    it('should prevent concurrent syncs and log a warning', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn');
      
      // Manually set syncing flag
      store.isSyncing = true;
      
      // Call sync again
      await store.sync();
      
      // Verification
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Already syncing, request ignored')
      );
      
      // Check fetch was NOT called
      expect(fetchMock).not.toHaveBeenCalled();
      
      // Check isSyncing flag is still true
      expect(store.isSyncing).toBe(true);
      
      consoleWarnSpy.mockRestore();
      store.isSyncing = false; // Reset flag
    });
  });

  describe('Operation Trimming', () => {
    it('should trim operations older than two minutes', () => {
      const currentTime = Date.now();
      
      // Create operations with different timestamps
      const recentOp1 = new Operation({
        type: 'create',
        instances: { id: 'recent1', name: 'Recent 1', value: 1 } as TestItem,
        timestamp: currentTime - 60 * 1000 // 1 min ago
      });
      
      const recentOp2 = new Operation({
        type: 'update',
        instances: { id: 'recent2', name: 'Recent 2', value: 2 } as TestItem,
        timestamp: currentTime - 100 * 1000 // 100 seconds ago
      });
      
      const oldOp1 = new Operation({
        type: 'create',
        instances: { id: 'old1', name: 'Old 1', value: 3 } as TestItem,
        timestamp: currentTime - 121 * 1000 // Just over 2 mins
      });
      
      const oldOp2 = new Operation({
        type: 'update',
        instances: { id: 'old2', name: 'Old 2', value: 4 } as TestItem,
        timestamp: currentTime - 180 * 1000 // 3 mins ago
      });
      
      // Add operations to store
      store.addOperation(recentOp1);
      store.addOperation(recentOp2);
      store.addOperation(oldOp1);
      store.addOperation(oldOp2);
      expect(store.operations).toHaveLength(4);
      
      // Mock Date.now
      vi.spyOn(global.Date, 'now').mockReturnValue(currentTime);
      
      // Get trimmed operations
      const trimmedOps = store.getTrimmedOperations();
      
      // Restore Date.now
      vi.mocked(global.Date.now).mockRestore();
      
      // Verify only recent operations are kept
      expect(trimmedOps).toHaveLength(2);
      expect(trimmedOps.map(op => op.operationId)).toContain(recentOp1.operationId);
      expect(trimmedOps.map(op => op.operationId)).toContain(recentOp2.operationId);
      expect(trimmedOps.map(op => op.operationId)).not.toContain(oldOp1.operationId);
      expect(trimmedOps.map(op => op.operationId)).not.toContain(oldOp2.operationId);
    });
  });

  describe('Edge Cases', () => {
    it('should handle operations with multiple instances', () => {
      const createMultiple = new Operation({
        type: 'create',
        instances: [
          { id: 'multi1', name: 'Multi 1', value: 1 },
          { id: 'multi2', name: 'Multi 2', value: 2 }
        ] as TestItem[]
      });
      
      store.addOperation(createMultiple);
      
      const renderedPks = store.render();
      expect(renderedPks).toHaveLength(5); // 3 initial + 2 new
      expect(renderedPks).toContain('multi1');
      expect(renderedPks).toContain('multi2');
    });
    
    it('should handle delete followed by create with same ID', () => {
      // Delete operation
      const deleteOp = new Operation({
        type: 'delete',
        instances: { id: 'item1' } as TestItem
      });
      store.addOperation(deleteOp);
      
      // Create operation with same ID
      const createOp = new Operation({
        type: 'create',
        instances: { id: 'item1', name: 'New Item 1', value: 110 } as TestItem
      });
      store.addOperation(createOp);
      
      // The ID should exist in the rendered result
      const renderedPks = store.render();
      expect(renderedPks).toContain('item1');
    });
    
    it('should throw error for unknown operation type', () => {
      const invalidOp = new Operation({
        // @ts-ignore - Intentionally using invalid type
        type: 'invalid-type',
        instances: { id: 'test' } as TestItem
      });
      
      // Create a ground truth set for testing
      const groundTruth = new Set(['item1', 'item2']);
      
      // The call should throw an error
      expect(() => {
        store.applyOperation(invalidOp, groundTruth);
      }).toThrow('Unknown operation type');
    });
  });
});