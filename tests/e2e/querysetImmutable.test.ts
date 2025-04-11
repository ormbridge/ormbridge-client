import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { DummyModel } from '../../models/backend1/django_app/dummymodel';
import { DummyRelatedModel } from '../../models/backend1/django_app/dummyrelatedmodel';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader'
import { initEventHandler, cleanupEventHandler } from '../../src/syncEngine/stores/operationEventHandlers';
import { 
  DoesNotExist, 
  ValidationError, 
  MultipleObjectsReturned,
  PermissionDenied,
  ConfigError 
} from '../../src/flavours/django/errors';

describe('Immutable QuerySet Tests', () => {
  let relatedInstance: any;
  let originalConfig: any;

  beforeAll(async () => {
    loadConfigFromFile();
    originalConfig = {
      getAuthHeaders: () => ({
        'Authorization': 'Token testtoken123'
      })
    };
    setBackendConfig('default', originalConfig);
    initEventHandler()
  });

  beforeEach(async () => {
    // Reset config before each test
    setBackendConfig('default', originalConfig);
    
    // Manual cleanup of all models before each test
    await DummyModel.objects.all().delete();
    await DummyRelatedModel.objects.all().delete();

    // Create a valid related model instance for use in tests
    relatedInstance = await DummyRelatedModel.objects.create({ name: 'ValidRelated' });
    
    // Create test data for our queries using the correct field names from DummyModel
    await DummyModel.objects.create({ 
      name: 'Test1', 
      value: 10,
      related: relatedInstance
    });
    await DummyModel.objects.create({ 
      name: 'Test2', 
      value: 20,
      related: relatedInstance
    });
    await DummyModel.objects.create({ 
      name: 'Test3', 
      value: 30,
      related: relatedInstance
    });
    await DummyModel.objects.create({ 
      name: 'Other1', 
      value: 40,
      related: relatedInstance
    });
  });

  afterEach(async () => {
    // Ensure the database is cleaned up after each test
    await DummyModel.objects.all().delete();
    await DummyRelatedModel.objects.all().delete();
    
    // Reset config after each test
    setBackendConfig('default', originalConfig);
  });

  afterAll(async () => {
    cleanupEventHandler()
  })

  it('should not modify original queryset when derived queryset is filtered', async () => {
    // Create a base queryset with a name filter
    const baseQs = DummyModel.objects.filter({ name__contains: 'Test' });
    
    // Derive a new queryset with additional filter
    const valueFilterQs = baseQs.filter({ value__gt: 15 });
    
    // Fetch results from both querysets
    const baseResults = await baseQs.fetch();
    const valueFilterResults = await valueFilterQs.fetch();
    
    // The base queryset should return all Test records (3)
    expect(baseResults.length).toBe(3);
    
    // The derived queryset should only return Test records with value > 15 (2)
    expect(valueFilterResults.length).toBe(2);
    
    // Double-check that results match expected criteria
    baseResults.forEach(item => {
      expect(item.name.includes('Test')).toBe(true);
    });
    
    valueFilterResults.forEach(item => {
      expect(item.name.includes('Test')).toBe(true);
      expect(item.value > 15).toBe(true);
    });
  });

  it('should not modify original queryset when derived queryset is ordered', async () => {
    // Create a base queryset
    const baseQs = DummyModel.objects.all();
    
    // By default, records might come back in any order
    const baseResults = await baseQs.fetch();
    
    // Create a derived queryset with ordering
    const orderedQs = baseQs.orderBy('-value');
    const orderedResults = await orderedQs.fetch();
    
    // Both should have the same number of results
    expect(baseResults.length).toBe(orderedResults.length);
    
    // The ordered queryset should have descending values
    for (let i = 0; i < orderedResults.length - 1; i++) {
      expect(orderedResults[i].value > orderedResults[i+1].value).toBe(true);
    }
    
    // Make another query on the original to ensure it wasn't affected
    const baseResultsAgain = await baseQs.fetch();
    expect(baseResultsAgain.length).toBe(baseResults.length);
  });

  it('should allow reusing a queryset after terminal operations', async () => {
    // Create a base queryset
    const baseQs = DummyModel.objects.filter({ name__contains: 'Test' });
    
    // Perform a terminal operation
    const firstTest = await baseQs.first();
    expect(firstTest).not.toBeNull();
    
    // The original queryset should still be usable
    const allTests = await baseQs.fetch();
    expect(allTests.length).toBe(3);
    
    // And we should be able to chain more filters
    const highValueTests = await baseQs.filter({ value__gt: 15 }).fetch();
    expect(highValueTests.length).toBe(2);
  });

  it('should allow multiple separate filter operations without accumulating', async () => {
    // Create a base queryset
    const baseQs = DummyModel.objects.all();
    
    // Apply different filters in separate operations
    const testQs = baseQs.filter({ name__startswith: 'Test' });
    const otherQs = baseQs.filter({ name__startswith: 'Other' });
    
    // Both querysets should have different results
    const testResults = await testQs.fetch();
    const otherResults = await otherQs.fetch();
    
    expect(testResults.length).toBe(3);
    expect(otherResults.length).toBe(1);
    
    // Original should still be intact
    const baseResults = await baseQs.fetch();
    expect(baseResults.length).toBe(4);
  });

  it('should accumulate filters when chained directly', async () => {
    // Chain filters directly
    const chainedQs = DummyModel.objects
      .filter({ name__startswith: 'Test' })
      .filter({ value__gt: 15 });
    
    const results = await chainedQs.fetch();
    
    // Should only find Test2 and Test3 (starts with Test, value > 15)
    expect(results.length).toBe(2);
    expect(results.some(r => r.name === 'Test2')).toBe(true);
    expect(results.some(r => r.name === 'Test3')).toBe(true);
  });

  it('should allow aggregation operations without materializing the queryset', async () => {
    // Create a base queryset
    const baseQs = DummyModel.objects.all();
    
    // Perform an aggregation
    const sumQs = baseQs.aggregate('sum', 'value', 'total_value');
    
    // Verify the aggregation was configured properly
    const built = sumQs.build();
    expect(built.aggregations).toContainEqual({
      function: 'sum',
      field: 'value',
      alias: 'total_value'
    });
    
    // The original queryset should still be usable
    const baseResults = await baseQs.fetch();
    expect(baseResults.length).toBe(4);
  });
  
  it('should support complex query operations in any order', async () => {
    // Create a complex query with multiple operations
    const qs = DummyModel.objects.filter({ name__contains: 'Test' });
    
    // Get count - a terminal operation
    const count = await qs.count();
    expect(count).toBe(3);
    
    // Filter more - should still work despite previous terminal operation
    const filtered = await qs.filter({ value__gt: 15 }).fetch();
    expect(filtered.length).toBe(2);
    
    // Order results
    const ordered = await qs.orderBy('-value').fetch();
    expect(ordered[0].value).toBe(30); // Highest value among Test* is Test3 with 30
    
    // Complex chaining still works
    const complex = await qs
      .filter({ value__lt: 30 })
      .orderBy('value')
      .first();
    
    expect(complex?.name).toBe('Test1'); // Test1 has lowest value among Test*
  });
});