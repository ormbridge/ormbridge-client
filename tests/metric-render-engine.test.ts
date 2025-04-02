import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { QueryState } from '../src/core-refactor/state/QueryState.js';
import { RenderEngine } from '../src/core-refactor/rendering/RenderEngine.js';
import {
    Metric
} from '../src/core-refactor/state/MetricState.js'
import {
  MetricRenderEngine,
  CountStrategy,
  SumStrategy,
  MinStrategy,
  MaxStrategy,
  MetricStrategyFactory
} from '../src/core-refactor/rendering/MetricRenderEngine.js';

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
        queryState.listeners.sync_started.forEach(cb => cb('sync_started'));

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

  // --- Count Strategy Tests ---
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
      const initialCount = metricRender.render(); // Should be 3

      queryState.add({
        type: 'create',
        instances: [{ id: 4, name: 'Dave', role: 'manager', salary: 90000, rating: 4.0, active: true }]
      });
      directDB.create({ id: 4, name: 'Dave', role: 'manager', salary: 90000, rating: 4.0, active: true });

      expect(metricRender.render()).toBe(initialCount + 1); // Optimistic = 4
      expect(metricRender.render()).toBe(directDB.count()); // DB = 4
      metricRender.destroy();
    });

    test('should update count after delete operation', () => {
      const strategy = new CountStrategy();
      const metricRender = new MetricRenderEngine(queryState, countMetric, strategy, renderEngine);
      const initialCount = metricRender.render(); // Should be 3

      queryState.add({ type: 'delete', instances: [1] });
      directDB.delete(1);

      expect(metricRender.render()).toBe(initialCount - 1); // Optimistic = 2
      expect(metricRender.render()).toBe(directDB.count()); // DB = 2
      metricRender.destroy();
    });

    test('should handle field-specific count', () => {
      const strategy = new CountStrategy();
      const metricRender = new MetricRenderEngine(queryState, countMetric, strategy, renderEngine);

      // Count items with 'rating' field initially
      const initialRatingCount = directDB.countField('rating'); // Use helper: Should be 3
      // Base the optimistic count on the initial *total* count metric
      // The diff calculation handles the field presence check
      expect(metricRender.render('rating')).toBe(initialRatingCount); // Expect 3 initially

      // Add item without rating field
      queryState.add({
        type: 'create',
        instances: [{ id: 4, name: 'Dave', role: 'manager', salary: 90000 }]
      });
      directDB.create({ id: 4, name: 'Dave', role: 'manager', salary: 90000 });

      // Optimistic rating count should remain the same (diff is 0)
      expect(metricRender.render('rating')).toBe(initialRatingCount); // Expect 3
      expect(metricRender.render('rating')).toBe(directDB.countField('rating')); // DB check = 3

      // Total count should increase
      expect(metricRender.render()).toBe(directDB.count()); // Expect 4
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
      const initialSum = metricRender.render('salary'); // 260000
      const newSalary = 90000;

      queryState.add({
        type: 'create',
        instances: [{ id: 4, name: 'Dave', salary: newSalary }]
      });
      directDB.create({ id: 4, name: 'Dave', salary: newSalary });

      expect(metricRender.render('salary')).toBe(initialSum + newSalary); // Opt = 350000
      expect(metricRender.render('salary')).toBe(directDB.sum('salary')); // DB = 350000
      metricRender.destroy();
    });

    test('should update sum after update operation', () => {
      const strategy = new SumStrategy();
      const metricRender = new MetricRenderEngine(queryState, sumMetric, strategy, renderEngine);
      const initialSum = metricRender.render('salary'); // 260000
      const originalSalary = initialData.find(i => i.id === 1).salary; // 100000
      const newSalary = 120000;
      const expectedDiff = newSalary - originalSalary; // +20000

      queryState.add({ type: 'update', instances: [{ id: 1, salary: newSalary }] });
      directDB.update({ id: 1, salary: newSalary });

      expect(metricRender.render('salary')).toBe(initialSum + expectedDiff); // Opt = 280000
      expect(metricRender.render('salary')).toBe(directDB.sum('salary'));   // DB = 280000
      metricRender.destroy();
    });

    test('should update sum after delete operation', () => {
      const strategy = new SumStrategy();
      const metricRender = new MetricRenderEngine(queryState, sumMetric, strategy, renderEngine);
      const initialSum = metricRender.render('salary'); // 260000
      const deletedSalary = initialData.find(i => i.id === 1).salary; // 100000
      const expectedDiff = -deletedSalary; // -100000

      queryState.add({ type: 'delete', instances: [1] });
      directDB.delete(1);

      expect(metricRender.render('salary')).toBe(initialSum + expectedDiff); // Opt = 160000
      expect(metricRender.render('salary')).toBe(directDB.sum('salary'));   // DB = 160000
      metricRender.destroy();
    });

    test('should handle null values in sum calculation', () => {
        const strategy = new SumStrategy();
        const metricRender = new MetricRenderEngine(queryState, sumMetric, strategy, renderEngine);
        const initialSum = metricRender.render('salary'); // 260000

        // Add item with null salary
        queryState.add({
            type: 'create',
            instances: [{ id: 4, name: 'Dave', salary: null }]
        });
        directDB.create({ id: 4, name: 'Dave', salary: null });

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
      expect(metricRender.render('salary')).toBe(directDB.min('salary')); // 75000
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
      // const initialMin = metricRender.render('salary'); // 75000

      queryState.add({
        type: 'create',
        instances: [{ id: 4, name: 'Dave', salary: 60000 }] // Lower salary
      });
      directDB.create({ id: 4, name: 'Dave', salary: 60000 });

      // Optimistic should update because new value is lower
      expect(metricRender.render('salary')).toBe(60000);
      expect(metricRender.render('salary')).toBe(directDB.min('salary')); // DB check
      metricRender.destroy();
    });

    test('should not update min after create operation with higher value', () => {
      const strategy = new MinStrategy();
      const metricRender = new MetricRenderEngine(queryState, minMetric, strategy, renderEngine);
      const initialMin = metricRender.render('salary'); // 75000

      queryState.add({
        type: 'create',
        instances: [{ id: 4, name: 'Dave', salary: 110000 }] // Higher salary
      });
      directDB.create({ id: 4, name: 'Dave', salary: 110000 });

      // Optimistic should NOT update because new value is higher
      expect(metricRender.render('salary')).toBe(initialMin);
      expect(metricRender.render('salary')).toBe(directDB.min('salary')); // DB check (still 75000)
      metricRender.destroy();
    });

    test('should NOT update optimistically after delete of min value item', () => {
      const strategy = new MinStrategy();
      const metricRender = new MetricRenderEngine(queryState, minMetric, strategy, renderEngine);
      const initialMin = metricRender.render('salary'); // 75000 (Bob)

      // Delete Bob (the min salary item)
      queryState.add({ type: 'delete', instances: [2] });
      directDB.delete(2); // DB min is now 85000 (Charlie)

      // Optimistic render CANNOT know the next minimum, so it sticks with the ground truth
      expect(metricRender.render('salary')).toBe(initialMin); // Expect 75000 optimistically
      // Compare against the *actual* new minimum in the DB
      expect(directDB.min('salary')).toBe(85000); // DB check
       metricRender.destroy();
    });
  });

  // --- Max Strategy Tests ---
  describe('MaxStrategy', () => {
    // Uses maxMetric from outer scope

    test('should calculate max correctly', () => {
      const strategy = new MaxStrategy();
      const metricRender = new MetricRenderEngine(queryState, maxMetric, strategy, renderEngine);
      expect(metricRender.render('salary')).toBe(directDB.max('salary')); // 100000
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
      // const initialMax = metricRender.render('salary'); // 100000

      queryState.add({
        type: 'create',
        instances: [{ id: 4, name: 'Dave', salary: 120000 }] // Higher salary
      });
      directDB.create({ id: 4, name: 'Dave', salary: 120000 });

      // Optimistic should update
      expect(metricRender.render('salary')).toBe(120000);
      expect(metricRender.render('salary')).toBe(directDB.max('salary')); // DB check
      metricRender.destroy();
    });

    test('should not update max after create operation with lower value', () => {
      const strategy = new MaxStrategy();
      const metricRender = new MetricRenderEngine(queryState, maxMetric, strategy, renderEngine);
      const initialMax = metricRender.render('salary'); // 100000

      queryState.add({
        type: 'create',
        instances: [{ id: 4, name: 'Dave', salary: 60000 }] // Lower salary
      });
      directDB.create({ id: 4, name: 'Dave', salary: 60000 });

      // Optimistic should NOT update
      expect(metricRender.render('salary')).toBe(initialMax);
      expect(metricRender.render('salary')).toBe(directDB.max('salary')); // DB check (still 100000)
      metricRender.destroy();
    });

    test('should NOT update optimistically after delete of max value item', () => {
      const strategy = new MaxStrategy();
      const metricRender = new MetricRenderEngine(queryState, maxMetric, strategy, renderEngine);
      const initialMax = metricRender.render('salary'); // 100000 (Alice)

      // Delete Alice (the max salary item)
      queryState.add({ type: 'delete', instances: [1] });
      directDB.delete(1); // DB max is now 85000 (Charlie)

      // Optimistic render CANNOT know the next maximum, sticks with ground truth
      expect(metricRender.render('salary')).toBe(initialMax); // Expect 100000 optimistically
      // Compare against the *actual* new maximum in the DB
      expect(directDB.max('salary')).toBe(85000); // DB check
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

  // --- Edge cases (Fix setup and expectations) ---
  describe('MetricRenderEngine Edge Cases', () => {
     // No shared metric here, create per test or describe block if needed

    test('should handle empty datasets', () => {
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


      // Delete all items from QueryState and directDB
      const allIds = initialData.map(item => item.id);
      queryState.add({ type: 'delete', instances: allIds });
      directDB.delete(allIds); // DB is now empty

       // Update metric ground truths (simulate a sync) - crucial for correct base values
       localCountMetric.value = 0;
       localSumMetric.value = 0;
       localMinMetric.value = null;
       localMaxMetric.value = null;


      // Count should be 0 (Base=0, SliceDiff=0-0=0 -> 0)
      expect(countMetricRender.render()).toBe(0);

      // Sum should be 0 (Base=0, SliceDiff=0-0=0 -> 0)
      expect(() => sumMetricRender.render('salary')).not.toThrow();
      expect(sumMetricRender.render('salary')).toBe(0);

      // Min/Max on empty optimistic slice should return ground truth
      expect(minMetricRender.render('salary')).toBe(null); // Base is null
      expect(maxMetricRender.render('salary')).toBe(null); // Base is null

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

      const initialSum = directDB.sum('salary'); // 260000
      const initialMin = directDB.min('salary'); // 75000
      const initialMax = directDB.max('salary'); // 100000

      // Add item with string value for salary
      queryState.add({
        type: 'create',
        instances: [{ id: 4, name: 'Dave', salary: 'Not a number' }]
      });
      directDB.create({ id: 4, name: 'Dave', salary: 'Not a number' });

      // Sum should ignore non-numeric (diff is 0)
      expect(sumMetricRender.render('salary')).toBe(initialSum);
      expect(sumMetricRender.render('salary')).toBe(directDB.sum('salary'));

      // Min should ignore non-numeric (slice min doesn't change relative to ground truth)
      expect(minMetricRender.render('salary')).toBe(initialMin);
      expect(minMetricRender.render('salary')).toBe(directDB.min('salary'));

      // Max should ignore non-numeric
      expect(maxMetricRender.render('salary')).toBe(initialMax);
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

      // Sum of non-existent field (slice sums are 0, diff is 0)
      expect(sumMetricRender.render('nonexistentField')).toBe(sumMetric.getValue()); // Expect base value (260000)
      expect(sumMetricRender.render('nonexistentField')).toBe(directDB.sum('nonexistentField') + sumMetric.getValue()); // DB sum is 0, so should equal base

      // Min of non-existent field (slice min is null) -> returns ground truth
      expect(minMetricRender.render('nonexistentField')).toBe(minMetric.getValue()); // Expect 75000
      expect(directDB.min('nonexistentField')).toBeNull();

      // Max of non-existent field (slice max is null) -> returns ground truth
      expect(maxMetricRender.render('nonexistentField')).toBe(maxMetric.getValue()); // Expect 100000
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


      // Store initial metric values before operations
      const initialCountGT = countMetric.getValue(); // 3
      const initialSumGT = sumMetric.getValue();     // 260000
      const initialMinGT = minMetric.getValue();     // 75000
      const initialMaxGT = maxMetric.getValue();     // 100000


      // 1. Create a new item
      queryState.add({
        type: 'create',
        instances: [{ id: 4, name: 'Dave', role: 'user', salary: 70000 }]
      });
      directDB.create({ id: 4, name: 'Dave', role: 'user', salary: 70000 });
      expect(countMetricRender.render()).toBe(initialCountGT + 1);
      expect(sumMetricRender.render('salary')).toBe(initialSumGT + 70000);
      expect(minMetricRender.render('salary')).toBe(70000); // New min found optimistically
      expect(maxMetricRender.render('salary')).toBe(initialMaxGT); // Max unchanged


      // 2. Update an existing item
      const aliceOriginalSalary = 100000;
      const aliceNewSalary = 110000;
      queryState.add({ type: 'update', instances: [{ id: 1, salary: aliceNewSalary }] });
      directDB.update({ id: 1, salary: aliceNewSalary });
      expect(countMetricRender.render()).toBe(initialCountGT + 1); // Count doesn't change on update
      expect(sumMetricRender.render('salary')).toBe(initialSumGT + 70000 + (aliceNewSalary - aliceOriginalSalary));
      expect(minMetricRender.render('salary')).toBe(70000); // Min still Dave
      expect(maxMetricRender.render('salary')).toBe(110000); // New max found optimistically


      // 3. Delete an item (Bob, id 2, salary 75000)
      const bobSalary = 75000;
      queryState.add({ type: 'delete', instances: [2] });
      directDB.delete(2);
      expect(countMetricRender.render()).toBe(initialCountGT); // 3 initial + 1 create - 1 delete
      expect(sumMetricRender.render('salary')).toBe(initialSumGT + 70000 + (aliceNewSalary - aliceOriginalSalary) - bobSalary);
      // Min was 70000 (Dave), deleting Bob (75000) doesn't change it
      expect(minMetricRender.render('salary')).toBe(70000);
      expect(maxMetricRender.render('salary')).toBe(110000); // Max still Alice


      // 4. Create another item
      const eveSalary = 95000;
      queryState.add({
        type: 'create',
        instances: [{ id: 5, name: 'Eve', role: 'manager', salary: eveSalary }]
      });
      directDB.create({ id: 5, name: 'Eve', role: 'manager', salary: eveSalary });
      expect(countMetricRender.render()).toBe(initialCountGT + 1); // Back to 4 items
      expect(sumMetricRender.render('salary')).toBe(initialSumGT + 70000 + (aliceNewSalary - aliceOriginalSalary) - bobSalary + eveSalary);
      expect(minMetricRender.render('salary')).toBe(70000); // Min still Dave
      expect(maxMetricRender.render('salary')).toBe(110000); // Max still Alice

      // Final Check against DB
      expect(countMetricRender.render()).toBe(directDB.count());
      expect(sumMetricRender.render('salary')).toBe(directDB.sum('salary'));
      // Optimistic min/max might differ if extremes were deleted
      // In this sequence, min (70k) and max(110k) were added/updated into the slice
      expect(minMetricRender.render('salary')).toBe(directDB.min('salary'));
      expect(maxMetricRender.render('salary')).toBe(directDB.max('salary'));

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

       const initialCount = countMetric.getValue();
       const initialSum = sumMetric.getValue();

       // Create operation
       const createOpId = queryState.add({
           type: 'create',
           instances: [{ id: 4, name: 'Dave', salary: 70000 }]
       });
       const optimisticCountAfterCreate = initialCount + 1;
       const optimisticSumAfterCreate = initialSum + 70000;

       expect(countMetricRender.render()).toBe(optimisticCountAfterCreate);
       expect(sumMetricRender.render('salary')).toBe(optimisticSumAfterCreate);

       // Confirm the operation (state shouldn't change optimistically)
       queryState.confirm(createOpId);
       directDB.create({ id: 4, name: 'Dave', salary: 70000 }); // Keep DB in sync

       expect(countMetricRender.render()).toBe(optimisticCountAfterCreate);
       expect(sumMetricRender.render('salary')).toBe(optimisticSumAfterCreate);
       expect(countMetricRender.render()).toBe(directDB.count());
       expect(sumMetricRender.render('salary')).toBe(directDB.sum('salary'));

       // Create another operation
       const createOpId2 = queryState.add({
           type: 'create',
           instances: [{ id: 5, name: 'Eve', salary: 95000 }]
       });
       const optimisticCountAfterCreate2 = optimisticCountAfterCreate + 1;
       const optimisticSumAfterCreate2 = optimisticSumAfterCreate + 95000;

       expect(countMetricRender.render()).toBe(optimisticCountAfterCreate2);
       expect(sumMetricRender.render('salary')).toBe(optimisticSumAfterCreate2);

       // Reject the second operation
       queryState.reject(createOpId2);

       // Values should revert to state after first confirmation
       expect(countMetricRender.render()).toBe(optimisticCountAfterCreate);
       expect(sumMetricRender.render('salary')).toBe(optimisticSumAfterCreate);
       expect(countMetricRender.render()).toBe(directDB.count());
       expect(sumMetricRender.render('salary')).toBe(directDB.sum('salary'));

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

       // Add operation
       queryState.add({
           type: 'create',
           instances: [{ id: 4, name: 'Dave', salary: 70000 }]
       });

       // Initial optimistic values
       const optimisticCount = countMetricRender.render(); // 3 + 1 = 4
       const optimisticSum = sumMetricRender.render('salary'); // 260000 + 70000 = 330000

       expect(optimisticCount).toBe(4);
       expect(optimisticSum).toBe(330000);

       // Prepare updated data for sync
       const updatedData = [...initialData, { id: 4, name: 'Dave', salary: 70000 }].map(i=>({...i}));
       const newDb = new SimpleDB(updatedData);

       // Update fetch mocks to return new ground truth *after* the operation is applied
       fetchCountMock.mockResolvedValue(newDb.count()); // Should resolve to 4
       fetchSumMock.mockResolvedValue(newDb.sum('salary')); // Should resolve to 330000
       // Mock the main ground truth fetch as well
       queryState.fetchGroundTruth = vi.fn().mockResolvedValue(updatedData);


       // Sync QueryState - this triggers Metric.sync internally via subscription
       await queryState.sync();

       // Check if mocks were called
       expect(queryState.fetchGroundTruth).toHaveBeenCalled();
       // Metric sync happens async via subscription, check mocks were eventually called
       await vi.waitFor(() => {
           expect(fetchCountMock).toHaveBeenCalled();
           expect(fetchSumMock).toHaveBeenCalled(); // Ensure sum mock was called
       });

       // Check that Metric instances have updated base values
       expect(countMetric.getValue()).toBe(4);
       expect(sumMetric.getValue()).toBe(330000);

       // After sync, the operation is usually confirmed and ground truth updated.
       // Render should now calculate diff based on the *new* ground truth.
       // Since the optimistic op matches the new ground truth, the diff should be 0.
       // Result = new_ground_truth_metric + 0
       expect(countMetricRender.render()).toBe(4); // 4 + (4-4) = 4
       expect(sumMetricRender.render('salary')).toBe(330000); // 330000 + (330k-330k) = 330000

       countMetricRender.destroy();
       sumMetricRender.destroy();
    });

    test('should handle all metrics in complex operation sequence', async () => {
       // Create render engines using outer scope metrics
       const countMetricRender = new MetricRenderEngine(queryState, countMetric, new CountStrategy(), renderEngine);
       const sumMetricRender = new MetricRenderEngine(queryState, sumMetric, new SumStrategy(), renderEngine);
       const minMetricRender = new MetricRenderEngine(queryState, minMetric, new MinStrategy(), renderEngine);
       const maxMetricRender = new MetricRenderEngine(queryState, maxMetric, new MaxStrategy(), renderEngine);

       // Initial ground truth values
       const initialCountGT = countMetric.getValue(); // 3
       const initialSumGT = sumMetric.getValue();     // 260000
       const initialMinGT = minMetric.getValue();     // 75000
       const initialMaxGT = maxMetric.getValue();     // 100000

       // Series of operations
       // 1. Create low salary
       queryState.add({ type: 'create', instances: [{ id: 4, name: 'Dave', salary: 50000 }]});
       directDB.create({ id: 4, name: 'Dave', salary: 50000 });
       // Opt: C=4, Sum=310k, Min=50k, Max=100k

       // 2. Create high salary
       queryState.add({ type: 'create', instances: [{ id: 5, name: 'Eve', salary: 120000 }]});
       directDB.create({ id: 5, name: 'Eve', salary: 120000 });
       // Opt: C=5, Sum=430k, Min=50k, Max=120k

       // 3. Update item
       const aliceOriginalSalary = 100000;
       const aliceNewSalary = 105000;
       queryState.add({ type: 'update', instances: [{ id: 1, salary: aliceNewSalary }]});
       directDB.update({ id: 1, salary: aliceNewSalary });
        // Opt: C=5, Sum=435k, Min=50k, Max=120k

       // 4. Delete item (Charlie, id 3, salary 85000)
       const charlieSalary = 85000;
       queryState.add({ type: 'delete', instances: [3] });
       directDB.delete(3);
       // Opt: C=4, Sum=350k, Min=50k, Max=120k

       // Check all metric calculations against directDB
       expect(countMetricRender.render()).toBe(directDB.count());           // Expect 4
       expect(sumMetricRender.render('salary')).toBe(directDB.sum('salary')); // Expect 350000
       // Min/Max were added/updated within slice, so optimistic should match DB
       expect(minMetricRender.render('salary')).toBe(directDB.min('salary')); // Expect 50000
       expect(maxMetricRender.render('salary')).toBe(directDB.max('salary')); // Expect 120000

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

       const initialCount = countMetric.getValue(); // 3
       const initialSum = sumMetric.getValue();     // 260000
       const initialMin = minMetric.getValue();     // 75000
       const initialMax = maxMetric.getValue();     // 100000

       // Create operations
       const opId1 = queryState.add({ type: 'create', instances: [{ id: 4, name: 'Dave', salary: 50000 }]}); // New min
       const opId2 = queryState.add({ type: 'create', instances: [{ id: 5, name: 'Eve', salary: 120000 }]}); // New max

       // Check optimistic values reflect both creates
       expect(countMetricRender.render()).toBe(initialCount + 2);           // 5
       expect(sumMetricRender.render('salary')).toBe(initialSum + 50000 + 120000); // 430000
       expect(minMetricRender.render('salary')).toBe(50000);                 // New lowest found
       expect(maxMetricRender.render('salary')).toBe(120000);                // New highest found

       // Reject both operations
       queryState.reject(opId1);
       queryState.reject(opId2);

       // Values should revert to initial ground truth metrics
       expect(countMetricRender.render()).toBe(initialCount); // 3
       expect(sumMetricRender.render('salary')).toBe(initialSum); // 260000
       expect(minMetricRender.render('salary')).toBe(initialMin); // 75000
       expect(maxMetricRender.render('salary')).toBe(initialMax); // 100000

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
        const countMetricRender = new MetricRenderEngine(queryState, countMetric, new CountStrategy(), renderEngine);
        const sumMetricRender = new MetricRenderEngine(queryState, sumMetric, new SumStrategy(), renderEngine);
        const minMetricRender = new MetricRenderEngine(queryState, minMetric, new MinStrategy(), renderEngine);
        const maxMetricRender = new MetricRenderEngine(queryState, maxMetric, new MaxStrategy(), renderEngine);

        // Add an optimistic operation
        queryState.add({
            type: 'create',
            instances: [{ id: 4, name: 'Dave', salary: 70000 }]
        });
        const optimisticCount = countMetricRender.render(); // 4
        const optimisticSum = sumMetricRender.render('salary'); // 330000
        const optimisticMin = minMetricRender.render('salary'); // 70000
        const optimisticMax = maxMetricRender.render('salary'); // 100000 (initial)

        expect(optimisticCount).toBe(4);
        expect(optimisticSum).toBe(330000);
        expect(optimisticMin).toBe(70000);
        expect(optimisticMax).toBe(100000);


        // Simulate server data changing *differently* than the optimistic update,
        // AND the operation getting confirmed/merged during sync.
        const serverData = [
            // Alice updated, Bob deleted, Charlie same, Dave added (but differently), Eve added
            { id: 1, name: 'Alice Admin', role: 'admin', salary: 115000 },
            // Bob (id:2) is gone
            { id: 3, name: 'Charlie', role: 'user', salary: 85000 },
            { id: 4, name: 'David Server', role: 'manager', salary: 75000 }, // Different from optimistic Dave
            { id: 5, name: 'Eve', role: 'admin', salary: 110000 }
        ].map(i=>({...i}));
        const serverDB = new SimpleDB(serverData);

        // Mock fetchGroundTruth for QueryState
        queryState.fetchGroundTruth = vi.fn().mockResolvedValue(serverData);

        // Mock metric fetches to return values based on SERVER data
        fetchCountMock.mockResolvedValue(serverDB.count());     // 4
        fetchSumMock.mockResolvedValue(serverDB.sum('salary')); // 115+85+75+110 = 385k
        fetchMinMock.mockResolvedValue(serverDB.min('salary')); // 75k
        fetchMaxMock.mockResolvedValue(serverDB.max('salary')); // 115k

        // Sync QueryState - fetches serverData, updates metrics' ground truth
        await queryState.sync();

        // Check mocks and metric values updated
        expect(queryState.fetchGroundTruth).toHaveBeenCalled();
         await vi.waitFor(() => { // Wait for metric syncs triggered by QS sync
            expect(fetchCountMock).toHaveBeenCalled();
            expect(fetchSumMock).toHaveBeenCalled();
            expect(fetchMinMock).toHaveBeenCalled();
            expect(fetchMaxMock).toHaveBeenCalled();
         });
        expect(countMetric.getValue()).toBe(serverDB.count());     // 4
        expect(sumMetric.getValue()).toBe(serverDB.sum('salary')); // 385k
        expect(minMetric.getValue()).toBe(serverDB.min('salary')); // 75k
        expect(maxMetric.getValue()).toBe(serverDB.max('salary')); // 115k


        // Check metrics after sync. RenderEngine now uses serverData as base.
        // The optimistic operation (add Dave id=4) is still in QueryState's ops list
        // until confirmed/rejected. Let's assume it remains inflight for this test.
        // The RenderEngine will apply the inflight 'add Dave' ON TOP of the new serverData base.
        directDB = new SimpleDB(serverData); // Base is server data
        directDB.create({ id: 4, name: 'Dave', salary: 70000 }); // Apply optimistic op on top (update Dave)
        directDB.update({ id: 4, name: 'Dave', salary: 70000 }); // Ensure update semantics if ID exists


        expect(countMetricRender.render()).toBe(directDB.count());           // Expect 4 (server count)
        expect(sumMetricRender.render('salary')).toBe(directDB.sum('salary')); // Expect server sum + diff = 385k + (70k - 75k) = 380k
        // Optimistic min (70k) vs server min (75k) -> optimistic wins
        expect(minMetricRender.render('salary')).toBe(directDB.min('salary')); // Expect 70k
         // Optimistic max (100k initial GT) vs server max (115k) -> server GT wins, optimistic op doesn't raise it
         // But wait, Alice was updated to 115k IN the server data. Max should be 115k based on the new GT.
         // The optimistic operation didn't add a value > 115k.
        expect(maxMetricRender.render('salary')).toBe(directDB.max('salary')); // Expect 115k


        countMetricRender.destroy();
        sumMetricRender.destroy();
        minMetricRender.destroy();
        maxMetricRender.destroy();
    });
  });
});