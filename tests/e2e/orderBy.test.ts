// tests/e2e/querysetOrderBy.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { DummyModel } from '../../models/backend1/django_app/dummymodel';
import { DummyRelatedModel } from '../../models/backend1/django_app/dummyrelatedmodel';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader'
import { initEventHandler, cleanupEventHandler } from '../../src/syncEngine/stores/operationEventHandlers';

describe('QuerySet OrderBy E2E Tests', () => {
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
      name: 'Test2', 
      value: 20,
      related: relatedInstance
    });
    await DummyModel.objects.create({ 
      name: 'Test1', 
      value: 10,
      related: relatedInstance
    });
    await DummyModel.objects.create({ 
      name: 'Other1', 
      value: 40,
      related: relatedInstance
    });
    await DummyModel.objects.create({ 
      name: 'Test3', 
      value: 30,
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

  it('should return results in descending order with -value', async () => {
    const results = await DummyModel.objects.orderBy('-value').fetch();
    
    // Log results for debugging
    console.log('Descending order results:', results.map(r => ({ name: r.name, value: r.value })));
    
    // Check results count
    expect(results.length).toBe(4);
    
    // Check if values are in descending order
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].value > results[i+1].value).toBe(true);
    }
    
    // First result should have the highest value
    expect(results[0].value).toBe(40);
    expect(results[0].name).toBe('Other1');
    
    // Last result should have the lowest value
    expect(results[results.length-1].value).toBe(10);
    expect(results[results.length-1].name).toBe('Test1');
  });

  it('should return results in ascending order by value', async () => {
    const results = await DummyModel.objects.orderBy('value').fetch();
    
    // Log results for debugging
    console.log('Ascending order results:', results.map(r => ({ name: r.name, value: r.value })));
    
    // Check results count
    expect(results.length).toBe(4);
    
    // Check if values are in ascending order
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].value < results[i+1].value).toBe(true);
    }
    
    // First result should have the lowest value
    expect(results[0].value).toBe(10);
    expect(results[0].name).toBe('Test1');
    
    // Last result should have the highest value
    expect(results[results.length-1].value).toBe(40);
    expect(results[results.length-1].name).toBe('Other1');
  });

  it('should maintain correct order through filter operations', async () => {
    // Filter to only 'Test' entries and order by descending value
    const results = await DummyModel.objects
      .filter({ name__startswith: 'Test' })
      .orderBy('-value')
      .fetch();
    
    // Log results for debugging
    console.log('Filtered & ordered results:', results.map(r => ({ name: r.name, value: r.value })));
    
    // Should only have 3 Test* entries
    expect(results.length).toBe(3);
    
    // Check correct ordering - should be Test3 (30), Test2 (20), Test1 (10)
    expect(results[0].name).toBe('Test3');
    expect(results[0].value).toBe(30);
    
    expect(results[1].name).toBe('Test2');
    expect(results[1].value).toBe(20);
    
    expect(results[2].name).toBe('Test1');
    expect(results[2].value).toBe(10);
    
    // Check descending order
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].value > results[i+1].value).toBe(true);
    }
  });

  it('should handle multiple ordering fields', async () => {
    // Create two records with the same value but different names
    await DummyModel.objects.create({ 
      name: 'SameValue1', 
      value: 50,
      related: relatedInstance
    });
    await DummyModel.objects.create({ 
      name: 'SameValue2', 
      value: 50,
      related: relatedInstance
    });
    
    // Order by value (desc) then name (asc)
    const results = await DummyModel.objects
      .orderBy('-value', 'name')
      .fetch();
    
    // Log results for debugging
    console.log('Multi-field ordered results:', results.map(r => ({ name: r.name, value: r.value })));
    
    // Should be 6 total entries
    expect(results.length).toBe(6);
    
    // First two entries should have value 50
    expect(results[0].value).toBe(50);
    expect(results[1].value).toBe(50);
    
    // And should be ordered by name
    expect(results[0].name).toBe('SameValue1');
    expect(results[1].name).toBe('SameValue2');
    
    // The next should be Other1 with value 40
    expect(results[2].name).toBe('Other1');
    expect(results[2].value).toBe(40);
  });

  it('should work with complex query chaining', async () => {
    // Filter, order, and fetch in a single chain
    const results = await DummyModel.objects
      .filter({ name__startswith: 'Test' })  // Only Test* records
      .orderBy('-value')                     // Descending by value
      .fetch();
    
    // Log results for debugging
    console.log('Complex chain results:', results.map(r => ({ name: r.name, value: r.value })));
    
    // Should only contain Test* entries in descending value order
    expect(results.length).toBe(3);
    expect(results[0].name).toBe('Test3');
    expect(results[0].value).toBe(30);
    expect(results[2].name).toBe('Test1');
    expect(results[2].value).toBe(10);
  });
});