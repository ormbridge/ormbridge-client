import { QuerysetStore } from '../../src/syncEngine/stores/querysetStore.js';
import { Operation } from '../../src/syncEngine/stores/operation.js';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// Simple in-memory database for comparison
class SimpleQuerySet {
  constructor(initialPks = [], pkField = 'id') {
    this.pks = new Set(initialPks);
    this.pkField = pkField;
  }

  create(items) {
    const newItems = Array.isArray(items) ? items : [items];
    newItems.forEach(item => {
      if (item && typeof item === 'object' && this.pkField in item) {
        this.pks.add(item[this.pkField]);
      }
    });
  }

  update(items) {
    // In a queryset, update doesn't matter for items already in the set
    // But for items not in the set, it acts like create (unless deleted)
    const updates = Array.isArray(items) ? items : [items];
    updates.forEach(update => {
      if (update && typeof update === 'object' && this.pkField in update) {
        this.pks.add(update[this.pkField]);
      }
    });
  }

  delete(ids) {
    const toDelete = Array.isArray(ids) ? ids : [ids];
    toDelete.forEach(id => {
      this.pks.delete(id);
    });
  }

  getAll() {
    return Array.from(this.pks);
  }
}

// Test Model Class
class TestModel {
  static modelName = 'TestModel';
  static primaryKeyField = 'id';
}

// Helper to sort arrays for comparison
function sortNumerically(a, b) {
  return a - b;
}

// Mock fetch function for testing
const mockFetch = vi.fn();

describe('QuerysetStore', () => {
  let querysetStore;
  let simpleQuerySet;
  const testAst = { type: 'query', conditions: [] }; // Sample query AST
  
  beforeEach(() => {
    // Reset mocks
    mockFetch.mockReset();
    vi.useFakeTimers();
    
    // Initial data
    const initialPks = [1, 2, 3];
    
    // Initialize stores
    simpleQuerySet = new SimpleQuerySet(initialPks, 'id');
    querysetStore = new QuerysetStore(
      TestModel,
      mockFetch,
      testAst,
      [...initialPks], // Initialize with same PKs
      []  // No operations initially
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Basic Operations', () => {
    test('should initialize correctly', () => {
      expect(querysetStore.groundTruthPks.length).toBe(3);
      expect(querysetStore.operations.length).toBe(0);
      expect(querysetStore.render().length).toBe(3);
    });

    test('should render ground truth when no operations', () => {
      const rendered = querysetStore.render().sort(sortNumerically);
      const expected = simpleQuerySet.getAll().sort(sortNumerically);
      expect(rendered).toEqual(expected);
    });
  });

  describe('Create Operations', () => {
    test('should apply optimistic create operations to rendered data', () => {
      // Add new item to simpleQuerySet
      const newItem = { id: 4, name: 'Item 4', value: 400 };
      simpleQuerySet.create(newItem);
      
      // Add create operation to querysetStore
      const createOp = new Operation({
        operationId: 'op-create-1',
        type: 'create',
        instances: [newItem],
        status: 'pending'
      });
      
      querysetStore.addOperation(createOp);
      
      // Compare rendered results
      const rendered = querysetStore.render().sort(sortNumerically);
      const expected = simpleQuerySet.getAll().sort(sortNumerically);
      expect(rendered).toEqual(expected);
    });

    test('should handle create with existing id', () => {
      // Create operation with id that already exists in ground truth
      const duplicateItem = { id: 1, name: 'Updated Item 1', value: 1000 };
      
      // Add create operation to querysetStore 
      const createOp = new Operation({
        operationId: 'op-create-dup',
        type: 'create',
        instances: [duplicateItem],
        status: 'pending'
      });
      
      querysetStore.addOperation(createOp);
      
      // For QuerysetStore, the ID should only be included once
      // (unlike ModelStore where we'd want to track the object itself)
      const rendered = querysetStore.render();
      expect(rendered.length).toBe(3); // Still only 3 IDs
      expect(rendered.includes(1)).toBe(true);
    });
  });

  describe('Update Operations', () => {
    test('should add items to queryset for optimistic update of new items', () => {
      // Update item not in queryset
      const updateNewItem = { id: 4, name: 'New Item', value: 400 };
      simpleQuerySet.update(updateNewItem);
      
      // Add update operation to querysetStore
      const updateOp = new Operation({
        operationId: 'op-update-new',
        type: 'update',
        instances: [updateNewItem],
        status: 'pending'
      });
      
      querysetStore.addOperation(updateOp);
      
      // Compare rendered results
      const rendered = querysetStore.render().sort(sortNumerically);
      const expected = simpleQuerySet.getAll().sort(sortNumerically);
      expect(rendered).toEqual(expected);
      expect(rendered.includes(4)).toBe(true);
    });

    test('should keep existing items in queryset for optimistic update', () => {
      // Update existing item
      const updateExistingItem = { id: 2, name: 'Updated Item', value: 250 };
      simpleQuerySet.update(updateExistingItem);
      
      // Add update operation to querysetStore
      const updateOp = new Operation({
        operationId: 'op-update-existing',
        type: 'update',
        instances: [updateExistingItem],
        status: 'pending'
      });
      
      querysetStore.addOperation(updateOp);
      
      // Compare rendered results
      const rendered = querysetStore.render().sort(sortNumerically);
      const expected = simpleQuerySet.getAll().sort(sortNumerically);
      expect(rendered).toEqual(expected);
      expect(rendered.includes(2)).toBe(true);
    });
  });

  describe('Delete Operations', () => {
    test('should apply optimistic delete operations to rendered data', () => {
      // Delete item from simpleQuerySet
      simpleQuerySet.delete(2);
      
      // Add delete operation to querysetStore
      const deleteOp = new Operation({
        operationId: 'op-delete-1',
        type: 'delete',
        instances: [{ id: 2 }],
        status: 'pending'
      });
      
      querysetStore.addOperation(deleteOp);
      
      // Compare rendered results
      const rendered = querysetStore.render().sort(sortNumerically);
      const expected = simpleQuerySet.getAll().sort(sortNumerically);
      expect(rendered).toEqual(expected);
      expect(rendered.includes(2)).toBe(false);
    });

    test('should handle delete of non-existent item gracefully', () => {
      // Delete non-existent item
      const initialCount = querysetStore.render().length;
      
      // Add delete operation for non-existent item
      const deleteOp = new Operation({
        operationId: 'op-delete-nonexistent',
        type: 'delete',
        instances: [{ id: 999 }], // Non-existent ID
        status: 'pending'
      });
      
      querysetStore.addOperation(deleteOp);
      
      // Should not affect anything
      expect(querysetStore.render().length).toBe(initialCount);
    });
  });

  describe('Update or Create Operations', () => {
    test('should handle update_or_create operations correctly', () => {
      // Add new item and update existing item in simpleQuerySet
      simpleQuerySet.update({ id: 1 }); // Existing item
      simpleQuerySet.update({ id: 4 }); // New item
      
      // Add update_or_create operation to querysetStore
      const upsertOp = new Operation({
        operationId: 'op-upsert-1',
        type: 'update_or_create',
        instances: [{ id: 1 }, { id: 4 }],
        status: 'pending'
      });
      
      querysetStore.addOperation(upsertOp);
      
      // Compare rendered results
      const rendered = querysetStore.render().sort(sortNumerically);
      const expected = simpleQuerySet.getAll().sort(sortNumerically);
      expect(rendered).toEqual(expected);
      expect(rendered.includes(1)).toBe(true);
      expect(rendered.includes(4)).toBe(true);
    });
  });

  describe('Get or Create Operations', () => {
    test('should handle get_or_create operations correctly', () => {
      // Add new item in simpleQuerySet
      simpleQuerySet.create({ id: 4 }); // New item
      
      // Add get_or_create operation to querysetStore
      const getOrCreateOp = new Operation({
        operationId: 'op-get-or-create-1',
        type: 'get_or_create',
        instances: [{ id: 1 }, { id: 4 }], // Existing and new
        status: 'pending'
      });
      
      querysetStore.addOperation(getOrCreateOp);
      
      // Compare rendered results
      const rendered = querysetStore.render().sort(sortNumerically);
      const expected = simpleQuerySet.getAll().sort(sortNumerically);
      expect(rendered).toEqual(expected);
      expect(rendered.includes(1)).toBe(true);
      expect(rendered.includes(4)).toBe(true);
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
      
      querysetStore.addOperation(createOp);
      
      // Confirm the operation
      querysetStore.confirm('op-create-confirm', [newItem]);
      
      // The item should still be in the rendered output
      const rendered = querysetStore.render();
      expect(rendered.includes(4)).toBe(true);
      
      // And the operation should be marked as confirmed
      const confirmedOp = querysetStore.operations.find(op => op.operationId === 'op-create-confirm');
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
      
      querysetStore.addOperation(createOp);
      
      // Initially, the new item should be in the rendered output
      expect(querysetStore.render().includes(4)).toBe(true);
      
      // Reject the operation
      querysetStore.reject('op-create-reject');
      
      // After rejection, the item should no longer be in the rendered output
      expect(querysetStore.render().includes(4)).toBe(false);
    });
  });

  describe('Operation Chaining', () => {
    test('should apply multiple operations in sequence', () => {
      // Simulate multiple operations happening in sequence
      
      // 1. Create a new item
      const newItem = { id: 4, name: 'New Item', value: 400 };
      simpleQuerySet.create(newItem);
      querysetStore.addOperation(new Operation({
        operationId: 'op-chain-1',
        type: 'create',
        instances: [newItem],
        status: 'pending'
      }));
      
      // 2. Update an existing item (no effect on queryset memberships)
      const updateItem = { id: 2, name: 'Updated in Chain', value: 250 };
      simpleQuerySet.update(updateItem);
      querysetStore.addOperation(new Operation({
        operationId: 'op-chain-2',
        type: 'update',
        instances: [updateItem],
        status: 'pending'
      }));
      
      // 3. Delete an item
      simpleQuerySet.delete(3);
      querysetStore.addOperation(new Operation({
        operationId: 'op-chain-3',
        type: 'delete',
        instances: [{ id: 3 }],
        status: 'pending'
      }));
      
      // Compare final state
      const rendered = querysetStore.render().sort(sortNumerically);
      const expected = simpleQuerySet.getAll().sort(sortNumerically);
      expect(rendered).toEqual(expected);
    });

    test('should handle delete-then-create operations (recreate scenario)', () => {
      // Delete an item
      querysetStore.addOperation(new Operation({
        operationId: 'op-delete-then-create-1',
        type: 'delete',
        instances: [{ id: 3 }],
        status: 'pending'
      }));
      
      // Then recreate it with new data
      const recreatedItem = { id: 3, name: 'Recreated Item', value: 333 };
      querysetStore.addOperation(new Operation({
        operationId: 'op-delete-then-create-2',
        type: 'create',
        instances: [recreatedItem],
        status: 'pending'
      }));
      
      // Apply same operations to simpleQuerySet
      simpleQuerySet.delete(3);
      simpleQuerySet.create(recreatedItem);
      
      // Compare final state
      const rendered = querysetStore.render().sort(sortNumerically);
      const expected = simpleQuerySet.getAll().sort(sortNumerically);
      expect(rendered).toEqual(expected);
      
      // Recreated item should be in result
      expect(rendered.includes(3)).toBe(true);
    });

    test('should not add items that were previously deleted in the chain', () => {
      // First, delete an item
      querysetStore.addOperation(new Operation({
        operationId: 'op-delete-first',
        type: 'delete',
        instances: [{ id: 3 }],
        status: 'pending'
      }));
      
      // Then try to update it (which would normally add it to the set)
      querysetStore.addOperation(new Operation({
        operationId: 'op-update-after-delete',
        type: 'update',
        instances: [{ id: 3, name: 'Should Not Be Added', value: 333 }],
        status: 'pending'
      }));
      
      // The item should still be excluded from the rendered set
      // because it was deleted earlier in the chain
      const rendered = querysetStore.render();
      expect(rendered.includes(3)).toBe(false);
    });
  });

  describe('Sync Functionality', () => {
    test('should update ground truth from server during sync', async () => {
      // Setup mock fetch to return updated data
      const updatedServerData = [
        { id: 1, name: 'Server Item 1' },
        { id: 2, name: 'Server Item 2' },
        { id: 4, name: 'Server Item 4' } // Item 3 missing, item 4 added
      ];
      
      mockFetch.mockResolvedValue(updatedServerData);
      
      // Perform sync
      await querysetStore.sync();
      
      // Ground truth PKs should be updated
      const groundTruth = querysetStore.groundTruthPks.sort(sortNumerically);
      expect(groundTruth).toEqual([1, 2, 4]);
      
      // Rendered data should reflect the new ground truth
      const rendered = querysetStore.render().sort(sortNumerically);
      expect(rendered).toEqual([1, 2, 4]);
    });

    test('should trim operations older than 2 minutes during sync', async () => {
      // Create multiple operations with different timestamps
      const newOp1 = new Operation({
        operationId: 'op-recent-1',
        type: 'create',
        instances: [{ id: 4 }],
        status: 'confirmed',
        timestamp: Date.now() // Current time
      });
      
      const newOp2 = new Operation({
        operationId: 'op-recent-2',
        type: 'update',
        instances: [{ id: 5 }],
        status: 'confirmed',
        timestamp: Date.now() // Current time
      });
      
      const oldOp = new Operation({
        operationId: 'op-old',
        type: 'delete',
        instances: [{ id: 6 }],
        status: 'confirmed',
        timestamp: Date.now() - (1000 * 60 * 3) // 3 minutes ago (should be trimmed)
      });
      
      // Add all operations
      querysetStore.addOperation(newOp1);
      querysetStore.addOperation(newOp2);
      querysetStore.addOperation(oldOp);
      
      expect(querysetStore.operations.length).toBe(3);
      
      // Setup mock fetch
      mockFetch.mockResolvedValue([]);
      
      // Perform sync
      await querysetStore.sync();
      
      // Old operation should be trimmed
      expect(querysetStore.operations.length).toBe(2);
      expect(querysetStore.operations.find(op => op.operationId === 'op-old')).toBeUndefined();
      expect(querysetStore.operations.find(op => op.operationId === 'op-recent-1')).toBeDefined();
      expect(querysetStore.operations.find(op => op.operationId === 'op-recent-2')).toBeDefined();
    });

    test('should handle errors during sync gracefully', async () => {
      // Setup mock fetch to throw an error
      mockFetch.mockRejectedValue(new Error('Network error'));
      
      // Store state before sync
      const beforeGroundTruth = [...querysetStore.groundTruthPks];
      const beforeOpCount = querysetStore.operations.length;
      
      // Attempt sync
      await querysetStore.sync();
      
      // Should not have changed ground truth on error
      expect(querysetStore.groundTruthPks).toEqual(beforeGroundTruth);
      expect(querysetStore.operations.length).toBe(beforeOpCount);
      expect(querysetStore.isSyncing).toBe(false); // Should reset syncing flag
    });

    test('should ignore duplicate sync requests', async () => {
      // Set syncing flag manually
      querysetStore.isSyncing = true;
      
      // Setup mock
      mockFetch.mockResolvedValue([]);
      
      // Attempt sync
      await querysetStore.sync();
      
      // Should not have called fetch
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('should handle invalid instances from server', async () => {
      // Setup mock fetch to return some invalid data
      mockFetch.mockResolvedValue([
        { id: 1 }, // Valid
        null, // Invalid
        "not an object", // Invalid
        { name: "Missing ID" }, // Invalid
        { id: 4 } // Valid
      ]);
      
      // Perform sync
      await querysetStore.sync();
      
      // Should only have processed the valid instances
      expect(querysetStore.groundTruthPks.sort(sortNumerically)).toEqual([1, 4]);
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
      
      querysetStore.addOperation(createOp);
      
      // Update the operation
      const updatedOp = new Operation({
        operationId: 'op-to-update',
        type: 'create', 
        instances: [{ id: 5, name: 'Updated', value: 500 }],
        status: 'pending'
      });
      
      const result = querysetStore.updateOperation(updatedOp);
      
      // Should return true for successful update
      expect(result).toBe(true);
      
      // Operation should be updated in the store
      const updatedOperation = querysetStore.operations.find(op => op.operationId === 'op-to-update');
      expect(updatedOperation.instances[0].id).toBe(5);
      
      // Rendered result should reflect the update
      const rendered = querysetStore.render();
      expect(rendered.includes(4)).toBe(false);
      expect(rendered.includes(5)).toBe(true);
    });
    
    test('should return false when updating non-existent operation', () => {
      // Try to update an operation that doesn't exist
      const nonExistentOp = new Operation({
        operationId: 'non-existent-op',
        type: 'update',
        instances: [{ id: 10, name: 'Shouldn\'t Exist', value: 999 }],
        status: 'pending'
      });
      
      const result = querysetStore.updateOperation(nonExistentOp);
      
      // Should return false for failed update
      expect(result).toBe(false);
      
      // Store operations should remain unchanged
      expect(querysetStore.operations.find(op => op.operationId === 'non-existent-op')).toBeUndefined();
    });
  });

  describe('Edge Cases', () => {
    test('should handle instances without primary key', () => {
      // Add invalid instances to operations
      querysetStore.addOperation(new Operation({
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
      const rendered = querysetStore.render();
      expect(rendered.includes(5)).toBe(true);
      // No way to check for the invalid ones since they don't have IDs
    });

    test('should handle empty operations array', () => {
      querysetStore.addOperation(new Operation({
        operationId: 'op-empty',
        type: 'create',
        instances: [], // Empty instances array
        status: 'pending'
      }));
      
      // Should not affect rendering
      expect(querysetStore.render().length).toBe(3);
    });

    test('should handle unknown operation types', () => {
      // Add operation with unknown type
      querysetStore.addOperation(new Operation({
        operationId: 'op-unknown',
        type: 'not_a_real_type',
        instances: [{ id: 5, name: 'Unknown Op', value: 500 }],
        status: 'pending'
      }));
      
      // Should not affect rendering (unknown op type is ignored)
      expect(querysetStore.render().includes(5)).toBe(false);
    });
    
    test('should handle setting invalid ground truth', () => {
      // Set invalid ground truth
      querysetStore.setGroundTruth("not an array");
      
      // Should convert to empty array
      expect(Array.isArray(querysetStore.groundTruthPks)).toBe(true);
      expect(querysetStore.groundTruthPks.length).toBe(0);
    });
    
    test('should handle setting invalid operations', () => {
      // Set invalid operations
      querysetStore.setOperations("not an array");
      
      // Should convert to empty array
      expect(Array.isArray(querysetStore.operations)).toBe(true);
      expect(querysetStore.operations.length).toBe(0);
    });
  });
  
  describe('groundTruthSet', () => {
    test('should return a Set of ground truth PKs', () => {
      const groundTruthSet = querysetStore.groundTruthSet;
      
      // Should be a Set
      expect(groundTruthSet instanceof Set).toBe(true);
      
      // Should contain the ground truth PKs
      expect(groundTruthSet.size).toBe(3);
      expect(groundTruthSet.has(1)).toBe(true);
      expect(groundTruthSet.has(2)).toBe(true);
      expect(groundTruthSet.has(3)).toBe(true);
    });
  });
  
  describe('Complex Scenarios', () => {
    test('should handle a full lifecycle of operations and sync', async () => {
      // 1. Create some local changes
      querysetStore.addOperation(new Operation({
        operationId: 'op-lifecycle-1',
        type: 'create',
        instances: [{ id: 4, name: 'Lifecycle Test', value: 400 }],
        status: 'pending'
      }));
      
      querysetStore.addOperation(new Operation({
        operationId: 'op-lifecycle-2',
        type: 'delete',
        instances: [{ id: 1 }],
        status: 'pending'
      }));
      
      // 2. Simulate server confirmation for the first operation
      querysetStore.confirm('op-lifecycle-1', [{ id: 4, name: 'Lifecycle Test', value: 400 }]);
      
      // 3. Setup mock server response for sync
      // This simulates the server having item 4, but still having item 1
      mockFetch.mockResolvedValue([
        { id: 1, name: 'Server Item 1' }, // Server doesn't know it was deleted
        { id: 2, name: 'Server Item 2' },
        { id: 3, name: 'Server Item 3' },
        { id: 4, name: 'Server Item 4' } // Confirmed item
      ]);
      
      // 4. Perform sync
      await querysetStore.sync();
      
      // 5. Check final state
      const rendered = querysetStore.render().sort(sortNumerically);
      
      // Should have items 2, 3, 4 (item 1 deleted by pending operation)
      expect(rendered).toEqual([2, 3, 4]);
      
      // Ground truth should match server (all 4 items)
      expect(querysetStore.groundTruthPks.sort(sortNumerically)).toEqual([1, 2, 3, 4]);
      
      // The delete operation for item 1 should still be pending
      expect(querysetStore.operations.some(op => 
        op.operationId === 'op-lifecycle-2' && op.status === 'pending'
      )).toBe(true);
    });
  });
});