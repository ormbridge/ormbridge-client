import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader'
import { DummyModel } from '../../models/backend1/django_app/dummymodel';

describe('Aggregation Integration Tests', () => {
  let originalConfig: any;
  const testData = [
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
    // Reset config before each test.
    setBackendConfig('default', originalConfig);
    // Clean up any previous records.
    try {
      await DummyModel.objects.all().delete();
    } catch (err) {}
    // Create test records.
    for (const data of testData) {
      await DummyModel.objects.create(data);
    }
  });

  afterEach(async () => {
    // Clean up after each test.
    await DummyModel.objects.all().delete();
  });

  it('should return correct count', async () => {
    const count = await DummyModel.objects.filter({ name__startswith: 'AggTest' }).count();
    expect(count).toBe(testData.length);
  });

  it('should return correct sum of the "value" field', async () => {
    const expectedSum = testData.reduce((sum, item) => sum + item.value, 0);
    const sum = await DummyModel.objects.filter({ name__startswith: 'AggTest' }).sum('value');
    expect(sum).toBe(expectedSum);
  });

  it('should return correct average of the "value" field', async () => {
    const expectedAvg = testData.reduce((sum, item) => sum + item.value, 0) / testData.length;
    const avg = await DummyModel.objects.filter({ name__startswith: 'AggTest' }).avg('value');
    expect(avg).toBeCloseTo(expectedAvg, 2);
  });

  it('should return correct minimum of the "value" field', async () => {
    const expectedMin = Math.min(...testData.map(item => item.value));
    const min = await DummyModel.objects.filter({ name__startswith: 'AggTest' }).min('value');
    expect(min).toBe(expectedMin);
  });

  it('should return correct maximum of the "value" field', async () => {
    const expectedMax = Math.max(...testData.map(item => item.value));
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
