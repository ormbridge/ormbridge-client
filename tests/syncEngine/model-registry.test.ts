import { modelStoreRegistry } from '../../src/syncEngine/registries/modelStoreRegistry.js';
import { ModelStore } from '../../src/syncEngine/stores/modelStore.js';
import { Operation } from '../../src/syncEngine/stores/operation.js';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// Test Model Class
class TestModel {
  static modelName = 'TestModel';
  static configKey = 'test_config';
  static primaryKeyField = 'id';
  
  static objects = {
    filter: () => ({
      fetch: async () => []
    })
  };
}

// Second Test Model Class for testing multiple model types
class AnotherModel {
  static modelName = 'AnotherModel';
  static configKey = 'another_config';
  static primaryKeyField = 'id';
  
  static objects = {
    filter: () => ({
      fetch: async () => []
    })
  };
}

describe('ModelStoreRegistry', () => {
  // Mock fetch for API calls
  const originalFetch = global.fetch;
  
  beforeEach(() => {
    // Reset the registry before each test
    modelStoreRegistry.clear();
    
    // Setup mock for global fetch
    global.fetch = vi.fn();
  });
  
  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
  });
  
  describe('Basic Registry Operations', () => {
    test('should create a new ModelStore for a model class', () => {
      const store = modelStoreRegistry.getStore(TestModel);
      
      // Store should be an instance of ModelStore
      expect(store).toBeInstanceOf(ModelStore);
      expect(store.modelClass).toBe(TestModel);
    });
    
    test('should return the same store instance for the same model class', () => {
      const store1 = modelStoreRegistry.getStore(TestModel);
      const store2 = modelStoreRegistry.getStore(TestModel);
      
      // Should be exactly the same instance
      expect(store1).toBe(store2);
    });
    
    test('should create separate stores for different model classes', () => {
      const store1 = modelStoreRegistry.getStore(TestModel);
      const store2 = modelStoreRegistry.getStore(AnotherModel);
      
      // Should be different instances
      expect(store1).not.toBe(store2);
      expect(store1.modelClass).toBe(TestModel);
      expect(store2.modelClass).toBe(AnotherModel);
    });
    
    test('should clear all stores', () => {
      // Create some stores
      modelStoreRegistry.getStore(TestModel);
      modelStoreRegistry.getStore(AnotherModel);
      
      // Clear the registry
      modelStoreRegistry.clear();
      
      // Creating stores again should create new instances
      const newStore = modelStoreRegistry.getStore(TestModel);
      expect(newStore.operations.length).toBe(0);
      expect(newStore.groundTruthArray.length).toBe(0);
    });
  });
  
  describe('Entity Management', () => {
    test('should get an entity from a store', () => {
      // Setup store with initial data
      const store = modelStoreRegistry.getStore(TestModel);
      store.setGroundTruth([
        { id: 1, name: 'Item 1', value: 100 },
        { id: 2, name: 'Item 2', value: 200 }
      ]);
      
      // Get an entity by primary key
      const entity = modelStoreRegistry.getEntity(TestModel, 1);
      
      // Should return the correct entity
      expect(entity).toEqual({ id: 1, name: 'Item 1', value: 100 });
    });
    
    test('should return null for non-existent entity', () => {
      // Get a non-existent entity
      const entity = modelStoreRegistry.getEntity(TestModel, 999);
      
      // Should return null
      expect(entity).toBeNull();
    });
    
    test('should set an entity in a store', () => {
      // Set a new entity
      const newEntity = { id: 3, name: 'New Entity', value: 300 };
      const result = modelStoreRegistry.setEntity(TestModel, 3, newEntity);
      
      // Result should be the entity
      expect(result).toEqual(newEntity);
      
      // Entity should be in the store
      const retrievedEntity = modelStoreRegistry.getEntity(TestModel, 3);
      expect(retrievedEntity).toEqual(newEntity);
    });
    
    test('should update an existing entity', () => {
      // First add an entity
      modelStoreRegistry.setEntity(TestModel, 4, { id: 4, name: 'Original', value: 400 });
      
      // Then update it
      const updatedEntity = { id: 4, name: 'Updated', value: 450 };
      modelStoreRegistry.setEntity(TestModel, 4, updatedEntity);
      
      // Get the entity
      const entity = modelStoreRegistry.getEntity(TestModel, 4);
      
      // Should reflect the update
      expect(entity).toEqual(updatedEntity);
    });
    
    test('should handle null/undefined inputs gracefully', () => {
      // Should return undefined for null model class
      expect(modelStoreRegistry.getEntity(null, 1)).toBeUndefined();
      
      // Should return undefined for null primary key
      expect(modelStoreRegistry.getEntity(TestModel, null)).toBeUndefined();
      
      // Should handle no data when setting
      expect(modelStoreRegistry.setEntity(null, 1, { id: 1 })).toBeUndefined();
    });
    
    test('should throw error if getEntity is called with object instead of pk', () => {
      // Should throw error when calling getEntity with an object
      expect(() => {
        modelStoreRegistry.getEntity(TestModel, { id: 1 });
      }).toThrow();
    });
    
    test('should throw error if setEntity is called with object instead of pk', () => {
      // Should throw error when calling setEntity with an object
      expect(() => {
        modelStoreRegistry.setEntity(TestModel, { id: 1 }, { id: 1, name: 'Test' });
      }).toThrow();
    });
  });
  
  describe('Integration with ModelStore', () => {
    test('should get entities reflecting operations', () => {
      // Get the store
      const store = modelStoreRegistry.getStore(TestModel);
      
      // Add initial data
      store.setGroundTruth([
        { id: 1, name: 'Item 1', value: 100 }
      ]);
      
      // Add an optimistic update operation
      store.addOperation(new Operation({
        operationId: 'op-update-1',
        type: 'update',
        instances: [{ id: 1, name: 'Updated Item 1' }],
        status: 'pending'
      }));
      
      // Get the entity - should reflect the update
      const entity = modelStoreRegistry.getEntity(TestModel, 1);
      
      // Value should be from ground truth, name should be from operation
      expect(entity.name).toBe('Updated Item 1');
      expect(entity.value).toBe(100);
    });
    
    test('should handle optimistic create operations', () => {
      // Get the store
      const store = modelStoreRegistry.getStore(TestModel);
      
      // Add an optimistic create operation
      const newItem = { id: 5, name: 'New Item', value: 500 };
      store.addOperation(new Operation({
        operationId: 'op-create-1',
        type: 'create',
        instances: [newItem],
        status: 'pending'
      }));
      
      // Get the entity - should exist from operation
      const entity = modelStoreRegistry.getEntity(TestModel, 5);
      
      // Should be the new item
      expect(entity).toEqual(newItem);
    });
    
    test('should handle optimistic delete operations', () => {
      // Get the store
      const store = modelStoreRegistry.getStore(TestModel);
      
      // Add initial data
      store.setGroundTruth([
        { id: 1, name: 'Item 1', value: 100 },
        { id: 2, name: 'Item 2', value: 200 }
      ]);
      
      // Add an optimistic delete operation
      store.addOperation(new Operation({
        operationId: 'op-delete-1',
        type: 'delete',
        instances: [{ id: 2 }],
        status: 'pending'
      }));
      
      // Item 1 should still exist
      expect(modelStoreRegistry.getEntity(TestModel, 1)).toBeDefined();
      
      // Item 2 should be deleted (null)
      expect(modelStoreRegistry.getEntity(TestModel, 2)).toBeNull();
    });
  });
});