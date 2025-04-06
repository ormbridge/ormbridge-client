import { describe, test, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import 'fake-indexeddb/auto'; // Patch IDB for testing

import { ModelStore } from '../../src/core-refactor/state/ModelStore.js';
import { RenderEngine } from '../../src/core-refactor/rendering/RenderEngine.js';
import { Metric } from '../../src/core-refactor/state/MetricState.js';
import { 
  MetricRenderEngine,
  CountStrategy, 
  SumStrategy,
  MinStrategy,
  MaxStrategy
} from '../../src/core-refactor/rendering/MetricRenderEngine.js';

// Test data for all tests
const initialData = [
  { id: 1, name: 'Alice', role: 'admin', salary: 100000, rating: 4.8, active: true },
  { id: 2, name: 'Bob', role: 'user', salary: 75000, rating: 4.2, active: true },
  { id: 3, name: 'Charlie', role: 'user', salary: 85000, rating: 4.5, active: true }
];

/**
 * SimpleDB - In-memory database for testing with CRUD operations
 * Simulates server-side data storage
 */
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

  // Helper to get valid numeric values for aggregation functions
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

/**
 * IntegrationTestHelper - Helper class for integration testing of ModelStore with metrics
 * Manages test state, provides factory methods for creating test components, and handles cleanup
 */
class IntegrationTestHelper {
    constructor() {
      this.activeStates = [];
      this.activeMetrics = [];
      this.activeRenderEngines = [];
      this.activeMetricRenderEngines = [];
      
      // Initialize mock database with test data
      this.directDB = new SimpleDB(initialData.map(item => ({...item})), 'id');
  
      // Store initial metric values based on the initial DB state for test initialization
      this._initialMetricValues = {
          count: this.directDB.count(),
          sum: this.directDB.sum('salary'),
          min: this.directDB.min('salary'),
          max: this.directDB.max('salary'),
      };
  
      this.fetchMocks = null;
  
      this.testId = Date.now().toString();
      this.testDbName = `test_db_${this.testId}`;
      this.testStoreName = `test_store_${this.testId}`;
    }
  
    // Create mock fetch functions that simulate API calls to server
    createFetchMocks() {
      return {
        fetchData: vi.fn().mockImplementation(() => Promise.resolve([...this.directDB.getAll()])),
        fetchCount: vi.fn().mockImplementation(() => Promise.resolve(this.directDB.count())),
        fetchSum: vi.fn().mockImplementation(() => Promise.resolve(this.directDB.sum('salary'))),
        fetchMin: vi.fn().mockImplementation(() => Promise.resolve(this.directDB.min('salary'))),
        fetchMax: vi.fn().mockImplementation(() => Promise.resolve(this.directDB.max('salary')))
      };
    }
  
    // Create ModelStore with persistence options
    createModelStore(options = {}) {
      // Initialize fetch mocks if needed
      if (!this.fetchMocks) {
          this.fetchMocks = this.createFetchMocks();
      }
      
      const defaults = {
        primaryKey: 'id',
        fetchGroundTruth: this.fetchMocks.fetchData,
        syncInterval: 0, // Disable periodic sync
        cacheAutoSync: false, // Disable auto-sync
        cacheSyncDelay: 1, // Minimal delay
        maxOperationAge: 15 * 1000,
        enableCache: true,
        cacheDbName: this.testDbName,
        cacheStoreName: this.testStoreName
      };
  
      const state = new ModelStore({...defaults, ...options});
      this.activeStates.push(state);
      return state;
    }
  
    // Create metrics for ModelStore
    createMetrics(modelStore) {
      // Initialize fetch mocks if needed
      if (!this.fetchMocks) {
          this.fetchMocks = this.createFetchMocks();
      }
      
      const metrics = {
        count: new Metric({
          modelStoreInstance: modelStore,
          fetchMetricValue: this.fetchMocks.fetchCount,
          initialValue: this._initialMetricValues.count,
          name: 'TotalCount'
        }),
  
        sum: new Metric({
          modelStoreInstance: modelStore,
          fetchMetricValue: this.fetchMocks.fetchSum,
          initialValue: this._initialMetricValues.sum,
          name: 'SalarySum'
        }),
  
        min: new Metric({
          modelStoreInstance: modelStore,
          fetchMetricValue: this.fetchMocks.fetchMin,
          initialValue: this._initialMetricValues.min,
          name: 'MinSalary'
        }),
  
        max: new Metric({
          modelStoreInstance: modelStore,
          fetchMetricValue: this.fetchMocks.fetchMax,
          initialValue: this._initialMetricValues.max,
          name: 'MaxSalary'
        })
      };
  
      this.activeMetrics.push(...Object.values(metrics));
      return metrics;
    }
  
    // Create a render engine for ModelStore
    createRenderEngine(modelStore) {
      const renderEngine = new RenderEngine(modelStore);
      renderEngine.subscribeToChanges(); // Enable cache invalidation
      this.activeRenderEngines.push(renderEngine);
      return renderEngine;
    }
  
    // Create metric render engines with different strategies
    createMetricRenderEngines(modelStore, metrics, renderEngine) {
      const metricRenderEngines = {
        count: new MetricRenderEngine(
          modelStore,
          metrics.count,
          new CountStrategy(),
          renderEngine
        ),
  
        sum: new MetricRenderEngine(
          modelStore,
          metrics.sum,
          new SumStrategy(),
          renderEngine
        ),
  
        min: new MetricRenderEngine(
          modelStore,
          metrics.min,
          new MinStrategy(),
          renderEngine
        ),
  
        max: new MetricRenderEngine(
          modelStore,
          metrics.max,
          new MaxStrategy(),
          renderEngine
        )
      };
  
      this.activeMetricRenderEngines.push(...Object.values(metricRenderEngines));
      return metricRenderEngines;
    }
  
    // Apply operations to the direct DB to keep it in sync with ModelStore
    syncOperation(operation, directDB) {
      const { type, instances } = operation;
  
      switch (type) {
        case 'create':
          directDB.create(instances);
          break;
        case 'update':
          directDB.update(instances);
          break;
        case 'delete':
          const ids = instances.map(instance =>
            typeof instance === 'object' ? instance.id : instance
          );
          directDB.delete(ids);
          break;
      }
    }
  
    // Clean up all resources to prevent test interference
    async cleanup() {
      // Clean up in reverse order of dependency
      for (const engine of this.activeMetricRenderEngines) {
        if (engine) engine.destroy();
      }
      this.activeMetricRenderEngines = [];
  
      for (const engine of this.activeRenderEngines) {
        if (engine) engine.destroy();
      }
      this.activeRenderEngines = [];
  
      for (const metric of this.activeMetrics) {
        if (metric) metric.destroy();
      }
      this.activeMetrics = [];
  
      for (const state of this.activeStates) {
        if (state) await state.destroy();
      }
      this.activeStates = [];
    }
  }

describe('ModelStore Persistence with Metrics Integration', () => {
  let helper;
  
  beforeEach(() => {
    helper = new IntegrationTestHelper();
    helper.directDB = new SimpleDB(initialData, 'id');
    helper.fetchMocks = helper.createFetchMocks();
    vi.clearAllMocks();
  });
  
  afterEach(async () => {
    await helper.cleanup();
  });

test('should persist and restore ModelStore with operations and render metrics correctly', async () => {
    // Phase 1: Setup initial ModelStore and perform operations
    const state1 = helper.createModelStore();
    await state1.ensureCacheLoaded();
    await state1.sync(); // Fetch and save ground truth
    
    // Create render engines
    const renderEngine1 = helper.createRenderEngine(state1);
    const metrics1 = helper.createMetrics(state1);
    const metricEngines1 = helper.createMetricRenderEngines(state1, metrics1, renderEngine1);
    
    // Verify initial state matches SimpleDB
    expect(state1.getGroundTruth()).toEqual(helper.directDB.getAll());
    expect(renderEngine1.render({ offset: 0, limit: 10 })).toEqual(helper.directDB.getAll());
    
    // Check initial metrics
    expect(metricEngines1.count.render()).toBe(helper.directDB.count());
    expect(metricEngines1.sum.render('salary')).toBe(helper.directDB.sum('salary'));
    expect(metricEngines1.min.render('salary')).toBe(helper.directDB.min('salary'));
    expect(metricEngines1.max.render('salary')).toBe(helper.directDB.max('salary'));
    
    // Perform operations
    // 1. Add a new employee
    const newItem = { id: 4, name: 'Dave', role: 'manager', salary: 90000, rating: 4.0, active: true };
    const createOpId = state1.add({
      type: 'create',
      instances: [newItem]
    });
    helper.syncOperation({ type: 'create', instances: [newItem] }, helper.directDB);
    
    // 2. Lower Bob's salary (to test min update)
    const lowerSalary = 60000; // Lower than current min of 75000
    const updateItem = { id: 2, salary: lowerSalary };
    const updateOpId = state1.add({
      type: 'update',
      instances: [updateItem]
    });
    helper.syncOperation({ type: 'update', instances: [updateItem] }, helper.directDB);
    
    // Verify operations applied correctly
    expect(renderEngine1.render({ offset: 0, limit: 10 })).toEqual(helper.directDB.getAll());
    expect(metricEngines1.count.render()).toBe(helper.directDB.count());
    expect(metricEngines1.sum.render('salary')).toBe(helper.directDB.sum('salary'));
    
    // Min should update immediately for a lower value
    expect(metricEngines1.min.render('salary')).toBe(lowerSalary);
    expect(metricEngines1.min.render('salary')).toBe(helper.directDB.min('salary'));
    
    expect(metricEngines1.max.render('salary')).toBe(helper.directDB.max('salary'));
    
    // Save to cache
    await state1._saveToCache();
    
    // Track information for verification after restore
    const versionBeforeDestroy = state1.version;
    const operationCountBeforeDestroy = state1.operations.size;
    
    // Destroy state1 and all its components
    await helper.cleanup();
    
    // Phase 2: Restore from cache and verify
    // Reset fetch mocks to track if they get called during restore
    helper.fetchMocks = helper.createFetchMocks();
    
    // Create new ModelStore pointing to same cache
    const state2 = helper.createModelStore({
      fetchGroundTruth: helper.fetchMocks.fetchData
    });
    
    // Wait for cache load
    await state2.ensureCacheLoaded();
    
    // Verify state was restored correctly
    expect(state2.isStale).toBe(true); // Should be marked as stale
    expect(helper.fetchMocks.fetchData).not.toHaveBeenCalled(); // No fetch yet
    expect(state2.version).toBe(versionBeforeDestroy);
    expect(state2.operations.size).toBe(operationCountBeforeDestroy);
    
    // Create render engines for restored state
    const renderEngine2 = helper.createRenderEngine(state2);
    const metrics2 = helper.createMetrics(state2);
    const metricEngines2 = helper.createMetricRenderEngines(state2, metrics2, renderEngine2);
    
    // Verify data renders correctly after restore
    expect(renderEngine2.render({ offset: 0, limit: 10 })).toEqual(helper.directDB.getAll());
    
    // Verify metrics are correct after restore
    expect(metricEngines2.count.render()).toBe(helper.directDB.count());
    expect(metricEngines2.sum.render('salary')).toBe(helper.directDB.sum('salary'));
    expect(metricEngines2.min.render('salary')).toBe(helper.directDB.min('salary'));
    expect(metricEngines2.max.render('salary')).toBe(helper.directDB.max('salary'));
    
    // Phase 3: Sync the restored state
    // Update DB state to simulate backend changes
    const updatedDirectDB = new SimpleDB(helper.directDB.getAll(), 'id');
    updatedDirectDB.update({ id: 1, salary: 110000 }); // Alice got a raise
    
    // Update fetch mocks to return new DB state
    helper.fetchMocks.fetchData.mockImplementation(() => Promise.resolve([...updatedDirectDB.getAll()]));
    helper.fetchMocks.fetchSum.mockImplementation(() => Promise.resolve(updatedDirectDB.sum('salary')));
    helper.fetchMocks.fetchMax.mockImplementation(() => Promise.resolve(updatedDirectDB.max('salary')));
    
    // Sync the state
    await state2.sync();
    
    // Verify ground truth updated
    expect(state2.getGroundTruth()).toEqual(updatedDirectDB.getAll());
    expect(helper.fetchMocks.fetchData).toHaveBeenCalled();
    
    // Verify metrics were synced
    expect(helper.fetchMocks.fetchCount).toHaveBeenCalled();
    expect(helper.fetchMocks.fetchSum).toHaveBeenCalled();
    expect(helper.fetchMocks.fetchMin).toHaveBeenCalled();
    expect(helper.fetchMocks.fetchMax).toHaveBeenCalled();
    
    // Verify rendered data updated
    helper.directDB = updatedDirectDB; // Update reference DB
    expect(renderEngine2.render({ offset: 0, limit: 10 })).toEqual(helper.directDB.getAll());
    
    // Verify metrics updated
    await vi.waitFor(() => {
      expect(metrics2.sum.getValue()).toBe(updatedDirectDB.sum('salary'));
    });
    
    expect(metricEngines2.count.render()).toBe(helper.directDB.count());
    expect(metricEngines2.sum.render('salary')).toBe(helper.directDB.sum('salary'));
    expect(metricEngines2.min.render('salary')).toBe(helper.directDB.min('salary'));
    expect(metricEngines2.max.render('salary')).toBe(helper.directDB.max('salary'));
    
    // Phase 4: Test deleting the minimum value item
    // Delete Bob (who has the minimum salary)
    const deleteOpId = state2.add({
      type: 'delete',
      instances: [2]  // Bob's ID
    });
    helper.syncOperation({ type: 'delete', instances: [2] }, helper.directDB);
    
    // The min metric shouldn't change until sync because we deleted the minimum value
    const minBeforeDeleteSync = metricEngines2.min.render('salary');
    
    // Calculate what the new min should be after deleting Bob
    const tempDB = new SimpleDB(helper.directDB.getAll(), 'id');
    const expectedNewMin = tempDB.min('salary');
    
    // Now sync to get the updated min from "server"
    helper.fetchMocks.fetchMin.mockImplementation(() => Promise.resolve(expectedNewMin));
    await state2.sync();
    
    // After sync, the min metric should update to the new minimum
    await vi.waitFor(() => {
      expect(metrics2.min.getValue()).toBe(expectedNewMin);
    });
    
    // Verify the min now renders correctly
    expect(metricEngines2.min.render('salary')).toBe(expectedNewMin);
    
    // Verify all other metrics still work
    expect(metricEngines2.count.render()).toBe(helper.directDB.count());
    expect(metricEngines2.sum.render('salary')).toBe(helper.directDB.sum('salary'));
    expect(metricEngines2.max.render('salary')).toBe(helper.directDB.max('salary'));
  });

  test('should handle operation confirmation and rejection across persistence boundary', async () => {
    // Phase 1: Setup ModelStore with pending operations
    const state1 = helper.createModelStore();
    await state1.ensureCacheLoaded();
    await state1.sync();
    
    const renderEngine1 = helper.createRenderEngine(state1);
    const metrics1 = helper.createMetrics(state1);
    const metricEngines1 = helper.createMetricRenderEngines(state1, metrics1, renderEngine1);
    
    // Add operations but don't confirm/reject yet
    const createOpId = state1.add({
      type: 'create',
      instances: [{ id: 4, name: 'Dave', role: 'manager', salary: 90000, rating: 4.0, active: true }]
    });
    
    const updateOpId = state1.add({
      type: 'update',
      instances: [{ id: 1, salary: 110000 }]
    });
    
    const deleteOpId = state1.add({
      type: 'delete',
      instances: [2]
    });
    
    // Update direclDB with these operations for comparison
    const directDBWithAllOps = new SimpleDB(helper.directDB.getAll(), 'id');
    directDBWithAllOps.create({ id: 4, name: 'Dave', role: 'manager', salary: 90000, rating: 4.0, active: true });
    directDBWithAllOps.update({ id: 1, salary: 110000 });
    directDBWithAllOps.delete(2);
    
    // Verify operations applied correctly in memory
    expect(renderEngine1.render({ offset: 0, limit: 10 })).toEqual(directDBWithAllOps.getAll());
    expect(metricEngines1.count.render()).toBe(directDBWithAllOps.count());
    expect(metricEngines1.sum.render('salary')).toBe(directDBWithAllOps.sum('salary'));
    
    // Save to cache
    await state1._saveToCache();
    
    // Phase 2: Restore and confirm/reject operations
    // Destroy and recreate from cache
    await helper.cleanup();
    
    // Reset fetch mocks
    helper.fetchMocks = helper.createFetchMocks();
    
    // Create new ModelStore pointing to same cache
    const state2 = helper.createModelStore({
      fetchGroundTruth: helper.fetchMocks.fetchData
    });
    
    await state2.ensureCacheLoaded();
    
    // Create new render engines
    const renderEngine2 = helper.createRenderEngine(state2);
    const metrics2 = helper.createMetrics(state2);
    const metricEngines2 = helper.createMetricRenderEngines(state2, metrics2, renderEngine2);
    
    // Verify operations were restored
    expect(state2.operations.size).toBe(3);
    expect(state2.operations.has(createOpId)).toBe(true);
    expect(state2.operations.has(updateOpId)).toBe(true);
    expect(state2.operations.has(deleteOpId)).toBe(true);
    
    // Verify rendering with pending operations
    expect(renderEngine2.render({ offset: 0, limit: 10 })).toEqual(directDBWithAllOps.getAll());
    expect(metricEngines2.count.render()).toBe(directDBWithAllOps.count());
    expect(metricEngines2.sum.render('salary')).toBe(directDBWithAllOps.sum('salary'));
    
    // Reject the delete operation
    state2.reject(deleteOpId);
    
    // Bob should be back, directDB reference needs update
    const directDBAfterReject = new SimpleDB(helper.directDB.getAll(), 'id');
    directDBAfterReject.create({ id: 4, name: 'Dave', role: 'manager', salary: 90000, rating: 4.0, active: true });
    directDBAfterReject.update({ id: 1, salary: 110000 });
    // Note: Bob not deleted
    
    // Verify rejection applied correctly
    expect(renderEngine2.render({ offset: 0, limit: 10 })).toEqual(directDBAfterReject.getAll());
    expect(metricEngines2.count.render()).toBe(directDBAfterReject.count());
    expect(metricEngines2.sum.render('salary')).toBe(directDBAfterReject.sum('salary'));
    
    // Confirm the create operation with modified data from "server"
    const finalInstanceData = { 
      id: 4, 
      name: 'Dave Smith', // Name changed by server
      role: 'manager', 
      salary: 92000,     // Salary adjusted
      rating: 4.0, 
      active: true 
    };
    
    state2.confirm(createOpId, [finalInstanceData]);
    
    // Update directDB reference
    const directDBAfterConfirm = new SimpleDB(helper.directDB.getAll(), 'id');
    directDBAfterConfirm.create(finalInstanceData);
    directDBAfterConfirm.update({ id: 1, salary: 110000 });
    
    // Verify confirmation applied with updated data
    expect(renderEngine2.render({ offset: 0, limit: 10 })).toEqual(directDBAfterConfirm.getAll());
    expect(metricEngines2.sum.render('salary')).toBe(directDBAfterConfirm.sum('salary'));
    
    // Save updated state
    await state2._saveToCache();
    
    // Phase 3: Restore again and verify operations state persisted
    await helper.cleanup();
    
    // Reset fetch mocks
    helper.fetchMocks = helper.createFetchMocks();
    
    // Create third ModelStore instance pointing to same cache
    const state3 = helper.createModelStore({
      fetchGroundTruth: helper.fetchMocks.fetchData
    });
    
    await state3.ensureCacheLoaded();
    
    // Create render engines
    const renderEngine3 = helper.createRenderEngine(state3);
    const metrics3 = helper.createMetrics(state3);
    const metricEngines3 = helper.createMetricRenderEngines(state3, metrics3, renderEngine3);
    
    // Verify operation states were persisted
    expect(state3.operations.size).toBe(3);
    expect(state3.operations.get(createOpId).status).toBe('confirmed');
    expect(state3.operations.get(updateOpId).status).toBe('inflight');
    expect(state3.operations.get(deleteOpId).status).toBe('rejected');
    
    // Verify rendering still correct
    expect(renderEngine3.render({ offset: 0, limit: 10 })).toEqual(directDBAfterConfirm.getAll());
    expect(metricEngines3.count.render()).toBe(directDBAfterConfirm.count());
    expect(metricEngines3.sum.render('salary')).toBe(directDBAfterConfirm.sum('salary'));
    
    // Phase 4: Run sync to trim operations
    // Mock the response from server
    helper.fetchMocks.fetchData.mockImplementation(() => Promise.resolve([...directDBAfterConfirm.getAll()]));
    helper.fetchMocks.fetchSum.mockImplementation(() => Promise.resolve(directDBAfterConfirm.sum('salary')));
    helper.fetchMocks.fetchCount.mockImplementation(() => Promise.resolve(directDBAfterConfirm.count()));
    
    // Set maxOperationAge to 0 to ensure trimming
    state3.maxOperationAge = 0;
    
    // Run sync to trigger operation trimming
    await state3.sync();
    
    // Verify confirmed and rejected operations were trimmed
    expect(state3.operations.size).toBe(1); // Only inflight remains
    expect(state3.operations.has(createOpId)).toBe(false); // Confirmed, now trimmed
    expect(state3.operations.has(updateOpId)).toBe(true);  // Still inflight
    expect(state3.operations.has(deleteOpId)).toBe(false); // Rejected, now trimmed
    
    // Verify rendering still correct after trim
    expect(renderEngine3.render({ offset: 0, limit: 10 })).toEqual(directDBAfterConfirm.getAll());
  });

  test('should handle automatic sync after cache restore', async () => {
    // Phase 1: Setup initial state
    const state1 = helper.createModelStore();
    await state1.ensureCacheLoaded();
    await state1.sync();
    await state1._saveToCache();
    
    // Destroy everything
    await helper.cleanup();
    
    // Phase 2: Update "server" data
    // Simulate server-side changes
    const updatedServerData = [...initialData];
    updatedServerData.push({ id: 4, name: 'Dave', role: 'manager', salary: 90000, rating: 4.0, active: true });
    updatedServerData[0].salary = 110000; // Alice got a raise
    
    const serverDB = new SimpleDB(updatedServerData, 'id');
    
    // Reset and update fetch mocks
    helper.fetchMocks = helper.createFetchMocks();
    helper.fetchMocks.fetchData.mockImplementation(() => Promise.resolve([...serverDB.getAll()]));
    helper.fetchMocks.fetchCount.mockImplementation(() => Promise.resolve(serverDB.count()));
    helper.fetchMocks.fetchSum.mockImplementation(() => Promise.resolve(serverDB.sum('salary')));
    helper.fetchMocks.fetchMin.mockImplementation(() => Promise.resolve(serverDB.min('salary')));
    helper.fetchMocks.fetchMax.mockImplementation(() => Promise.resolve(serverDB.max('salary')));
    
    // Phase 3: Restore with auto-sync enabled
    // Create promise to wait for sync completion
    let syncCompletedPromise;
    
    const state2 = helper.createModelStore({
      cacheAutoSync: true,        // Enable auto-sync
      cacheSyncDelay: 10,         // Short delay
      fetchGroundTruth: helper.fetchMocks.fetchData
    });
    
    // Set up promise to detect sync completion
    syncCompletedPromise = new Promise(resolve => {
      state2.subscribe((eventType) => {
        if (eventType === 'sync_completed') {
          resolve(true);
        }
      }, ['sync_completed']);
    });
    
    // Wait for cache load
    await state2.ensureCacheLoaded();
    
    // Create render engines
    const renderEngine2 = helper.createRenderEngine(state2);
    const metrics2 = helper.createMetrics(state2);
    const metricEngines2 = helper.createMetricRenderEngines(state2, metrics2, renderEngine2);
    
    // Verify initial state
    expect(state2.isStale).toBe(true);
    expect(helper.fetchMocks.fetchData).not.toHaveBeenCalled();
    
    // Wait for auto-sync to complete
    await syncCompletedPromise;
    
    // Verify sync happened
    expect(helper.fetchMocks.fetchData).toHaveBeenCalled();
    expect(state2.isStale).toBe(false);
    expect(state2.getGroundTruth()).toEqual(serverDB.getAll());
    
    // Verify metrics were synced
    expect(helper.fetchMocks.fetchCount).toHaveBeenCalled();
    expect(helper.fetchMocks.fetchSum).toHaveBeenCalled();
    
    // Verify rendering after sync
    helper.directDB = serverDB; // Update reference DB
    expect(renderEngine2.render({ offset: 0, limit: 10 })).toEqual(helper.directDB.getAll());
    
    // Verify metrics
    expect(metricEngines2.count.render()).toBe(helper.directDB.count());
    expect(metricEngines2.sum.render('salary')).toBe(helper.directDB.sum('salary'));
    expect(metricEngines2.min.render('salary')).toBe(helper.directDB.min('salary'));
    expect(metricEngines2.max.render('salary')).toBe(helper.directDB.max('salary'));
  });
});