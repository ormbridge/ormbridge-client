import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { QueryState } from '../../src/core-refactor/state/QueryState.js';
import { RenderEngine } from '../../src/core-refactor/rendering/RenderEngine.js';
import {
    Metric
} from '../../src/core-refactor/state/MetricState.js'
import {
  MetricRenderEngine,
  CountStrategy,
  SumStrategy,
  MinStrategy,
  MaxStrategy,
  MetricStrategyFactory
} from '../../src/core-refactor/rendering/MetricRenderEngine.js';

// Simple in-memory database for comparison that includes metric calculation methods
class SimpleDB {
  constructor(initialData = [], pkField = 'id') {
    this.data = initialData.map(item => ({...item})); // Deep copy initial data
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

  // Helper to get valid numeric values, mirroring internal logic
  _getNumericValues(field, filterFn = null) {
      let dataSet = filterFn ? this.data.filter(filterFn) : this.data;
      return dataSet
          .map(item => item[field])
          .filter(value => value !== null && value !== undefined && !isNaN(parseFloat(value)))
          .map(value => parseFloat(value));
  }


  getAll(sortFn) {
    const result = [...this.data];
    return sortFn ? result.sort(sortFn) : result;
  }

  getPaginated(offset = 0, limit = 10, sortFn) {
    const sorted = this.getAll(sortFn);
    return sorted.slice(offset, offset + limit);
  }

  count(filterFn = null) {
    if (filterFn) {
      return this.data.filter(filterFn).length;
    }
    return this.data.length;
  }

  // Count items having a specific field (non-null/undefined)
  countField(field, filterFn = null) {
      let dataSet = filterFn ? this.data.filter(filterFn) : this.data;
      return dataSet.filter(item => item && typeof item === 'object' && item[field] !== null && item[field] !== undefined).length;
  }

  sum(field, filterFn = null) {
      const values = this._getNumericValues(field, filterFn);
      if (values.length === 0) return 0;
      return values.reduce((total, value) => total + value, 0);
  }

  min(field, filterFn = null) {
      const values = this._getNumericValues(field, filterFn);
      if (values.length === 0) return null;
      return Math.min(...values);
  }

  max(field, filterFn = null) {
      const values = this._getNumericValues(field, filterFn);
      if (values.length === 0) return null;
      return Math.max(...values);
  }
}

const initialData = [
  { id: 1, name: 'Alice', role: 'admin', salary: 100000, rating: 4.8, active: true },
  { id: 2, name: 'Bob', role: 'user', salary: 75000, rating: 4.2, active: true },
  { id: 3, name: 'Charlie', role: 'user', salary: 85000, rating: 4.5, active: true }
];

// --- Metric Tests (Keep as is) ---
describe('Metric', () => {
    let queryState;
    let fetchMetricMock;

    beforeEach(() => {
        fetchMetricMock = vi.fn().mockResolvedValue(42);
        queryState = new QueryState({
            primaryKey: 'id',
            fetchGroundTruth: () => Promise.resolve([...initialData]), // Use copy
        });
        // No need to set ground truth here, Metric doesn't use it directly
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    test('should construct properly with required options', () => {
        const metric = new Metric({
            queryStateInstance: queryState,
            fetchMetricValue: fetchMetricMock,
            name: 'TestMetric'
        });
        expect(metric.queryState).toBe(queryState);
        expect(metric.fetchMetricValue).toBe(fetchMetricMock);
        expect(metric.metricName).toBe('TestMetric');
        expect(metric.value).toBe(null);
        metric.destroy(); // Cleanup
    });

    test('should throw error if required options are missing', () => {
        expect(() => new Metric()).toThrow();
        // Need mock QueryState with subscribe for this test
        const mockQS = { subscribe: vi.fn(() => vi.fn()), addListener: vi.fn(), removeListener: vi.fn() };
        expect(() => new Metric({})).toThrow();
        expect(() => new Metric({ queryStateInstance: mockQS })).toThrow();
        expect(() => new Metric({ fetchMetricValue: fetchMetricMock })).toThrow();
    });

     test('should throw error if queryStateInstance is invalid', () => {
         expect(() => new Metric({ queryStateInstance: {}, fetchMetricValue: fetchMetricMock })).toThrow(/must have a 'subscribe' method/);
     });


    test('should support initial value', () => {
        const metric = new Metric({
            queryStateInstance: queryState,
            fetchMetricValue: fetchMetricMock,
            initialValue: 100
        });
        expect(metric.value).toBe(100);
        metric.destroy();
    });

    test('should subscribe to QueryState sync events', async () => {
        const metric = new Metric({
            queryStateInstance: queryState,
            fetchMetricValue: fetchMetricMock,
            name: 'SyncSubTest'
        });

        // Manually trigger the event QueryState would emit
        queryState._notify('sync_started', {});

        // Give promise chance to resolve (fetchMetricValue is async)
        await vi.waitFor(() => {
          expect(fetchMetricMock).toHaveBeenCalled();
        });

        metric.destroy();
    });

    test('should update value after sync', async () => {
        fetchMetricMock.mockResolvedValue(100);
        const metric = new Metric({
            queryStateInstance: queryState,
            fetchMetricValue: fetchMetricMock,
            initialValue: null // Start with null
        });
        expect(metric.value).toBe(null);

        // Trigger sync manually (like Metric._subscribeToQueryState would)
        await metric.sync();

        expect(metric.value).toBe(100);
        expect(fetchMetricMock).toHaveBeenCalled();
        metric.destroy();
    });

    test('should handle sync errors gracefully', async () => {
        const error = new Error('Sync failed');
        fetchMetricMock.mockRejectedValue(error);
        const metric = new Metric({
            queryStateInstance: queryState,
            fetchMetricValue: fetchMetricMock,
            initialValue: 50
        });

        await metric.sync(); // Should not throw

        expect(metric.value).toBe(50); // Value remains unchanged
        expect(metric.lastSyncError).toBe(error);
        metric.destroy();
    });

    test('should clean up subscription on destroy', () => {
        const unsubscribeMock = vi.fn();
        const subscribeMock = vi.fn().mockReturnValue(unsubscribeMock);
        const mockQueryState = {
            subscribe: subscribeMock,
            // Add other methods if needed by QueryState constructor or Metric
        };

        const metric = new Metric({
            queryStateInstance: mockQueryState,
            fetchMetricValue: fetchMetricMock
        });

        // Spy on the actual unsubscriber stored internally if possible,
        // otherwise check if the mock returned by subscribe was called.
        // Direct spy might be tricky if unsubscriber is stored internally without exposure.
        // So, testing the mock is the reliable way here.

        metric.destroy();

        expect(unsubscribeMock).toHaveBeenCalled();
        // Optional: check if internal reference is cleared, though less critical than calling it
        expect(metric.queryStateUnsubscriber).toBe(null);
    });
});


// --- MetricRenderEngine Tests ---
describe('MetricRenderEngine', () => {
  let directDB;
  let queryState;
  let renderEngine;
  // Define metrics and mocks in the main scope for access in tests
  let countMetric, sumMetric, minMetric, maxMetric;
  let fetchCountMock, fetchSumMock, fetchMinMock, fetchMaxMock;

  beforeEach(() => {
    // Reset direct DB
    directDB = new SimpleDB(initialData); // Uses deep copy internally now

    // Mocks for ground truth metric values
    fetchCountMock = vi.fn().mockResolvedValue(directDB.count());
    fetchSumMock = vi.fn().mockResolvedValue(directDB.sum('salary'));
    fetchMinMock = vi.fn().mockResolvedValue(directDB.min('salary'));
    fetchMaxMock = vi.fn().mockResolvedValue(directDB.max('salary'));

    // Set up QueryState and RenderEngine
    queryState = new QueryState({
      primaryKey: 'id',
      fetchGroundTruth: () => Promise.resolve(initialData.map(i => ({...i}))) // Return copies
    });

    // Initialize ground truth IN QueryState
    queryState._setGroundTruth(initialData.map(i => ({...i}))); // Use copies

    renderEngine = new RenderEngine(queryState);

    // Create Metric instances with initial values matching directDB
    countMetric = new Metric({
        queryStateInstance: queryState,
        fetchMetricValue: fetchCountMock,
        initialValue: directDB.count(), // Use initial DB state
        name: 'TotalCount'
    });
     sumMetric = new Metric({
        queryStateInstance: queryState,
        fetchMetricValue: () => fetchSumMock('salary'), // Adjust mock if needed per test
        initialValue: directDB.sum('salary'),
        name: 'TotalSalary'
     });
     minMetric = new Metric({
        queryStateInstance: queryState,
        fetchMetricValue: () => fetchMinMock('salary'),
        initialValue: directDB.min('salary'),
        name: 'MinSalary'
     });
     maxMetric = new Metric({
        queryStateInstance: queryState,
        fetchMetricValue: () => fetchMaxMock('salary'),
        initialValue: directDB.max('salary'),
        name: 'MaxSalary'
     });
  });

   afterEach(() => {
     // Destroy metrics to unsubscribe
     countMetric?.destroy();
     sumMetric?.destroy();
     minMetric?.destroy();
     maxMetric?.destroy();
     renderEngine?.destroy(); // Assuming RenderEngine might have cleanup
     queryState?.destroy(); // Assuming QueryState has cleanup
     vi.restoreAllMocks();
   });

   describe('CountStrategy', () => {
    // Uses countMetric from outer scope
  
    test('should calculate count correctly', () => {
      const strategy = new CountStrategy();
      const metricRender = new MetricRenderEngine(queryState, countMetric, strategy, renderEngine);
      expect(metricRender.render()).toBe(directDB.count());
      metricRender.destroy();
    });
  
    test('should update count after create operation', () => {
      const strategy = new CountStrategy();
      const metricRender = new MetricRenderEngine(queryState, countMetric, strategy, renderEngine);
      const initialCount = directDB.count();
  
      // Create new item
      const newItem = { id: 4, name: 'Dave', role: 'manager', salary: 90000, rating: 4.0, active: true };
      queryState.add({
        type: 'create',
        instances: [newItem]
      });
      directDB.create(newItem);
  
      expect(metricRender.render()).toBe(initialCount + 1);
      expect(metricRender.render()).toBe(directDB.count());
      metricRender.destroy();
    });
  
    test('should update count after delete operation', () => {
      const strategy = new CountStrategy();
      const metricRender = new MetricRenderEngine(queryState, countMetric, strategy, renderEngine);
      const initialCount = directDB.count();
  
      // Delete item
      queryState.add({ type: 'delete', instances: [1] });
      directDB.delete(1);
  
      expect(metricRender.render()).toBe(initialCount - 1);
      expect(metricRender.render()).toBe(directDB.count());
      metricRender.destroy();
    });
  
    test('should handle field-specific count', () => {
      const strategy = new CountStrategy();
      const metricRender = new MetricRenderEngine(queryState, countMetric, strategy, renderEngine);
  
      // Count items with 'rating' field initially
      const initialRatingCount = directDB.countField('rating');
      expect(metricRender.render('rating')).toBe(initialRatingCount);
  
      // Add item without rating field
      const newItem = { id: 4, name: 'Dave', role: 'manager', salary: 90000 };
      queryState.add({
        type: 'create',
        instances: [newItem]
      });
      directDB.create(newItem);
  
      // Optimistic rating count should remain the same (diff is 0)
      expect(metricRender.render('rating')).toBe(initialRatingCount);
      expect(metricRender.render('rating')).toBe(directDB.countField('rating'));
  
      // Total count should increase
      expect(metricRender.render()).toBe(directDB.count());
      metricRender.destroy();
    });
  });

 // --- Sum Strategy Tests ---
describe('SumStrategy', () => {
  // Uses sumMetric from outer scope

  test('should calculate sum correctly', () => {
    const strategy = new SumStrategy();
    const metricRender = new MetricRenderEngine(queryState, sumMetric, strategy, renderEngine);
    expect(metricRender.render('salary')).toBe(directDB.sum('salary'));
    metricRender.destroy();
  });

  test('should throw error if field is not provided', () => {
    const strategy = new SumStrategy();
    const metricRender = new MetricRenderEngine(queryState, sumMetric, strategy, renderEngine);
    expect(() => metricRender.render()).toThrow('SumStrategy requires a field parameter');
    metricRender.destroy();
  });

  test('should update sum after create operation', () => {
    const strategy = new SumStrategy();
    const metricRender = new MetricRenderEngine(queryState, sumMetric, strategy, renderEngine);
    const initialSum = directDB.sum('salary');
    const newSalary = 90000;

    // Create new item with salary
    const newItem = { id: 4, name: 'Dave', salary: newSalary };
    queryState.add({
      type: 'create',
      instances: [newItem]
    });
    directDB.create(newItem);

    expect(metricRender.render('salary')).toBe(initialSum + newSalary);
    expect(metricRender.render('salary')).toBe(directDB.sum('salary'));
    metricRender.destroy();
  });

  test('should update sum after update operation', () => {
    const strategy = new SumStrategy();
    const metricRender = new MetricRenderEngine(queryState, sumMetric, strategy, renderEngine);
    const initialSum = directDB.sum('salary');
    
    // Get original item
    const originalItem = initialData.find(i => i.id === 1);
    const originalSalary = originalItem.salary;
    const newSalary = 120000;
    const expectedDiff = newSalary - originalSalary;

    // Update item
    queryState.add({ type: 'update', instances: [{ id: 1, salary: newSalary }] });
    directDB.update({ id: 1, salary: newSalary });

    expect(metricRender.render('salary')).toBe(initialSum + expectedDiff);
    expect(metricRender.render('salary')).toBe(directDB.sum('salary'));
    metricRender.destroy();
  });

  test('should update sum after delete operation', () => {
    const strategy = new SumStrategy();
    const metricRender = new MetricRenderEngine(queryState, sumMetric, strategy, renderEngine);
    const initialSum = directDB.sum('salary');
    
    // Get original item to calculate expected difference
    const deletedItem = initialData.find(i => i.id === 1);
    const deletedSalary = deletedItem.salary;
    const expectedDiff = -deletedSalary;

    // Delete item
    queryState.add({ type: 'delete', instances: [1] });
    directDB.delete(1);

    expect(metricRender.render('salary')).toBe(initialSum + expectedDiff);
    expect(metricRender.render('salary')).toBe(directDB.sum('salary'));
    metricRender.destroy();
  });

  test('should handle null values in sum calculation', () => {
    const strategy = new SumStrategy();
    const metricRender = new MetricRenderEngine(queryState, sumMetric, strategy, renderEngine);
    const initialSum = directDB.sum('salary');

    // Add item with null salary
    const newItem = { id: 4, name: 'Dave', salary: null };
    queryState.add({
        type: 'create',
        instances: [newItem]
    });
    directDB.create(newItem);

    // Sum should not change (diff is 0)
    expect(metricRender.render('salary')).toBe(initialSum);
    expect(metricRender.render('salary')).toBe(directDB.sum('salary'));
    metricRender.destroy();
  });
});

  // --- Min Strategy Tests ---
describe('MinStrategy', () => {
  // Uses minMetric from outer scope

  test('should calculate min correctly', () => {
    const strategy = new MinStrategy();
    const metricRender = new MetricRenderEngine(queryState, minMetric, strategy, renderEngine);
    expect(metricRender.render('salary')).toBe(directDB.min('salary'));
    metricRender.destroy();
  });

  test('should throw error if field is not provided', () => {
    const strategy = new MinStrategy();
    const metricRender = new MetricRenderEngine(queryState, minMetric, strategy, renderEngine);
    expect(() => metricRender.render()).toThrow('MinStrategy requires a field parameter');
    metricRender.destroy();
  });

  test('should update min after create operation with lower value', () => {
    const strategy = new MinStrategy();
    const metricRender = new MetricRenderEngine(queryState, minMetric, strategy, renderEngine);
    const currentMin = directDB.min('salary');
    const newLowerSalary = currentMin - 15000; // Ensure it's lower than current min
    
    // Create new item with lower salary
    queryState.add({
      type: 'create',
      instances: [{ id: 4, name: 'Dave', salary: newLowerSalary }]
    });
    directDB.create({ id: 4, name: 'Dave', salary: newLowerSalary });

    // Optimistic should update because new value is lower
    expect(metricRender.render('salary')).toBe(newLowerSalary);
    expect(metricRender.render('salary')).toBe(directDB.min('salary'));
    metricRender.destroy();
  });

  test('should not update min after create operation with higher value', () => {
    const strategy = new MinStrategy();
    const metricRender = new MetricRenderEngine(queryState, minMetric, strategy, renderEngine);
    const initialMin = directDB.min('salary');
    const newHigherSalary = initialMin + 35000; // Ensure it's higher than current min

    // Create new item with higher salary
    queryState.add({
      type: 'create',
      instances: [{ id: 4, name: 'Dave', salary: newHigherSalary }]
    });
    directDB.create({ id: 4, name: 'Dave', salary: newHigherSalary });

    // Optimistic should NOT update because new value is higher
    expect(metricRender.render('salary')).toBe(initialMin);
    expect(metricRender.render('salary')).toBe(directDB.min('salary'));
    metricRender.destroy();
  });

  test('should NOT update optimistically after delete of min value item', () => {
    const strategy = new MinStrategy();
    const metricRender = new MetricRenderEngine(queryState, minMetric, strategy, renderEngine);
    
    // Find the minimum salary item
    const minSalary = directDB.min('salary');
    const minSalaryItem = initialData.find(item => item.salary === minSalary);
    const initialMin = minSalary;

    // Delete the min salary item
    queryState.add({ type: 'delete', instances: [minSalaryItem.id] });
    directDB.delete(minSalaryItem.id);

    // Optimistic render CANNOT know the next minimum, so it sticks with the ground truth
    expect(metricRender.render('salary')).toBe(initialMin);
    
    // Compare against the *actual* new minimum in the DB
    const newDbMin = directDB.min('salary');
    expect(newDbMin).not.toBe(initialMin); // Verify that min actually changed in DB
    
    metricRender.destroy();
  });
});

  // --- Max Strategy Tests ---
  describe('MaxStrategy', () => {
    // Uses maxMetric from outer scope

    test('should calculate max correctly', () => {
      const strategy = new MaxStrategy();
      const metricRender = new MetricRenderEngine(queryState, maxMetric, strategy, renderEngine);
      expect(metricRender.render('salary')).toBe(directDB.max('salary'));
      metricRender.destroy();
    });

    test('should throw error if field is not provided', () => {
      const strategy = new MaxStrategy();
      const metricRender = new MetricRenderEngine(queryState, maxMetric, strategy, renderEngine);
      expect(() => metricRender.render()).toThrow('MaxStrategy requires a field parameter');
      metricRender.destroy();
    });

    test('should update max after create operation with higher value', () => {
      const strategy = new MaxStrategy();
      const metricRender = new MetricRenderEngine(queryState, maxMetric, strategy, renderEngine);
      const currentMax = directDB.max('salary');
      const newHigherSalary = currentMax + 20000; // Ensure it's higher than current max
      
      // Create new item with higher salary
      queryState.add({
        type: 'create',
        instances: [{ id: 4, name: 'Dave', salary: newHigherSalary }]
      });
      directDB.create({ id: 4, name: 'Dave', salary: newHigherSalary });

      // Optimistic should update
      expect(metricRender.render('salary')).toBe(newHigherSalary);
      expect(metricRender.render('salary')).toBe(directDB.max('salary'));
      metricRender.destroy();
    });

    test('should not update max after create operation with lower value', () => {
      const strategy = new MaxStrategy();
      const metricRender = new MetricRenderEngine(queryState, maxMetric, strategy, renderEngine);
      const initialMax = directDB.max('salary');
      const newLowerSalary = initialMax - 40000; // Ensure it's lower than current max

      // Create new item with lower salary
      queryState.add({
        type: 'create',
        instances: [{ id: 4, name: 'Dave', salary: newLowerSalary }]
      });
      directDB.create({ id: 4, name: 'Dave', salary: newLowerSalary });

      // Optimistic should NOT update
      expect(metricRender.render('salary')).toBe(initialMax);
      expect(metricRender.render('salary')).toBe(directDB.max('salary'));
      metricRender.destroy();
    });

    test('should NOT update optimistically after delete of max value item', () => {
      const strategy = new MaxStrategy();
      const metricRender = new MetricRenderEngine(queryState, maxMetric, strategy, renderEngine);
      
      // Find the maximum salary item
      const maxSalary = directDB.max('salary');
      const maxSalaryItem = initialData.find(item => item.salary === maxSalary);
      const initialMax = maxSalary;

      // Delete the max salary item
      queryState.add({ type: 'delete', instances: [maxSalaryItem.id] });
      directDB.delete(maxSalaryItem.id);

      // Optimistic render CANNOT know the next maximum, sticks with ground truth
      expect(metricRender.render('salary')).toBe(initialMax);
      
      // Compare against the *actual* new maximum in the DB
      const newDbMax = directDB.max('salary');
      expect(newDbMax).not.toBe(initialMax); // Verify that max actually changed in DB
      
      metricRender.destroy();
    });
  });

  // --- MetricStrategyFactory Tests (FilterFn expectations removed) ---
  describe('MetricStrategyFactory', () => {
    test('should create CountStrategy correctly', () => {
      // const filterFn = item => item.active === true; // Keep for context if needed
      const strategy = MetricStrategyFactory.createCountStrategy(/*filterFn*/);
      expect(strategy).toBeInstanceOf(CountStrategy);
      // expect(strategy.filterFn).toBe(filterFn); // Removed assertion
    });

    test('should create SumStrategy correctly', () => {
      // const filterFn = item => item.active === true;
      const strategy = MetricStrategyFactory.createSumStrategy(/*filterFn*/);
      expect(strategy).toBeInstanceOf(SumStrategy);
      // expect(strategy.filterFn).toBe(filterFn); // Removed assertion
    });

    test('should create MinStrategy correctly', () => {
      // const filterFn = item => item.active === true;
      const strategy = MetricStrategyFactory.createMinStrategy(/*filterFn*/);
      expect(strategy).toBeInstanceOf(MinStrategy);
      // expect(strategy.filterFn).toBe(filterFn); // Removed assertion
    });

    test('should create MaxStrategy correctly', () => {
      // const filterFn = item => item.active === true;
      const strategy = MetricStrategyFactory.createMaxStrategy(/*filterFn*/);
      expect(strategy).toBeInstanceOf(MaxStrategy);
      // expect(strategy.filterFn).toBe(filterFn); // Removed assertion
    });
  });

  // --- Cache handling tests (Keep as is, should be ok) ---
  describe('MetricRenderEngine Cache', () => {
     let strategy;
     let metricRender;
     let specificCountMetric; // Use a specific metric for this block

     beforeEach(() => {
       // Use the countMetric from the outer scope for consistency
       specificCountMetric = countMetric; // Re-assign for clarity if needed or use outer countMetric directly
       strategy = new CountStrategy();
       metricRender = new MetricRenderEngine(queryState, specificCountMetric, strategy, renderEngine);
     });

      afterEach(() => {
         metricRender?.destroy();
      });

     test('should cache calculation results', () => {
       const initialResult = metricRender.render();
       expect(metricRender._cache.size).toBe(1);
       const cacheEntry = metricRender._cache.get('no_field');
       expect(cacheEntry).toBeDefined();
       expect(cacheEntry.queryStateVersion).toBe(queryState.version);
       expect(cacheEntry.metricValue).toBe(initialResult);

       const calculateSpy = vi.spyOn(strategy, 'calculate');
       const cachedResult = metricRender.render();
       expect(cachedResult).toBe(initialResult);
       expect(calculateSpy).not.toHaveBeenCalled();
       calculateSpy.mockRestore();
     });

     test('should invalidate cache when QueryState changes', () => {
       const initialResult = metricRender.render();
       const calculateSpy = vi.spyOn(strategy, 'calculate');

       queryState.add({
         type: 'create',
         instances: [{ id: 4, name: 'Dave' }]
       }); // This bumps queryState.version

       const newResult = metricRender.render();
       expect(newResult).not.toBe(initialResult); // Value should change
       expect(newResult).toBe(directDB.count() + 1); // Check against expected new count
       expect(calculateSpy).toHaveBeenCalled();
       calculateSpy.mockRestore();
     });

     test('should cache field-specific calculations separately', () => {
        // Need a Sum Metric and RenderEngine for this test
        const localSumMetric = new Metric({
             queryStateInstance: queryState,
             fetchMetricValue: () => fetchSumMock('salary'), // Use outer mock
             initialValue: directDB.sum('salary'),
             name: 'CacheTestSumSalary'
         });
        const sumStrategy = new SumStrategy();
        const sumMetricRender = new MetricRenderEngine(queryState, localSumMetric, sumStrategy, renderEngine);

        const salarySumResult = sumMetricRender.render('salary');
        const ratingSumResult = sumMetricRender.render('rating'); // Use another numeric field

        expect(sumMetricRender._cache.size).toBe(2);
        expect(sumMetricRender._cache.get('salary')).toBeDefined();
        expect(sumMetricRender._cache.get('rating')).toBeDefined();
        expect(sumMetricRender._cache.get('salary').metricValue).toBe(salarySumResult);
        expect(sumMetricRender._cache.get('rating').metricValue).toBe(ratingSumResult);

        sumMetricRender.destroy();
        localSumMetric.destroy();
     });

     test('should clear cache on destroy', () => {
       metricRender.render(); // Populate cache
       expect(metricRender._cache?.size).toBeGreaterThan(0); // Check cache exists before size
       metricRender.destroy();
       expect(metricRender._cache).toBeNull(); // Expect cache to be nulled out
     });
   });

  // --- Edge cases (Using SimpleDB for verification) ---
describe('MetricRenderEngine Edge Cases', () => {
  test('should handle empty datasets', async () => {
    // Create specific metrics and engines for this test
    const localCountMetric = new Metric({ queryStateInstance: queryState, fetchMetricValue: async () => 0, initialValue: 0, name: 'EmptyCount'});
    const localSumMetric = new Metric({ queryStateInstance: queryState, fetchMetricValue: async () => 0, initialValue: 0, name: 'EmptySum'});
    const localMinMetric = new Metric({ queryStateInstance: queryState, fetchMetricValue: async () => null, initialValue: null, name: 'EmptyMin'});
    const localMaxMetric = new Metric({ queryStateInstance: queryState, fetchMetricValue: async () => null, initialValue: null, name: 'EmptyMax'});
  
    const countStrategy = new CountStrategy();
    const sumStrategy = new SumStrategy();
    const minStrategy = new MinStrategy();
    const maxStrategy = new MaxStrategy();
  
    const countMetricRender = new MetricRenderEngine(queryState, localCountMetric, countStrategy, renderEngine);
    const sumMetricRender = new MetricRenderEngine(queryState, localSumMetric, sumStrategy, renderEngine);
    const minMetricRender = new MetricRenderEngine(queryState, localMinMetric, minStrategy, renderEngine);
    const maxMetricRender = new MetricRenderEngine(queryState, localMaxMetric, maxStrategy, renderEngine);
  
    // Store original fetchGroundTruth
    const originalFetchGroundTruth = queryState.fetchGroundTruth;
    
    // Override fetchGroundTruth to return empty array
    queryState.fetchGroundTruth = vi.fn().mockResolvedValue([]);
    
    // Set up empty test DB
    const emptyDB = new SimpleDB([]);
    
    // Delete all items from QueryState and directDB
    const allIds = initialData.map(item => item.id);
    queryState.add({ type: 'delete', instances: allIds });
    directDB.delete(allIds); // DB is now empty
  
    // Trigger an actual sync to update internal state
    await queryState.sync();
    
    // Wait for sync to complete and metrics to update
    await vi.waitFor(() => {
      expect(localCountMetric.getValue()).toBe(emptyDB.count());
      expect(localSumMetric.getValue()).toBe(emptyDB.sum('salary'));
    });
  
    // Now test the renders against empty DB
    expect(countMetricRender.render()).toBe(emptyDB.count());
    expect(sumMetricRender.render('salary')).toBe(emptyDB.sum('salary'));
    expect(minMetricRender.render('salary')).toBe(emptyDB.min('salary'));
    expect(maxMetricRender.render('salary')).toBe(emptyDB.max('salary'));
  
    // Restore original fetchGroundTruth
    queryState.fetchGroundTruth = originalFetchGroundTruth;
  
    // Cleanup
    countMetricRender.destroy(); localCountMetric.destroy();
    sumMetricRender.destroy(); localSumMetric.destroy();
    minMetricRender.destroy(); localMinMetric.destroy();
    maxMetricRender.destroy(); localMaxMetric.destroy();
  });

  test('should handle non-numeric values in numeric operations', () => {
    // Use the main sum/min/max metrics which have correct initial values
    const sumStrategy = new SumStrategy();
    const minStrategy = new MinStrategy();
    const maxStrategy = new MaxStrategy();

    const sumMetricRender = new MetricRenderEngine(queryState, sumMetric, sumStrategy, renderEngine);
    const minMetricRender = new MetricRenderEngine(queryState, minMetric, minStrategy, renderEngine);
    const maxMetricRender = new MetricRenderEngine(queryState, maxMetric, maxStrategy, renderEngine);

    // Store initial DB values for comparison
    const initialSum = directDB.sum('salary');
    const initialMin = directDB.min('salary');
    const initialMax = directDB.max('salary');

    // Add item with string value for salary
    queryState.add({
      type: 'create',
      instances: [{ id: 4, name: 'Dave', salary: 'Not a number' }]
    });
    directDB.create({ id: 4, name: 'Dave', salary: 'Not a number' });

    // Sum should ignore non-numeric
    expect(sumMetricRender.render('salary')).toBe(directDB.sum('salary'));

    // Min should ignore non-numeric
    expect(minMetricRender.render('salary')).toBe(directDB.min('salary'));

    // Max should ignore non-numeric
    expect(maxMetricRender.render('salary')).toBe(directDB.max('salary'));

    sumMetricRender.destroy();
    minMetricRender.destroy();
    maxMetricRender.destroy();
  });

  test('should handle missing fields', () => {
    // Use the main sum/min/max metrics
    const sumStrategy = new SumStrategy();
    const minStrategy = new MinStrategy();
    const maxStrategy = new MaxStrategy();

    const sumMetricRender = new MetricRenderEngine(queryState, sumMetric, sumStrategy, renderEngine);
    const minMetricRender = new MetricRenderEngine(queryState, minMetric, minStrategy, renderEngine);
    const maxMetricRender = new MetricRenderEngine(queryState, maxMetric, maxStrategy, renderEngine);

    // Sum of non-existent field
    expect(sumMetricRender.render('nonexistentField')).toBe(directDB.sum('nonexistentField') + sumMetric.getValue());

    // Min of non-existent field
    expect(minMetricRender.render('nonexistentField')).toBe(minMetric.getValue());
    expect(directDB.min('nonexistentField')).toBeNull();

    // Max of non-existent field
    expect(maxMetricRender.render('nonexistentField')).toBe(maxMetric.getValue());
    expect(directDB.max('nonexistentField')).toBeNull();

    sumMetricRender.destroy();
    minMetricRender.destroy();
    maxMetricRender.destroy();
  });

  test('should handle multiple operations correctly', () => {
    // Use main count/sum metrics
    const countStrategy = new CountStrategy();
    const sumStrategy = new SumStrategy();
    const minStrategy = new MinStrategy();
    const maxStrategy = new MaxStrategy();

    const countMetricRender = new MetricRenderEngine(queryState, countMetric, countStrategy, renderEngine);
    const sumMetricRender = new MetricRenderEngine(queryState, sumMetric, sumStrategy, renderEngine);
    const minMetricRender = new MetricRenderEngine(queryState, minMetric, minStrategy, renderEngine);
    const maxMetricRender = new MetricRenderEngine(queryState, maxMetric, maxStrategy, renderEngine);

    // Set up test DB that we'll keep in sync with operations
    const testDB = new SimpleDB(initialData);

    // Store initial metric values before operations
    const initialCountGT = countMetric.getValue();
    const initialSumGT = sumMetric.getValue();
    const initialMinGT = minMetric.getValue();
    const initialMaxGT = maxMetric.getValue();

    // 1. Create a new item
    const newItem = { id: 4, name: 'Dave', role: 'user', salary: 70000 };
    queryState.add({
      type: 'create',
      instances: [newItem]
    });
    testDB.create(newItem);
    
    expect(countMetricRender.render()).toBe(testDB.count());
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));
    expect(minMetricRender.render('salary')).toBe(testDB.min('salary'));
    expect(maxMetricRender.render('salary')).toBe(testDB.max('salary'));

    // 2. Update an existing item
    const aliceUpdate = { id: 1, salary: 110000 };
    queryState.add({ type: 'update', instances: [aliceUpdate] });
    testDB.update(aliceUpdate);
    
    expect(countMetricRender.render()).toBe(testDB.count());
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));
    expect(minMetricRender.render('salary')).toBe(testDB.min('salary'));
    expect(maxMetricRender.render('salary')).toBe(testDB.max('salary'));

    // 3. Delete an item (Bob, id 2)
    queryState.add({ type: 'delete', instances: [2] });
    testDB.delete(2);
    
    expect(countMetricRender.render()).toBe(testDB.count());
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));
    expect(minMetricRender.render('salary')).toBe(testDB.min('salary'));
    expect(maxMetricRender.render('salary')).toBe(testDB.max('salary'));

    // 4. Create another item
    const newItem2 = { id: 5, name: 'Eve', role: 'manager', salary: 95000 };
    queryState.add({
      type: 'create',
      instances: [newItem2]
    });
    testDB.create(newItem2);
    
    expect(countMetricRender.render()).toBe(testDB.count());
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));
    expect(minMetricRender.render('salary')).toBe(testDB.min('salary'));
    expect(maxMetricRender.render('salary')).toBe(testDB.max('salary'));

    countMetricRender.destroy();
    sumMetricRender.destroy();
    minMetricRender.destroy();
    maxMetricRender.destroy();
  });

  test('should handle operation confirmation and rejection', () => {
    // Use main count/sum metrics
    const countStrategy = new CountStrategy();
    const sumStrategy = new SumStrategy();
    const countMetricRender = new MetricRenderEngine(queryState, countMetric, countStrategy, renderEngine);
    const sumMetricRender = new MetricRenderEngine(queryState, sumMetric, sumStrategy, renderEngine);

    // Set up test DB that we'll keep in sync with operations
    const testDB = new SimpleDB(initialData);

    // Create operation
    const newItem = { id: 4, name: 'Dave', salary: 70000 };
    const createOpId = queryState.add({
      type: 'create',
      instances: [newItem]
    });
    testDB.create(newItem);

    expect(countMetricRender.render()).toBe(testDB.count());
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));

    // Confirm the operation (state shouldn't change optimistically)
    queryState.confirm(createOpId);

    expect(countMetricRender.render()).toBe(testDB.count());
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));

    // Create another operation
    const newItem2 = { id: 5, name: 'Eve', salary: 95000 };
    const createOpId2 = queryState.add({
      type: 'create',
      instances: [newItem2]
    });
    testDB.create(newItem2);

    expect(countMetricRender.render()).toBe(testDB.count());
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));

    // Reject the second operation - remove from testDB
    queryState.reject(createOpId2);
    testDB.delete(newItem2.id);

    // Values should revert to state after first confirmation
    expect(countMetricRender.render()).toBe(testDB.count());
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));

    countMetricRender.destroy();
    sumMetricRender.destroy();
  });
  });

  // --- Integration with QueryState ---
describe('MetricRenderEngine Integration with QueryState', () => {
  // Uses metrics from outer scope

  test('should synchronize metrics during QueryState sync', async () => {
    const countStrategy = new CountStrategy();
    const sumStrategy = new SumStrategy();
    const countMetricRender = new MetricRenderEngine(queryState, countMetric, countStrategy, renderEngine);
    const sumMetricRender = new MetricRenderEngine(queryState, sumMetric, sumStrategy, renderEngine);

    // Set up test DB to track operations
    const testDB = new SimpleDB(initialData);

    // Add operation
    const newItem = { id: 4, name: 'Dave', salary: 70000 };
    queryState.add({
      type: 'create',
      instances: [newItem]
    });
    testDB.create(newItem);

    // Verify optimistic values
    expect(countMetricRender.render()).toBe(testDB.count());
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));

    // Prepare updated data for sync
    const updatedData = [...initialData, newItem].map(i => ({...i}));
    const newDb = new SimpleDB(updatedData);

    // Update fetch mocks to return new ground truth *after* the operation is applied
    fetchCountMock.mockResolvedValue(newDb.count());
    fetchSumMock.mockResolvedValue(newDb.sum('salary'));
    // Mock the main ground truth fetch as well
    queryState.fetchGroundTruth = vi.fn().mockResolvedValue(updatedData);

    // Sync QueryState - this triggers Metric.sync internally via subscription
    await queryState.sync();

    // Check if mocks were called
    expect(queryState.fetchGroundTruth).toHaveBeenCalled();
    // Metric sync happens async via subscription, check mocks were eventually called
    await vi.waitFor(() => {
      expect(fetchCountMock).toHaveBeenCalled();
      expect(fetchSumMock).toHaveBeenCalled();
    });

    // Check that Metric instances have updated base values
    expect(countMetric.getValue()).toBe(newDb.count());
    expect(sumMetric.getValue()).toBe(newDb.sum('salary'));

    // After sync, the operation is usually confirmed and ground truth updated.
    // Render should now calculate diff based on the *new* ground truth.
    expect(countMetricRender.render()).toBe(newDb.count());
    expect(sumMetricRender.render('salary')).toBe(newDb.sum('salary'));

    countMetricRender.destroy();
    sumMetricRender.destroy();
  });

  test('should handle all metrics in complex operation sequence', async () => {
    // Create render engines using outer scope metrics
    const countMetricRender = new MetricRenderEngine(queryState, countMetric, new CountStrategy(), renderEngine);
    const sumMetricRender = new MetricRenderEngine(queryState, sumMetric, new SumStrategy(), renderEngine);
    const minMetricRender = new MetricRenderEngine(queryState, minMetric, new MinStrategy(), renderEngine);
    const maxMetricRender = new MetricRenderEngine(queryState, maxMetric, new MaxStrategy(), renderEngine);

    // Initial ground truth values from directDB
    const initialCountGT = directDB.count();
    const initialSumGT = directDB.sum('salary');
    const initialMinGT = directDB.min('salary');
    const initialMaxGT = directDB.max('salary');

    // Keep a test DB in sync with operations
    const testDB = new SimpleDB(initialData);

    // Series of operations
    // 1. Create low salary
    const lowSalaryItem = { id: 4, name: 'Dave', salary: 50000 };
    queryState.add({ type: 'create', instances: [lowSalaryItem] });
    testDB.create(lowSalaryItem);
    directDB.create(lowSalaryItem);

    // Verify metrics match test DB after first operation
    expect(countMetricRender.render()).toBe(testDB.count());
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));
    expect(minMetricRender.render('salary')).toBe(testDB.min('salary'));
    expect(maxMetricRender.render('salary')).toBe(testDB.max('salary'));

    // 2. Create high salary
    const highSalaryItem = { id: 5, name: 'Eve', salary: 120000 };
    queryState.add({ type: 'create', instances: [highSalaryItem] });
    testDB.create(highSalaryItem);
    directDB.create(highSalaryItem);

    // Verify metrics match test DB after second operation
    expect(countMetricRender.render()).toBe(testDB.count());
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));
    expect(minMetricRender.render('salary')).toBe(testDB.min('salary'));
    expect(maxMetricRender.render('salary')).toBe(testDB.max('salary'));

    // 3. Update item
    const aliceUpdate = { id: 1, salary: 105000 };
    queryState.add({ type: 'update', instances: [aliceUpdate] });
    testDB.update(aliceUpdate);
    directDB.update(aliceUpdate);

    // Verify metrics match test DB after update operation
    expect(countMetricRender.render()).toBe(testDB.count());
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));
    expect(minMetricRender.render('salary')).toBe(testDB.min('salary'));
    expect(maxMetricRender.render('salary')).toBe(testDB.max('salary'));

    // 4. Delete item (Charlie, id 3)
    queryState.add({ type: 'delete', instances: [3] });
    testDB.delete(3);
    directDB.delete(3);

    // Check all metric calculations against testDB and directDB
    expect(countMetricRender.render()).toBe(testDB.count());
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));
    expect(minMetricRender.render('salary')).toBe(testDB.min('salary'));
    expect(maxMetricRender.render('salary')).toBe(testDB.max('salary'));

    // Double-check against directDB
    expect(countMetricRender.render()).toBe(directDB.count());
    expect(sumMetricRender.render('salary')).toBe(directDB.sum('salary'));
    expect(minMetricRender.render('salary')).toBe(directDB.min('salary'));
    expect(maxMetricRender.render('salary')).toBe(directDB.max('salary'));

    countMetricRender.destroy();
    sumMetricRender.destroy();
    minMetricRender.destroy();
    maxMetricRender.destroy();
  });

  test('should handle rejected operations in all metrics', () => {
    const countMetricRender = new MetricRenderEngine(queryState, countMetric, new CountStrategy(), renderEngine);
    const sumMetricRender = new MetricRenderEngine(queryState, sumMetric, new SumStrategy(), renderEngine);
    const minMetricRender = new MetricRenderEngine(queryState, minMetric, new MinStrategy(), renderEngine);
    const maxMetricRender = new MetricRenderEngine(queryState, maxMetric, new MaxStrategy(), renderEngine);

    // Set up test DB to track operations
    const testDB = new SimpleDB(initialData);

    // Store initial metric values from the test DB
    const initialCount = testDB.count();
    const initialSum = testDB.sum('salary');
    const initialMin = testDB.min('salary');
    const initialMax = testDB.max('salary');

    // Create operations
    const newMinItem = { id: 4, name: 'Dave', salary: 50000 };
    const newMaxItem = { id: 5, name: 'Eve', salary: 120000 };
    
    const opId1 = queryState.add({ type: 'create', instances: [newMinItem] });
    const opId2 = queryState.add({ type: 'create', instances: [newMaxItem] });
    
    // Update test DB (temporarily)
    testDB.create(newMinItem);
    testDB.create(newMaxItem);

    // Check optimistic values reflect both creates
    expect(countMetricRender.render()).toBe(testDB.count());
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));
    expect(minMetricRender.render('salary')).toBe(testDB.min('salary'));
    expect(maxMetricRender.render('salary')).toBe(testDB.max('salary'));

    // Reject both operations and revert test DB
    queryState.reject(opId1);
    queryState.reject(opId2);
    testDB.delete(newMinItem.id);
    testDB.delete(newMaxItem.id);

    // Values should revert to initial state
    expect(countMetricRender.render()).toBe(initialCount);
    expect(sumMetricRender.render('salary')).toBe(initialSum);
    expect(minMetricRender.render('salary')).toBe(initialMin);
    expect(maxMetricRender.render('salary')).toBe(initialMax);

    // Check against DB (which never had the rejected ops)
    expect(countMetricRender.render()).toBe(directDB.count());
    expect(sumMetricRender.render('salary')).toBe(directDB.sum('salary'));
    expect(minMetricRender.render('salary')).toBe(directDB.min('salary'));
    expect(maxMetricRender.render('salary')).toBe(directDB.max('salary'));

    countMetricRender.destroy();
    sumMetricRender.destroy();
    minMetricRender.destroy();
    maxMetricRender.destroy();
  });

  test('should incorporate ground truth changes from sync', async () => {
    // Create a simple sum metric renderer
    const sumMetricRender = new MetricRenderEngine(queryState, sumMetric, new SumStrategy(), renderEngine);
    
    // Start with clean state 
    queryState.operations.clear();
    
    // Get a reference to initial ground truth data
    const initialData = queryState.getGroundTruth();
    let testDB = new SimpleDB(initialData);
    
    // Reset metric value to match test DB
    sumMetric.value = testDB.sum('salary');
    
    // Check initial sum
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));
    
    // Add optimistic update
    const salaryUpdate = { id: 1, salary: 65000 };
    queryState.add({
      type: 'update',
      instances: [salaryUpdate]
    });
    
    // Apply same update to our test DB
    testDB.update(salaryUpdate);
    
    // Check sum after update - should match our test DB
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));
    
    // Create server data
    const serverData = [
      { id: 1, name: 'Alice', salary: 100000 },
      { id: 2, name: 'Bob', salary: 80000 },
      { id: 3, name: 'Charlie', salary: 90000 }
    ];
    const serverDB = new SimpleDB(serverData);
    
    // Mock server responses
    queryState.fetchGroundTruth = vi.fn().mockResolvedValue(serverData);
    fetchSumMock.mockResolvedValue(serverDB.sum('salary'));
    
    // Sync queryState with server
    await queryState.sync();
    
    // Verify metric ground truth updated
    await vi.waitFor(() => {
      expect(fetchSumMock).toHaveBeenCalled();
    });
    expect(sumMetric.getValue()).toBe(serverDB.sum('salary'));
    
    // Update our test DB to match the server state + optimistic updates
    testDB = new SimpleDB(serverData);
    testDB.update(salaryUpdate);
    
    // Check sum after sync - should match updated test DB
    expect(sumMetricRender.render('salary')).toBe(testDB.sum('salary'));
    
    sumMetricRender.destroy();
  });
});
});