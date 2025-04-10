import { MetricStore } from '../../src/syncEngine/stores/metricStore.js';
import { 
  CountStrategy, 
  SumStrategy, 
  MinStrategy, 
  MaxStrategy,
  MetricStrategyFactory 
} from '../../src/syncEngine/stores/metricOptCalcs.js'
import { ModelStore } from '../../src/syncEngine/stores/modelStore.js';
import { Operation } from '../../src/syncEngine/stores/operation.js';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// Enhanced SimpleDB with metric calculation capabilities
class SimpleDB {
  constructor(initialData = [], pkField = 'id') {
    this.data = JSON.parse(JSON.stringify(initialData));
    this.pkField = pkField;
  }

  // Basic CRUD operations
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

  // Metric calculation methods
  count(field = null) {
    if (!field) {
      return this.data.length;
    }
    
    return this.data.filter(item => 
      item && typeof item === 'object' && item[field] !== null && item[field] !== undefined
    ).length;
  }

  sum(field) {
    if (!field) return 0;

    return this.data
      .filter(item => item && typeof item === 'object')
      .map(item => item[field])
      .filter(value => value !== null && value !== undefined && !isNaN(parseFloat(value)))
      .reduce((total, value) => total + parseFloat(value), 0);
  }

  min(field) {
    if (!field) return null;

    const values = this.data
      .filter(item => item && typeof item === 'object')
      .map(item => item[field])
      .filter(value => value !== null && value !== undefined && !isNaN(parseFloat(value)))
      .map(value => parseFloat(value));
    
    if (values.length === 0) return null;
    return Math.min(...values);
  }

  max(field) {
    if (!field) return null;

    const values = this.data
      .filter(item => item && typeof item === 'object')
      .map(item => item[field])
      .filter(value => value !== null && value !== undefined && !isNaN(parseFloat(value)))
      .map(value => parseFloat(value));
    
    if (values.length === 0) return null;
    return Math.max(...values);
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

describe('MetricStore', () => {
  // Mock fetch functions
  const mockDataFetch = vi.fn();
  const mockMetricFetch = vi.fn();
  
  let simpleDb;
  let modelStore;
  let initialData;
  
  beforeEach(() => {
    // Reset mocks
    mockDataFetch.mockReset();
    mockMetricFetch.mockReset();
    vi.useFakeTimers();
    
    // Initial data
    initialData = [
      { id: 1, name: 'Item 1', amount: 100, score: 5.5 },
      { id: 2, name: 'Item 2', amount: 200, score: 7.5 },
      { id: 3, name: 'Item 3', amount: 300, score: 9.0 }
    ];
    
    // Initialize stores
    simpleDb = new SimpleDB(initialData, 'id');
    
    // Set up ModelStore
    modelStore = new ModelStore(
      TestModel,
      mockDataFetch,
      [...initialData], // Initialize with same data
      []  // No operations initially
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Count Metric', () => {
    test('should calculate count correctly with no operations', () => {
      // Create metric
      const countMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createCountStrategy(),
        initialValue: simpleDb.count(), // Start with current count
        name: 'ItemCount'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data on metric and render
      countMetric.setGroundTruthData(groundTruthData);
      countMetric.setOptimisticData(optimisticData);
      const metricValue = countMetric.render();
      
      // Compare with SimpleDB count
      expect(metricValue).toBe(simpleDb.count());
      expect(metricValue).toBe(3);
    });
    
    test('should update count when items are added', () => {
      // Start with current count
      const initialCount = simpleDb.count();
      
      // Add new item to modelStore
      const newItem = { id: 4, name: 'Item 4', amount: 400, score: 8.0 };
      
      const createOp = new Operation({
        operationId: 'op-create-1',
        type: 'create',
        instances: [newItem],
        status: 'pending'
      });
      
      modelStore.addOperation(createOp);
      
      // Also add to SimpleDB
      simpleDb.create(newItem);
      
      // Create metric with original count
      const countMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createCountStrategy(),
        initialValue: initialCount,
        name: 'ItemCount'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data on metric and render
      countMetric.setGroundTruthData(groundTruthData);
      countMetric.setOptimisticData(optimisticData);
      const metricValue = countMetric.render();
      
      // Compare with SimpleDB
      expect(metricValue).toBe(simpleDb.count());
      expect(metricValue).toBe(4); // Count increased to 4
    });
    
    test('should update count when items are deleted', () => {
      // Start with current count
      const initialCount = simpleDb.count();
      
      // Delete an item from modelStore
      const deleteOp = new Operation({
        operationId: 'op-delete-1',
        type: 'delete',
        instances: [{ id: 3 }],
        status: 'pending'
      });
      
      modelStore.addOperation(deleteOp);
      
      // Also delete from SimpleDB
      simpleDb.delete(3);
      
      // Create metric with original count
      const countMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createCountStrategy(),
        initialValue: initialCount,
        name: 'ItemCount'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data on metric and render
      countMetric.setGroundTruthData(groundTruthData);
      countMetric.setOptimisticData(optimisticData);
      const metricValue = countMetric.render();
      
      // Compare with SimpleDB
      expect(metricValue).toBe(simpleDb.count());
      expect(metricValue).toBe(2); // Count decreased to 2
    });
    
    test('should handle field-specific count', () => {
      // Add an item without 'amount' field
      const itemWithoutAmount = { id: 5, name: 'No Amount' };
      modelStore.addOperation(new Operation({
        operationId: 'op-create-no-amount',
        type: 'create',
        instances: [itemWithoutAmount],
        status: 'pending'
      }));
      
      simpleDb.create(itemWithoutAmount);
      
      // Create metric with field-specific count
      const fieldCountMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createCountStrategy(),
        field: 'amount', // Only count items with amount field
        initialValue: simpleDb.count('amount'),
        name: 'AmountCount'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data on metric and render
      fieldCountMetric.setGroundTruthData(groundTruthData);
      fieldCountMetric.setOptimisticData(optimisticData);
      const metricValue = fieldCountMetric.render();
      
      // Compare with SimpleDB
      expect(metricValue).toBe(simpleDb.count('amount'));
      expect(metricValue).toBe(3); // Only 3 items have 'amount' field
    });
  });

  describe('Sum Metric', () => {
    test('should calculate sum correctly with no operations', () => {
      // Create metric
      const sumMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createSumStrategy(),
        field: 'amount',
        initialValue: simpleDb.sum('amount'), // Start with current sum
        name: 'AmountSum'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data on metric and render
      sumMetric.setGroundTruthData(groundTruthData);
      sumMetric.setOptimisticData(optimisticData);
      const metricValue = sumMetric.render();
      
      // Compare with SimpleDB
      expect(metricValue).toBe(simpleDb.sum('amount'));
      expect(metricValue).toBe(600); // 100 + 200 + 300
    });
    
    test('should update sum when items are added', () => {
      // Start with current sum
      const initialSum = simpleDb.sum('amount');
      
      // Add new item to modelStore
      const newItem = { id: 4, name: 'Item 4', amount: 400, score: 8.0 };
      
      const createOp = new Operation({
        operationId: 'op-create-1',
        type: 'create',
        instances: [newItem],
        status: 'pending'
      });
      
      modelStore.addOperation(createOp);
      
      // Also add to SimpleDB
      simpleDb.create(newItem);
      
      // Create metric with original sum
      const sumMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createSumStrategy(),
        field: 'amount',
        initialValue: initialSum,
        name: 'AmountSum'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data on metric and render
      sumMetric.setGroundTruthData(groundTruthData);
      sumMetric.setOptimisticData(optimisticData);
      const metricValue = sumMetric.render();
      
      // Compare with SimpleDB
      expect(metricValue).toBe(simpleDb.sum('amount'));
      expect(metricValue).toBe(1000); // 100 + 200 + 300 + 400
    });
    
    test('should update sum when items are updated', () => {
      // Start with current sum
      const initialSum = simpleDb.sum('amount');
      
      // Update an item in modelStore
      const updateOp = new Operation({
        operationId: 'op-update-1',
        type: 'update',
        instances: [{ id: 2, amount: 250 }], // Increase from 200 to 250
        status: 'pending'
      });
      
      modelStore.addOperation(updateOp);
      
      // Also update in SimpleDB
      simpleDb.update({ id: 2, amount: 250 });
      
      // Create metric with original sum
      const sumMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createSumStrategy(),
        field: 'amount',
        initialValue: initialSum,
        name: 'AmountSum'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data on metric and render
      sumMetric.setGroundTruthData(groundTruthData);
      sumMetric.setOptimisticData(optimisticData);
      const metricValue = sumMetric.render();
      
      // Compare with SimpleDB
      expect(metricValue).toBe(simpleDb.sum('amount'));
      expect(metricValue).toBe(650); // 100 + 250 + 300
    });
    
    test('should update sum when items are deleted', () => {
      // Start with current sum
      const initialSum = simpleDb.sum('amount');
      
      // Delete an item from modelStore
      const deleteOp = new Operation({
        operationId: 'op-delete-1',
        type: 'delete',
        instances: [{ id: 3 }], // Item with amount 300
        status: 'pending'
      });
      
      modelStore.addOperation(deleteOp);
      
      // Also delete from SimpleDB
      simpleDb.delete(3);
      
      // Create metric with original sum
      const sumMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createSumStrategy(),
        field: 'amount',
        initialValue: initialSum,
        name: 'AmountSum'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data on metric and render
      sumMetric.setGroundTruthData(groundTruthData);
      sumMetric.setOptimisticData(optimisticData);
      const metricValue = sumMetric.render();
      
      // Compare with SimpleDB
      expect(metricValue).toBe(simpleDb.sum('amount'));
      expect(metricValue).toBe(300); // 100 + 200
    });
  });

  describe('Min Metric', () => {
    test('should calculate min correctly with no operations', () => {
      // Create metric
      const minMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createMinStrategy(),
        field: 'amount',
        initialValue: simpleDb.min('amount'), // Start with current min
        name: 'AmountMin'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data on metric and render
      minMetric.setGroundTruthData(groundTruthData);
      minMetric.setOptimisticData(optimisticData);
      const metricValue = minMetric.render();
      
      // Compare with SimpleDB
      expect(metricValue).toBe(simpleDb.min('amount'));
      expect(metricValue).toBe(100); // Minimum is 100
    });
    
    test('should update min when item with lower value is added', () => {
      // Start with current min
      const initialMin = simpleDb.min('amount');
      
      // Add new item with lower amount to modelStore
      const newItem = { id: 4, name: 'Item 4', amount: 50, score: 8.0 };
      
      const createOp = new Operation({
        operationId: 'op-create-1',
        type: 'create',
        instances: [newItem],
        status: 'pending'
      });
      
      modelStore.addOperation(createOp);
      
      // Also add to SimpleDB
      simpleDb.create(newItem);
      
      // Create metric with original min
      const minMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createMinStrategy(),
        field: 'amount',
        initialValue: initialMin,
        name: 'AmountMin'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data on metric and render
      minMetric.setGroundTruthData(groundTruthData);
      minMetric.setOptimisticData(optimisticData);
      const metricValue = minMetric.render();
      
      // Compare with SimpleDB
      expect(metricValue).toBe(simpleDb.min('amount'));
      expect(metricValue).toBe(50); // New minimum is 50
    });
    
    test('should keep min when current min is deleted but not lowest', () => {
      // First, update item 1 to have a higher amount
      modelStore.addOperation(new Operation({
        operationId: 'op-update-1',
        type: 'update',
        instances: [{ id: 1, amount: 150 }], // Increase from 100 to 150
        status: 'pending'
      }));
      
      simpleDb.update({ id: 1, amount: 150 });
      
      // Add a new min item
      const newMinItem = { id: 4, name: 'New Min', amount: 50 };
      modelStore.addOperation(new Operation({
        operationId: 'op-create-min',
        type: 'create',
        instances: [newMinItem],
        status: 'pending'
      }));
      
      simpleDb.create(newMinItem);
      
      // Now delete the new min item
      modelStore.addOperation(new Operation({
        operationId: 'op-delete-min',
        type: 'delete',
        instances: [{ id: 4 }],
        status: 'pending'
      }));
      
      simpleDb.delete(4);
      
      // Create metric that knows about the original min
      const minMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createMinStrategy(),
        field: 'amount',
        initialValue: 100, // Original min
        name: 'AmountMin'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data on metric and render
      minMetric.setGroundTruthData(groundTruthData);
      minMetric.setOptimisticData(optimisticData);
      const metricValue = minMetric.render();
      
      // In this case, we expect the min to remain at the original value (100)
      // since the MetricStore can't detect that the min has changed to 150
      // without a server sync. This is expected behavior.
      expect(metricValue).toBe(100);
      
      // But SimpleDB calculates directly from current data
      expect(simpleDb.min('amount')).toBe(150);
    });
  });

  describe('Max Metric', () => {
    test('should calculate max correctly with no operations', () => {
      // Create metric
      const maxMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createMaxStrategy(),
        field: 'amount',
        initialValue: simpleDb.max('amount'), // Start with current max
        name: 'AmountMax'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data on metric and render
      maxMetric.setGroundTruthData(groundTruthData);
      maxMetric.setOptimisticData(optimisticData);
      const metricValue = maxMetric.render();
      
      // Compare with SimpleDB
      expect(metricValue).toBe(simpleDb.max('amount'));
      expect(metricValue).toBe(300); // Maximum is 300
    });
    
    test('should update max when item with higher value is added', () => {
      // Start with current max
      const initialMax = simpleDb.max('amount');
      
      // Add new item with higher amount to modelStore
      const newItem = { id: 4, name: 'Item 4', amount: 500, score: 8.0 };
      
      const createOp = new Operation({
        operationId: 'op-create-1',
        type: 'create',
        instances: [newItem],
        status: 'pending'
      });
      
      modelStore.addOperation(createOp);
      
      // Also add to SimpleDB
      simpleDb.create(newItem);
      
      // Create metric with original max
      const maxMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createMaxStrategy(),
        field: 'amount',
        initialValue: initialMax,
        name: 'AmountMax'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data on metric and render
      maxMetric.setGroundTruthData(groundTruthData);
      maxMetric.setOptimisticData(optimisticData);
      const metricValue = maxMetric.render();
      
      // Compare with SimpleDB
      expect(metricValue).toBe(simpleDb.max('amount'));
      expect(metricValue).toBe(500); // New maximum is 500
    });
    
    test('should update max when current max is updated', () => {
      // Start with current max
      const initialMax = simpleDb.max('amount');
      
      // Update max item in modelStore
      const updateOp = new Operation({
        operationId: 'op-update-max',
        type: 'update',
        instances: [{ id: 3, amount: 350 }], // Increase from 300 to 350
        status: 'pending'
      });
      
      modelStore.addOperation(updateOp);
      
      // Also update in SimpleDB
      simpleDb.update({ id: 3, amount: 350 });
      
      // Create metric with original max
      const maxMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createMaxStrategy(),
        field: 'amount',
        initialValue: initialMax,
        name: 'AmountMax'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data on metric and render
      maxMetric.setGroundTruthData(groundTruthData);
      maxMetric.setOptimisticData(optimisticData);
      const metricValue = maxMetric.render();
      
      // Compare with SimpleDB
      expect(metricValue).toBe(simpleDb.max('amount'));
      expect(metricValue).toBe(350); // Updated maximum is 350
    });
    
    test('should handle when max item is deleted', () => {
      // Start with current max
      const initialMax = simpleDb.max('amount');
      
      // Delete max item from modelStore
      const deleteOp = new Operation({
        operationId: 'op-delete-max',
        type: 'delete',
        instances: [{ id: 3 }], // Delete item with amount 300 (current max)
        status: 'pending'
      });
      
      modelStore.addOperation(deleteOp);
      
      // Also delete from SimpleDB
      simpleDb.delete(3);
      
      // Create metric with original max
      const maxMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createMaxStrategy(),
        field: 'amount',
        initialValue: initialMax,
        name: 'AmountMax'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data on metric and render
      maxMetric.setGroundTruthData(groundTruthData);
      maxMetric.setOptimisticData(optimisticData);
      const metricValue = maxMetric.render();
      
      // When the max item is deleted, the metric should reflect the original ground truth value
      // until it syncs with the server to get the new accurate max
      expect(metricValue).toBe(initialMax);
      
      // But SimpleDB will calculate the new max directly
      expect(simpleDb.max('amount')).toBe(200);
    });
  });

  describe('Complex Scenarios', () => {
    test('should handle multiple operations', () => {
      // Record initial metric values
      const initialCount = simpleDb.count();
      const initialSum = simpleDb.sum('amount');
      const initialMin = simpleDb.min('amount');
      const initialMax = simpleDb.max('amount');
      
      // Perform multiple operations
      
      // 1. Add a new item
      const newItem = { id: 4, name: 'Item 4', amount: 50, score: 5.0 };
      modelStore.addOperation(new Operation({
        operationId: 'op-complex-1',
        type: 'create',
        instances: [newItem],
        status: 'pending'
      }));
      simpleDb.create(newItem);
      
      // 2. Update an existing item
      modelStore.addOperation(new Operation({
        operationId: 'op-complex-2',
        type: 'update',
        instances: [{ id: 2, amount: 250 }], // Increase from 200 to 250
        status: 'pending'
      }));
      simpleDb.update({ id: 2, amount: 250 });
      
      // 3. Delete an item
      modelStore.addOperation(new Operation({
        operationId: 'op-complex-3',
        type: 'delete',
        instances: [{ id: 3 }], // Delete item with amount 300
        status: 'pending'
      }));
      simpleDb.delete(3);
      
      // Create metrics with original values
      const countMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createCountStrategy(),
        initialValue: initialCount,
        name: 'ComplexCount'
      });
      
      const sumMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createSumStrategy(),
        field: 'amount',
        initialValue: initialSum,
        name: 'ComplexSum'
      });
      
      const minMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createMinStrategy(),
        field: 'amount',
        initialValue: initialMin,
        name: 'ComplexMin'
      });
      
      const maxMetric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createMaxStrategy(),
        field: 'amount',
        initialValue: initialMax,
        name: 'ComplexMax'
      });
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data and render all metrics
      countMetric.setGroundTruthData(groundTruthData).setOptimisticData(optimisticData);
      sumMetric.setGroundTruthData(groundTruthData).setOptimisticData(optimisticData);
      minMetric.setGroundTruthData(groundTruthData).setOptimisticData(optimisticData);
      maxMetric.setGroundTruthData(groundTruthData).setOptimisticData(optimisticData);
      
      // Check count metric
      expect(countMetric.render()).toBe(simpleDb.count());
      expect(countMetric.render()).toBe(3); // Added 1, removed 1, net change 0
      
      // Check sum metric
      expect(sumMetric.render()).toBe(simpleDb.sum('amount'));
      expect(sumMetric.render()).toBe(400); // Added 50, updated +50, removed 300, net change -200
      
      // Check min metric
      expect(minMetric.render()).toBe(simpleDb.min('amount'));
      expect(minMetric.render()).toBe(50); // New min is 50
      
      // Check max metric - this one will be different because we removed the max item!
      // MetricStore can't know the next max value without a server sync
      expect(maxMetric.render()).toBe(initialMax); 
      expect(simpleDb.max('amount')).toBe(250); // SimpleDB just recalculates directly
    });
    
    test('should handle sync with fetchMetricValue', async () => {
      // Start with current metrics
      const initialCount = simpleDb.count();
      const initialSum = simpleDb.sum('amount');
      
      // Set up metrics
      const countMetric = new MetricStore({
        fetchMetricValue: () => Promise.resolve(5), // Server returns 5 as the count
        strategy: MetricStrategyFactory.createCountStrategy(),
        initialValue: initialCount,
        name: 'SyncCount'
      });
      
      const sumMetric = new MetricStore({
        fetchMetricValue: () => Promise.resolve(800), // Server returns 800 as the sum
        strategy: MetricStrategyFactory.createSumStrategy(),
        field: 'amount',
        initialValue: initialSum,
        name: 'SyncSum'
      });
      
      // Add an item to modelStore
      const newItem = { id: 4, name: 'Item 4', amount: 400, score: 8.0 };
      modelStore.addOperation(new Operation({
        operationId: 'op-sync-1',
        type: 'create',
        instances: [newItem],
        status: 'pending'
      }));
      
      // Also add to SimpleDB
      simpleDb.create(newItem);
      
      // Get data from model store
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      // Set data and render both metrics
      countMetric.setGroundTruthData(groundTruthData);
      countMetric.setOptimisticData(optimisticData);
      
      sumMetric.setGroundTruthData(groundTruthData);
      sumMetric.setOptimisticData(optimisticData);
      
      // Before sync, metrics should show optimistic values
      expect(countMetric.render()).toBe(4); // 3 + 1 new item
      expect(sumMetric.render()).toBe(1000); // 600 + 400 from new item
      
      // Sync both metrics (this would normally happen from ModelStore sync trigger)
      await countMetric.sync();
      await sumMetric.sync();
      
      // After sync, the ground truth values are updated from server
      expect(countMetric.getGroundTruth()).toBe(5);
      expect(sumMetric.getGroundTruth()).toBe(800);
      
      // Rendered values should reflect new ground truth plus optimistic changes
      expect(countMetric.render()).toBe(6); // 5 from server + 1 optimistic item
      expect(sumMetric.render()).toBe(1200); // 800 from server + 400 from optimistic item
    });
    
    test('should handle complex data changes after sync', async () => {
      // Set up metrics
      const countMetric = new MetricStore({
        fetchMetricValue: () => Promise.resolve(10), // Server says total count is 10
        strategy: MetricStrategyFactory.createCountStrategy(),
        initialValue: 3, // Initial count is 3
        name: 'ComplexSyncCount'
      });
      
      const sumMetric = new MetricStore({
        fetchMetricValue: () => Promise.resolve(1500), // Server says total sum is 1500
        strategy: MetricStrategyFactory.createSumStrategy(),
        field: 'amount',
        initialValue: 600, // Initial sum is 600
        name: 'ComplexSyncSum'
      });
      
      // First render with original values
      const groundTruthData = modelStore.getGroundTruth();
      const optimisticData = modelStore.render();
      
      countMetric.setGroundTruthData(groundTruthData);
      countMetric.setOptimisticData(optimisticData);
      
      sumMetric.setGroundTruthData(groundTruthData);
      sumMetric.setOptimisticData(optimisticData);
      
      // Initial optimistic values should match current data
      expect(countMetric.render()).toBe(3);
      expect(sumMetric.render()).toBe(600);
      
      // Sync metrics with server values
      await countMetric.sync();
      await sumMetric.sync();
      
      // Values should now reflect the server ground truth
      expect(countMetric.getGroundTruth()).toBe(10);
      expect(sumMetric.getGroundTruth()).toBe(1500);
      
      // Add operations to ModelStore
      modelStore.addOperation(new Operation({
        operationId: 'op-sync-complex-1',
        type: 'create',
        instances: [
          { id: 4, name: 'New Item 4', amount: 400 },
          { id: 5, name: 'New Item 5', amount: 500 }
        ],
        status: 'pending'
      }));
      
      modelStore.addOperation(new Operation({
        operationId: 'op-sync-complex-2',
        type: 'delete',
        instances: [{ id: 1 }], // Delete item with amount 100
        status: 'pending'
      }));
      
      // Update SimpleDB to match
      simpleDb.create({ id: 4, name: 'New Item 4', amount: 400 });
      simpleDb.create({ id: 5, name: 'New Item 5', amount: 500 });
      simpleDb.delete(1);
      
      // Get updated data from model store
      const updatedGroundTruthData = modelStore.getGroundTruth();
      const updatedOptimisticData = modelStore.render();
      
      // Update metrics with new data
      countMetric.setGroundTruthData(updatedGroundTruthData);
      countMetric.setOptimisticData(updatedOptimisticData);
      
      sumMetric.setGroundTruthData(updatedGroundTruthData);
      sumMetric.setOptimisticData(updatedOptimisticData);
      
      // Check optimistic values after operations
      // Count: +2 created, -1 deleted = net +1
      expect(countMetric.render()).toBe(11); // 10 base + net change of 1
      
      // Sum: +400 +500 -100 = net +800
      expect(sumMetric.render()).toBe(2300); // 1500 base + net change of 800
    });
  });
  
  describe('Sync', () => {
    test('should update value when syncing', async () => {
      const metric = new MetricStore({
        fetchMetricValue: () => Promise.resolve(10), // Different from initial value
        strategy: MetricStrategyFactory.createCountStrategy(),
        initialValue: 3,
        name: 'SyncTest'
      });
      
      await metric.sync();
      
      // Only check that the value was updated
      expect(metric.getGroundTruth()).toBe(10);
    });
    
    test('should keep same value when sync yields same value', async () => {
      const metric = new MetricStore({
        fetchMetricValue: () => Promise.resolve(3), // Same as initial value
        strategy: MetricStrategyFactory.createCountStrategy(),
        initialValue: 3,
        name: 'NoChangeTest'
      });
      
      await metric.sync();
      
      // Verify value remains unchanged
      expect(metric.getGroundTruth()).toBe(3);
    });
    
    test('should handle errors during sync without changing value', async () => {
      const metric = new MetricStore({
        fetchMetricValue: () => Promise.reject(new Error('Sync failed')),
        strategy: MetricStrategyFactory.createCountStrategy(),
        initialValue: 3,
        name: 'ErrorSync'
      });
      
      await metric.sync();
      
      // Value should not change on sync error
      expect(metric.getGroundTruth()).toBe(3);
      expect(metric.lastSyncError).not.toBeNull();
    });
  });
  
  describe('Resource Cleanup', () => {
    test('should clean up resources when destroyed', () => {
      const metric = new MetricStore({
        fetchMetricValue: mockMetricFetch,
        strategy: MetricStrategyFactory.createCountStrategy(),
        initialValue: 3,
        name: 'CleanupTest'
      });
      
      // Set some data
      metric.setGroundTruthData([{ id: 1 }, { id: 2 }]);
      metric.setOptimisticData([{ id: 1 }, { id: 2 }, { id: 3 }]);
      
      // Destroy the metric
      metric.destroy();
      
      // Check that resources are cleaned up
      expect(metric.strategy).toBeNull();
      expect(metric.groundTruthDataSlice).toBeNull();
      expect(metric.optimisticDataSlice).toBeNull();
    });
  });
});