import { initEventHandler, cleanupEventHandler } from '../src/syncEngine/stores/operationEventHandlers';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { DummyModel } from '../models/backend1/django_app/dummymodel';
import { DummyRelatedModel } from '../models/backend1/django_app/dummyrelatedmodel';
import { setBackendConfig } from '../src/config';
import { loadConfigFromFile } from '../src/cli/configFileLoader';
import { Operation } from '../src/syncEngine/stores/operation';
import { querysetStoreRegistry } from '../src/syncEngine/registries/querysetStoreRegistry';
import { modelStoreRegistry } from '../src/syncEngine/registries/modelStoreRegistry';
import { v7 as uuidv7 } from "uuid";

describe('QuerysetStore Side Effects Tests', () => {
  let relatedInstance;
  let originalConfig;

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
    // Reset config before each test
    setBackendConfig('default', originalConfig);
    
    // Manual cleanup of all models before each test
    await DummyModel.objects.all().delete();
    await DummyRelatedModel.objects.all().delete();
    
    // Clear registries
    querysetStoreRegistry.clear();
    modelStoreRegistry.clear();

    // Create a valid related model instance for use in tests
    relatedInstance = await DummyRelatedModel.objects.create({ name: 'ValidRelated' });
    
    // Initialize the event handler
    initEventHandler();
  });

  afterEach(async () => {
    // Ensure the database is cleaned up after each test
    await DummyModel.objects.all().delete();
    await DummyRelatedModel.objects.all().delete();
    
    // Reset config after each test
    setBackendConfig('default', originalConfig);

    // Clean up event handlers
    cleanupEventHandler();
  });

  describe('Create Operations', () => {
    it('should add a create operation to the originating queryset only', async () => {
      // Create two different querysets
      const nameFilteredQs = DummyModel.objects.filter({ name: 'TestCreate' });
      const valueFilteredQs = DummyModel.objects.filter({ value: 50 });
      
      // Initialize both stores by accessing them
      const nameFilteredStore = querysetStoreRegistry.getStore(nameFilteredQs);
      const valueFilteredStore = querysetStoreRegistry.getStore(valueFilteredQs);
      
      // Force sync to ensure clean state
      await nameFilteredStore.sync();
      await valueFilteredStore.sync();
      
      // Verify initial state is empty
      expect(nameFilteredStore.render()).toHaveLength(0);
      expect(valueFilteredStore.render()).toHaveLength(0);
      
      // Create a new operation for the name-filtered queryset
      const newInstance = {
        name: 'TestCreate',
        value: 50,
        related: relatedInstance.pk,
        id: 9999 // Mock ID for testing
      };
      
      // Create operation that's associated with the nameFilteredQs
      const createOperation = new Operation({
        type: 'create',
        instances: [newInstance],
        queryset: nameFilteredQs,
        status: 'inflight'
      });
      
      // After the operation is created, the event handler should have added it to the stores
      // Verify both stores now via render()
      const nameFilteredPks = nameFilteredStore.render();
      const valueFilteredPks = valueFilteredStore.render();
      
      // The name-filtered queryset should contain the new instance
      expect(nameFilteredPks).toHaveLength(1);
      expect(nameFilteredPks[0]).toBe(9999);
      
      // The value-filtered queryset should NOT contain the new instance
      // since create operations only affect the originating queryset
      expect(valueFilteredPks).toHaveLength(0);
    });
    
    it('should confirm a create operation and keep it in the originating queryset only', async () => {
      // Create and initialize querysets
      const nameFilteredQs = DummyModel.objects.filter({ name: 'TestCreate' });
      const valueFilteredQs = DummyModel.objects.filter({ value: 50 });
      
      const nameFilteredStore = querysetStoreRegistry.getStore(nameFilteredQs);
      const valueFilteredStore = querysetStoreRegistry.getStore(valueFilteredQs);
      
      await nameFilteredStore.sync();
      await valueFilteredStore.sync();
      
      // Create a new operation for the name-filtered queryset
      const newInstance = {
        name: 'TestCreate',
        value: 50,
        related: relatedInstance.pk,
        id: 9999 // Mock ID for testing
      };
      
      // Create operation that's associated with the nameFilteredQs
      const createOperation = new Operation({
        type: 'create',
        instances: [newInstance],
        queryset: nameFilteredQs,
        status: 'inflight'
      });
      
      // Verify operation was added to the name-filtered store
      expect(nameFilteredStore.render()).toHaveLength(1);
      
      // Confirm the operation
      createOperation.updateStatus('confirmed', [newInstance]);
      
      // Verify the instance is still in the name-filtered store after confirmation
      expect(nameFilteredStore.render()).toHaveLength(1);
      expect(nameFilteredStore.render()[0]).toBe(9999);
      
      // The value-filtered store should still not have the instance
      expect(valueFilteredStore.render()).toHaveLength(0);
    });
    
    it('should reject a create operation and remove it from the originating queryset', async () => {
      // Create and initialize querysets
      const nameFilteredQs = DummyModel.objects.filter({ name: 'TestCreate' });
      
      const nameFilteredStore = querysetStoreRegistry.getStore(nameFilteredQs);
      await nameFilteredStore.sync();
      
      // Create a new operation for the name-filtered queryset
      const newInstance = {
        name: 'TestCreate',
        value: 50,
        related: relatedInstance.pk,
        id: 9999 // Mock ID for testing
      };
      
      // Create operation that's associated with the nameFilteredQs
      const createOperation = new Operation({
        type: 'create',
        instances: [newInstance],
        queryset: nameFilteredQs,
        status: 'inflight'
      });
      
      // Verify operation was added
      expect(nameFilteredStore.render()).toHaveLength(1);
      
      // Reject the operation
      createOperation.updateStatus('rejected');
      
      // Verify the instance is no longer in the store after rejection
      expect(nameFilteredStore.render()).toHaveLength(0);
    });
  });

  describe('Update Operations', () => {
    it('should apply an update operation to all querysets for the model', async () => {
      // Create an instance in the database
      const existingInstance = await DummyModel.objects.create({
        name: 'InitialName',
        value: 25,
        related: relatedInstance.pk
      });
      
      // Create two different querysets
      const nameFilteredQs = DummyModel.objects.filter({ name: 'InitialName' });
      const valueFilteredQs = DummyModel.objects.filter({ value: 25 });
      
      // Initialize both stores
      const nameFilteredStore = querysetStoreRegistry.getStore(nameFilteredQs);
      const valueFilteredStore = querysetStoreRegistry.getStore(valueFilteredQs);
      
      await nameFilteredStore.sync();
      await valueFilteredStore.sync();
      
      // Verify initial state has the instance
      expect(nameFilteredStore.render()).toHaveLength(1);
      expect(valueFilteredStore.render()).toHaveLength(1);
      
      // Update the instance
      const updatedInstance = {
        id: existingInstance.pk,
        name: 'UpdatedName',
        value: 50
      };
      
      // Create update operation that's associated with nameFilteredQs
      const updateOperation = new Operation({
        type: 'update',
        instances: [updatedInstance],
        queryset: nameFilteredQs,
        status: 'inflight'
      });
      
      // Verify the instance now only appears in valueFilteredQs (because name no longer matches)
      // but should disappear from nameFilteredQs
      const nameFilteredPks = nameFilteredStore.render();
      const valueFilteredPks = valueFilteredStore.render();
      
      // The name-filtered queryset should no longer contain the instance
      expect(nameFilteredPks).toHaveLength(0);
      
      // The value-filtered queryset should still contain the instance since value still matches
      expect(valueFilteredPks).toHaveLength(1);
      expect(valueFilteredPks[0]).toBe(existingInstance.pk);
    });
  });

  describe('Delete Operations', () => {
    it('should apply a delete operation to all querysets for the model', async () => {
      // Create an instance in the database
      const existingInstance = await DummyModel.objects.create({
        name: 'TestDelete',
        value: 30,
        related: relatedInstance.pk
      });
      
      // Create two different querysets that both match the instance
      const nameFilteredQs = DummyModel.objects.filter({ name: 'TestDelete' });
      const valueFilteredQs = DummyModel.objects.filter({ value: 30 });
      
      // Initialize both stores
      const nameFilteredStore = querysetStoreRegistry.getStore(nameFilteredQs);
      const valueFilteredStore = querysetStoreRegistry.getStore(valueFilteredQs);
      
      await nameFilteredStore.sync();
      await valueFilteredStore.sync();
      
      // Verify initial state has the instance
      expect(nameFilteredStore.render()).toHaveLength(1);
      expect(valueFilteredStore.render()).toHaveLength(1);
      
      // Create delete operation that's associated with nameFilteredQs only
      const deleteOperation = new Operation({
        type: 'delete',
        instances: [{ id: existingInstance.pk }],
        queryset: nameFilteredQs,
        status: 'inflight'
      });
      
      // Verify the instance is removed from BOTH querysets
      expect(nameFilteredStore.render()).toHaveLength(0);
      expect(valueFilteredStore.render()).toHaveLength(0);
    });
    
    it('should restore a deleted instance when the delete operation is rejected', async () => {
      // Create an instance in the database
      const existingInstance = await DummyModel.objects.create({
        name: 'TestDeleteReject',
        value: 35,
        related: relatedInstance.pk
      });
      
      // Create a queryset that matches the instance
      const nameFilteredQs = DummyModel.objects.filter({ name: 'TestDeleteReject' });
      
      // Initialize the store
      const nameFilteredStore = querysetStoreRegistry.getStore(nameFilteredQs);
      await nameFilteredStore.sync();
      
      // Verify initial state has the instance
      expect(nameFilteredStore.render()).toHaveLength(1);
      
      // Create delete operation
      const deleteOperation = new Operation({
        type: 'delete',
        instances: [{ id: existingInstance.pk }],
        queryset: nameFilteredQs,
        status: 'inflight'
      });
      
      // Verify the instance is removed
      expect(nameFilteredStore.render()).toHaveLength(0);
      
      // Reject the delete operation
      deleteOperation.updateStatus('rejected');
      
      // Verify the instance is restored
      expect(nameFilteredStore.render()).toHaveLength(1);
      expect(nameFilteredStore.render()[0]).toBe(existingInstance.pk);
    });
  });

  describe('LiveQueryset', () => {
    it('should return dynamically updated results when using LiveQueryset', async () => {
      // Create two instances in the database
      const instance1 = await DummyModel.objects.create({
        name: 'LiveTest1',
        value: 40,
        related: relatedInstance.pk
      });
      
      const instance2 = await DummyModel.objects.create({
        name: 'LiveTest2',
        value: 45,
        related: relatedInstance.pk
      });
      
      // Create a queryset and get a live view
      const queryset = DummyModel.objects.filter({ name__startswith: 'LiveTest' });
      const liveQueryset = querysetStoreRegistry.getEntity(queryset);
      
      // Verify initial state contains both instances
      expect(liveQueryset.length).toBe(2);
      
      // Create delete operation for one instance
      const deleteOperation = new Operation({
        type: 'delete',
        instances: [{ id: instance1.pk }],
        queryset: queryset,
        status: 'inflight'
      });
      
      // Verify the instance is removed from the LiveQueryset
      expect(liveQueryset.length).toBe(1);
      
      // Use array methods on LiveQueryset
      const mappedResult = liveQueryset.map(item => item.id);
      expect(mappedResult).toContain(instance2.pk);
      expect(mappedResult).not.toContain(instance1.pk);
    });
  });
});