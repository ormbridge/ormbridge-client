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

describe('get() Method Tests', () => {
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
  it('should retrieve a unique instance by id', async () => {
    const instance = await DummyModel.objects.create({
      name: 'UniqueTest',
      value: 10,
      related: relatedInstance.pk
    });
    const retrieved = await DummyModel.objects.get({ id: instance.pk });
    expect(retrieved.name).toBe('UniqueTest');
  });

  it('should throw a ValidationError when provided a non-existent related key', async () => {
    await expect(
      DummyModel.objects.create({
        name: 'InvalidRelatedTest',
        value: 20,
        related: 9999 // This id does not exist
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('should throw a DoesNotExist error when no record matches', async () => {
    await expect(
      DummyModel.objects.get({ id: 9999 })
    ).rejects.toBeInstanceOf(DoesNotExist);
  });

  it('should throw a MultipleObjectsReturned error when more than one record matches', async () => {
    await DummyModel.objects.create({ 
      name: 'MultiTest', 
      value: 10, 
      related: relatedInstance.pk 
    });
    await DummyModel.objects.create({ 
      name: 'MultiTest', 
      value: 20, 
      related: relatedInstance.pk 
    });
    
    await expect(
      DummyModel.objects.filter({ name: 'MultiTest' }).get()
    ).rejects.toBeInstanceOf(MultipleObjectsReturned);
  });

  // Permission Tests
  it('should throw PermissionDenied when user lacks permissions', async () => {
    const instance = await DummyModel.objects.create({
      name: 'PermTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    try {
      // Simulate unauthorized access
      setBackendConfig('default', {
        getAuthHeaders: () => ({
          'Authorization': 'Token invalid_token'
        })
      });
      
      await expect(
        DummyModel.objects.get({ id: instance.pk })
      ).rejects.toBeInstanceOf(PermissionDenied);
    } finally {
      // Restore valid config even if test fails
      setBackendConfig('default', originalConfig);
    }
  });

  // Query Syntax Tests
  it('should throw ValidationError for invalid field syntax', async () => {
    await expect(
      DummyModel.objects.get({ 'invalid.field__name': 'value' })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // Type Validation Tests
  it('should throw ValidationError when field type does not match', async () => {
    await expect(
      DummyModel.objects.get({ value: "not_a_number" })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // Empty/Null Parameter Tests
  it('should throw DoesNotExist when get() is called with empty parameters', async () => {
    await expect(
      DummyModel.objects.get({})
    ).rejects.toBeInstanceOf(DoesNotExist);
  });

  it('should throw DoesNotExist when get() is called with null/undefined values', async () => {
    await expect(
      DummyModel.objects.get({ name: null })
    ).rejects.toBeInstanceOf(DoesNotExist);

    await expect(
      DummyModel.objects.get({ name: undefined })
    ).rejects.toBeInstanceOf(DoesNotExist);
  });

  // Complex Query Tests
  it('should handle lookups with multiple conditions correctly', async () => {
    const instance = await DummyModel.objects.create({
      name: 'ComplexTest',
      value: 42,
      related: relatedInstance.pk
    });
    
    const retrieved = await DummyModel.objects.get({
      name: 'ComplexTest',
      value__gt: 40,
      value__lt: 50
    });
    
    expect(retrieved.pk).toBe(instance.pk);
  });

  // Related Field Tests
  it('should handle related field lookups correctly', async () => {
    const instance = await DummyModel.objects.create({
      name: 'RelatedTest',
      value: 10,
      related: relatedInstance.pk
    });
    
    const retrieved = await DummyModel.objects.get({
      'related__name': 'ValidRelated'
    });
    
    expect(retrieved.pk).toBe(instance.pk);
  });

  // Field Validation
  it('should throw ValidationError for invalid field names', async () => {
    await expect(
      DummyModel.objects.get({ nonexistent_field: 'value' })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // Query Operator Validation
  it('should throw ValidationError for invalid query operators', async () => {
    await expect(
      DummyModel.objects.get({ value__invalid_operator: 42 })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // Special Characters
  it('should handle special characters in field values correctly', async () => {
    const specialName = 'Test@#$%^&*()';
    const instance = await DummyModel.objects.create({
      name: specialName,
      value: 10,
      related: relatedInstance.pk
    });
    
    const retrieved = await DummyModel.objects.get({ name: specialName });
    expect(retrieved.pk).toBe(instance.pk);
  });
});