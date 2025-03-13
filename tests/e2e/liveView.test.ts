import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader'
import { DummyModel } from '../../models/backend1/django_app/dummymodel';
import { DummyRelatedModel } from '../../models/backend1/django_app/dummyrelatedmodel';
import { 
  legacyLiveView as liveView, 
  LiveQuerySet,
  activeOperationIds,
  generateOperationId
} from '../../src/core/liveView';
import { MultipleObjectsReturned, DoesNotExist } from '../../src/flavours/django/errors';

// Configuration for test user
const testConfig = {
  API_URL: 'http://127.0.0.1:8000/ormbridge',
  GENERATED_TYPES_DIR: './models/backend1',
  getAuthHeaders: () => ({
    'Authorization': 'Token testtoken123'
  }),
  events: {
    type: 'pusher',
    pusher: {
      clientOptions: {
        appKey: '31f0a279ab07525d29ba',
        cluster: 'eu',
        forceTLS: true,
        authEndpoint: 'http://127.0.0.1:8000/ormbridge/events/auth/'
      }
    }
  }
};

// Helper function to wait for a specific amount of time
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to wait for a condition to be true with timeout
const waitForCondition = async (condition, maxWait = 5000, checkInterval = 100) => {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWait) {
    if (await condition()) {
      return true;
    }
    await wait(checkInterval);
  }
  
  return false;
};

// Increase test timeout to accommodate network delays
vi.setConfig({
  testTimeout: 40000, // 40 seconds
});

describe('LiveView E2E Tests', () => {
  let originalConfig: any;

  beforeAll(async () => {
    loadConfigFromFile();
    originalConfig = testConfig;
    setBackendConfig('default', originalConfig);
  });

  beforeEach(async () => {
    // Ensure operation ID is cleared before starting test
    activeOperationIds.clear();
    
    // Wait to give the server time to recover from previous tests
    await wait(300);
    
    try {
      // Delete all test data with sufficient wait times
      await DummyModel.objects.all().delete();
      await wait(200);
      await DummyRelatedModel.objects.all().delete();
      await wait(200);
    } catch (error) {
      console.warn('Error during test cleanup:', error);
    }
  });

  afterEach(async () => {
    // Clear operation ID
    activeOperationIds.clear();
    
    try {
      // Clean up remaining data with sufficient wait times
      await DummyModel.objects.all().delete();
      await wait(200);
      await DummyRelatedModel.objects.all().delete();
      await wait(200);
    } catch (error) {
      console.warn('Error during test cleanup:', error);
    }
  });

  it('should initialize a LiveQuerySet with initial data', async () => {
    // Create test data
    await DummyModel.objects.create({ name: 'Item 1', value: 100 });
    await DummyModel.objects.create({ name: 'Item 2', value: 200 });
    DummyModel.objects.filter({name__contains: 'Robert', related__isnull: false})
    
    // Create LiveQuerySet with the new options format
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Fetch data
    const items = await liveQs.fetch();
    
    // Verify
    expect(items.length).toBe(2);
    
    // Instead of checking specific order, just verify both items exist
    const itemNames = items.map(item => item.name);
    expect(itemNames).toContain('Item 1');
    expect(itemNames).toContain('Item 2');
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should handle optimistic create in LiveQuerySet', async () => {
    // Create initial data
    await DummyModel.objects.create({ name: 'Initial Item', value: 50 });
    
    // Create LiveQuerySet with the new options format
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Optimistic create
    const newItem = await liveQs.create({ name: 'New Item', value: 100 });
    
    // Fetch updated data
    const items = await liveQs.fetch();
    
    // Verify LiveQuerySet was updated optimistically
    expect(items.length).toBe(2);
    expect(newItem.name).toBe('New Item');
    expect(newItem.value).toBe(100);
    
    // Verify it was added to database
    const dbItems = await DummyModel.objects.all().fetch();
    expect(dbItems.length).toBe(2);
    expect(dbItems.some(item => item.name === 'New Item')).toBe(true);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should handle optimistic update in LiveQuerySet', async () => {
    // Create test data
    const item = await DummyModel.objects.create({ name: 'Update Me', value: 75 });
    
    // Create LiveQuerySet with the new options format
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Optimistic update
    const updatedItem = await liveQs.filter({id: item.id}).update({ name: 'Updated', value: 150 });
    
    // Fetch updated data
    const items = await liveQs.fetch();
    
    // Verify in-memory update happened immediately (optimistically)
    expect(items.length).toBe(1);
    expect(items[0].name).toBe('Updated');
    expect(items[0].value).toBe(150);
    
    // Verify database update
    const dbItem = await DummyModel.objects.get({ id: item.id });
    expect(dbItem.name).toBe('Updated');
    expect(dbItem.value).toBe(150);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should handle optimistic delete in LiveQuerySet', async () => {
    // Create test data
    await DummyModel.objects.create({ name: 'Delete Me', value: 30 });
    
    // Create LiveQuerySet with the new options format
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Verify initial state
    let items = await liveQs.fetch();
    expect(items.length).toBe(1);
    
    // Optimistic delete
    await liveQs.delete();
    
    // Verify in-memory state after delete (optimistically updated)
    items = await liveQs.fetch();
    expect(items.length).toBe(0);
    
    // Verify database state
    const dbItems = await DummyModel.objects.all().fetch();
    expect(dbItems.length).toBe(0);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should handle external create events', async () => {
    // Create LiveQuerySet with the new options format
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Wait longer for subscription to be fully established
    await wait(1500);

    // Create item directly with ORM, not through LiveQuerySet
    await DummyModel.objects.create({ name: 'External Item', value: 300 });
    
    // Wait for the event to propagate with increased timeout
    const eventPropagated = await waitForCondition(async () => {
      const currentItems = await liveQs.fetch();
      return currentItems.some(item => item.name === 'External Item');
    }, 8000, 200);
    
    // Assert that the event propagated successfully
    expect(eventPropagated).toBe(true, 'External create event did not propagate in time');
    
    // Final verification
    const finalItems = await liveQs.fetch();
    const externalItem = finalItems.find(item => item.name === 'External Item');
    expect(externalItem).toBeDefined();
    expect(externalItem?.value).toBe(300);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should handle external update events', async () => {
    // Create initial data
    const item = await DummyModel.objects.create({ name: 'Will Be Updated', value: 50 });
    await wait(200);
    
    // Create LiveQuerySet to observe changes
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Wait longer for subscription to be fully established
    await wait(1500);
    
    await DummyModel.objects.filter({ id: item.id }).update({ 
      name: 'Updated Externally', 
      value: 150 
    });
    
    // Wait for the update to be reflected with increased timeout
    const updatePropagated = await waitForCondition(async () => {
      const items = await liveQs.fetch();
      const updatedItem = items.find(i => i.id === item.id);
      return updatedItem?.name === 'Updated Externally';
    }, 8000, 200);
    
    // Assert that the update propagated successfully
    expect(updatePropagated).toBe(true, 'External update event did not propagate in time');
    
    // Final verification
    const finalItems = await liveQs.fetch();
    const updatedItem = finalItems.find(i => i.id === item.id);
    expect(updatedItem).toBeDefined();
    expect(updatedItem?.name).toBe('Updated Externally');
    expect(updatedItem?.value).toBe(150);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should handle external delete events', async () => {
    // Create initial data
    const item = await DummyModel.objects.create({ name: 'Will Be Deleted', value: 75 });
    await wait(200);
    
    // Create LiveQuerySet to observe changes
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Wait longer for subscription to be fully established
    await wait(1500);
    
    // Check initial state
    let items = await liveQs.fetch();
    expect(items.length).toBe(1);
    
    await DummyModel.objects.filter({ id: item.id }).delete();
    
    // Wait for the delete to be reflected with increased timeout
    const deletePropagated = await waitForCondition(async () => {
      const items = await liveQs.fetch();
      return items.length === 0;
    }, 8000, 200);
    
    // Assert that the delete propagated successfully
    expect(deletePropagated).toBe(true, 'External delete event did not propagate in time');
    
    // Final verification
    const finalItems = await liveQs.fetch();
    expect(finalItems.length).toBe(0);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should apply in-memory filtering', async () => {
    // Create test data
    await DummyModel.objects.create({ name: 'Red', value: 10 });
    await DummyModel.objects.create({ name: 'Green', value: 20 });
    await DummyModel.objects.create({ name: 'Blue', value: 30 });
    
    // Create base LiveQuerySet with the new options format
    const baseLiveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Apply in-memory filter
    const filteredLiveQs = baseLiveQs.filter({ value: 20 });
    
    // Fetch data from filtered LiveQuerySet
    const items = await filteredLiveQs.fetch();
    
    // Verify filter was applied correctly
    expect(items.length).toBe(1);
    expect(items[0].name).toBe('Green');
    
    // Clean up
    baseLiveQs.destroy();
    await wait(200);
  });

  it('should respect pagination with limit and offset', async () => {
    // Create test data - 5 items
    for (let i = 1; i <= 5; i++) {
      await DummyModel.objects.create({ name: `Item ${i}`, value: i * 10 });
      await wait(50); // Small wait between creates to ensure consistent order
    }
    
    // Create LiveQuerySet with limit=2, offset=1 using the new options format
    const liveQs = await liveView(
      DummyModel.objects.all().orderBy('id'),  // Order explicitly by ID
      {
        serializer: { limit: 2, offset: 1 }
      }
    );
    
    // Wait for subscription to stabilize
    await wait(500);
    
    // Fetch data
    const items = await liveQs.fetch();
    
    // Verify pagination
    expect(items.length).toBe(2);
    
    // Verify items 2 and 3 are included (but don't assume specific order)
    const itemNames = items.map(item => item.name);
    expect(itemNames).toContain('Item 2');
    expect(itemNames).toContain('Item 3');
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should handle multiple filters from the same base LiveQuerySet', async () => {
    // Create test data
    await DummyModel.objects.create({ name: 'Apple', value: 10 });
    await DummyModel.objects.create({ name: 'Banana', value: 20 });
    await DummyModel.objects.create({ name: 'Cherry', value: 30 });
    
    // Create base LiveQuerySet with the new options format
    const baseLiveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Apply different filters to the same base LiveQuerySet
    const filteredByValue10 = baseLiveQs.filter({ value: 10 });
    const filteredByValue20 = baseLiveQs.filter({ value: 20 });
    const filteredByValue30 = baseLiveQs.filter({ value: 30 });
    
    // Fetch from each filtered LiveQuerySet
    const items10 = await filteredByValue10.fetch();
    const items20 = await filteredByValue20.fetch();
    const items30 = await filteredByValue30.fetch();
    
    // Verify each filter works correctly
    expect(items10.length).toBe(1);
    expect(items10[0].name).toBe('Apple');
    
    expect(items20.length).toBe(1);
    expect(items20[0].name).toBe('Banana');
    
    expect(items30.length).toBe(1);
    expect(items30[0].name).toBe('Cherry');
    
    // Clean up
    baseLiveQs.destroy();
    await wait(200);
  });

  it('should handle optimistic create with fixed page size', async () => {
    // Create initial data - 3 items
    for (let i = 1; i <= 3; i++) {
      await DummyModel.objects.create({ name: `Initial ${i}`, value: i * 10 });
      await wait(50); // Small wait between creates
    }
    
    // Create LiveQuerySet with fixedPageSize and limit=3 using the new options format
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 3, offset: 0 },
        fixedPageSize: true
      }
    );
    
    // Verify initial state
    let items = await liveQs.fetch();
    expect(items.length).toBe(3);
    
    // Wait before optimistic create
    await wait(300);
    
    // Optimistic create with fixed page size
    await liveQs.create({ name: 'New Item', value: 100 });
    
    // Verify fixed page size maintained the page size by removing the last item
    items = await liveQs.fetch();
    expect(items.length).toBe(3);
    
    // Verify the new item is included
    const newItemExists = items.some(item => item.name === 'New Item');
    expect(newItemExists).toBe(true);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should handle sequential operations on the same LiveQuerySet', async () => {
    // Create LiveQuerySet with the new options format
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Initial state - empty
    let items = await liveQs.fetch();
    expect(items.length).toBe(0);
    
    // Create an item
    const item = await liveQs.create({ name: 'Sequential Test', value: 50 });
    items = await liveQs.fetch();
    expect(items.length).toBe(1);
    
    // Update the item
    await liveQs.filter({id: item.id}).update({ name: 'Updated Sequential', value: 100 });
    items = await liveQs.fetch();
    expect(items.length).toBe(1);
    expect(items[0].name).toBe('Updated Sequential');
    
    // Delete the item
    await liveQs.delete();
    items = await liveQs.fetch();
    expect(items.length).toBe(0);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should handle aggregation methods returning objects with a value property', async () => {
    // First, ensure a clean slate
    await DummyModel.objects.all().delete();
    await wait(500);
    
    // Create test data
    await DummyModel.objects.create({ name: 'Item 1', value: 10 });
    await DummyModel.objects.create({ name: 'Item 2', value: 20 });
    await DummyModel.objects.create({ name: 'Item 3', value: 30 });
    await wait(200);
    
    // Create LiveQuerySet with the new options format
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Verify initial data count
    const initialItems = await liveQs.fetch();
    expect(initialItems.length).toBe(3);
    
    // Test aggregations - now they return objects with a value property
    const count = await liveQs.count();
    const sum = await liveQs.sum('value');
    const avg = await liveQs.avg('value');
    const min = await liveQs.min('value');
    const max = await liveQs.max('value');
    
    // Verify that each metric is an object with a value property
    expect(count).toHaveProperty('value');
    expect(sum).toHaveProperty('value');
    expect(avg).toHaveProperty('value');
    expect(min).toHaveProperty('value');
    expect(max).toHaveProperty('value');
    
    // Verify the actual values
    expect(count.value).toBe(3);
    expect(sum.value).toBe(60);
    expect(avg.value).toBe(20);
    expect(min.value).toBe(10);
    expect(max.value).toBe(30);
    
    // Clean up
    liveQs.destroy();
    await wait(500);
  });
  
  it('should update metric objects when data changes', async () => {
    // First, ensure a clean slate
    await DummyModel.objects.all().delete();
    await wait(500);
    
    // Create initial test data
    await DummyModel.objects.create({ name: 'Item 1', value: 10 });
    await DummyModel.objects.create({ name: 'Item 2', value: 20 });
    await wait(200);
    
    // Create LiveQuerySet with the new options format
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Verify initial data count
    let items = await liveQs.fetch();
    expect(items.length).toBe(2);
    
    // Get initial metrics
    const count = await liveQs.count();
    const sum = await liveQs.sum('value');
    const avg = await liveQs.avg('value');
    
    // Verify initial values
    expect(count.value).toBe(2);
    expect(sum.value).toBe(30);
    expect(avg.value).toBe(15);
    
    // Wait for subscription to be fully established
    await wait(1500);
    
    // Create a new item directly with ORM to trigger an external create event
    await DummyModel.objects.create({ name: 'Item 3', value: 30 });
    
    // Wait for the event to propagate
    const eventPropagated = await waitForCondition(async () => {
      const currentItems = await liveQs.fetch();
      return currentItems.length === 3;
    }, 8000, 200);
    
    // Assert that the event propagated successfully
    expect(eventPropagated).toBe(true, 'External create event did not propagate in time');
    
    // Wait for metrics to refresh
    await wait(500);
    
    // Manually trigger a refresh to ensure metrics are updated
    await liveQs.count();
    
    // Verify that the metric objects have been updated
    expect(count.value).toBe(3, 'Count metric was not updated correctly');
    expect(sum.value).toBe(60, 'Sum metric was not updated correctly');
    expect(avg.value).toBe(20, 'Average metric was not updated correctly');
    
    // Clean up
    liveQs.destroy();
    await wait(500);
  });
  
  it('should update metric objects on update events', async () => {
    // First, ensure a clean slate
    await DummyModel.objects.all().delete();
    await wait(500);
    
    // Create initial test data
    const item = await DummyModel.objects.create({ name: 'Update Me', value: 10 });
    await DummyModel.objects.create({ name: 'Other Item', value: 20 });
    await wait(200);
    
    // Create LiveQuerySet with the new options format
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Verify initial data count
    let items = await liveQs.fetch();
    expect(items.length).toBe(2);
    
    // Get initial metrics
    const sum = await liveQs.sum('value');
    const avg = await liveQs.avg('value');
    
    // Verify initial values
    expect(sum.value).toBe(30);
    expect(avg.value).toBe(15);
    
    // Wait for subscription to be fully established
    await wait(1500);
    
    // Update an item directly with ORM to trigger an external update event
    await DummyModel.objects.filter({ id: item.id }).update({ value: 40 });
    
    // Wait for the update event to propagate
    const updatePropagated = await waitForCondition(async () => {
      const currentItems = await liveQs.fetch();
      const updatedItem = currentItems.find(i => i.id === item.id);
      return updatedItem?.value === 40;
    }, 8000, 200);
    
    // Assert that the update propagated successfully
    expect(updatePropagated).toBe(true, 'External update event did not propagate in time');
    
    // Wait for metrics to refresh
    await wait(500);
    
    // Manually trigger a refresh to ensure metrics are updated
    await liveQs.sum('value');
    
    // Verify that the metric objects have been updated
    expect(sum.value).toBe(60, 'Sum metric was not updated correctly'); // 40 + 20
    expect(avg.value).toBe(30, 'Average metric was not updated correctly'); // (40 + 20) / 2
    
    // Clean up
    liveQs.destroy();
    await wait(500);
  });
  
  it('should update metric objects on delete events', async () => {
    // First, ensure a clean slate by deleting all existing items
    await DummyModel.objects.all().delete();
    await wait(500);
    
    // Create initial test data
    const item1 = await DummyModel.objects.create({ name: 'Delete Me', value: 30 });
    const item2 = await DummyModel.objects.create({ name: 'Keep Me', value: 10 });
    await wait(200);
    
    // Create LiveQuerySet with the new options format
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Wait for subscription to be fully established
    await wait(1500);
    
    // Verify initial data is correct
    let items = await liveQs.fetch();
    expect(items.length).toBe(2);
    
    // Get initial metrics
    const count = await liveQs.count();
    const sum = await liveQs.sum('value');
    const avg = await liveQs.avg('value');
    const max = await liveQs.max('value');
    
    // Verify initial values
    expect(count.value).toBe(2);
    expect(sum.value).toBe(40);
    expect(avg.value).toBe(20);
    expect(max.value).toBe(30);
    
    // Delete an item directly with ORM to trigger an external delete event
    await DummyModel.objects.filter({ id: item1.id }).delete();
    
    // Wait for the delete event to propagate
    const deletePropagated = await waitForCondition(async () => {
      const currentItems = await liveQs.fetch();
      return currentItems.length === 1;
    }, 8000, 200);
    
    // Assert that the delete propagated successfully
    expect(deletePropagated).toBe(true, 'External delete event did not propagate in time');
    
    // Wait for metrics to refresh
    await wait(1000);
    
    // Verify that the metric objects have been updated
    expect(count.value).toBe(1, 'Count metric was not updated correctly');
    expect(sum.value).toBe(10, 'Sum metric was not updated correctly');
    expect(avg.value).toBe(10, 'Average metric was not updated correctly');
    expect(max.value).toBe(10, 'Max metric was not updated correctly');
    
    // Clean up
    liveQs.destroy();
    await wait(500);
  });

  it('should support delete chaining with inline filter chaining', async () => {
    // Create test data: one item to keep and two items to delete.
    await DummyModel.objects.create({ name: 'Keep Me', value: 50 });
    await DummyModel.objects.create({ name: 'Delete Me', value: 100 });
    await DummyModel.objects.create({ name: 'Delete Me', value: 150 });
    
    // Initialize the LiveQuerySet over all items.
    const liveQs = await liveView(
      DummyModel.objects.all(),
      { serializer: { limit: 10, offset: 0 } }
    );
    
    // Allow some time for the LiveQuerySet to fetch data.
    await wait(500);
    
    // Verify that three items exist initially.
    let items = await liveQs.fetch();
    expect(items.length).toBe(3);
    
    // Perform a bulk delete using inline chaining;
    // note that the filter is only applied because it is immediately chained with .delete()
    await liveQs.filter({ name: 'Delete Me' }).delete();
    
    // Verify in-memory that only the "Keep Me" item remains.
    items = await liveQs.fetch();
    expect(items.length).toBe(1);
    expect(items[0].name).toBe('Keep Me');
    
    // Verify the database state to ensure only the "Keep Me" record exists.
    const dbItems = await DummyModel.objects.all().fetch();
    expect(dbItems.length).toBe(1);
    expect(dbItems[0].name).toBe('Keep Me');
    
    // Clean up the LiveQuerySet subscription.
    liveQs.destroy();
    await wait(200);
  });

  it('should not change the base LiveQuerySet when filter() is applied without chaining a terminal method', async () => {
    // Create test data: one item with "Delete Me" and one with "Keep Me"
    await DummyModel.objects.create({ name: 'Delete Me', value: 100 });
    await DummyModel.objects.create({ name: 'Keep Me', value: 50 });
    
    // Initialize the LiveQuerySet over all items.
    const liveQs = await liveView(
      DummyModel.objects.all(),
      { serializer: { limit: 10, offset: 0 } }
    );
    
    // Allow time for the LiveQuerySet to fetch data.
    await wait(500);
    
    // Fetch data from the base LiveQuerySet.
    const baseItemsBefore = await liveQs.fetch();
    expect(baseItemsBefore.length).toBe(2);
    
    // Apply a filter, but do not chain it with a terminal method.
    // This should return a new LiveQuerySet instance without modifying liveQs.
    const filteredLiveQs = liveQs.filter({ name: 'Delete Me' });
    
    // Fetch from the base liveQs again; it should still contain all items.
    const baseItemsAfter = await liveQs.fetch();
    expect(baseItemsAfter.length).toBe(2);
    
    // Verify the new filtered instance only contains items with name "Delete Me"
    const filteredItems = await filteredLiveQs.fetch();
    expect(filteredItems.length).toBe(1);
    expect(filteredItems[0].name).toBe('Delete Me');
    
    // Clean up the LiveQuerySet subscription.
    liveQs.destroy();
    await wait(200);
  });

  it('should support terminal methods get, first, and last', async () => {
    // Clear any existing items to ensure a clean test environment
    await DummyModel.objects.all().delete();
    await wait(300);
    
    // Create LiveQuerySet first
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Wait for subscription to be fully established
    await wait(500);
    
    // Create test data with known IDs to avoid order dependencies
    const item1 = await DummyModel.objects.create({ name: 'Item A', value: 100 });
    await wait(200);
    const item2 = await DummyModel.objects.create({ name: 'Item B', value: 200 });
    await wait(200);
    const item3 = await DummyModel.objects.create({ name: 'Item C', value: 300 });
    
    // Wait for events to propagate using waitForCondition
    const allItemsReceived = await waitForCondition(async () => {
      const items = await liveQs.fetch();
      return items.length === 3;
    }, 5000, 200);
    
    // Assert that all items were received
    expect(allItemsReceived).toBe(true, 'Not all items were received in time');

    // Test get() with known fields returns the expected item
    const itemB = await liveQs.get({ name: 'Item B' });
    expect(itemB.name).toBe('Item B');
    expect(itemB.value).toBe(200);
    
    // Test get() with ID is reliable and order-independent
    const itemById = await liveQs.get({ id: item3.id });
    expect(itemById.name).toBe('Item C');
    expect(itemById.value).toBe(300);

    // For first() and last(), we don't care which exact items they return,
    // just that they return valid items from the collection
    const firstItem = await liveQs.first();
    expect(firstItem).not.toBeNull();
    expect(['Item A', 'Item B', 'Item C']).toContain(firstItem?.name);
    
    const lastItem = await liveQs.last();
    expect(lastItem).not.toBeNull();
    expect(['Item A', 'Item B', 'Item C']).toContain(lastItem?.name);

    // Create a duplicate to test error for multiple objects
    await DummyModel.objects.create({ name: 'Duplicate', value: 200 });
    
    // Wait for the duplicate item to be received
    const duplicateReceived = await waitForCondition(async () => {
      const items = await liveQs.fetch();
      return items.length === 4;
    }, 5000, 200);
    
    expect(duplicateReceived).toBe(true, 'Duplicate item was not received in time');
    
    try {
      await liveQs.get({ value: 200 });
      throw new Error('Expected get() to throw MultipleObjectsReturned error.');
    } catch (error: any) {
      expect(error.message).toContain('Multiple objects returned');
    }

    // Test get() throws error when no object matches
    try {
      await liveQs.get({ name: 'Nonexistent' });
      throw new Error('Expected get() to throw DoesNotExist error.');
    } catch (error: any) {
      expect(error.message).toContain('DoesNotExist');
    }
    
    // Clean up resources
    liveQs.destroy();
    await wait(300);
  });
});