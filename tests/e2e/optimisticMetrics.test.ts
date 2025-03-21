import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { DummyModel } from '../../models/backend1/django_app/dummymodel';
import { DummyRelatedModel } from '../../models/backend1/django_app/dummyrelatedmodel';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader';
import { liveView, liveQueryRegistry } from '../../src/core/liveView';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

describe('Optimistic Metrics Tests', () => {
  let relatedInstance;

  beforeAll(async () => {
    liveQueryRegistry.namespaceRegistry = new Map();
    loadConfigFromFile();
    const config = {
      getAuthHeaders: () => ({
        'Authorization': 'Token testtoken123'
      })
    };
    setBackendConfig('default', config);
  });

  beforeEach(async () => {
    // Clean up before each test
    await DummyModel.objects.all().delete();
    await DummyRelatedModel.objects.all().delete();
    
    // Create a related model to use in tests
    relatedInstance = await DummyRelatedModel.objects.create({ name: 'ValidRelated' });
  });

  afterEach(async () => {
    // Clean up after each test
    await DummyModel.objects.all().delete();
    await DummyRelatedModel.objects.all().delete();
  });

  it('should optimistically update count metric on create', async () => {
    // Create initial data
    await DummyModel.objects.create({ name: 'Item1', value: 10, related: relatedInstance.id });
    await DummyModel.objects.create({ name: 'Item2', value: 20, related: relatedInstance.id });
    
    // Set up a liveQuerySet
    const reactiveArray = [];
    const liveQs = await liveView(DummyModel.objects.all(), reactiveArray);
    
    // Get the initial count - should be 2
    const countMetric = await liveQs.count();
    expect(countMetric.value).toBe(2);
    
    // Create new item - don't await so we can check optimistic updates
    const createPromise = liveQs.create({ 
      name: 'Item3', 
      value: 30, 
      related: relatedInstance.id 
    });
    
    // Check that count is optimistically updated immediately
    expect(countMetric.value).toBe(3);
    
    // Complete the operation
    await createPromise;
    
    // Verify final state
    expect(countMetric.value).toBe(3);
  });

  it('should optimistically update min metric on create with lower value', async () => {
    // Create initial data
    await DummyModel.objects.create({ name: 'Item1', value: 30, related: relatedInstance.id });
    await DummyModel.objects.create({ name: 'Item2', value: 20, related: relatedInstance.id });
    
    // Set up a liveQuerySet
    const reactiveArray = [];
    const liveQs = await liveView(DummyModel.objects.all(), reactiveArray);
    
    // Get the initial min - should be 20
    const minMetric = await liveQs.min('value');
    expect(minMetric.value).toBe(20);
    
    // Create new item with lower value - don't await so we can check optimistic updates
    const createPromise = liveQs.create({ 
      name: 'Item3', 
      value: 10, 
      related: relatedInstance.id 
    });
    
    // Check that min is optimistically updated immediately
    expect(minMetric.value).toBe(10);
    
    // Complete the operation
    await createPromise;
    
    // Verify final state
    expect(minMetric.value).toBe(10);
  });

  it('should optimistically update max metric on create with higher value', async () => {
    // Create initial data
    await DummyModel.objects.create({ name: 'Item1', value: 10, related: relatedInstance.id });
    await DummyModel.objects.create({ name: 'Item2', value: 20, related: relatedInstance.id });
    
    // Set up a liveQuerySet
    const reactiveArray = [];
    const liveQs = await liveView(DummyModel.objects.all(), reactiveArray);
    
    // Get the initial max - should be 20
    const maxMetric = await liveQs.max('value');
    expect(maxMetric.value).toBe(20);
    
    // Create new item with higher value - don't await so we can check optimistic updates
    const createPromise = liveQs.create({ 
      name: 'Item3', 
      value: 30, 
      related: relatedInstance.id 
    });
    
    // Check that max is optimistically updated immediately
    expect(maxMetric.value).toBe(30);
    
    // Complete the operation
    await createPromise;
    
    // Verify final state
    expect(maxMetric.value).toBe(30);
  });

  it('should roll back optimistic update when operation fails', async () => {
    // Create initial data
    await DummyModel.objects.create({ name: 'Item1', value: 10, related: relatedInstance.id });
    await DummyModel.objects.create({ name: 'Item2', value: 20, related: relatedInstance.id });
    
    // Set up a liveQuerySet
    const reactiveArray = [];
    const liveQs = await liveView(DummyModel.objects.all(), reactiveArray);
    
    // Get the initial count - should be 2
    const countMetric = await liveQs.count();
    expect(countMetric.value).toBe(2);
    
    // Try to create new item with invalid related ID to cause a failure
    const invalidRelatedId = 99999; // An ID that doesn't exist
    
    let error;
    try {
      // Create fails - don't await so we can check optimistic updates
      const createPromise = liveQs.create({ 
        name: 'Item3', 
        value: 30, 
        related: invalidRelatedId 
      });
      
      // Check that count is optimistically updated immediately
      expect(countMetric.value).toBe(3);
      
      // This should throw an error
      await createPromise;
    } catch (e) {
      error = e;
    }
    
    // Verify error occurred
    expect(error).toBeDefined();
    
    // Verify rollback occurred
    expect(countMetric.value).toBe(2);
  });

  it('should roll back optimistic min/max updates when create operation fails', async () => {
    // Create initial data
    await DummyModel.objects.create({ name: 'Item1', value: 20, related: relatedInstance.id });
    await DummyModel.objects.create({ name: 'Item2', value: 40, related: relatedInstance.id });
    
    // Set up a liveQuerySet
    const reactiveArray = [];
    const liveQs = await liveView(DummyModel.objects.all(), reactiveArray);
    
    // Get the initial min and max metrics
    const minMetric = await liveQs.min('value');
    const maxMetric = await liveQs.max('value');
    expect(minMetric.value).toBe(20);
    expect(maxMetric.value).toBe(40);
    
    // Try to create new item with both lower min and higher max, but with invalid related ID
    const invalidRelatedId = 99999; // An ID that doesn't exist
    
    let error;
    try {
      // Create fails - don't await so we can check optimistic updates
      const createPromise = liveQs.create({ 
        name: 'Item3', 
        value: 10, // Lower than current min
        related: invalidRelatedId 
      });
      
      // Check that min is optimistically updated immediately
      expect(minMetric.value).toBe(10);
      expect(maxMetric.value).toBe(40); // Max should remain unchanged
      
      // This should throw an error
      await createPromise;
    } catch (e) {
      error = e;
    }
    
    // Verify error occurred
    expect(error).toBeDefined();
    
    // Verify rollback occurred for min
    expect(minMetric.value).toBe(20);
    
    // Try again with a value higher than max
    try {
      // Create fails - don't await so we can check optimistic updates
      const createPromise = liveQs.create({ 
        name: 'Item4', 
        value: 50, // Higher than current max
        related: invalidRelatedId 
      });
      
      // Check that max is optimistically updated immediately
      expect(minMetric.value).toBe(20); // Min should remain unchanged
      expect(maxMetric.value).toBe(50);
      
      // This should throw an error
      await createPromise;
    } catch (e) {
      error = e;
    }
    
    // Verify rollback occurred for max
    expect(maxMetric.value).toBe(40);
  });

  it('should optimistically update count metric on direct delete', async () => {
    // Create initial data
    await DummyModel.objects.create({ name: 'Simple1', value: 10, related: relatedInstance.id });
    await delay(100);
    await DummyModel.objects.create({ name: 'Simple2', value: 20, related: relatedInstance.id });
    await delay(100);
    
    // Set up a liveQuerySet
    const reactiveArray = [];
    const liveQs = await liveView(DummyModel.objects.all().filter({ name__startswith: 'Simple' }), reactiveArray);
    await delay(100);
    
    // Verify initial state
    expect(reactiveArray.length).toBe(2);
    
    // Get the count metric
    const countMetric = await liveQs.count();
    await delay(100);
    
    expect(countMetric.value).toBe(2);
    
    // Start delete operation but DON'T await it yet to check optimistic updates
    const deletePromise = liveQs.delete();
    
    // Check that count is optimistically updated immediately
    expect(countMetric.value).toBe(0);
    
    // Complete the operation
    await deletePromise;
    await delay(200);
    
    // Verify final state
    expect(countMetric.value).toBe(0);
    expect(reactiveArray.length).toBe(0);
  });
  
it('should optimistically update count metric on filtered delete', async () => {
  // Create initial data
  const filterA = await DummyModel.objects.create({ name: 'FilterA', value: 10, related: relatedInstance.id });
  const filterB = await DummyModel.objects.create({ name: 'FilterB', value: 20, related: relatedInstance.id });
  await delay(100);
  
  // Set up a liveQuerySet
  const reactiveArray = [];
  const liveQs = await liveView(DummyModel.objects.all(), reactiveArray);
  await delay(100);
  
  // Get the parent count metric
  const parentCountMetric = await liveQs.count();
  await delay(100);
  
  expect(parentCountMetric.value).toBe(2);
  
  // Create a filtered queryset for B specifically
  const filteredQs = liveQs.filter({ id: filterB.id });
  
  // Get the filtered count metric
  const filteredCountMetric = await filteredQs.count();
  await delay(100);
  
  expect(filteredCountMetric.value).toBe(1); // Just filterB
  
  // Start delete operation but DON'T await it yet to check optimistic updates
  const deletePromise = filteredQs.delete();
  
  // Check that counts are optimistically updated immediately
  expect(filteredCountMetric.value).toBe(0); // Filtered item deleted optimistically
  expect(parentCountMetric.value).toBe(1);   // Only filterA remains optimistically
  
  // Complete the operation
  await deletePromise;
  await delay(100);
  
  // Verify final state
  expect(filteredCountMetric.value).toBe(0);
  expect(parentCountMetric.value).toBe(1);
});
});