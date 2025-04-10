import { metricStoreRegistry } from '../../src/syncEngine/registries/metricStoreRegistry.js';
import { MetricStore } from '../../src/syncEngine/stores/metricStore.js';
import { 
  CountStrategy, 
  SumStrategy, 
  MinStrategy, 
  MaxStrategy, 
  MetricStrategyFactory 
} from '../../src/syncEngine/stores/metricOptCalcs.js';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { DummyModel, DummyModelQuerySet } from '../../models/backend1/django_app/dummymodel.js';
import { DummyRelatedModel } from '../../models/backend1/django_app/dummyrelatedmodel.js';

describe('MetricStoreRegistry', () => {
  beforeEach(() => {
    // Reset registry before each test
    metricStoreRegistry.clear();
    
    // Reset mocks
    vi.clearAllMocks();
  });
  
  describe('Basic Registry Operations', () => {
    test('should create a new MetricStore for a metric', () => {
      const queryset = DummyModel.objects.all();
      const fetchMetricValue = vi.fn();
      
      const store = metricStoreRegistry.getStore(
        queryset,
        'count',
        null,
        fetchMetricValue,
        0
      );
      
      // Store should be an instance of MetricStore
      expect(store).toBeInstanceOf(MetricStore);
      expect(store.strategy).toBeInstanceOf(CountStrategy);
    });
    
    test('should throw error when required parameters are missing', () => {
      const queryset = DummyModel.objects.all();
      const fetchMetricValue = vi.fn();
      
      // Missing queryset
      expect(() => {
        metricStoreRegistry.getStore(
          null,
          'count',
          null,
          fetchMetricValue
        );
      }).toThrow(/requires queryset/);
      
      // Missing metricType
      expect(() => {
        metricStoreRegistry.getStore(
          queryset,
          null,
          null,
          fetchMetricValue
        );
      }).toThrow(/metricType is required/);
      
      // Queryset without model
      const invalidQueryset = {
        build: () => ({}),
        // No model property
      };
      
      expect(() => {
        metricStoreRegistry.getStore(
          invalidQueryset,
          'count',
          null,
          fetchMetricValue
        );
      }).toThrow(/requires queryset with ModelClass/);
    });
    
    test('should throw error when field is required but not provided', () => {
      const queryset = DummyModel.objects.all();
      const fetchMetricValue = vi.fn();
      
      // sum requires field
      expect(() => {
        metricStoreRegistry.getStore(
          queryset,
          'sum',
          null, // Missing field
          fetchMetricValue
        );
      }).toThrow(/Field is required for sum metric/);
      
      // min requires field
      expect(() => {
        metricStoreRegistry.getStore(
          queryset,
          'min',
          null, // Missing field
          fetchMetricValue
        );
      }).toThrow(/Field is required for min metric/);
      
      // max requires field
      expect(() => {
        metricStoreRegistry.getStore(
          queryset,
          'max',
          null, // Missing field
          fetchMetricValue
        );
      }).toThrow(/Field is required for max metric/);
    });
    
    test('should return the same store instance for the same metric parameters', () => {
      const queryset = DummyModel.objects.all();
      const fetchMetricValue = vi.fn();
      
      const store1 = metricStoreRegistry.getStore(
        queryset,
        'count',
        null,
        fetchMetricValue
      );
      
      const store2 = metricStoreRegistry.getStore(
        queryset,
        'count',
        null,
        fetchMetricValue
      );
      
      // Should be exactly the same instance
      expect(store1).toBe(store2);
    });
    
    test('should create separate stores for different parameters', () => {
      const queryset = DummyModel.objects.all();
      const fetchMetricValue = vi.fn();
      
      // Count store
      const countStore = metricStoreRegistry.getStore(
        queryset,
        'count',
        null,
        fetchMetricValue
      );
      
      // Sum store
      const sumStore = metricStoreRegistry.getStore(
        queryset,
        'sum',
        'value',
        fetchMetricValue
      );
      
      // Different models
      const relatedQueryset = DummyRelatedModel.objects.all();
      const relatedCountStore = metricStoreRegistry.getStore(
        relatedQueryset,
        'count',
        null,
        fetchMetricValue
      );
      
      // Should be different instances
      expect(countStore).not.toBe(sumStore);
      expect(countStore).not.toBe(relatedCountStore);
      
      // Should have correct strategies
      expect(countStore.strategy).toBeInstanceOf(CountStrategy);
      expect(sumStore.strategy).toBeInstanceOf(SumStrategy);
      expect(relatedCountStore.strategy).toBeInstanceOf(CountStrategy);
    });
    
    test('should clear all stores', () => {
      // Create some stores
      const queryset = DummyModel.objects.all();
      const fetchMetricValue = vi.fn();
      
      const store = metricStoreRegistry.getStore(
        queryset,
        'count',
        null,
        fetchMetricValue,
        10 // Initial value
      );
      
      // Create destroy spy
      const destroySpy = vi.spyOn(store, 'destroy');
      
      // Clear the registry
      metricStoreRegistry.clear();
      
      // Should have called destroy on the store
      expect(destroySpy).toHaveBeenCalled();
      
      // Creating a store again should create a new instance
      const newStore = metricStoreRegistry.getStore(
        queryset,
        'count',
        null,
        fetchMetricValue
      );
      
      // Should be a different instance
      expect(newStore).not.toBe(store);
      
      // Clean up
      destroySpy.mockRestore();
    });
  });
  
  describe('Metric Entity Management', () => {
    test('should get a metric value from a store as an object with a value getter', () => {
      const queryset = DummyModel.objects.all();
      const fetchMetricValue = vi.fn();
      
      // Create store with initial value
      const store = metricStoreRegistry.getStore(
        queryset,
        'count',
        null,
        fetchMetricValue,
        42 // Initial value
      );
      
      // Mock the render method
      vi.spyOn(store, 'render').mockReturnValue(42);
      
      // Get the metric entity
      const entity = metricStoreRegistry.getEntity(queryset, 'count');
      
      // Should return an object with a value getter
      expect(entity).toBeInstanceOf(Object);
      expect(entity).toHaveProperty('value');
      expect(entity.value).toBe(42);
      
      // The render method should have been called when accessing entity.value
      expect(store.render).toHaveBeenCalled();
    });
    
    test('should return null for non-existent metric', () => {
      const queryset = DummyModel.objects.all();
      
      // Get a metric that doesn't exist yet
      const entity = metricStoreRegistry.getEntity(queryset, 'count');
      
      // Should return null
      expect(entity).toBeNull();
    });
    
    test('should set a metric value', () => {
      const queryset = DummyModel.objects.all();
      
      // Set a metric value
      const result = metricStoreRegistry.setEntity(
        queryset,
        'count',
        null,
        100
      );
      
      // Result should be the value
      expect(result).toBe(100);
      
      // Get the store and mock render
      const store = metricStoreRegistry.getStore(queryset, 'count');
      vi.spyOn(store, 'render').mockReturnValue(100);
      
      // Value should be accessible via the value getter
      const entity = metricStoreRegistry.getEntity(queryset, 'count');
      expect(entity.value).toBe(100);
      expect(store.render).toHaveBeenCalled();
    });
    
    test('should update an existing metric value', () => {
      const queryset = DummyModel.objects.all();
      const fetchMetricValue = vi.fn();
      
      // Create store with initial value
      const store = metricStoreRegistry.getStore(
        queryset,
        'count',
        null,
        fetchMetricValue,
        50 // Initial value
      );
      
      // Mock render for initial value
      vi.spyOn(store, 'render').mockReturnValue(50);
      
      // Verify initial value
      const initialEntity = metricStoreRegistry.getEntity(queryset, 'count');
      expect(initialEntity.value).toBe(50);
      
      // Update the value
      metricStoreRegistry.setEntity(queryset, 'count', null, 150);
      
      // Update the mock for new value
      store.render.mockReturnValue(150);
      
      // Get the updated entity
      const updatedEntity = metricStoreRegistry.getEntity(queryset, 'count');
      
      // Should reflect the update through the value getter
      expect(updatedEntity.value).toBe(150);
    });
    
    test('should handle null/undefined inputs gracefully', () => {
      // Should return null for null parameters
      expect(metricStoreRegistry.getEntity(null, 'count')).toBeNull();
      expect(metricStoreRegistry.getEntity(DummyModel.objects.all(), null)).toBeNull();
      
      // Should return null when setting with null parameters
      expect(metricStoreRegistry.setEntity(null, 'count', null, 100)).toBeNull();
      expect(metricStoreRegistry.setEntity(DummyModel.objects.all(), null, null, 100)).toBeNull();
    });
    
    test('should get all metrics for a queryset as objects with value getters', () => {
      const queryset = DummyModel.objects.all();
      const fetchMetricValue = vi.fn();
      
      // Create multiple metrics for the same queryset
      const countStore = metricStoreRegistry.getStore(
        queryset,
        'count',
        null,
        fetchMetricValue,
        10 // Initial value
      );
      
      const sumStore = metricStoreRegistry.getStore(
        queryset,
        'sum',
        'value',
        fetchMetricValue,
        500 // Initial value
      );
      
      const maxStore = metricStoreRegistry.getStore(
        queryset,
        'max',
        'value',
        fetchMetricValue,
        95 // Initial value
      );
      
      // Mock render methods
      vi.spyOn(countStore, 'render').mockReturnValue(10);
      vi.spyOn(sumStore, 'render').mockReturnValue(500);
      vi.spyOn(maxStore, 'render').mockReturnValue(95);
      
      // Get all entities
      const entities = metricStoreRegistry.getEntities(queryset);
      
      // Should have all metrics with value getters
      expect(entities).toHaveProperty('count');
      expect(entities).toHaveProperty('sum');
      expect(entities).toHaveProperty('max');
      
      // Check count entity
      expect(entities.count).toHaveProperty('value');
      expect(entities.count.value).toBe(10);
      expect(countStore.render).toHaveBeenCalled();
      
      // Check field-specific entities
      expect(entities.sum).toHaveProperty('value');
      expect(entities.sum.value).toHaveProperty('value');
      expect(entities.sum.value.value).toBe(500);
      expect(sumStore.render).toHaveBeenCalled();
      
      expect(entities.max).toHaveProperty('value');
      expect(entities.max.value).toHaveProperty('value');
      expect(entities.max.value.value).toBe(95);
      expect(maxStore.render).toHaveBeenCalled();
    });
    
    test('should verify the value getter calls render method each time', () => {
      const queryset = DummyModel.objects.all();
      const fetchMetricValue = vi.fn();
      
      // Create store with initial value
      const store = metricStoreRegistry.getStore(
        queryset,
        'count',
        null,
        fetchMetricValue,
        42 // Initial value
      );
      
      // Mock the render method with a counter
      let renderCallCount = 0;
      vi.spyOn(store, 'render').mockImplementation(() => {
        renderCallCount++;
        return renderCallCount * 10;
      });
      
      // Get the metric entity
      const entity = metricStoreRegistry.getEntity(queryset, 'count');
      
      // First access should call render once and return 10
      expect(entity.value).toBe(10);
      expect(store.render).toHaveBeenCalledTimes(1);
      
      // Second access should call render again and return 20
      expect(entity.value).toBe(20);
      expect(store.render).toHaveBeenCalledTimes(2);
      
      // Third access should call render again and return 30
      expect(entity.value).toBe(30);
      expect(store.render).toHaveBeenCalledTimes(3);
    });
  });
  
  describe('Sync Operations', () => {
    test('should sync a specific metric', async () => {
      const queryset = DummyModel.objects.all();
      // Mock the executeQuery method on the queryset
      const executeQuerySpy = vi.spyOn(queryset, 'executeQuery')
        .mockImplementation(() => Promise.resolve({ data: 42 }));
      
      // Create metric with fetch function that returns value from queryset
      const fetchMetricValue = vi.fn().mockImplementation(() => Promise.resolve(42));
      
      const store = metricStoreRegistry.getStore(
        queryset,
        'count',
        null,
        fetchMetricValue,
        0 // Initial value
      );
      
      // Add spy to track calls to the store's sync method
      const syncSpy = vi.spyOn(store, 'sync');
      vi.spyOn(store, 'render').mockReturnValue(42);
      
      // Sync the metric
      await metricStoreRegistry.sync(queryset, 'count');
      
      // Should have called the store's sync method
      expect(syncSpy).toHaveBeenCalled();
      
      // Value should be updated
      const entity = metricStoreRegistry.getEntity(queryset, 'count');
      expect(entity.value).toBe(42);
      
      // Clean up
      syncSpy.mockRestore();
      executeQuerySpy.mockRestore();
    });
    
    test('should handle non-existent metric during sync', async () => {
      const queryset = DummyModel.objects.all();
      
      // Try to sync a metric that doesn't exist
      await metricStoreRegistry.sync(queryset, 'count');
      
      // No error should be thrown, function should return silently
      expect(metricStoreRegistry.getEntity(queryset, 'count')).toBeNull();
    });
    
    test('should sync all metrics', async () => {
      const queryset = DummyModel.objects.all();
      
      // Create multiple metrics
      const countFetch = vi.fn().mockResolvedValue(10);
      const sumFetch = vi.fn().mockResolvedValue(500);
      
      const countStore = metricStoreRegistry.getStore(
        queryset,
        'count',
        null,
        countFetch,
        0
      );
      
      const sumStore = metricStoreRegistry.getStore(
        queryset,
        'sum',
        'value',
        sumFetch,
        0
      );
      
      // Add spies to track calls to sync methods
      const countSyncSpy = vi.spyOn(countStore, 'sync');
      const sumSyncSpy = vi.spyOn(sumStore, 'sync');
      
      // Mock render methods
      vi.spyOn(countStore, 'render').mockReturnValue(10);
      vi.spyOn(sumStore, 'render').mockReturnValue(500);
      
      // Sync all metrics
      await metricStoreRegistry.syncAll();
      
      // Should have called sync on both stores
      expect(countSyncSpy).toHaveBeenCalled();
      expect(sumSyncSpy).toHaveBeenCalled();
      
      // Values should be updated
      const countEntity = metricStoreRegistry.getEntity(queryset, 'count');
      expect(countEntity.value).toBe(10);
      
      const sumEntity = metricStoreRegistry.getEntity(queryset, 'sum', 'value');
      expect(sumEntity.value).toBe(500);
      
      // Clean up
      countSyncSpy.mockRestore();
      sumSyncSpy.mockRestore();
    });
  });
  
  describe('Key Generation', () => {
    test('should generate different keys for different metrics', () => {
      const generateKey = vi.spyOn(metricStoreRegistry, '_generateKey');
      
      const queryset = DummyModel.objects.all();
      const fetchMetricValue = vi.fn();
      
      // Different metric types
      metricStoreRegistry.getStore(queryset, 'count', null, fetchMetricValue);
      metricStoreRegistry.getStore(queryset, 'sum', 'value', fetchMetricValue);
      
      // Should have generated different keys
      const firstCall = generateKey.mock.results[0].value;
      const secondCall = generateKey.mock.results[1].value;
      
      expect(firstCall).not.toBe(secondCall);
      expect(firstCall).toContain('count');
      expect(secondCall).toContain('sum::value');
      
      generateKey.mockRestore();
    });
    
    test('should generate different keys for different models', () => {
      const generateKey = vi.spyOn(metricStoreRegistry, '_generateKey');
      
      // Different model classes
      const dummyQueryset = DummyModel.objects.all();
      const relatedQueryset = DummyRelatedModel.objects.all();
      const fetchMetricValue = vi.fn();
      
      metricStoreRegistry.getStore(dummyQueryset, 'count', null, fetchMetricValue);
      metricStoreRegistry.getStore(relatedQueryset, 'count', null, fetchMetricValue);
      
      // Should have generated different keys
      const firstCall = generateKey.mock.results[0].value;
      const secondCall = generateKey.mock.results[1].value;
      
      expect(firstCall).not.toBe(secondCall);
      expect(firstCall).toContain('default::django_app.dummymodel');
      expect(secondCall).toContain('default::django_app.dummyrelatedmodel');
      
      generateKey.mockRestore();
    });
    
    test('should generate different keys for different querysets', () => {
      const generateKey = vi.spyOn(metricStoreRegistry, '_generateKey');
      
      // Create querysets with different filters
      const queryset1 = DummyModel.objects.all();
      const queryset2 = DummyModel.objects.filter({ name: 'test' });
      const fetchMetricValue = vi.fn();
      
      metricStoreRegistry.getStore(queryset1, 'count', null, fetchMetricValue);
      metricStoreRegistry.getStore(queryset2, 'count', null, fetchMetricValue);
      
      // Should have generated different keys due to different ASTs
      const firstCall = generateKey.mock.results[0].value;
      const secondCall = generateKey.mock.results[1].value;
      
      expect(firstCall).not.toBe(secondCall);
      
      generateKey.mockRestore();
    });
  });
  
  describe('Factory Functions', () => {
    test('should create fetch function for count metric', () => {
      const queryset = DummyModel.objects.all();
      // Mock the executeQuery method
      const executeQuerySpy = vi.spyOn(queryset, 'executeQuery')
        .mockImplementation(ast => {
          // Check the AST properties
          expect(ast.type).toBe('count');
          return Promise.resolve({ data: 5 });
        });
      
      // Create fetch function
      const fetchFn = metricStoreRegistry.createFetchMetricValueFn(queryset, 'count');
      
      // Should be a function
      expect(typeof fetchFn).toBe('function');
      
      // Call the function
      return fetchFn().then(value => {
        // Should return the result from executeQuery
        expect(value).toBe(5);
        
        // Should have called executeQuery on the queryset
        expect(executeQuerySpy).toHaveBeenCalled();
        
        // Clean up
        executeQuerySpy.mockRestore();
      });
    });
    
    test('should create fetch function for sum metric with field', () => {
      const queryset = DummyModel.objects.all();
      // Mock the executeQuery method
      const executeQuerySpy = vi.spyOn(queryset, 'executeQuery')
        .mockImplementation(ast => {
          // Check the AST properties
          expect(ast.type).toBe('sum');
          expect(ast.field).toBe('value');
          return Promise.resolve({ data: 500 });
        });
      
      // Create fetch function with field
      const fetchFn = metricStoreRegistry.createFetchMetricValueFn(queryset, 'sum', 'value');
      
      // Call the function
      return fetchFn().then(value => {
        // Should return the result from executeQuery
        expect(value).toBe(500);
        
        // Should have called executeQuery on the queryset
        expect(executeQuerySpy).toHaveBeenCalled();
        
        // Clean up
        executeQuerySpy.mockRestore();
      });
    });
    
    test('should handle errors in fetch function', () => {
      const queryset = DummyModel.objects.all();
      // Mock the executeQuery method to reject
      const executeQuerySpy = vi.spyOn(queryset, 'executeQuery')
        .mockRejectedValue(new Error('Test error'));
      
      // Create fetch function
      const fetchFn = metricStoreRegistry.createFetchMetricValueFn(queryset, 'count');
      
      // Error should be propagated
      return expect(fetchFn()).rejects.toThrow('Test error')
        .finally(() => {
          // Clean up
          executeQuerySpy.mockRestore();
        });
    });
  });
  
  describe('Integration with MetricStore', () => {
    test('should track metric values with underlying stores', async () => {
      const queryset = DummyModel.objects.all();
      
      // Mock implementation that returns different values on subsequent calls
      let callCount = 0;
      const fetchMetricValue = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount * 10); // 10, 20, 30, etc.
      });
      
      // Create store and get initial value
      const store = metricStoreRegistry.getStore(
        queryset,
        'count',
        null,
        fetchMetricValue,
        0 // Initial value
      );
      
      // Mock the render method based on current value
      // We need to mock render() to return the appropriate values at each step
      const renderSpy = vi.spyOn(store, 'render');
      
      // For initial state, return 0
      renderSpy.mockReturnValueOnce(0);
      
      // Initial value
      const initialEntity = metricStoreRegistry.getEntity(queryset, 'count');
      expect(initialEntity.value).toBe(0);
      
      // Update mock for first sync (return 10)
      renderSpy.mockReturnValueOnce(10);
      
      // First sync
      await metricStoreRegistry.sync(queryset, 'count');
      
      // Value should be updated to 10
      const firstEntity = metricStoreRegistry.getEntity(queryset, 'count');
      expect(firstEntity.value).toBe(10);
      
      // Update mock for second sync (return 20)
      renderSpy.mockReturnValueOnce(20);
      
      // Second sync
      await metricStoreRegistry.sync(queryset, 'count');
      
      // Value should be updated to 20
      const secondEntity = metricStoreRegistry.getEntity(queryset, 'count');
      expect(secondEntity.value).toBe(20);
      
      // Update mock for manual value set (return 50)
      renderSpy.mockReturnValueOnce(50);
      
      // Set value manually
      metricStoreRegistry.setEntity(queryset, 'count', null, 50);
      
      // Value should be 50
      const manualEntity = metricStoreRegistry.getEntity(queryset, 'count');
      expect(manualEntity.value).toBe(50);
      
      // Update mock for third sync (return 30)
      renderSpy.mockReturnValueOnce(30);
      
      // Third sync
      await metricStoreRegistry.sync(queryset, 'count');
      
      // Value should be updated to 30
      const thirdEntity = metricStoreRegistry.getEntity(queryset, 'count');
      expect(thirdEntity.value).toBe(30);
      
      // Clean up
      renderSpy.mockRestore();
    });
    
    test('should use different strategies for different metric types', () => {
      const queryset = DummyModel.objects.all();
      const fetchMetricValue = vi.fn();
      
      // Get stores for different metric types
      const countStore = metricStoreRegistry.getStore(
        queryset, 'count', null, fetchMetricValue
      );
      
      const sumStore = metricStoreRegistry.getStore(
        queryset, 'sum', 'value', fetchMetricValue
      );
      
      const minStore = metricStoreRegistry.getStore(
        queryset, 'min', 'value', fetchMetricValue
      );
      
      const maxStore = metricStoreRegistry.getStore(
        queryset, 'max', 'value', fetchMetricValue
      );
      
      // Should have correct strategy types
      expect(countStore.strategy).toBeInstanceOf(CountStrategy);
      expect(sumStore.strategy).toBeInstanceOf(SumStrategy);
      expect(minStore.strategy).toBeInstanceOf(MinStrategy);
      expect(maxStore.strategy).toBeInstanceOf(MaxStrategy);
    });
    
    test('should get all stores for a queryset', () => {
      const queryset = DummyModel.objects.all();
      const fetchMetricValue = vi.fn();
      
      // Create multiple stores for the same queryset
      const countStore = metricStoreRegistry.getStore(
        queryset, 'count', null, fetchMetricValue
      );
      
      const sumStore = metricStoreRegistry.getStore(
        queryset, 'sum', 'value', fetchMetricValue
      );
      
      // Get all stores for the queryset
      const stores = metricStoreRegistry.getStoresForQueryset(queryset);
      
      // Should return both stores
      expect(stores).toHaveLength(2);
      expect(stores).toContain(countStore);
      expect(stores).toContain(sumStore);
    });
  });
});