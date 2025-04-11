import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { DummyModel } from '../../models/backend1/django_app/dummymodel';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader'
import { initEventHandler, cleanupEventHandler } from '../../src/syncEngine/stores/operationEventHandlers';

describe('QuerySet Search Tests', () => {
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
    // Clear all DummyModel records before each test
    await DummyModel.objects.all().delete();
  });

  afterEach(async () => {
    // Clean up after each test
    await DummyModel.objects.all().delete();
    setBackendConfig('default', originalConfig);
  });

  afterAll(async () => {
    cleanupEventHandler()
  })

  it('should return matching record when search query is provided without searchFields', async () => {
    // DummyModel config searchable_fields = {"name"}
    await DummyModel.objects.create({ name: 'Alpha', value: 1 });
    await DummyModel.objects.create({ name: 'Beta', value: 2 });
    
    // No searchFields provided, so full config ("name") is used.
    const results = await DummyModel.objects.search("Alpha").fetch();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Alpha');
  });

  it('should return matching record when search query is provided with searchFields that intersect config', async () => {
    await DummyModel.objects.create({ name: 'Alpha', value: 1 });
    await DummyModel.objects.create({ name: 'Beta', value: 2 });
    
    // Provide searchFields that intersect the config ("name")
    const results = await DummyModel.objects.search("Alpha", ["name"]).fetch();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Alpha');
  });

  it('should not apply search when searchFields provided do not intersect config', async () => {
    // Create two records
    await DummyModel.objects.create({ name: 'Alpha', value: 1 });
    await DummyModel.objects.create({ name: 'Beta', value: 2 });
    
    // Provide searchFields that do not intersect config (e.g. "value")
    // In this case the intersection is empty, so the search node does nothing.
    const results = await DummyModel.objects.search("Alpha", ["value"]).fetch();
    expect(results.length).toBe(2);
  });

  it('should return all records if searchQuery is empty', async () => {
    await DummyModel.objects.create({ name: 'Alpha', value: 1 });
    await DummyModel.objects.create({ name: 'Beta', value: 2 });
    
    // An empty search query results in no search filtering.
    const results = await DummyModel.objects.search("").fetch();
    expect(results.length).toBe(2);
  });

  it('should combine search with filter correctly', async () => {
    // Create three records:
    // - One that matches the filter and the search.
    // - One that matches only the filter.
    // - One that matches neither.
    await DummyModel.objects.create({ name: 'Alpha', value: 10 });
    await DummyModel.objects.create({ name: 'Beta', value: 20 });
    await DummyModel.objects.create({ name: 'Alpha', value: 30 });
    
    // Apply a filter that selects records with value > 15, then search for "Alpha".
    // Only the third record should be returned.
    const results = await DummyModel.objects
      .filter({ value__gte: 15 })
      .search("Alpha")
      .fetch();
      
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Alpha');
    expect(results[0].value).toBe(30);
  });
});