import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
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

describe('getOrCreate() Method Tests', () => {
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

  // Basic Functionality Tests
  it('should return existing instance when it already exists', async () => {
    // Create an instance first
    const existingInstance = await DummyModel.objects.create({
      name: 'ExistingTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    // Try to get or create with same lookup values
    const [instance, created] = await DummyModel.objects.getOrCreate(
      { name: 'ExistingTest' }
    );
    
    // Verify it found the existing instance and didn't create a new one
    expect(created).toBe(false);
    expect(instance.pk).toBe(existingInstance.pk);
    expect(instance.value).toBe(10);
    
    // Verify no new instances were created
    expect(await DummyModel.objects.filter({ name: 'ExistingTest' }).count()).toBe(1);
  });

  it('should create a new instance when it does not exist', async () => {
    // Verify no instance exists yet
    expect(await DummyModel.objects.filter({ name: 'NewTest' }).exists()).toBe(false);
    
    // Get or create
    const [instance, created] = await DummyModel.objects.getOrCreate(
      { name: 'NewTest' },
      { defaults: { value: 20, related: relatedInstance.pk } }
    );
    
    // Verify it created a new instance
    expect(created).toBe(true);
    expect(instance.name).toBe('NewTest');
    expect(instance.value).toBe(20);
    
    // Verify the instance now exists in the database
    expect(await DummyModel.objects.filter({ name: 'NewTest' }).exists()).toBe(true);
  });

  it('should support object destructuring via ResultTuple', async () => {
    // Test object destructuring syntax
    const result = await DummyModel.objects.getOrCreate(
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

  it('should use defaults when creating but not when getting', async () => {
    // Create an instance first
    await DummyModel.objects.create({
      name: 'DefaultsTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    // Try to get or create with different defaults
    const [instance, created] = await DummyModel.objects.getOrCreate(
      { name: 'DefaultsTest' },
      { defaults: { value: 999, related: relatedInstance.pk } }
    );
    
    // Verify it found existing instance and ignored defaults
    expect(created).toBe(false);
    expect(instance.value).toBe(10); // Original value, not 999
    
    // Create a new one with defaults
    const [newInstance, newCreated] = await DummyModel.objects.getOrCreate(
      { name: 'NewDefaultsTest' },
      { defaults: { value: 50, related: relatedInstance.pk } }
    );
    
    // Verify defaults were used
    expect(newCreated).toBe(true);
    expect(newInstance.value).toBe(50);
  });

  // Validation Tests
  it('should throw ValidationError when creating with invalid data', async () => {
    // Attempt to create with invalid related ID
    await expect(
      DummyModel.objects.getOrCreate(
        { name: 'ValidationTest' },
        { defaults: { value: 10, related: 9999 } } // Invalid related ID
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('should throw ValidationError for invalid field names in lookup', async () => {
    await expect(
      DummyModel.objects.getOrCreate(
        { nonexistent_field: 'test' } // Field doesn't exist
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // Lookup Field Tests
  it('should handle complex lookup conditions correctly', async () => {
    // Create instance
    await DummyModel.objects.create({
      name: 'ComplexLookupTest',
      value: 42,
      related: relatedInstance.pk
    });
    
    // Try to get or create with complex lookup
    const [instance, created] = await DummyModel.objects.getOrCreate(
      {
        name: 'ComplexLookupTest',
        value__gt: 40,
        value__lt: 50
      },
      { defaults: { related: relatedInstance.pk } }
    );
    
    // Verify it found the existing instance
    expect(created).toBe(false);
    expect(instance.name).toBe('ComplexLookupTest');
    expect(instance.value).toBe(42);
  });

  it('should handle related field lookups', async () => {
    // Create instance
    await DummyModel.objects.create({
      name: 'RelatedLookupTest',
      value: 15,
      related: relatedInstance.pk
    });
    
    // Try to get or create with related field lookup
    const [instance, created] = await DummyModel.objects.getOrCreate(
      { 'related__name': 'ValidRelated', name: 'RelatedLookupTest' },
      { defaults: { value: 25 } }
    );
    
    // Verify it found the existing instance
    expect(created).toBe(false);
    expect(instance.name).toBe('RelatedLookupTest');
    expect(instance.value).toBe(15);
  });

  // Permission Tests
  it('should throw PermissionDenied when user lacks permissions', async () => {
    // Save original config
    const savedConfig = {
      getAuthHeaders: () => ({
        'Authorization': 'Token testtoken123'
      })
    };
    
    try {
      // Configure unauthorized access
      setBackendConfig('default', {
        getAuthHeaders: () => ({
          'Authorization': 'Token invalid_token'
        })
      });
      
      // Try to get or create with invalid permissions
      await expect(
        DummyModel.objects.getOrCreate(
          { name: 'PermissionTest' },
          { defaults: { value: 10, related: relatedInstance.pk } }
        )
      ).rejects.toBeInstanceOf(PermissionDenied);
    } finally {
      // Reset to valid config before cleanup occurs
      setBackendConfig('default', savedConfig);
    }
  });

  // Transaction and Atomicity Tests
  it('should maintain atomicity during getOrCreate operations', async () => {
    // Create a partial object that will fail validation during create
    await expect(
      DummyModel.objects.getOrCreate(
        { name: 'AtomicityTest', value: 10 },
        { defaults: { related: 9999 } } // Invalid related ID
      )
    ).rejects.toBeInstanceOf(ValidationError);
    
    // Verify no partial object was created
    expect(await DummyModel.objects.filter({ name: 'AtomicityTest' }).exists()).toBe(false);
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
    
    // Try to get or create with lookup that matches multiple records
    await expect(
      DummyModel.objects.getOrCreate({ name: 'DuplicateTest' })
    ).rejects.toBeInstanceOf(MultipleObjectsReturned);
  });

  // Special Character Handling
  it('should handle special characters in lookup values', async () => {
    const specialName = 'Test@#$%^&*()';
    
    // Get or create with special characters (should create)
    const [instance1, created1] = await DummyModel.objects.getOrCreate(
      { name: specialName },
      { defaults: { value: 10, related: relatedInstance.pk } }
    );
    
    expect(created1).toBe(true);
    expect(instance1.name).toBe(specialName);
    
    // Try again (should get)
    const [instance2, created2] = await DummyModel.objects.getOrCreate(
      { name: specialName },
      { defaults: { value: 999, related: relatedInstance.pk } }
    );
    
    expect(created2).toBe(false);
    expect(instance2.pk).toBe(instance1.pk);
  });

  // Empty Defaults
  it('should validate required fields correctly', async () => {
    // Test with missing name (which is required)
    await expect(
      DummyModel.objects.getOrCreate(
        { value: 100 }, // Trying to look up by value without providing name
        { defaults: { } } // No defaults, so name will be missing
      )
    ).rejects.toBeInstanceOf(ValidationError);
    
    // Test with minimal valid instance - only name is required
    const [instance, created] = await DummyModel.objects.getOrCreate(
      { name: 'MinimalTest' }
      // No defaults needed since related is nullable
    );
    
    expect(created).toBe(true);
    expect(instance.name).toBe('MinimalTest');
    // Value should have the default from the model
    expect(instance.value).toBe(0);
    // Related should be null
    expect(instance.related).toBeNull();
  });
});