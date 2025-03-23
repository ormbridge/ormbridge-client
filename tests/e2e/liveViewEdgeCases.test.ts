import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader'
import { DummyModel } from '../../models/backend1/django_app/dummymodel';
import { DummyRelatedModel } from '../../models/backend1/django_app/dummyrelatedmodel';
import { 
  legacyLiveView as liveView, 
  LiveQuerySet,
  activeOperationIds,
  generateOperationId,
  handleModelEvent
} from '../../src/core/liveView';
import { MultipleObjectsReturned, DoesNotExist } from '../../src/flavours/django/errors';
import { EventType } from '../../src/core/eventReceivers';

// Use same test configuration as in the main tests
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

// Helper functions from the original tests
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

describe('LiveView Edge Cases Tests', () => {
  let originalConfig;

  beforeAll(async () => {
    loadConfigFromFile();
    originalConfig = testConfig;
    setBackendConfig('default', originalConfig);
  });

  beforeEach(async () => {
    // Clear operation IDs
    activeOperationIds.clear();
    
    // Wait to give server time to recover
    await wait(300);
    
    try {
      // Delete all test data
      await DummyModel.objects.all().delete();
      await wait(200);
      await DummyRelatedModel.objects.all().delete();
      await wait(200);
    } catch (error) {
      console.warn('Error during test cleanup:', error);
    }
  });

  afterEach(async () => {
    // Clear operation IDs
    activeOperationIds.clear();
    
    try {
      // Clean up remaining data
      await DummyModel.objects.all().delete();
      await wait(200);
      await DummyRelatedModel.objects.all().delete();
      await wait(200);
    } catch (error) {
      console.warn('Error during test cleanup:', error);
    }
  });

  it('should handle external bulk update events with non-existent items', async () => {
    // Create initial data
    const item1 = await DummyModel.objects.create({ name: 'Existing Item', value: 50 });
    await wait(200);
    
    // Create LiveQuerySet with all items
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Wait for subscription to be fully established
    await wait(1500);
    
    // Verify initial state
    let items = await liveQs.fetch();
    expect(items.length).toBe(1);
    
    // Create a mock bulk update event that includes both existing and non-existent items
    const bulkUpdateEvent = {
      type: EventType.BULK_UPDATE,
      namespace: DummyModel.modelName,
      model: DummyModel.modelName,
      operationId: generateOperationId(),
      instances: [item1.id, 9999], // 9999 is a non-existent ID
      pk_field_name: DummyModel.primaryKeyField
    };
    
    // Manually trigger the event (simulates receiving from server)
    await handleModelEvent(bulkUpdateEvent);
    
    // Wait for event processing
    await wait(500);
    
    // Verify that the LiveQuerySet still has the original item
    // and wasn't affected by the non-existent item in the bulk update
    items = await liveQs.fetch();
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(item1.id);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should handle external create events that do not match filter criteria', async () => {
    // Create initial data
    await DummyModel.objects.create({ name: 'Item 1', value: 10 });
    await DummyModel.objects.create({ name: 'Item 2', value: 20 });
    await wait(200);
    
    // Create LiveQuerySet with a specific filter
    const liveQs = await liveView(
      DummyModel.objects.filter({ value: 10 }),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Wait for subscription to be fully established
    await wait(1500);
    
    // Verify initial state
    let items = await liveQs.fetch();
    expect(items.length).toBe(1);
    expect(items[0].name).toBe('Item 1');
    
    // Create an item that doesn't match the filter
    await DummyModel.objects.create({ name: 'Item 3', value: 30 });
    
    // Wait for potential event processing
    await wait(1000);
    
    // Verify that the LiveQuerySet wasn't affected by the non-matching item
    items = await liveQs.fetch();
    expect(items.length).toBe(1);
    expect(items[0].name).toBe('Item 1');
    
    // Now create an item that does match the filter
    await DummyModel.objects.create({ name: 'Item 4', value: 10 });
    
    // Wait for the event to propagate
    const eventPropagated = await waitForCondition(async () => {
      const currentItems = await liveQs.fetch();
      return currentItems.length === 2;
    }, 8000, 200);
    
    // Verify that only matching items were added
    expect(eventPropagated).toBe(true);
    items = await liveQs.fetch();
    expect(items.length).toBe(2);
    expect(items.some(item => item.name === 'Item 4')).toBe(true);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should handle multiple consecutive refresh calls', async () => {
    // Create test data
    await DummyModel.objects.create({ name: 'Item A', value: 10 });
    await DummyModel.objects.create({ name: 'Item B', value: 20 });
    await DummyModel.objects.create({ name: 'Item C', value: 30 });
    await wait(200);
    
    // Create LiveQuerySet with all items
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Wait for subscription to be fully established
    await wait(1500);
    
    // Verify initial state
    let items = await liveQs.fetch();
    expect(items.length).toBe(3);
    
    // First refresh with a filter
    await liveQs.refresh({
      newQs: DummyModel.objects.filter({ value: 20 }),
      clearData: true
    });
    
    // Verify after first refresh
    items = await liveQs.fetch();
    expect(items.length).toBe(1);
    expect(items[0].name).toBe('Item B');
    
    // Immediately do a second refresh with a different filter
    await liveQs.refresh({
      newQs: DummyModel.objects.filter({ value: 30 }),
      clearData: true
    });
    
    // Verify after second refresh
    items = await liveQs.fetch();
    expect(items.length).toBe(1);
    expect(items[0].name).toBe('Item C');
    
    // Immediately do a third refresh with all items
    await liveQs.refresh({
      newQs: DummyModel.objects.all(),
      clearData: true
    });
    
    // Verify after third refresh
    items = await liveQs.fetch();
    expect(items.length).toBe(3);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should handle empty result sets correctly', async () => {
    // Create LiveQuerySet with a filter that matches nothing
    const liveQs = await liveView(
      DummyModel.objects.filter({ name: 'Nonexistent' }),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Wait for subscription to be fully established
    await wait(1500);
    
    // Verify initial state is empty
    let items = await liveQs.fetch();
    expect(items.length).toBe(0);
    
    // Try to get a non-existent item using get()
    try {
      await liveQs.get({ name: 'Nonexistent' });
      // Should not reach here
      expect(true).toBe(false, 'Expected DoesNotExist error was not thrown');
    } catch (error) {
      expect(error.message).toContain('DoesNotExist');
    }
    
    // Try first() and last() on empty dataset
    const firstItem = await liveQs.first();
    const lastItem = await liveQs.last();
    
    expect(firstItem).toBeNull();
    expect(lastItem).toBeNull();
    
    // Try count aggregation on empty dataset
    const count = await liveQs.count();
    expect(count.value).toBe(0);
    
    // Note: We don't test sum on empty dataset as it might return null rather than 0
    // depending on the implementation
    
    // Add an item that matches our filter
    await DummyModel.objects.create({ name: 'Nonexistent', value: 50 });
    
    // Wait for the event to propagate
    const eventPropagated = await waitForCondition(async () => {
      const currentItems = await liveQs.fetch();
      return currentItems.length === 1;
    }, 8000, 200);
    
    // Verify the item was added
    expect(eventPropagated).toBe(true);
    items = await liveQs.fetch();
    expect(items.length).toBe(1);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should handle filter() method with no conditions', async () => {
    // Create test data
    await DummyModel.objects.create({ name: 'Item 1', value: 10 });
    await DummyModel.objects.create({ name: 'Item 2', value: 20 });
    await wait(200);
    
    // Create LiveQuerySet with all items
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Wait for subscription to be fully established
    await wait(1500);
    
    // Call filter with an empty object
    const filteredLiveQs = liveQs.filter({});
    
    // Verify that all items are returned (no filtering applied)
    const items = await filteredLiveQs.fetch();
    expect(items.length).toBe(2);
    
    // Clean up
    liveQs.destroy();
    filteredLiveQs.destroy();
    await wait(200);
  });

  it('should handle sequential create and update operations', async () => {
    // Create LiveQuerySet first
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Wait for subscription to be fully established
    await wait(1500);
    
    // Create an item first
    const createdItem = await liveQs.create({ name: 'Sequential Item', value: 100 });
    
    // Wait for the create to fully complete
    await wait(500);
    
    // Now create a filtered LiveQuerySet to update the item
    const filteredLiveQs = liveQs.filter({ id: createdItem.id });
    
    // Update the created item
    await filteredLiveQs.update({ value: 200 });
    
    // Verify that the item was created and updated correctly
    const items = await liveQs.fetch();
    
    expect(items.length).toBe(1);
    expect(items[0].name).toBe('Sequential Item');
    expect(items[0].value).toBe(200);
    
    // Clean up
    liveQs.destroy();
    filteredLiveQs.destroy();
    await wait(200);
  });

  it('should handle delete() after filtering with invalid field', async () => {
    // Create test data
    await DummyModel.objects.create({ name: 'Item 1', value: 10 });
    await DummyModel.objects.create({ name: 'Item 2', value: 20 });
    await wait(200);
    
    // Create LiveQuerySet with all items
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Wait for subscription to be fully established
    await wait(1500);
    
    // Filter with a field that doesn't exist
    const filteredLiveQs = liveQs.filter({ nonExistentField: 'value' });
    
    // Verify no items match the filter
    let items = await filteredLiveQs.fetch();
    expect(items.length).toBe(0);
    
    // Try to delete the filtered items (should not affect any items)
    await filteredLiveQs.delete();
    
    // Verify no items were deleted from the original LiveQuerySet
    items = await liveQs.fetch();
    expect(items.length).toBe(2);
    
    // Clean up
    liveQs.destroy();
    filteredLiveQs.destroy();
    await wait(200);
  });

  it('should handle external events correctly with filtering', async () => {
    // Create initial data
    const item = await DummyModel.objects.create({ name: 'Test Item', value: 10 });
    await wait(200);
    
    // Create LiveQuerySet with value filter
    const liveQs = await liveView(
      DummyModel.objects.filter({ value: 10 }),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Wait for subscription to be fully established
    await wait(1500);
    
    // Verify initial state
    let items = await liveQs.fetch();
    expect(items.length).toBe(1);
    
    // Update the item so it no longer matches the filter
    await DummyModel.objects.filter({ id: item.id }).update({ value: 20 });
    
    // Wait a sufficient amount of time for the update event to propagate
    await wait(2000);
    
    // Verify the item was removed due to no longer matching filter
    // External update events DO apply the filter criteria
    items = await liveQs.fetch();
    expect(items.length).toBe(0);
    
    // Create a new item that matches filter through ORM
    const newItem = await DummyModel.objects.create({ name: 'New Item', value: 10 });
    
    // Wait a sufficient amount of time for the create event to propagate
    await wait(2000);
    
    // Verify new item shows up since it matches filter
    // External create events DO apply the filter criteria
    items = await liveQs.fetch();
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(newItem.id);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should handle multiple metric updates in rapid succession', async () => {
    // Create LiveQuerySet first (with empty dataset)
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Wait for subscription to be fully established
    await wait(1500);
    
    // Get initial count metric
    const count = await liveQs.count();
    expect(count.value).toBe(0);
    
    // Rapid creation of multiple items
    const createPromises = [];
    for (let i = 1; i <= 5; i++) {
      createPromises.push(DummyModel.objects.create({ name: `Item ${i}`, value: i * 10 }));
      await wait(50); // Small delay to ensure they're created in sequence
    }
    
    await Promise.all(createPromises);
    
    // Wait for the events to propagate
    const eventsProcessed = await waitForCondition(async () => {
      const currentItems = await liveQs.fetch();
      return currentItems.length === 5;
    }, 8000, 200);
    
    // Verify the final dataset
    expect(eventsProcessed).toBe(true);
    const items = await liveQs.fetch();
    expect(items.length).toBe(5);
    
    // Verify the count metric was updated
    expect(count.value).toBe(5);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should show created items in filtered LiveQuerySet even if they do not match the filter', async () => {
    // Create LiveQuerySet with a specific filter
    const liveQs = await liveView(
      DummyModel.objects.filter({ value: 10 }),
      {
        serializer: { limit: 10, offset: 0 }
      }
    );
    
    // Wait for subscription to be fully established
    await wait(1500);
    
    // Create an item that doesn't match the filter
    const item = await liveQs.create({ name: 'Non-matching Item', value: 20 });
    
    // Verify the item was created in the database
    const dbItem = await DummyModel.objects.get({ id: item.id });
    expect(dbItem).toBeDefined();
    expect(dbItem.name).toBe('Non-matching Item');
    expect(dbItem.value).toBe(20);
    
    // Verify item appears in the LiveQuerySet even though it doesn't match the filter
    // This is the expected behavior for items created through the LiveQuerySet itself
    let items = await liveQs.fetch();
    expect(items.length).toBe(1);
    expect(items[0].name).toBe('Non-matching Item');
    expect(items[0].value).toBe(20);
    
    // Now refresh the LiveQuerySet, which should apply the filter again
    await liveQs.refresh({ clearData: true });
    
    // After refresh, the item should no longer be in the LiveQuerySet
    items = await liveQs.fetch();
    expect(items.length).toBe(0);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should correctly apply insertion behavior for local and remote items', async () => {
    // Create LiveQuerySet with custom insertion behavior
    const liveQs = await liveView(
      DummyModel.objects.all(),
      {
        serializer: { limit: 10, offset: 0 },
        insertBehavior: {
          local: 'append',  // Local items at the end
          remote: 'prepend' // Remote items at the beginning
        }
      }
    );
    
    // Wait for subscription to be fully established
    await wait(1500);
    
    // Create a local item
    const localItem = await liveQs.create({ name: 'Local Item', value: 10 });
    
    // Verify local item was appended
    let items = await liveQs.fetch();
    expect(items.length).toBe(1);
    expect(items[0].name).toBe('Local Item');
    
    // Create a remote item directly with the ORM
    await DummyModel.objects.create({ name: 'Remote Item', value: 20 });
    
    // Wait for the remote item to be received
    const eventPropagated = await waitForCondition(async () => {
      const currentItems = await liveQs.fetch();
      return currentItems.length === 2;
    }, 8000, 200);
    
    // Verify the remote item was prepended
    expect(eventPropagated).toBe(true);
    items = await liveQs.fetch();
    expect(items.length).toBe(2);
    expect(items[0].name).toBe('Remote Item'); // Remote should be first
    expect(items[1].name).toBe('Local Item'); // Local should be second
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });

  it('should handle fixed page size with various operations', async () => {
    // Create initial data - 5 items
    for (let i = 1; i <= 5; i++) {
      await DummyModel.objects.create({ name: `Initial ${i}`, value: i * 10 });
      await wait(50); // Small wait between creates
    }
    
    // Create LiveQuerySet with fixedPageSize and limit=3
    const liveQs = await liveView(
      DummyModel.objects.all().orderBy('-id'), // Most recent first
      {
        serializer: { limit: 3, offset: 0 },
        fixedPageSize: true
      }
    );
    
    // Wait for subscription to be fully established
    await wait(1500);
    
    // Verify initial state (should have the 3 most recent items)
    let items = await liveQs.fetch();
    expect(items.length).toBe(3);
    
    // Create a new item locally
    await liveQs.create({ name: 'New Local Item', value: 100 });
    
    // Verify fixed page size was maintained (still 3 items)
    items = await liveQs.fetch();
    expect(items.length).toBe(3);
    expect(items.some(item => item.name === 'New Local Item')).toBe(true);
    
    // Create a new item remotely
    await DummyModel.objects.create({ name: 'New Remote Item', value: 110 });
    
    // Wait a sufficient amount of time for the event to propagate
    await wait(2000);
    
    // Verify fixed page size was maintained after remote item (still 3 items)
    items = await liveQs.fetch();
    expect(items.length).toBe(3);
    
    // Clean up
    liveQs.destroy();
    await wait(200);
  });
});