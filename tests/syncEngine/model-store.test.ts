import { ModelStore } from '../../src/syncEngine/stores/modelStore.js';
import { Operation } from '../../src/syncEngine/stores/operation.js';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

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

// Test Model Class
class TestModel {
  static modelName = 'TestModel';
  static primaryKeyField = 'id';
}

// Helper to sort arrays for comparison
function sortById(a, b) {
  return a.id - b.id;
}

// Mock fetch function for testing
const mockFetch = vi.fn();

describe('ModelStore', () => {
  let modelStore;
  let simpleDb;
  
  beforeEach(() => {
    // Reset mocks
    mockFetch.mockReset();
    vi.useFakeTimers();
    
    // Initial data
    const initialData = [
      { id: 1, name: 'Item 1', value: 100 },
      { id: 2, name: 'Item 2', value: 200 },
      { id: 3, name: 'Item 3', value: 300 }
    ];
    
    // Initialize stores
    simpleDb = new SimpleDB(initialData, 'id');
    modelStore = new ModelStore(
      TestModel,
      mockFetch,
      [...initialData], // Initialize with same data
      []  // No operations initially
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Basic Operations', () => {
    test('should initialize correctly', () => {
      expect(modelStore.groundTruthArray.length).toBe(3);
      expect(modelStore.operations.length).toBe(0);
      expect(modelStore.render().length).toBe(3);
    });

    test('should render ground truth when no operations', () => {
      const rendered = modelStore.render().sort(sortById);
      const expected = simpleDb.getAll().sort(sortById);
      expect(rendered).toEqual(expected);
    });
  });

  describe('Create Operations', () => {
    test('should apply optimistic create operations to rendered data', () => {
      // Add new item to simpleDb
      const newItem = { id: 4, name: 'Item 4', value: 400 };
      simpleDb.create(newItem);
      
      // Add create operation to modelStore
      const createOp = new Operation({
        operationId: 'op-create-1',
        type: 'create',
        instances: [newItem],
        status: 'pending'
      });
      
      modelStore.addOperation(createOp);
      
      // Compare rendered results
      const rendered = modelStore.render().sort(sortById);
      const expected = simpleDb.getAll().sort(sortById);
      expect(rendered).toEqual(expected);
    });

    test('should handle create with duplicate id gracefully', () => {
      // Create operation with id that already exists in ground truth
      const duplicateItem = { id: 1, name: 'Updated Item 1', value: 1000 };
      
      // Add create operation to modelStore 
      const createOp = new Operation({
        operationId: 'op-create-dup',
        type: 'create',
        instances: [duplicateItem],
        status: 'pending'
      });
      
      modelStore.addOperation(createOp);
      
      // In ModelStore, create doesn't update existing items
      // The item should exist once with original values
      const rendered = modelStore.render();
      const item1 = rendered.find(x => x.id === 1);
      expect(item1.name).toBe('Item 1');
      expect(item1.value).toBe(100);
      expect(rendered.length).toBe(3); // Still only 3 items
    });
  });

  describe('Update Operations', () => {
    test('should apply optimistic update operations to rendered data', () => {
      // Update item in simpleDb
      const updateItem = { id: 2, name: 'Updated Item 2', value: 250 };
      simpleDb.update(updateItem);
      
      // Add update operation to modelStore
      const updateOp = new Operation({
        operationId: 'op-update-1',
        type: 'update',
        instances: [updateItem],
        status: 'pending'
      });
      
      modelStore.addOperation(updateOp);
      
      // Compare rendered results
      const rendered = modelStore.render().sort(sortById);
      const expected = simpleDb.getAll().sort(sortById);
      expect(rendered).toEqual(expected);
    });

    test('should handle partial updates correctly', () => {
      // Partial update in simpleDb
      const partialUpdate = { id: 3, value: 350 }; // Only update value
      simpleDb.update(partialUpdate);
      
      // Add update operation to modelStore
      const updateOp = new Operation({
        operationId: 'op-update-partial',
        type: 'update',
        instances: [partialUpdate],
        status: 'pending'
      });
      
      modelStore.addOperation(updateOp);
      
      // Compare rendered results
      const rendered = modelStore.render().sort(sortById);
      const expected = simpleDb.getAll().sort(sortById);
      expect(rendered).toEqual(expected);
      
      // Verify name is still there
      const updatedItem = rendered.find(x => x.id === 3);
      expect(updatedItem.name).toBe('Item 3');
      expect(updatedItem.value).toBe(350);
    });

    test('should handle update of non-existent item', () => {
      // Update non-existent item in simpleDb (acts like upsert)
      const nonExistentUpdate = { id: 5, name: 'New Item', value: 500 };
      simpleDb.update(nonExistentUpdate);
      
      // Add update operation to modelStore
      const updateOp = new Operation({
        operationId: 'op-update-nonexistent',
        type: 'update',
        instances: [nonExistentUpdate],
        status: 'pending'
      });
      
      modelStore.addOperation(updateOp);
      
      // Compare rendered results - the behavior should match
      const rendered = modelStore.render().sort(sortById);
      const expected = simpleDb.getAll().sort(sortById);
      expect(rendered).toEqual(expected);
    });
  });

  describe('Delete Operations', () => {
    test('should apply optimistic delete operations to rendered data', () => {
      // Delete item from simpleDb
      simpleDb.delete(2);
      
      // Add delete operation to modelStore
      const deleteOp = new Operation({
        operationId: 'op-delete-1',
        type: 'delete',
        instances: [{ id: 2 }],
        status: 'pending'
      });
      
      modelStore.addOperation(deleteOp);
      
      // Compare rendered results
      const rendered = modelStore.render().sort(sortById);
      const expected = simpleDb.getAll().sort(sortById);
      expect(rendered).toEqual(expected);
    });

    test('should handle delete of non-existent item gracefully', () => {
      // Delete non-existent item
      const initialCount = modelStore.render().length;
      
      // Add delete operation for non-existent item
      const deleteOp = new Operation({
        operationId: 'op-delete-nonexistent',
        type: 'delete',
        instances: [{ id: 999 }], // Non-existent ID
        status: 'pending'
      });
      
      modelStore.addOperation(deleteOp);
      
      // Should not affect anything
      expect(modelStore.render().length).toBe(initialCount);
    });
  });

  describe('Update or Create Operations', () => {
    test('should update existing items with update_or_create', () => {
      // Update item in simpleDb
      const updateItem = { id: 1, name: 'Upserted Item 1', value: 1100 };
      simpleDb.update(updateItem);
      
      // Add update_or_create operation to modelStore
      const upsertOp = new Operation({
        operationId: 'op-upsert-1',
        type: 'update_or_create',
        instances: [updateItem],
        status: 'pending'
      });
      
      modelStore.addOperation(upsertOp);
      
      // Compare rendered results
      const rendered = modelStore.render().sort(sortById);
      const expected = simpleDb.getAll().sort(sortById);
      expect(rendered).toEqual(expected);
    });

    test('should create new items with update_or_create if they don\'t exist', () => {
      // Create new item in simpleDb via update (upsert behavior)
      const newItem = { id: 5, name: 'Upserted New Item', value: 500 };
      simpleDb.update(newItem);
      
      // Add update_or_create operation to modelStore
      const upsertOp = new Operation({
        operationId: 'op-upsert-new',
        type: 'update_or_create',
        instances: [newItem],
        status: 'pending'
      });
      
      modelStore.addOperation(upsertOp);
      
      // Compare rendered results
      const rendered = modelStore.render().sort(sortById);
      const expected = simpleDb.getAll().sort(sortById);
      expect(rendered).toEqual(expected);
    });
  });

  describe('Get or Create Operations', () => {
    test('should retrieve existing items with get_or_create', () => {
      // Existing item
      const existingId = 2;
      
      // Add get_or_create operation to modelStore
      const getOrCreateOp = new Operation({
        operationId: 'op-get-or-create-existing',
        type: 'get_or_create',
        instances: [{ id: existingId, name: 'New Name', value: 250 }],
        status: 'pending'
      });
      
      modelStore.addOperation(getOrCreateOp);
      
      // The existing item should not be changed by get_or_create
      const rendered = modelStore.render();
      const item = rendered.find(x => x.id === existingId);
      expect(item.name).toBe('Item 2');
      expect(item.value).toBe(200);
    });

    test('should create new items with get_or_create if they don\'t exist', () => {
      // New item
      const newItem = { id: 5, name: 'Get or Create New', value: 500 };
      
      // Add get_or_create operation to modelStore
      const getOrCreateOp = new Operation({
        operationId: 'op-get-or-create-new',
        type: 'get_or_create',
        instances: [newItem],
        status: 'pending'
      });
      
      modelStore.addOperation(getOrCreateOp);
      simpleDb.create(newItem);
      
      // Compare rendered results
      const rendered = modelStore.render().sort(sortById);
      const expected = simpleDb.getAll().sort(sortById);
      expect(rendered).toEqual(expected);
    });
  });

  describe('Operation Status Management', () => {
    test('should respect confirmed operations', () => {
      const newItem = { id: 4, name: 'New Item', value: 400 };
      
      // Add create operation
      const createOp = new Operation({
        operationId: 'op-create-confirm',
        type: 'create',
        instances: [newItem],
        status: 'pending'
      });
      
      modelStore.addOperation(createOp);
      
      // Confirm the operation
      modelStore.confirm('op-create-confirm', [newItem]);
      
      // The item should still be in the rendered output
      const rendered = modelStore.render();
      expect(rendered.find(x => x.id === 4)).toEqual(newItem);
      
      // And the operation should be marked as confirmed
      const confirmedOp = modelStore.operations.find(op => op.operationId === 'op-create-confirm');
      expect(confirmedOp.status).toBe('confirmed');
    });

    test('should ignore rejected operations', () => {
      const newItem = { id: 4, name: 'Rejected Item', value: 400 };
      
      // Add create operation
      const createOp = new Operation({
        operationId: 'op-create-reject',
        type: 'create',
        instances: [newItem],
        status: 'pending'
      });
      
      modelStore.addOperation(createOp);
      
      // Initially, the new item should be in the rendered output
      expect(modelStore.render().find(x => x.id === 4)).toEqual(newItem);
      
      // Reject the operation
      modelStore.reject('op-create-reject');
      
      // After rejection, the item should no longer be in the rendered output
      expect(modelStore.render().find(x => x.id === 4)).toBeUndefined();
    });
  });

  describe('Operation Chaining', () => {
    test('should apply multiple operations in sequence', () => {
      // Simulate multiple operations happening in sequence
      
      // 1. Create a new item
      const newItem = { id: 4, name: 'New Item', value: 400 };
      simpleDb.create(newItem);
      modelStore.addOperation(new Operation({
        operationId: 'op-chain-1',
        type: 'create',
        instances: [newItem],
        status: 'pending'
      }));
      
      // 2. Update an existing item
      const updateItem = { id: 2, name: 'Updated in Chain', value: 250 };
      simpleDb.update(updateItem);
      modelStore.addOperation(new Operation({
        operationId: 'op-chain-2',
        type: 'update',
        instances: [updateItem],
        status: 'pending'
      }));
      
      // 3. Delete an item
      simpleDb.delete(3);
      modelStore.addOperation(new Operation({
        operationId: 'op-chain-3',
        type: 'delete',
        instances: [{ id: 3 }],
        status: 'pending'
      }));
      
      // Compare final state
      const rendered = modelStore.render().sort(sortById);
      const expected = simpleDb.getAll().sort(sortById);
      expect(rendered).toEqual(expected);
    });

    test('should handle conflicting operations correctly', () => {
      // Multiple operations on the same item
      
      // 1. Update an item
      const update1 = { id: 1, name: 'First Update', value: 150 };
      modelStore.addOperation(new Operation({
        operationId: 'op-conflict-1',
        type: 'update',
        instances: [update1],
        status: 'pending'
      }));
      
      // 2. Update same item again with different values
      const update2 = { id: 1, value: 175 }; // Update just the value
      modelStore.addOperation(new Operation({
        operationId: 'op-conflict-2',
        type: 'update',
        instances: [update2],
        status: 'pending'
      }));
      
      // Apply same updates to simpleDb
      simpleDb.update(update1);
      simpleDb.update(update2);
      
      // Final state should have name from first update, value from second
      const rendered = modelStore.render().sort(sortById);
      const expected = simpleDb.getAll().sort(sortById);
      expect(rendered).toEqual(expected);
      
      // Check specific fields
      const updatedItem = rendered.find(x => x.id === 1);
      expect(updatedItem.name).toBe('First Update'); // From first update
      expect(updatedItem.value).toBe(175); // From second update
    });

    test('should handle create-then-update operations', () => {
      // Create a new item
      const newItem = { id: 4, name: 'Brand New', value: 400 };
      modelStore.addOperation(new Operation({
        operationId: 'op-create-then-update-1',
        type: 'create',
        instances: [newItem],
        status: 'pending'
      }));
      
      // Then update it before it exists in ground truth
      const updateItem = { id: 4, name: 'Updated New Item', value: 450 };
      modelStore.addOperation(new Operation({
        operationId: 'op-create-then-update-2',
        type: 'update',
        instances: [updateItem],
        status: 'pending'
      }));
      
      // Apply same operations to simpleDb
      simpleDb.create(newItem);
      simpleDb.update(updateItem);
      
      // Compare final state
      const rendered = modelStore.render().sort(sortById);
      const expected = simpleDb.getAll().sort(sortById);
      expect(rendered).toEqual(expected);
    });

    test('should handle update-then-delete operations', () => {
      // Update an item
      const updateItem = { id: 2, name: 'About to Delete', value: 999 };
      modelStore.addOperation(new Operation({
        operationId: 'op-update-then-delete-1',
        type: 'update',
        instances: [updateItem],
        status: 'pending'
      }));
      
      // Then delete it
      modelStore.addOperation(new Operation({
        operationId: 'op-update-then-delete-2',
        type: 'delete',
        instances: [{ id: 2 }],
        status: 'pending'
      }));
      
      // Apply same operations to simpleDb
      simpleDb.update(updateItem);
      simpleDb.delete(2);
      
      // Compare final state
      const rendered = modelStore.render().sort(sortById);
      const expected = simpleDb.getAll().sort(sortById);
      expect(rendered).toEqual(expected);
      
      // Item 2 should not be in the result
      expect(rendered.find(x => x.id === 2)).toBeUndefined();
    });

    test('should handle delete-then-create operations (recreate scenario)', () => {
      // Delete an item
      modelStore.addOperation(new Operation({
        operationId: 'op-delete-then-create-1',
        type: 'delete',
        instances: [{ id: 3 }],
        status: 'pending'
      }));
      
      // Then recreate it with new data
      const recreatedItem = { id: 3, name: 'Recreated Item', value: 333 };
      modelStore.addOperation(new Operation({
        operationId: 'op-delete-then-create-2',
        type: 'create',
        instances: [recreatedItem],
        status: 'pending'
      }));
      
      // Apply same operations to simpleDb
      simpleDb.delete(3);
      simpleDb.create(recreatedItem);
      
      // Compare final state
      const rendered = modelStore.render().sort(sortById);
      const expected = simpleDb.getAll().sort(sortById);
      expect(rendered).toEqual(expected);
      
      // Recreated item should be in result with new values
      const recItem = rendered.find(x => x.id === 3);
      expect(recItem).toEqual(recreatedItem);
    });
  });

  describe('Sync Functionality', () => {
    test('should add ground truth from server during sync', async () => {
      // Setup mock fetch to return updated data
      const updatedServerData = [
        { id: 1, name: 'Server Updated 1', value: 150 },
        { id: 2, name: 'Server Updated 2', value: 250 },
        { id: 3, name: 'Server Updated 3', value: 350 }
      ];
      
      mockFetch.mockResolvedValue(updatedServerData);
      
      // Perform sync
      await modelStore.sync();
      
      // Ground truth should be updated
      const groundTruth = modelStore.groundTruthArray.sort(sortById);
      expect(groundTruth).toEqual(updatedServerData);
      
      // Rendered data should reflect the new ground truth
      const rendered = modelStore.render().sort(sortById);
      expect(rendered).toEqual(updatedServerData);
    });

    test('should trim operations older than 2 minutes during sync', async () => {
      // Create multiple operations with different timestamps
      const newOp1 = new Operation({
        operationId: 'op-recent-1',
        type: 'create',
        instances: [{ id: 4, name: 'Recent 1', value: 400 }],
        status: 'confirmed',
        timestamp: Date.now() // Current time
      });
      
      const newOp2 = new Operation({
        operationId: 'op-recent-2',
        type: 'update',
        instances: [{ id: 1, name: 'Recent Update', value: 150 }],
        status: 'confirmed',
        timestamp: Date.now() // Current time
      });
      
      const oldOp = new Operation({
        operationId: 'op-old',
        type: 'delete',
        instances: [{ id: 5 }],
        status: 'confirmed',
        timestamp: Date.now() - (1000 * 60 * 3) // 3 minutes ago (should be trimmed)
      });
      
      // Add all operations
      modelStore.addOperation(newOp1);
      modelStore.addOperation(newOp2);
      modelStore.addOperation(oldOp);
      
      expect(modelStore.operations.length).toBe(3);
      
      // Setup mock fetch
      mockFetch.mockResolvedValue([]);
      
      // Perform sync
      await modelStore.sync();
      
      // Old operation should be trimmed
      expect(modelStore.operations.length).toBe(2);
      expect(modelStore.operations.find(op => op.operationId === 'op-old')).toBeUndefined();
      expect(modelStore.operations.find(op => op.operationId === 'op-recent-1')).toBeDefined();
      expect(modelStore.operations.find(op => op.operationId === 'op-recent-2')).toBeDefined();
    });

    test('should handle errors during sync gracefully', async () => {
      // Setup mock fetch to throw an error
      mockFetch.mockRejectedValue(new Error('Network error'));
      
      // Store state before sync
      const beforeGroundTruth = [...modelStore.groundTruthArray];
      const beforeOpCount = modelStore.operations.length;
      
      // Attempt sync
      await modelStore.sync();
      
      // Should not have changed ground truth on error
      expect(modelStore.groundTruthArray).toEqual(beforeGroundTruth);
      expect(modelStore.operations.length).toBe(beforeOpCount);
      expect(modelStore.isSyncing).toBe(false); // Should reset syncing flag
    });

    test('should ignore duplicate sync requests', async () => {
      // Set syncing flag manually
      modelStore.isSyncing = true;
      
      // Setup mock
      mockFetch.mockResolvedValue([]);
      
      // Attempt sync
      await modelStore.sync();
      
      // Should not have called fetch
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('should skip fetch when no ground truth PKs exist', async () => {
      // Empty the ground truth
      modelStore.setGroundTruth([]);
      
      // Setup mock
      mockFetch.mockResolvedValue([]);
      
      // Perform sync
      await modelStore.sync();
      
      // Should not have called fetch
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('Filtered Rendering', () => {
    test('should render only specific PKs when filtered', () => {
      // Render only items with IDs 1 and 3
      const filtered = modelStore.render(new Set([1, 3])).sort(sortById);
      
      // Should only have 2 items
      expect(filtered.length).toBe(2);
      expect(filtered[0].id).toBe(1);
      expect(filtered[1].id).toBe(3);
    });

    test('should apply operations to filtered PKs only', () => {
      // Add operations affecting all items
      modelStore.addOperation(new Operation({
        operationId: 'op-filter-1',
        type: 'update',
        instances: [
          { id: 1, value: 111 },
          { id: 2, value: 222 },
          { id: 3, value: 333 }
        ],
        status: 'pending'
      }));
      
      // Render only subset
      const filtered = modelStore.render(new Set([1, 3]));
      
      // Should only contain the filtered items with updates
      expect(filtered.length).toBe(2);
      expect(filtered.find(x => x.id === 1).value).toBe(111);
      expect(filtered.find(x => x.id === 3).value).toBe(333);
      expect(filtered.find(x => x.id === 2)).toBeUndefined();
    });
  });

  describe('Operation Updating', () => {
    test('should update existing operation', () => {
      // Add initial operation
      const createOp = new Operation({
        operationId: 'op-to-update',
        type: 'create',
        instances: [{ id: 4, name: 'Initial', value: 400 }],
        status: 'pending'
      });
      
      modelStore.addOperation(createOp);
      
      // Update the operation
      const updatedOp = new Operation({
        operationId: 'op-to-update',
        type: 'create', 
        instances: [{ id: 4, name: 'Updated', value: 450 }],
        status: 'pending'
      });
      
      const result = modelStore.updateOperation(updatedOp);
      
      // Should return true for successful update
      expect(result).toBe(true);
      
      // Operation should be updated in the store
      const updatedOperation = modelStore.operations.find(op => op.operationId === 'op-to-update');
      expect(updatedOperation.instances[0].name).toBe('Updated');
      expect(updatedOperation.instances[0].value).toBe(450);
    });
    
    test('should return false when updating non-existent operation', () => {
      // Try to update an operation that doesn't exist
      const nonExistentOp = new Operation({
        operationId: 'non-existent-op',
        type: 'update',
        instances: [{ id: 1, name: 'Shouldn\'t Exist', value: 999 }],
        status: 'pending'
      });
      
      const result = modelStore.updateOperation(nonExistentOp);
      
      // Should return false for failed update
      expect(result).toBe(false);
      
      // Store operations should remain unchanged
      expect(modelStore.operations.find(op => op.operationId === 'non-existent-op')).toBeUndefined();
    });
  });

  describe('Edge Cases', () => {
    test('should handle instances without primary key', () => {
      // Add invalid instances to operations
      modelStore.addOperation(new Operation({
        operationId: 'op-invalid',
        type: 'create',
        instances: [
          { name: 'No ID', value: 999 }, // Missing ID
          null, // Null instance
          { id: 5, name: 'Valid', value: 500 } // Valid instance
        ],
        status: 'pending'
      }));
      
      // Should only process the valid instance
      const rendered = modelStore.render();
      expect(rendered.find(x => x.id === 5)).toBeDefined();
      expect(rendered.find(x => x.name === 'No ID')).toBeUndefined();
    });

    test('should handle empty operations array', () => {
      modelStore.addOperation(new Operation({
        operationId: 'op-empty',
        type: 'create',
        instances: [], // Empty instances array
        status: 'pending'
      }));
      
      // Should not affect rendering
      expect(modelStore.render().length).toBe(3);
    });

    test('should handle unknown operation types', () => {
      // Add operation with unknown type
      modelStore.addOperation(new Operation({
        operationId: 'op-unknown',
        type: 'not_a_real_type',
        instances: [{ id: 5, name: 'Unknown Op', value: 500 }],
        status: 'pending'
      }));
      
      // Should not affect rendering (unknown op type is ignored)
      expect(modelStore.render().find(x => x.id === 5)).toBeUndefined();
    });
    
    test('should handle missing or invalid instance in addToGroundTruth', () => {
      // Try to add invalid instances to ground truth
      modelStore.addToGroundTruth([
        null,
        "not an object",
        { name: 'Missing ID' }, // No ID
        { id: 4, name: 'Valid', value: 400 } // Valid instance
      ]);
      
      // Should only add the valid instance
      expect(modelStore.groundTruthArray.length).toBe(4);
      expect(modelStore.groundTruthArray.find(x => x.id === 4)).toBeDefined();
    });
    
    test('should handle setting invalid ground truth', () => {
      // Set invalid ground truth
      modelStore.setGroundTruth("not an array");
      
      // Should convert to empty array
      expect(Array.isArray(modelStore.groundTruthArray)).toBe(true);
      expect(modelStore.groundTruthArray.length).toBe(0);
    });
    
    test('should handle setting invalid operations', () => {
      // Set invalid operations
      modelStore.setOperations("not an array");
      
      // Should convert to empty array
      expect(Array.isArray(modelStore.operations)).toBe(true);
      expect(modelStore.operations.length).toBe(0);
    });
  });
  
  describe('Ground Truth Management', () => {
    test('should correctly extract primary keys from ground truth', () => {
      // Add some items with and without primary keys
      modelStore.setGroundTruth([
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
        { name: 'No ID' }, // No primary key
        null, // null item
        { id: 3, name: 'Item 3' }
      ]);
      
      // Should only return PKs for valid items
      const pks = modelStore.groundTruthPks;
      expect(pks.length).toBe(3);
      expect(pks).toContain(1);
      expect(pks).toContain(2);
      expect(pks).toContain(3);
    });
    
    test('should properly merge updates when adding to ground truth', () => {
      // Initial state has items 1, 2, and 3
      
      // Add updates for item 2 and a new item 4
      modelStore.addToGroundTruth([
        { id: 2, name: 'Updated Item 2', value: 250 },
        { id: 4, name: 'New Item', value: 400 }
      ]);
      
      // Ground truth should now have 4 items
      expect(modelStore.groundTruthArray.length).toBe(4);
      
      // Item 2 should be updated
      const item2 = modelStore.groundTruthArray.find(x => x.id === 2);
      expect(item2.name).toBe('Updated Item 2');
      expect(item2.value).toBe(250);
      
      // Item 4 should be added
      const item4 = modelStore.groundTruthArray.find(x => x.id === 4);
      expect(item4).toBeDefined();
      expect(item4.name).toBe('New Item');
    });
  });
  
  describe('Complex Scenarios', () => {
    test('should handle a full lifecycle of operations and sync', async () => {
      // 1. Create some local changes
      modelStore.addOperation(new Operation({
        operationId: 'op-lifecycle-1',
        type: 'create',
        instances: [{ id: 4, name: 'Lifecycle Test', value: 400 }],
        status: 'pending'
      }));
      
      modelStore.addOperation(new Operation({
        operationId: 'op-lifecycle-2',
        type: 'update',
        instances: [{ id: 1, name: 'Updated in Lifecycle', value: 150 }],
        status: 'pending'
      }));
      
      // 2. Simulate server confirmation for the first operation
      modelStore.confirm('op-lifecycle-1', [{ id: 4, name: 'Lifecycle Test', value: 400 }]);
      
      // 3. Setup mock server response for sync
      // This simulates the server having the confirmed item 4, but not yet having the update to item 1
      mockFetch.mockResolvedValue([
        { id: 1, name: 'Item 1', value: 100 }, // Original value from server
        { id: 2, name: 'Item 2', value: 200 },
        { id: 3, name: 'Item 3', value: 300 },
        { id: 4, name: 'Lifecycle Test', value: 400 } // Confirmed item
      ]);
      
      // 4. Perform sync
      await modelStore.sync();
      
      // 5. Check final state
      const rendered = modelStore.render().sort(sortById);
      
      // Should have 4 items total
      expect(rendered.length).toBe(4);
      
      // Item 1 should still have the optimistic update, not the server value
      expect(rendered.find(x => x.id === 1).name).toBe('Updated in Lifecycle');
      
      // Item 4 should exist from both ground truth and the confirmed operation
      expect(rendered.find(x => x.id === 4).name).toBe('Lifecycle Test');
      
      // Operations should still include the pending update to item 1
      expect(modelStore.operations.some(op => 
        op.operationId === 'op-lifecycle-2' && op.status === 'pending'
      )).toBe(true);
    });
    
    test('should handle conflict between optimistic update and server update', async () => {
      // 1. Optimistically update item 2
      modelStore.addOperation(new Operation({
        operationId: 'op-conflict-server',
        type: 'update',
        instances: [{ id: 2, name: 'Optimistic Update', value: 250 }],
        status: 'pending' 
      }));
      
      // 2. Setup mock server response with different update to the same item
      mockFetch.mockResolvedValue([
        { id: 1, name: 'Item 1', value: 100 },
        { id: 2, name: 'Server Update', value: 275 }, // Server has different update
        { id: 3, name: 'Item 3', value: 300 }
      ]);
      
      // 3. Perform sync
      await modelStore.sync();
      
      // 4. Check result - optimistic update should win for rendering
      const rendered = modelStore.render();
      const item2 = rendered.find(x => x.id === 2);
      
      // Name from optimistic update
      expect(item2.name).toBe('Optimistic Update');
      // Value from optimistic update
      expect(item2.value).toBe(250);
      
      // But ground truth should be updated with server values
      const groundTruthItem = modelStore.groundTruthArray.find(x => x.id === 2);
      expect(groundTruthItem.name).toBe('Server Update');
      expect(groundTruthItem.value).toBe(275);
    });
  });
});