import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { DummyModel } from '../../models/backend1/django_app/dummymodel';
import { DummyRelatedModel } from '../../models/backend1/django_app/dummyrelatedmodel';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader'
import { initEventHandler, cleanupEventHandler } from '../../src/syncEngine/stores/operationEventHandlers';

import { 
  DoesNotExist, 
  ValidationError, 
  PermissionDenied,
  ConfigError 
} from '../../src/flavours/django/errors';

describe('delete() Method Tests', () => {
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

  it('should delete an instance by calling the method on the instance', async () => {
    const instance = await DummyModel.objects.create({
      name: 'DeleteTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    // Verify instance exists
    const pk = instance.pk;
    const fetchedInstance = await DummyModel.objects.get({ id: pk });
    expect(fetchedInstance).toBeTruthy();
    
    // Delete the instance
    const [deletedCount, deletionsByModel] = await instance.delete();
    
    // Verify delete operation reports success
    expect(deletedCount).toBe(1);
    expect(await DummyModel.objects.filter({ id: pk }).exists()).toBe(false);
    
    // Verify instance no longer exists using get() with try/catch
    try {
      await DummyModel.objects.get({ id: pk });
      fail('Expected DoesNotExist error was not thrown');
    } catch (error) {
      expect(error.name).toBe('DoesNotExist');
    }
  });

  it('should throw an error when trying to delete an unsaved instance', async () => {
    const unsavedInstance = new DummyModel({
      name: 'UnsavedTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    // Try to delete an unsaved instance
    await expect(unsavedInstance.delete()).rejects.toThrow('Cannot delete unsaved instance');
  });

  // Permission Tests
  it('should throw PermissionDenied when user lacks delete permissions', async () => {
    const instance = await DummyModel.objects.create({
      name: 'PermDeleteTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    // Configure unauthorized access
    setBackendConfig('default', {
      getAuthHeaders: () => ({
        'Authorization': 'Token invalid_token'
      })
    });
    
    // Try to delete with invalid permissions
    await expect(instance.delete()).rejects.toBeInstanceOf(PermissionDenied);
    
    // Verify the instance still exists by fetching it
    setBackendConfig('default', originalConfig);
    const fetchedInstance = await DummyModel.objects.get({ id: instance.pk });
    expect(fetchedInstance).toBeTruthy();
  });

  // Connection error handling
  it('should handle connection errors gracefully during delete operations', async () => {
    const instance = await DummyModel.objects.create({
      name: 'ConnectionErrorTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    // Configure a bad connection
    setBackendConfig('default', {
      getAuthHeaders: () => {
        throw new Error('Connection error');
      }
    });
    
    // Try to delete with connection error
    await expect(instance.delete()).rejects.toThrow('Connection error');
    
    // Restore connection and verify instance still exists by fetching it
    setBackendConfig('default', originalConfig);
    const fetchedInstance = await DummyModel.objects.get({ id: instance.pk });
    expect(fetchedInstance).toBeTruthy();
  });
  
  it('should delete all instances matching a filter', async () => {
    // Create multiple instances with the same pattern
    await DummyModel.objects.create({
      name: 'BatchDelete1',
      value: 100,
      related: relatedInstance.pk
    });
    
    await DummyModel.objects.create({
      name: 'BatchDelete2',
      value: 100,
      related: relatedInstance.pk
    });
    
    // Verify instances exist by counting them
    const initialCount = await DummyModel.objects.filter({ name__startswith: 'BatchDelete' }).count();
    expect(initialCount).toBe(2);
    
    // Delete all instances matching the filter
    const [deletedCount, deletionsByModel] = await DummyModel.objects.filter({ name__startswith: 'BatchDelete' }).delete();
    
    // Verify delete operation reports success
    expect(deletedCount).toBe(2);
    
    // Verify instances no longer exist by looking for any matching records
    try {
      await DummyModel.objects.filter({ name__startswith: 'BatchDelete' }).get();
      fail('Expected DoesNotExist error was not thrown');
    } catch (error) {
      expect(error.name).toBe('DoesNotExist');
    }
  });

  // ----- Extended Tests Below -----

  it('should return correct deletion mapping details when deleting an instance', async () => {
    const instance = await DummyModel.objects.create({
      name: 'MappingTest',
      value: 20,
      related: relatedInstance.pk
    });
    const pk = instance.pk;
    
    // Delete the instance and check deletion mapping details
    const [deletedCount, deletionsByModel] = await instance.delete();
    expect(deletedCount).toBe(1);
    // Updated expectation based on the actual key format
    expect(deletionsByModel).toHaveProperty('django_app.dummymodel');
    expect(deletionsByModel['django_app.dummymodel']).toBe(1);
    
    // Confirm instance no longer exists
    await expect(DummyModel.objects.get({ id: pk })).rejects.toThrow(DoesNotExist);
  });

  it('should return 0 deletions for a filter that matches no records', async () => {
    // Attempt to delete instances that do not exist
    const [deletedCount, deletionsByModel] = await DummyModel.objects.filter({ name: 'NonExistentName' }).delete();
    expect(deletedCount).toBe(0);
    // Updated expectation: expect key with a 0 count rather than an empty object
    expect(deletionsByModel).toEqual({ 'django_app.dummymodel': 0 });
  });

  it('should throw DoesNotExist when attempting to delete an already deleted instance', async () => {
    const instance = await DummyModel.objects.create({
      name: 'AlreadyDeletedTest',
      value: 30,
      related: relatedInstance.pk
    });
    const pk = instance.pk;
    
    // First deletion should succeed
    await instance.delete();
    
    // A second deletion call on the same instance should throw an error
    await expect(instance.delete()).rejects.toThrow(DoesNotExist);
    
    // Confirm that the instance is indeed gone
    await expect(DummyModel.objects.get({ id: pk })).rejects.toThrow(DoesNotExist);
  });

  it('should delete a related model instance using its own delete() method', async () => {
    // Create a related model instance
    const related = await DummyRelatedModel.objects.create({ name: 'ToBeDeleted' });
    const pk = related.pk;
    
    // Delete the related model instance
    const [deletedCount, deletionsByModel] = await related.delete();
    expect(deletedCount).toBe(1);
    // Updated expectation for the related model key
    expect(deletionsByModel).toHaveProperty('django_app.dummyrelatedmodel');
    expect(deletionsByModel['django_app.dummyrelatedmodel']).toBe(1);
    
    // Verify the instance no longer exists
    expect(await DummyRelatedModel.objects.filter({ id: pk }).exists()).toBe(false);
    try {
      await DummyRelatedModel.objects.get({ id: pk });
      fail('Expected DoesNotExist error was not thrown');
    } catch (error) {
      expect(error.name).toBe('DoesNotExist');
    }
  });
});