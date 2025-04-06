import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ModelStore, Operation, OperationType } from '../../src/syncEngine/stores/ModelStore';
import { IndexedDBStorage } from '../../src/syncEngine/persistence/IndexedDBStorage';
import { deleteDB } from 'idb';

// Simple in-memory database for comparison
class SimpleDB {
  constructor(initialData = [], pkField = 'id') {
    this.data = JSON.parse(JSON.stringify(initialData));
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
      } else {
        // Add upsert behavior to match ModelStore behavior
        this.data.push({...update});
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

// Test data interface
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

describe('ModelStore Helper Methods', () => {
  let store: ModelStore<TestItem>;
  let modelClass = TestModelClass;
  let storage: IndexedDBStorage;
  let simpleDb: SimpleDB;
  let fetchMock: vi.Mock;
  let storeKey: string;
  const TEST_DB_NAME = 'test_modelsync_helpers';
  
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
    storeKey = `modelstore::${TestModelClass.modelName}::${TestModelClass.configKey}`;
    
    // Create a real IndexedDBStorage instance
    storage = new IndexedDBStorage({
      dbName: TEST_DB_NAME,
      storeName: 'test_store',
      version: 1
    });
    
    // Initialize model store with real storage
    store = new ModelStore<TestItem>(TestModelClass, fetchMock, storage);
    
    // Initialize SimpleDB with the same data
    simpleDb = new SimpleDB(initialData, 'id');

    // Set the ground truth
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

  // Tests for the confirm helper method
  describe('confirm method', () => {
    it('should change the status of an operation to confirmed', async () => {
      // Create an operation
      const operation = new Operation<TestItem>({
        type: 'create',
        instances: { id: 'item4', name: 'Item 4', value: 400 }
      });
      
      // Add the operation to the store
      store.addOperation(operation);
      
      // Confirm the operation
      store.confirm(operation.operationId, [{ id: 'item4', name: 'Confirmed Item 4', value: 450 }]);
      
      // Wait for IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Verify the operation was confirmed
      const updatedOp = store.operations.find(op => op.operationId === operation.operationId);
      expect(updatedOp).toBeDefined();
      expect(updatedOp?.status).toBe('confirmed');
      
      // Verify the instances were updated
      expect(updatedOp?.instances[0].name).toBe('Confirmed Item 4');
      expect(updatedOp?.instances[0].value).toBe(450);
    });

    it('should confirm operations with multiple instances', async () => {
      // Create an operation with multiple instances
      const operation = new Operation<TestItem>({
        type: 'create',
        instances: [
          { id: 'batch1', name: 'Batch Item 1', value: 100 },
          { id: 'batch2', name: 'Batch Item 2', value: 200 }
        ]
      });
      
      // Add the operation to the store
      store.addOperation(operation);
      
      // Confirm the operation with modified instances
      store.confirm(operation.operationId, [
        { id: 'batch1', name: 'Confirmed Batch 1', value: 150 },
        { id: 'batch2', name: 'Confirmed Batch 2', value: 250 }
      ]);
      
      // Wait for IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Verify the operation was confirmed
      const updatedOp = store.operations.find(op => op.operationId === operation.operationId);
      expect(updatedOp).toBeDefined();
      expect(updatedOp?.status).toBe('confirmed');
      
      // Verify all instances were updated
      expect(updatedOp?.instances).toHaveLength(2);
      expect(updatedOp?.instances[0].name).toBe('Confirmed Batch 1');
      expect(updatedOp?.instances[0].value).toBe(150);
      expect(updatedOp?.instances[1].name).toBe('Confirmed Batch 2');
      expect(updatedOp?.instances[1].value).toBe(250);
    });

    it('should update the timestamp when confirming an operation', async () => {
      // Mock Date.now() to return a fixed timestamp
      const originalDateNow = Date.now;
      const initialTime = 1000000;
      const confirmTime = 2000000;
      
      try {
        // Set initial time
        global.Date.now = vi.fn(() => initialTime);
        
        // Create an operation
        const operation = new Operation<TestItem>({
          type: 'update',
          instances: { id: 'item1', name: 'Updated Item 1' }
        });
        
        // Add the operation to the store
        store.addOperation(operation);
        
        // Change the mock time
        global.Date.now = vi.fn(() => confirmTime);
        
        // Confirm the operation
        store.confirm(operation.operationId, [{ id: 'item1', name: 'Confirmed Update' }]);
        
        // Wait for IndexedDB operations to complete
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Verify the timestamp was updated
        const updatedOp = store.operations.find(op => op.operationId === operation.operationId);
        expect(updatedOp?.timestamp).toBe(confirmTime);
      } finally {
        // Restore original Date.now
        global.Date.now = originalDateNow;
      }
    });

    it('should do nothing when confirming a non-existent operation', async () => {
      // Initial operations count
      const initialOpsCount = store.operations.length;
      
      // Try to confirm a non-existent operation
      store.confirm('non-existent-id', [{ id: 'fake', name: 'Fake Item', value: 999 }]);
      
      // Wait for IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Verify operations were not changed
      expect(store.operations.length).toBe(initialOpsCount);
    });
  });

  // Tests for the reject helper method
  describe('reject method', () => {
    it('should change the status of an operation to rejected', async () => {
      // Create an operation
      const operation = new Operation<TestItem>({
        type: 'create',
        instances: { id: 'item4', name: 'Item 4', value: 400 }
      });
      
      // Add the operation to the store
      store.addOperation(operation);
      
      // Reject the operation
      store.reject(operation.operationId, [{ id: 'item4', name: 'Rejected Item 4', value: 450 }]);
      
      // Wait for IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Verify the operation was rejected
      const updatedOp = store.operations.find(op => op.operationId === operation.operationId);
      expect(updatedOp).toBeDefined();
      expect(updatedOp?.status).toBe('rejected');
    });

    it('should exclude rejected operations from render results', async () => {
      // Create an operation
      const operation = new Operation<TestItem>({
        type: 'create',
        instances: { id: 'reject-test', name: 'Should Not Appear', value: 999 }
      });
      
      // Add the operation to the store
      store.addOperation(operation);
      
      // Add to SimpleDB for verification
      simpleDb.create({ id: 'reject-test', name: 'Should Not Appear', value: 999 });
      
      // Get the data with the operation applied (before rejection)
      const beforeReject = store.render().sort(sortById);
      expect(beforeReject.find(item => item.id === 'reject-test')).toBeDefined();
      
      // Reject the operation
      store.reject(operation.operationId, [{ id: 'reject-test', name: 'Rejected', value: 999 }]);
      
      // Remove from SimpleDB for comparison
      simpleDb.delete('reject-test');
      
      // Wait for IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Verify rejected operations don't appear in rendered results
      const afterReject = store.render().sort(sortById);
      const simpleDbData = simpleDb.getAll(sortById);
      
      expect(afterReject).toEqual(simpleDbData);
      expect(afterReject.find(item => item.id === 'reject-test')).toBeUndefined();
    });

    it('should reject operations with multiple instances', async () => {
      // Create an operation with multiple instances
      const operation = new Operation<TestItem>({
        type: 'create',
        instances: [
          { id: 'batch1', name: 'Batch Item 1', value: 100 },
          { id: 'batch2', name: 'Batch Item 2', value: 200 }
        ]
      });
      
      // Add the operation to the store
      store.addOperation(operation);
      
      // Reject the operation
      store.reject(operation.operationId, [
        { id: 'batch1', name: 'Rejected Batch 1', value: 150 },
        { id: 'batch2', name: 'Rejected Batch 2', value: 250 }
      ]);
      
      // Wait for IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Verify the operation was rejected
      const updatedOp = store.operations.find(op => op.operationId === operation.operationId);
      expect(updatedOp).toBeDefined();
      expect(updatedOp?.status).toBe('rejected');
      
      // Verify rejected operations don't appear in rendered results
      const renderedData = store.render().sort(sortById);
      expect(renderedData.find(item => item.id === 'batch1')).toBeUndefined();
      expect(renderedData.find(item => item.id === 'batch2')).toBeUndefined();
    });

    it('should update the timestamp when rejecting an operation', async () => {
      // Mock Date.now() to return a fixed timestamp
      const originalDateNow = Date.now;
      const initialTime = 1000000;
      const rejectTime = 3000000;
      
      try {
        // Set initial time
        global.Date.now = vi.fn(() => initialTime);
        
        // Create an operation
        const operation = new Operation<TestItem>({
          type: 'delete',
          instances: { id: 'item1' }
        });
        
        // Add the operation to the store
        store.addOperation(operation);
        
        // Change the mock time
        global.Date.now = vi.fn(() => rejectTime);
        
        // Reject the operation
        store.reject(operation.operationId, [{ id: 'item1' }]);
        
        // Wait for IndexedDB operations to complete
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Verify the timestamp was updated
        const updatedOp = store.operations.find(op => op.operationId === operation.operationId);
        expect(updatedOp?.timestamp).toBe(rejectTime);
      } finally {
        // Restore original Date.now
        global.Date.now = originalDateNow;
      }
    });

    it('should do nothing when rejecting a non-existent operation', async () => {
      // Initial operations count
      const initialOpsCount = store.operations.length;
      
      // Try to reject a non-existent operation
      store.reject('non-existent-id', [{ id: 'fake', name: 'Fake Item', value: 999 }]);
      
      // Wait for IndexedDB operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Verify operations were not changed
      expect(store.operations.length).toBe(initialOpsCount);
    });
  });
});

describe('ModelStore Multiple Instances Operations', () => {
  let store: ModelStore<TestItem>;
  let modelClass = TestModelClass;
  let storage: IndexedDBStorage;
  let simpleDb: SimpleDB;
  let fetchMock: vi.Mock;
  const TEST_DB_NAME = 'test_modelsync_multiple';
  
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
    
    // Create a real IndexedDBStorage instance
    storage = new IndexedDBStorage({
      dbName: TEST_DB_NAME,
      storeName: 'test_store',
      version: 1
    });
    
    // Initialize model store with real storage
    store = new ModelStore<TestItem>(TestModelClass, fetchMock, storage);
    
    // Initialize SimpleDB with the same data
    simpleDb = new SimpleDB(initialData, 'id');

    // Set the ground truth
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

  describe('Multiple Instance Operations', () => {
    it('should handle a complex sequence of multi-instance operations', async () => {
      // 1. Create multiple items
      const createBatch = [
        { id: 'multi1', name: 'Multi Item 1', value: 100 },
        { id: 'multi2', name: 'Multi Item 2', value: 200 },
        { id: 'multi3', name: 'Multi Item 3', value: 300 }
      ];
      
      store.addOperation(new Operation({
        type: 'create',
        instances: createBatch
      }));
      
      simpleDb.create(createBatch);
      
      // Verify initial creation worked
      let renderedData = store.render().sort(sortById);
      let simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.length).toBe(6); // 3 original + 3 new
      
      // 2. Update multiple items, including one created in previous step
      const updateBatch = [
        { id: 'item1', name: 'Updated Original 1', value: 150 },
        { id: 'multi2', name: 'Updated Multi 2', value: 250 },
        { id: 'non-existent', name: 'Should Be Created', value: 999 } // This should create a new item
      ];
      
      store.addOperation(new Operation({
        type: 'update',
        instances: updateBatch
      }));
      
      simpleDb.update(updateBatch);
      
      // Verify updates worked
      renderedData = store.render().sort(sortById);
      simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.length).toBe(7); // 6 existing + 1 upserted
      expect(renderedData.find(item => item.id === 'item1')?.name).toBe('Updated Original 1');
      expect(renderedData.find(item => item.id === 'multi2')?.name).toBe('Updated Multi 2');
      expect(renderedData.find(item => item.id === 'non-existent')?.name).toBe('Should Be Created');
      
      // 3. Delete multiple items in a single operation
      const deleteBatch = [
        { id: 'multi1' },
        { id: 'multi3' },
        { id: 'item2' }
      ];
      
      store.addOperation(new Operation({
        type: 'delete',
        instances: deleteBatch
      }));
      
      simpleDb.delete(['multi1', 'multi3', 'item2']);
      
      // Verify deletes worked
      renderedData = store.render().sort(sortById);
      simpleDbData = simpleDb.getAll(sortById);
      
      expect(renderedData).toEqual(simpleDbData);
      expect(renderedData.length).toBe(4);
      expect(renderedData.find(item => item.id === 'multi1')).toBeUndefined();
      expect(renderedData.find(item => item.id === 'multi3')).toBeUndefined();
      expect(renderedData.find(item => item.id === 'item2')).toBeUndefined();
    });

    it('should filter ground truth and operations by primary keys', async () => {
      // Create a diverse set of operations
      const operations = [
        new Operation({
          type: 'create',
          instances: [
            { id: 'filter1', name: 'Filter Item 1', value: 100 },
            { id: 'filter2', name: 'Filter Item 2', value: 200 }
          ]
        }),
        new Operation({
          type: 'update',
          instances: [
            { id: 'item1', name: 'Updated Filter Item' },
            { id: 'filter1', value: 150 }
          ]
        }),
        new Operation({
          type: 'delete',
          instances: [
            { id: 'item2' },
            { id: 'filter2' }
          ]
        })
      ];
      
      // Add all operations to the store
      operations.forEach(op => store.addOperation(op));
      
      // Set up a filter for only specific items
      const filterPks = new Set(['item1', 'filter1']);
      
      // Render with the filter
      const filteredData = store.render(filterPks);
      
      // Verify only filtered items are included
      expect(filteredData.length).toBe(2);
      expect(filteredData.find(item => item.id === 'item1')).toBeDefined();
      expect(filteredData.find(item => item.id === 'filter1')).toBeDefined();
      expect(filteredData.find(item => item.id === 'item2')).toBeUndefined();
      expect(filteredData.find(item => item.id === 'filter2')).toBeUndefined();
      
      // Verify the filtered items have operations applied
      expect(filteredData.find(item => item.id === 'item1')?.name).toBe('Updated Filter Item');
      expect(filteredData.find(item => item.id === 'filter1')?.value).toBe(150);
    });

    it('should correctly apply operations based on their status', async () => {
      // 1. Create a multi-instance operation
      const createOp = new Operation({
        type: 'create',
        instances: [
          { id: 'status1', name: 'Status Item 1', value: 100 },
          { id: 'status2', name: 'Status Item 2', value: 200 },
          { id: 'status3', name: 'Status Item 3', value: 300 }
        ]
      });
      
      store.addOperation(createOp);
      
      // 2. Confirm the create operation (changes all instances inside)
      store.confirm(createOp.operationId, [
        { id: 'status1', name: 'Confirmed Status 1', value: 101 },
        { id: 'status2', name: 'Confirmed Status 2', value: 202 },
        { id: 'status3', name: 'Confirmed Status 3', value: 303 }
      ]);
      
      // 3. Create an update operation
      const updateOp = new Operation({
        type: 'update',
        instances: [
          { id: 'status1', value: 150 },
          { id: 'status2', value: 250 },
          { id: 'status3', value: 350 }
        ]
      });
      
      store.addOperation(updateOp);
      
      // 4. Reject this update operation
      store.reject(updateOp.operationId, updateOp.instances);
      
      // Verify the final state
      const renderedData = store.render();
      const status1 = renderedData.find(item => item.id === 'status1');
      const status2 = renderedData.find(item => item.id === 'status2');
      const status3 = renderedData.find(item => item.id === 'status3');
      
      // All items should be from the confirmed create operation, not the rejected update
      expect(status1?.name).toBe('Confirmed Status 1');
      expect(status1?.value).toBe(101); // Not 150 since update was rejected
      
      expect(status2?.name).toBe('Confirmed Status 2');
      expect(status2?.value).toBe(202); // Not 250 since update was rejected
      
      expect(status3?.name).toBe('Confirmed Status 3');
      expect(status3?.value).toBe(303); // Not 350 since update was rejected
    });

    it('should handle targeted partial updates in multi-instance operations', async () => {
      // Create a batch of items first
      const createBatch = [
        { id: 'partial1', name: 'Partial Item 1', value: 100, lastUpdated: 1000 },
        { id: 'partial2', name: 'Partial Item 2', value: 200, lastUpdated: 1000 },
        { id: 'partial3', name: 'Partial Item 3', value: 300, lastUpdated: 1000 }
      ];
      
      store.addOperation(new Operation({
        type: 'create',
        instances: createBatch
      }));
      
      simpleDb.create(createBatch);
      
      // Now do a partial update that only changes certain fields
      const partialUpdate = [
        { id: 'partial1', value: 150 }, // Only update value
        { id: 'partial2', name: 'Updated Partial 2' }, // Only update name
        { id: 'partial3', lastUpdated: 2000 } // Only update timestamp
      ];
      
      store.addOperation(new Operation({
        type: 'update',
        instances: partialUpdate
      }));
      
      simpleDb.update(partialUpdate);
      
      // Verify partial updates worked correctly
      const renderedData = store.render();
      
      const item1 = renderedData.find(item => item.id === 'partial1');
      expect(item1?.name).toBe('Partial Item 1'); // Unchanged
      expect(item1?.value).toBe(150); // Updated
      expect(item1?.lastUpdated).toBe(1000); // Unchanged
      
      const item2 = renderedData.find(item => item.id === 'partial2');
      expect(item2?.name).toBe('Updated Partial 2'); // Updated
      expect(item2?.value).toBe(200); // Unchanged
      expect(item2?.lastUpdated).toBe(1000); // Unchanged
      
      const item3 = renderedData.find(item => item.id === 'partial3');
      expect(item3?.name).toBe('Partial Item 3'); // Unchanged
      expect(item3?.value).toBe(300); // Unchanged
      expect(item3?.lastUpdated).toBe(2000); // Updated
    });
  });
});