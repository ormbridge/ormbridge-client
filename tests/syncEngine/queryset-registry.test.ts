import { querysetStoreRegistry, LiveQueryset } from '../../src/syncEngine/registries/querysetStoreRegistry.js';
import { modelStoreRegistry } from '../../src/syncEngine/registries/modelStoreRegistry.js';
import { QuerysetStore } from '../../src/syncEngine/stores/querysetStore.js';
import { Operation } from '../../src/syncEngine/stores/operation.js';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the LiveQueryset implementation since we're importing the real class
vi.mock('../../src/syncEngine/registries/querysetStoreRegistry.js', () => ({
  LiveQueryset: vi.fn().mockImplementation(queryset => {
    return {
      queryset,
      getCurrentItems: vi.fn().mockImplementation(() => {
        // Simple implementation for testing
        const pks = querysetStoreRegistry.getStore(queryset).render();
        return pks.map(pk => ({ id: pk })); // Mock model instances
      })
    };
  })
}));

// Test Model Class
class TestModel {
  static modelName = 'TestModel';
  static configKey = 'test_config';
  static primaryKeyField = 'id';
}

// Mock Queryset Class
class MockQueryset {
  constructor(model = TestModel, initialAst = {}) {
    this.model = model;
    this.ast = initialAst;
    this.fetchImplementation = vi.fn().mockResolvedValue([]);
  }
  
  build() {
    return this.ast;
  }
  
  fetch(options = {}) {
    return this.fetchImplementation(options);
  }
  
  // Add methods needed for tests
  mockFetchImplementation(fn) {
    this.fetchImplementation = fn;
    return this;
  }
}

describe('QuerysetStoreRegistry', () => {
  beforeEach(() => {
    // Reset registries before each test
    querysetStoreRegistry.clear();
    modelStoreRegistry.clear();
    
    // Reset mocks
    vi.clearAllMocks();
  });
  
  describe('Basic Registry Operations', () => {
    test('should create a new QuerysetStore for a queryset', () => {
      const queryset = new MockQueryset();
      const store = querysetStoreRegistry.getStore(queryset);
      
      // Store should be an instance of QuerysetStore
      expect(store).toBeInstanceOf(QuerysetStore);
      expect(store.modelClass).toBe(TestModel);
    });
    
    test('should return the same store instance for querysets with the same model and AST', () => {
      const queryset1 = new MockQueryset(TestModel, { type: 'query', conditions: [] });
      const queryset2 = new MockQueryset(TestModel, { type: 'query', conditions: [] });
      
      const store1 = querysetStoreRegistry.getStore(queryset1);
      const store2 = querysetStoreRegistry.getStore(queryset2);
      
      // Should be exactly the same instance
      expect(store1).toBe(store2);
    });
    
    test('should create separate stores for different ASTs', () => {
      const queryset1 = new MockQueryset(TestModel, { type: 'query', conditions: [] });
      const queryset2 = new MockQueryset(TestModel, { type: 'query', conditions: [{ field: 'status', value: 'active' }] });
      
      const store1 = querysetStoreRegistry.getStore(queryset1);
      const store2 = querysetStoreRegistry.getStore(queryset2);
      
      // Should be different instances
      expect(store1).not.toBe(store2);
    });
    
    test('should throw error when getStore is called with invalid queryset', () => {
      expect(() => {
        querysetStoreRegistry.getStore(null);
      }).toThrow();
      
      expect(() => {
        querysetStoreRegistry.getStore({ /* missing model property */ });
      }).toThrow();
    });
    
    test('should clear all stores', () => {
      // Create some stores
      const queryset1 = new MockQueryset(TestModel, { type: 'query', conditions: [] });
      const queryset2 = new MockQueryset(TestModel, { type: 'query', conditions: [{ field: 'status', value: 'active' }] });
      
      querysetStoreRegistry.getStore(queryset1);
      querysetStoreRegistry.getStore(queryset2);
      
      // Clear the registry
      querysetStoreRegistry.clear();
      
      // Creating a store again should create a new instance
      const newStore = querysetStoreRegistry.getStore(queryset1);
      expect(newStore.operations.length).toBe(0);
      expect(newStore.groundTruthPks.length).toBe(0);
    });
  });
  
  describe('Queryset Entity Management', () => {
    test('should get a LiveQueryset instance for a queryset', () => {
      const queryset = new MockQueryset();
      const liveQueryset = querysetStoreRegistry.getEntity(queryset);
      
      // Should be a LiveQueryset
      expect(LiveQueryset).toHaveBeenCalledWith(queryset);
      expect(liveQueryset.queryset).toBe(queryset);
    });
    
    test('should set ground truth for a queryset', () => {
      const queryset = new MockQueryset();
      const instances = [
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' }
      ];
      
      const result = querysetStoreRegistry.setEntity(queryset, instances);
      
      // Result should be the instances
      expect(result).toEqual(instances);
      
      // Check that the store has the correct ground truth
      const store = querysetStoreRegistry.getStore(queryset);
      expect(store.groundTruthPks.sort()).toEqual([1, 2]);
    });
    
    test('should handle empty instances when setting querysets', () => {
      const queryset = new MockQueryset();
      
      // Set empty array
      const result = querysetStoreRegistry.setEntity(queryset, []);
      
      // Result should be empty array
      expect(result).toEqual([]);
      
      // Ground truth should be empty
      const store = querysetStoreRegistry.getStore(queryset);
      expect(store.groundTruthPks).toEqual([]);
    });
    
    test('should handle null/undefined inputs gracefully', () => {
      // Should return empty array for null queryset
      expect(querysetStoreRegistry.setEntity(null, [{ id: 1 }])).toEqual([]);
      
      // Should return empty array for null instances
      const queryset = new MockQueryset();
      expect(querysetStoreRegistry.setEntity(queryset, null)).toEqual([]);
    });
  });
  
  describe('Integration with QuerysetStore', () => {
    test('should get updated data through LiveQueryset when operations are added', () => {
      const queryset = new MockQueryset();
      const store = querysetStoreRegistry.getStore(queryset);
      
      // Set initial ground truth
      store.setGroundTruth([1, 2, 3]);
      
      // Get LiveQueryset
      const liveQueryset = querysetStoreRegistry.getEntity(queryset);
      
      // Initially, getCurrentItems should return items for PKs 1, 2, 3
      expect(liveQueryset.getCurrentItems().map(item => item.id).sort()).toEqual([1, 2, 3]);
      
      // Add an operation to delete PK 2
      store.addOperation(new Operation({
        operationId: 'op-delete-1',
        type: 'delete',
        instances: [{ id: 2 }],
        status: 'pending'
      }));
      
      // Add an operation to create PK 4
      store.addOperation(new Operation({
        operationId: 'op-create-1',
        type: 'create',
        instances: [{ id: 4 }],
        status: 'pending'
      }));
      
      // getCurrentItems should now reflect the operations
      expect(liveQueryset.getCurrentItems().map(item => item.id).sort()).toEqual([1, 3, 4]);
    });
    
    test('should initialize the store with fetch on first access', async () => {
      // Create queryset with mock fetch implementation
      const queryset = new MockQueryset();
      queryset.mockFetchImplementation(() => Promise.resolve([
        { id: 10 }, { id: 20 }, { id: 30 }
      ]));
      
      // Get store - this should trigger initial sync
      const store = querysetStoreRegistry.getStore(queryset);
      
      // Wait for sync to complete (use setTimeout because sync is async)
      await new Promise(resolve => setTimeout(resolve, 0));
      
      // Check that fetchImplementation was called
      expect(queryset.fetchImplementation).toHaveBeenCalled();
      
      // Ground truth should be updated with fetched PKs
      expect(store.groundTruthPks.sort((a, b) => a - b)).toEqual([10, 20, 30]);
    });
  });
  
  describe('Key Generation', () => {
    test('should generate different keys for different models', () => {
      const generateKey = vi.spyOn(querysetStoreRegistry, '_generateKey');
      
      // Different model classes
      class Model1 {
        static modelName = 'Model1';
        static configKey = 'config1';
      }
      
      class Model2 {
        static modelName = 'Model2';
        static configKey = 'config2';
      }
      
      const queryset1 = new MockQueryset(Model1, { type: 'query' });
      const queryset2 = new MockQueryset(Model2, { type: 'query' });
      
      querysetStoreRegistry.getStore(queryset1);
      querysetStoreRegistry.getStore(queryset2);
      
      // Should have generated different keys
      const firstCall = generateKey.mock.results[0].value;
      const secondCall = generateKey.mock.results[1].value;
      
      expect(firstCall).not.toBe(secondCall);
      expect(firstCall).toContain('config1::Model1');
      expect(secondCall).toContain('config2::Model2');
      
      generateKey.mockRestore();
    });
    
    test('should generate different keys for different query ASTs', () => {
      const generateKey = vi.spyOn(querysetStoreRegistry, '_generateKey');
      
      const queryset1 = new MockQueryset(TestModel, { type: 'query', conditions: [] });
      const queryset2 = new MockQueryset(TestModel, { type: 'query', conditions: [{ field: 'status' }] });
      
      querysetStoreRegistry.getStore(queryset1);
      querysetStoreRegistry.getStore(queryset2);
      
      // Should have generated different keys due to different ASTs
      const firstCall = generateKey.mock.results[0].value;
      const secondCall = generateKey.mock.results[1].value;
      
      expect(firstCall).not.toBe(secondCall);
      
      generateKey.mockRestore();
    });
    
    test('should generate the same key for equivalent ASTs', () => {
      const generateKey = vi.spyOn(querysetStoreRegistry, '_generateKey');
      
      // Same AST structure but different object instances
      const queryset1 = new MockQueryset(TestModel, { type: 'query', conditions: [] });
      const queryset2 = new MockQueryset(TestModel, { type: 'query', conditions: [] });
      
      querysetStoreRegistry.getStore(queryset1);
      querysetStoreRegistry.getStore(queryset2);
      
      // Should have generated the same key
      const firstCall = generateKey.mock.results[0].value;
      const secondCall = generateKey.mock.results[1].value;
      
      expect(firstCall).toBe(secondCall);
      
      generateKey.mockRestore();
    });
  });
});