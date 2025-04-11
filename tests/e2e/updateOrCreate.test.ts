import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { DummyModel } from '../../models/backend1/django_app/dummymodel';
import { DummyRelatedModel } from '../../models/backend1/django_app/dummyrelatedmodel';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader'
import { 
  DoesNotExist, 
  ValidationError, 
  MultipleObjectsReturned,
  PermissionDenied,
  ConfigError 
} from '../../src/flavours/django/errors';
import { ResultTuple } from '../../src/flavours/django/manager';
import { initEventHandler, cleanupEventHandler } from '../../src/syncEngine/stores/operationEventHandlers';

describe('updateOrCreate() Method Tests', () => {
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

  // Basic Functionality Tests
  it('should create a new instance when it does not exist', async () => {
    // Verify no instance exists yet
    expect(await DummyModel.objects.filter({ name: 'CreateTest' }).exists()).toBe(false);
    
    // Update or create
    const [instance, created] = await DummyModel.objects.updateOrCreate(
      { name: 'CreateTest' },
      { defaults: { value: 20, related: relatedInstance.pk } }
    );
    
    // Verify it created a new instance
    expect(created).toBe(true);
    expect(instance.name).toBe('CreateTest');
    expect(instance.value).toBe(20);
    
    // Verify the instance exists in the database
    expect(await DummyModel.objects.filter({ name: 'CreateTest' }).exists()).toBe(true);
  });

  it('should update an existing instance when it exists', async () => {
    // Create an instance first
    const existingInstance = await DummyModel.objects.create({
      name: 'UpdateTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    // Update or create with same lookup, different defaults
    const [instance, created] = await DummyModel.objects.updateOrCreate(
      { name: 'UpdateTest' },
      { defaults: { value: 50, related: relatedInstance.pk } }
    );
    
    // Verify it found and updated the existing instance
    expect(created).toBe(false);
    expect(instance.pk).toBe(existingInstance.pk);
    expect(instance.value).toBe(50); // Updated value
    
    // Verify only one instance exists
    expect(await DummyModel.objects.filter({ name: 'UpdateTest' }).count()).toBe(1);
    
    // Verify in database the value was updated
    const updatedFromDb = await DummyModel.objects.get({ id: instance.pk });
    expect(updatedFromDb.value).toBe(50);
  });

  it('should support object destructuring via ResultTuple', async () => {
    // Test object destructuring syntax
    const result = await DummyModel.objects.updateOrCreate(
      { name: 'DestructuringTest' },
      { defaults: { value: 30, related: relatedInstance.pk } }
    );
    
    // Verify it's a ResultTuple
    expect(result).toBeInstanceOf(ResultTuple);
    
    // Test object destructuring
    const { instance, created } = result;
    expect(created).toBe(true);
    expect(instance.name).toBe('DestructuringTest');
    expect(instance.value).toBe(30);
  });

  // Partial Update Tests
  it('should only update fields specified in defaults', async () => {
    // Create an instance with multiple fields
    await DummyModel.objects.create({
      name: 'PartialUpdateTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    // Update only the value field
    const [instance, created] = await DummyModel.objects.updateOrCreate(
      { name: 'PartialUpdateTest' },
      { defaults: { value: 99 } }
    );
    
    // Verify only value was updated, other fields retained
    expect(created).toBe(false);
    expect(instance.value).toBe(99);
    expect(instance.related.id).toBe(relatedInstance.pk);
  });

  // Validation Tests
  it('should throw ValidationError when updating with invalid data', async () => {
    // Create a valid instance
    await DummyModel.objects.create({
      name: 'ValidationTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    // Try to update with invalid related ID
    await expect(
      DummyModel.objects.updateOrCreate(
        { name: 'ValidationTest' },
        { defaults: { related: 9999 } } // Invalid related ID
      )
    ).rejects.toBeInstanceOf(ValidationError);
    
    // Original instance should be unchanged
    const original = await DummyModel.objects.get({ name: 'ValidationTest' });
    expect(original.value).toBe(10);
    expect(original.related.id).toBe(relatedInstance.pk);
  });

  it('should not throw ValidationError for invalid field names in defaults', async () => {
    // we refactored the backend so that it uses DRF serializers for validation which will ignore unknown fields
    let result = await DummyModel.objects.updateOrCreate(
      { name: 'InvalidFieldTest' },
      { defaults: { nonexistent_field: 'test', related: relatedInstance.pk } }
    )
    expect(result).toBeInstanceOf(ResultTuple);
  });

  // Lookup Field Tests
  it('should handle complex lookup conditions correctly', async () => {
    // Create instance
    await DummyModel.objects.create({
      name: 'ComplexLookupTest',
      value: 42,
      related: relatedInstance.pk
    });
    
    // Try to update or create with complex lookup
    const [instance, created] = await DummyModel.objects.updateOrCreate(
      {
        name: 'ComplexLookupTest',
        value__gt: 40,
        value__lt: 50
      },
      { defaults: { value: 45 } }
    );
    
    // Verify it found and updated the existing instance
    expect(created).toBe(false);
    expect(instance.name).toBe('ComplexLookupTest');
    expect(instance.value).toBe(45);
  });

  it('should handle related field lookups', async () => {
    // Create instance
    await DummyModel.objects.create({
      name: 'RelatedLookupTest',
      value: 15,
      related: relatedInstance.pk
    });
    
    // Try to update or create with related field lookup
    const [instance, created] = await DummyModel.objects.updateOrCreate(
      { 'related__name': 'ValidRelated', name: 'RelatedLookupTest' },
      { defaults: { value: 25 } }
    );
    
    // Verify it found and updated the existing instance
    expect(created).toBe(false);
    expect(instance.name).toBe('RelatedLookupTest');
    expect(instance.value).toBe(25);
  });

  // Permission Tests
  it('should throw PermissionDenied when user lacks permissions', async () => {
    // Create instance first
    await DummyModel.objects.create({
      name: 'PermissionTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    // Save original config
    const savedConfig = { ...originalConfig };
    
    try {
      // Configure unauthorized access
      setBackendConfig('default', {
        getAuthHeaders: () => ({
          'Authorization': 'Token invalid_token'
        })
      });
      
      // Try to update or create with invalid permissions
      await expect(
        DummyModel.objects.updateOrCreate(
          { name: 'PermissionTest' },
          { defaults: { value: 99 } }
        )
      ).rejects.toBeInstanceOf(PermissionDenied);
    } finally {
      // Ensure config is always restored, even if test fails
      setBackendConfig('default', savedConfig);
    }
    
    // Verify instance remains unchanged
    const unchanged = await DummyModel.objects.get({ name: 'PermissionTest' });
    expect(unchanged.value).toBe(10);
  });

  // Transaction and Atomicity Tests
  it('should maintain atomicity during updateOrCreate operations', async () => {
    // Create a valid instance
    await DummyModel.objects.create({
      name: 'AtomicityTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    // Try to update with invalid data
    await expect(
      DummyModel.objects.updateOrCreate(
        { name: 'AtomicityTest' },
        { defaults: { related: 9999 } } // Invalid related ID
      )
    ).rejects.toBeInstanceOf(ValidationError);
    
    // Verify the instance remains unchanged
    const unchanged = await DummyModel.objects.get({ name: 'AtomicityTest' });
    expect(unchanged.value).toBe(10);
    expect(unchanged.related.id).toBe(relatedInstance.pk);
  });

  // Multiple Matching Objects
  it('should throw MultipleObjectsReturned when lookup matches multiple records', async () => {
    // Create multiple instances with the same name
    await DummyModel.objects.create({
      name: 'DuplicateTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    await DummyModel.objects.create({
      name: 'DuplicateTest',
      value: 20,
      related: relatedInstance.pk
    });
    
    // Try to update or create with lookup that matches multiple records
    await expect(
      DummyModel.objects.updateOrCreate({ name: 'DuplicateTest' })
    ).rejects.toBeInstanceOf(MultipleObjectsReturned);
  });

  // Update with changing lookup fields
  it('should update the existing instance when changing the lookup field', async () => {
    // Create an instance
    await DummyModel.objects.create({
      name: 'OriginalName',
      value: 10,
      related: relatedInstance.pk
    });
    
    // Update including the lookup field itself
    const [instance, created] = await DummyModel.objects.updateOrCreate(
      { name: 'OriginalName' },
      { defaults: { name: 'UpdatedName', value: 20 } }
    );
    
    // When updating the lookup field, it updates the existing record, not creating a new one
    expect(created).toBe(false);
    expect(instance.name).toBe('UpdatedName');
    expect(instance.value).toBe(20);
    
    // The original name no longer exists, only the updated name
    expect(await DummyModel.objects.filter({ name: 'OriginalName' }).exists()).toBe(false);
    expect(await DummyModel.objects.filter({ name: 'UpdatedName' }).exists()).toBe(true);
  });

  // Special Character Handling
  it('should update the existing instance when updating with special characters', async () => {
    const specialName = 'Test@#$%^&*()';
    const specialUpdatedName = '!@#Updated$%^&*';
    
    // Create with special characters
    await DummyModel.objects.create({
      name: specialName,
      value: 10,
      related: relatedInstance.pk
    });
    
    // Update with special characters - because we're changing the name field
    // this will be treated as a new record
    const [instance, created] = await DummyModel.objects.updateOrCreate(
      { name: specialName },
      { defaults: { name: specialUpdatedName, value: 30 } }
    );
    
    // Again, changing the lookup field creates a new record
    expect(created).toBe(false);
    expect(instance.name).toBe(specialUpdatedName);
    expect(instance.value).toBe(30);
    
    // Verify both records exist
    expect(await DummyModel.objects.filter({ name: specialName }).exists()).toBe(false);
    expect(await DummyModel.objects.filter({ name: specialUpdatedName }).exists()).toBe(true);
  });

  // Concurrent Updates
  it('should handle concurrent updates correctly', async () => {
    // Create an instance
    await DummyModel.objects.create({
      name: 'ConcurrentTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    // Simulate concurrent updates by performing two consecutive updates
    const [instance1, created1] = await DummyModel.objects.updateOrCreate(
      { name: 'ConcurrentTest' },
      { defaults: { value: 20 } }
    );
    
    const [instance2, created2] = await DummyModel.objects.updateOrCreate(
      { name: 'ConcurrentTest' },
      { defaults: { value: 30 } }
    );
    
    // Verify the second update took effect
    expect(created1).toBe(false);
    expect(created2).toBe(false);
    expect(instance2.value).toBe(30);
    
    // Verify in database
    const finalInstance = await DummyModel.objects.get({ name: 'ConcurrentTest' });
    expect(finalInstance.value).toBe(30);
  });

  // Empty Defaults Test
  it('should not modify any fields when defaults is empty', async () => {
    // Create an instance
    await DummyModel.objects.create({
      name: 'EmptyDefaultsTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    // Update with empty defaults
    const [instance, created] = await DummyModel.objects.updateOrCreate(
      { name: 'EmptyDefaultsTest' },
      { defaults: {} }
    );
    
    // Verify nothing changed
    expect(created).toBe(false);
    expect(instance.value).toBe(10);
    expect(instance.related.id).toBe(relatedInstance.pk);
  });
});