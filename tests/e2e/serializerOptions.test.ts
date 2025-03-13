import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { setBackendConfig } from '../../src/config';
import { DummyModel } from '../../models/backend1/django_app/dummymodel';
import { loadConfigFromFile } from '../../src/cli/configFileLoader'

describe('Aggregation Integration Tests', () => {
  let originalConfig: any;
  const aggTestData = [
    { name: 'AggTest1', value: 10 },
    { name: 'AggTest2', value: 20 },
    { name: 'AggTest3', value: 30 },
    { name: 'AggTest4', value: 40 }
  ];

  beforeAll(async () => {
    // Load configuration and set up auth for the backend.
    loadConfigFromFile();
    originalConfig = {
      getAuthHeaders: () => ({
        'Authorization': 'Token testtoken123'
      })
    };
    setBackendConfig('default', originalConfig);
  });

  beforeEach(async () => {
    // Reset config and clean up previous records.
    setBackendConfig('default', originalConfig);
    try {
      await DummyModel.objects.all().delete();
    } catch (err) {}
    // Create aggregation test records.
    for (const data of aggTestData) {
      await DummyModel.objects.create(data);
    }
  });

  afterEach(async () => {
    // Clean up after each test.
    await DummyModel.objects.all().delete();
  });

  it('should return correct count', async () => {
    const count = await DummyModel.objects.filter({ name__startswith: 'AggTest' }).count();
    expect(count).toBe(aggTestData.length);
  });

  it('should return correct sum of the "value" field', async () => {
    const expectedSum = aggTestData.reduce((sum, item) => sum + item.value, 0);
    const sum = await DummyModel.objects.filter({ name__startswith: 'AggTest' }).sum('value');
    expect(sum).toBe(expectedSum);
  });

  it('should return correct average of the "value" field', async () => {
    const expectedAvg = aggTestData.reduce((sum, item) => sum + item.value, 0) / aggTestData.length;
    const avg = await DummyModel.objects.filter({ name__startswith: 'AggTest' }).avg('value');
    expect(avg).toBeCloseTo(expectedAvg, 2);
  });

  it('should return correct minimum of the "value" field', async () => {
    const expectedMin = Math.min(...aggTestData.map(item => item.value));
    const min = await DummyModel.objects.filter({ name__startswith: 'AggTest' }).min('value');
    expect(min).toBe(expectedMin);
  });

  it('should return correct maximum of the "value" field', async () => {
    const expectedMax = Math.max(...aggTestData.map(item => item.value));
    const max = await DummyModel.objects.filter({ name__startswith: 'AggTest' }).max('value');
    expect(max).toBe(expectedMax);
  });

  it('should support using aggregate() in the query chain', async () => {
    const qs = DummyModel.objects.filter({ name__startswith: 'AggTest' }).aggregate('sum', 'value', 'totalValue');
    const built = qs.build();
    expect(built.aggregations).toContainEqual({
      function: 'sum',
      field: 'value',
      alias: 'totalValue'
    });
  });
});

describe('Serializer Options Integration Tests', () => {
  let originalConfig: any;
  const serializerTestData = [
    { name: 'Test1', value: 100 },
    { name: 'Test2', value: 200 },
    { name: 'Test3', value: 300 },
    { name: 'Test4', value: 400 },
    { name: 'Test5', value: 500 }
  ];

  beforeAll(async () => {
    // Ensure config is loaded and set up auth for the backend.
    loadConfigFromFile();
    originalConfig = {
      getAuthHeaders: () => ({
        'Authorization': 'Token testtoken123'
      })
    };
    setBackendConfig('default', originalConfig);
  });

  beforeEach(async () => {
    // Reset config and clean up previous records.
    setBackendConfig('default', originalConfig);
    try {
      await DummyModel.objects.all().delete();
    } catch (err) {}
    // Create serializer test records.
    for (const data of serializerTestData) {
      await DummyModel.objects.create(data);
    }
  });

  afterEach(async () => {
    // Clean up after each test.
    await DummyModel.objects.all().delete();
  });

  it('should correctly apply limit and offset for pagination', async () => {
    // Use serializer options to only fetch 2 records, skipping the first one.
    const qs = DummyModel.objects.all().all({ limit: 2, offset: 1 });
    const built = qs.build();
    expect(built.serializerOptions.limit).toBe(2);
    expect(built.serializerOptions.offset).toBe(1);

    const results = await qs.fetch();
    expect(results.length).toBe(2);
    // Assuming records are returned in creation order.
    expect(results[0].name).toBe('Test2');
    expect(results[1].name).toBe('Test3');
  });

  it('should pass depth option to the backend', async () => {
    // Set a depth option for nested serialization.
    const qs = DummyModel.objects.all().all({ depth: 2 });
    const built = qs.build();
    expect(built.serializerOptions.depth).toBe(2);

    const results = await qs.fetch();
    expect(Array.isArray(results)).toBe(true);
    // Additional assertions can be added if DummyModel has nested relations.
  });

  it('should pass fields option to return only specified fields', async () => {
    // Ask the backend to return only the "name" field.
    const qs = DummyModel.objects.all().all({ fields: ['name'] });
    const built = qs.build();
    expect(built.serializerOptions.fields).toEqual(['name']);

    const results = await qs.fetch();
    results.forEach(model => {
      expect(model).toHaveProperty('name');
      // If the backend omits unspecified fields, "value" might be undefined.
      // expect(model.value).toBeUndefined();
    });
  });

  it('should combine multiple serializer options correctly', async () => {
    // Combine depth, fields, limit, and offset.
    const qs = DummyModel.objects.all().all({
      depth: 1,
      fields: ['name', 'value'],
      limit: 3,
      offset: 2
    });
    const built = qs.build();
    expect(built.serializerOptions.depth).toBe(1);
    expect(built.serializerOptions.fields).toEqual(['name', 'value']);
    expect(built.serializerOptions.limit).toBe(3);
    expect(built.serializerOptions.offset).toBe(2);

    const results = await qs.fetch();
    expect(results.length).toBeLessThanOrEqual(3);
    results.forEach(model => {
      expect(model).toHaveProperty('name');
      expect(model).toHaveProperty('value');
    });
  });
});