import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { DummyModel } from '../../models/backend1/django_app/dummymodel';
import { DummyRelatedModel } from '../../models/backend1/django_app/dummyrelatedmodel';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader'
import { ValidationError } from '../../src/flavours/django/errors';
import { Q } from '../../src/flavours/django/q';

describe('QuerySet Filter & Exclude Tests', () => {
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
  });

  beforeEach(async () => {
    // Reset config and clear the database before each test
    setBackendConfig('default', originalConfig);
    await DummyModel.objects.fetch({}); // Ensure previous queries are materialized/deleted.
    await DummyModel.objects.all().delete();
    await DummyRelatedModel.objects.all().delete();

    // Create a valid related model instance for lookup tests
    relatedInstance = await DummyRelatedModel.objects.create({ name: 'ValidRelated' });
  });

  afterEach(async () => {
    // Clean up the database and reset config after each test
    await DummyModel.objects.all().delete();
    await DummyRelatedModel.objects.all().delete();
    setBackendConfig('default', originalConfig);
  });

  it('should return correct records with basic filter conditions', async () => {
    await DummyModel.objects.create({ name: 'FilterTest1', value: 10, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'FilterTest2', value: 20, related: relatedInstance.pk });
    const results = await DummyModel.objects.filter({ value: 10 }).fetch();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('FilterTest1');
  });

  it('should support complex lookups with Q objects', async () => {
    await DummyModel.objects.create({ name: 'ComplexTest1', value: 15, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'ComplexTest2', value: 25, related: relatedInstance.pk });
    // Combine multiple conditions using Q objects (default combination is AND)
    const results = await DummyModel.objects.filter({
      Q: [
        { name: 'ComplexTest1', value__lt: 20 },
        { value__gt: 10 }
      ]
    }).fetch();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('ComplexTest1');
  });

  it('should exclude records properly', async () => {
    await DummyModel.objects.create({ name: 'ExcludeTest1', value: 5, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'ExcludeTest2', value: 15, related: relatedInstance.pk });
    const results = await DummyModel.objects.exclude({ value: 5 }).fetch();
    expect(results.some(rec => rec.name === 'ExcludeTest1')).toBe(false);
    expect(results.length).toBe(1);
  });

  it('should filter records with range queries using __gte and __lte', async () => {
    await DummyModel.objects.create({ name: 'RangeTest1', value: 10, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'RangeTest2', value: 20, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'RangeTest3', value: 30, related: relatedInstance.pk });
    const results = await DummyModel.objects.filter({ value__gte: 15, value__lte: 25 }).fetch();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('RangeTest2');
  });

  it('should throw ValidationError for invalid field names in filter', async () => {
    await expect(
      DummyModel.objects.filter({ invalidField: 'test' }).fetch()
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('should handle filtering with special characters in field values', async () => {
    const specialName = 'Special!@#$%^&*()';
    await DummyModel.objects.create({ name: specialName, value: 100, related: relatedInstance.pk });
    const results = await DummyModel.objects.filter({ name: specialName }).fetch();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe(specialName);
  });

  it('should return an empty array when no records match the filter', async () => {
    await DummyModel.objects.create({ name: 'NoMatchTest', value: 50, related: relatedInstance.pk });
    const results = await DummyModel.objects.filter({ name: 'NonExistent' }).fetch();
    expect(results.length).toBe(0);
  });

  it('should filter using nested related field lookups', async () => {
    await DummyModel.objects.create({ name: 'RelatedTest', value: 10, related: relatedInstance.pk });
    const results = await DummyModel.objects.filter({ 'related__name': 'ValidRelated' }).fetch();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('RelatedTest');
  });

  // Additional tests for chained filters and nested model parameters:

  it('should support chaining multiple filters correctly', async () => {
    await DummyModel.objects.create({ name: 'ChainTest1', value: 5, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'ChainTest2', value: 15, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'ChainTest3', value: 25, related: relatedInstance.pk });

    const qs = DummyModel.objects.filter({ value__gte: 10 });
    const results = await qs.filter({ value__lte: 20 }).fetch();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('ChainTest2');
  });

  it('should return all records when filtering with an empty object', async () => {
    await DummyModel.objects.create({ name: 'EmptyFilterTest1', value: 100, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'EmptyFilterTest2', value: 200, related: relatedInstance.pk });
    const results = await DummyModel.objects.filter({}).fetch();
    expect(results.length).toBe(2);
  });

  it('should filter nested model parameters with chained filters', async () => {
    // Create multiple related instances with distinct names
    const relatedA = await DummyRelatedModel.objects.create({ name: 'RelatedA' });
    const relatedB = await DummyRelatedModel.objects.create({ name: 'RelatedB' });

    await DummyModel.objects.create({ name: 'NestedChainTest1', value: 10, related: relatedA.pk });
    await DummyModel.objects.create({ name: 'NestedChainTest2', value: 20, related: relatedB.pk });
    await DummyModel.objects.create({ name: 'NestedChainTest3', value: 30, related: relatedA.pk });

    // First, filter on nested related field, then chain with a range filter
    const qs = DummyModel.objects.filter({ 'related__name': 'RelatedA' });
    const results = await qs.filter({ value__gte: 15 }).fetch();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('NestedChainTest3');
  });

  it('should support chaining filters using both object and Q object syntax', async () => {
    await DummyModel.objects.create({ name: 'ChainedMixed1', value: 5, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'ChainedMixed2', value: 15, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'ChainedMixed3', value: 25, related: relatedInstance.pk });

    // Use an object filter and then chain with a Q object condition
    const qs = DummyModel.objects.filter({ value__gte: 10 });
    const results = await qs.filter({
      Q: [{ value__lte: 20 }]
    }).fetch();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('ChainedMixed2');
  });

  // --- Additional Q Object Tests for OR and AND Behaviour ---

  it('should return records matching OR conditions using Q objects', async () => {
    // Create several records
    await DummyModel.objects.create({ name: 'OrTest1', value: 10, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'OrTest2', value: 20, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'OrTest3', value: 30, related: relatedInstance.pk });

    // Use an explicit OR operator to get records where either value equals 10 OR value equals 30.
    const qs = DummyModel.objects.filter({
      Q: [
        Q('OR', { value: 10 }, { value: 30 })
      ]
    });
    const results = await qs.fetch();
    expect(results.length).toBe(2);
    const values = results.map(r => r.value);
    expect(values).toContain(10);
    expect(values).toContain(30);
  });

  it('should return records matching AND conditions using Q objects', async () => {
    // Create records that vary by name and value.
    await DummyModel.objects.create({ name: 'AndTest1', value: 15, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'AndTest2', value: 15, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'AndTest1', value: 25, related: relatedInstance.pk });

    // When combining multiple Q conditions without an explicit operator, they default to AND.
    const qs = DummyModel.objects.filter({
      Q: [
        { name: 'AndTest1' },
        { value: 15 }
      ]
    });
    const results = await qs.fetch();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('AndTest1');
    expect(results[0].value).toBe(15);
  });

  it('should support nested Q objects combining OR and AND conditions', async () => {
    // Create several records with different attributes.
    await DummyModel.objects.create({ name: 'NestedTest1', value: 10, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'NestedTest2', value: 20, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'NestedTest3', value: 30, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'NestedTest4', value: 40, related: relatedInstance.pk });

    // Build a nested Q query:
    // ((value equals 10 OR value equals 30) AND name equals "NestedTest1")
    const orCondition = Q('OR', { value: 10 }, { value: 30 });
    const qs = DummyModel.objects.filter({
      Q: [
        orCondition,
        { name: 'NestedTest1' }
      ]
    });
    const results = await qs.fetch();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('NestedTest1');
    expect(results[0].value).toBe(10);
  });

  it('should support chaining Q objects with object filters', async () => {
    // Create records with mixed attributes.
    await DummyModel.objects.create({ name: 'ChainQTest1', value: 5, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'ChainQTest2', value: 15, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'ChainQTest3', value: 25, related: relatedInstance.pk });
    
    // First, filter with a Q object (OR condition) and then chain an object filter.
    const qs = DummyModel.objects.filter({
      Q: [ Q('OR', { name: 'ChainQTest1' }, { name: 'ChainQTest3' }) ]
    }).filter({ value__gte: 10 });
    const results = await qs.fetch();
    // Only ChainQTest3 should match because ChainQTest1 is filtered out by value__gte:10.
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('ChainQTest3');
    expect(results[0].value).toBe(25);
  });

  // --- Extra Tests for Additional Edge Cases ---

  it('should support chaining multiple excludes', async () => {
    // Create records with different values.
    await DummyModel.objects.create({ name: 'MultiExclude1', value: 5, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'MultiExclude2', value: 10, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'MultiExclude3', value: 15, related: relatedInstance.pk });
    // Chain two exclude calls.
    const results = await DummyModel.objects
      .exclude({ value: 5 })
      .exclude({ value: 10 })
      .fetch();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('MultiExclude3');
  });

  it('should support mixed chaining of filters and excludes', async () => {
    // Create several records.
    await DummyModel.objects.create({ name: 'MixedTest1', value: 5, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'MixedTest2', value: 15, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'MixedTest3', value: 25, related: relatedInstance.pk });
    // Apply filter, then exclude, then another filter.
    const results = await DummyModel.objects
      .filter({ value__gte: 5 })
      .exclude({ name: 'MixedTest1' })
      .filter({ value__lte: 25 })
      .fetch();
    expect(results.length).toBe(2);
    const names = results.map(r => r.name);
    expect(names).toContain('MixedTest2');
    expect(names).toContain('MixedTest3');
  });

  it('should handle an empty Q array without affecting the query', async () => {
    await DummyModel.objects.create({ name: 'EmptyQTest1', value: 10, related: relatedInstance.pk });
    // Pass an empty Q array.
    const results = await DummyModel.objects.filter({ Q: [] }).fetch();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('EmptyQTest1');
  });

  it('should support deeply nested Q objects', async () => {
    // Create records with varying attributes.
    await DummyModel.objects.create({ name: 'DeepNested1', value: 10, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'DeepNested2', value: 20, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'DeepNested3', value: 30, related: relatedInstance.pk });

    // Build a deeply nested Q: ((name equals 'DeepNested1' OR (name equals 'DeepNested2' AND value < 25)) AND value >= 10)
    const nestedQ = Q(
      'OR',
      { name: 'DeepNested1' },
      Q('AND', { name: 'DeepNested2' }, { value__lt: 25 })
    );
    const qs = DummyModel.objects.filter({
      Q: [ nestedQ, { value__gte: 10 } ]
    });
    const results = await qs.fetch();
    // Expect both DeepNested1 and DeepNested2 to match.
    expect(results.length).toBe(2);
    const names = results.map(r => r.name);
    expect(names).toContain('DeepNested1');
    expect(names).toContain('DeepNested2');
  });

  // --- Demonstrating the async iterator via the spread operator ---
  it('should support using the spread operator to iterate over the QuerySet', async () => {
    await DummyModel.objects.create({ name: 'SpreadTest1', value: 10, related: relatedInstance.pk });
    await DummyModel.objects.create({ name: 'SpreadTest2', value: 20, related: relatedInstance.pk });
    // Using the async iterator to collect all items.
    const results = [];
    for await (const item of DummyModel.objects.filter({ value: 10 })) {
      results.push(item);
    }
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('SpreadTest1');
  });

  it('should filter using a related model field with icontains operator', async () => {
    // Create related instances with names that contain various substrings.
    const relatedAlice = await DummyRelatedModel.objects.create({ name: 'Alice Johnson' });
    const relatedBob = await DummyRelatedModel.objects.create({ name: 'Bob Smith' });
    const relatedCharlie = await DummyRelatedModel.objects.create({ name: 'Charlie Brown' });
    
    // Create DummyModel instances linked to these related models.
    await DummyModel.objects.create({ name: 'Book1', value: 1, related: relatedAlice.pk });
    await DummyModel.objects.create({ name: 'Book2', value: 2, related: relatedBob.pk });
    await DummyModel.objects.create({ name: 'Book3', value: 3, related: relatedCharlie.pk });
    
    // Filter DummyModel instances where the related model's name icontains 'bob'
    const results = await DummyModel.objects.filter({ 'related__name__icontains': 'bob' }).fetch();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Book2');
  });
  
});