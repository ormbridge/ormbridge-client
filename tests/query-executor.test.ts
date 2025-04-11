import { initEventHandler, cleanupEventHandler } from '../src/syncEngine/stores/operationEventHandlers';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { DummyModel } from '../models/backend1/django_app/dummymodel';
import { DummyRelatedModel } from '../models/backend1/django_app/dummyrelatedmodel';
import { setBackendConfig } from '../src/config';
import { loadConfigFromFile } from '../src/cli/configFileLoader'
import { 
  DoesNotExist, 
  ValidationError, 
  MultipleObjectsReturned,
  PermissionDenied
} from '../src/flavours/django/errors';
import { QueryExecutor } from '../src/flavours/django/queryExecutor';

describe('QueryExecutor Tests', () => {
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
    initEventHandler();
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
    cleanupEventHandler();
  })

  // executeGet tests
  describe('get operations', () => {
    it('should fetch a single instance successfully', async () => {
      // Create a test instance
      const instance = await DummyModel.objects.create({
        name: 'GetTest',
        value: 10,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ id: instance.pk });
      const result = await QueryExecutor.execute(querySet, 'get');
      
      expect(result).toBeTruthy();
      expect(result.name).toBe('GetTest');
      expect(result.value).toBe(10);
      expect(result.related.id).toBe(relatedInstance.pk);
    });

    it('should throw DoesNotExist when no record matches', async () => {
      const querySet = DummyModel.objects.filter({ id: 9999 });
      
      await expect(QueryExecutor.execute(querySet, 'get'))
        .rejects.toBeInstanceOf(DoesNotExist);
    });

    it('should fetch a single instance with related fields', async () => {
      // Create a test instance
      const instance = await DummyModel.objects.create({
        name: 'GetRelatedTest',
        value: 20,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ id: instance.pk }).selectRelated('related');
      const result = await QueryExecutor.execute(querySet, 'get');
      
      expect(result).toBeTruthy();
      expect(result.related).toBeTruthy();
      expect(result.related.name).toBe('ValidRelated');
    });

    it('should fetch the first instance from multiple records', async () => {
      // Create multiple test instances
      await DummyModel.objects.create({
        name: 'FirstTest1',
        value: 30,
        related: relatedInstance.pk
      });
      
      await DummyModel.objects.create({
        name: 'FirstTest2',
        value: 40,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ name__startswith: 'FirstTest' }).orderBy('value');
      const result = await QueryExecutor.execute(querySet, 'first');
      
      expect(result).toBeTruthy();
      expect(result.name).toBe('FirstTest1');
      expect(result.value).toBe(30);
    });

    it('should return null when first() finds no records', async () => {
      const querySet = DummyModel.objects.filter({ name: 'NonExistent' });
      const result = await QueryExecutor.execute(querySet, 'first');
      
      expect(result).toBeNull();
    });

    it('should fetch the last instance from multiple records', async () => {
      // Create multiple test instances
      await DummyModel.objects.create({
        name: 'LastTest1',
        value: 50,
        related: relatedInstance.pk
      });
      
      await DummyModel.objects.create({
        name: 'LastTest2',
        value: 60,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ name__startswith: 'LastTest' }).orderBy('value');
      const result = await QueryExecutor.execute(querySet, 'last');
      
      expect(result).toBeTruthy();
      expect(result.name).toBe('LastTest2');
      expect(result.value).toBe(60);
    });
  });

  // executeList tests
  describe('list operations', () => {
    it('should fetch all instances matching a filter', async () => {
      // Create multiple test instances
      await DummyModel.objects.create({
        name: 'ListTest1',
        value: 70,
        related: relatedInstance.pk
      });
      
      await DummyModel.objects.create({
        name: 'ListTest2',
        value: 80,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ name__startswith: 'ListTest' });
      const results = await QueryExecutor.execute(querySet, 'list');
      
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(2);
      expect(results[0].name).toMatch(/^ListTest/);
      expect(results[1].name).toMatch(/^ListTest/);
    });

    it('should return an empty array when no records match', async () => {
      const querySet = DummyModel.objects.filter({ name: 'NonExistent' });
      const results = await QueryExecutor.execute(querySet, 'list');
      
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });

    it('should fetch instances with related fields', async () => {
      // Create test instances
      await DummyModel.objects.create({
        name: 'ListRelatedTest',
        value: 90,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ name: 'ListRelatedTest' }).selectRelated('related');
      const results = await QueryExecutor.execute(querySet, 'list');
      
      expect(results.length).toBe(1);
      expect(results[0].related).toBeTruthy();
      expect(results[0].related.name).toBe('ValidRelated');
    });
  });

  // executeOrCreate tests
  describe('create operations', () => {
    it('should get an existing instance without creating a new one', async () => {
      // Create a test instance
      const instance = await DummyModel.objects.create({
        name: 'GetOrCreateTest',
        value: 100,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ name: 'GetOrCreateTest' });
      const args = {
        lookup: { name: 'GetOrCreateTest' },
        defaults: {
          value: 100,
          related: relatedInstance.pk
        }
      };
      
      const resultTuple = await QueryExecutor.execute(querySet, 'get_or_create', args);
      
      expect(resultTuple).toBeInstanceOf(Array);
      expect(resultTuple.length).toBe(2);
      expect(resultTuple[0].pk).toBe(instance.pk);
      expect(resultTuple[1]).toBe(false);
      
      // Check named properties
      expect(resultTuple.instance.pk).toBe(instance.pk);
      expect(resultTuple.created).toBe(false);
    });
    
    it('should create a new instance when none exists', async () => {
      const querySet = DummyModel.objects.filter({ 
        name: 'NewGetOrCreateTest'
      });
      
      const args = {
        lookup: { name: 'NewGetOrCreateTest' },
        defaults: {
          value: 110,
          related: relatedInstance.pk
        }
      };
      
      const resultTuple = await QueryExecutor.execute(querySet, 'get_or_create', args);
      
      expect(resultTuple).toBeInstanceOf(Array);
      expect(resultTuple.length).toBe(2);
      expect(resultTuple[0].name).toBe('NewGetOrCreateTest');
      expect(resultTuple[1]).toBe(true);
      
      // Check named properties
      expect(resultTuple.instance.name).toBe('NewGetOrCreateTest');
      expect(resultTuple.created).toBe(true);
      
      // Verify instance was actually created in the database
      const exists = await DummyModel.objects.filter({ name: 'NewGetOrCreateTest' }).exists();
      expect(exists).toBe(true);
    });
    
    it('should update an existing instance with update_or_create', async () => {
      // Create a test instance
      const instance = await DummyModel.objects.create({
        name: 'UpdateOrCreateTest',
        value: 120,
        related: relatedInstance.pk,
      });
      
      const querySet = DummyModel.objects.filter({ 
        name: 'UpdateOrCreateTest'
      });
      
      const args = {
        lookup: { name: 'UpdateOrCreateTest' },
        defaults: {
          value: 130, // Updated value
          related: relatedInstance.pk
        }
      };
      
      const resultTuple = await QueryExecutor.execute(querySet, 'update_or_create', args);
      
      expect(resultTuple).toBeInstanceOf(Array);
      expect(resultTuple[0].value).toBe(130);
      expect(resultTuple[1]).toBe(false);
      
      // Verify instance was actually updated in the database
      const updated = await DummyModel.objects.get({ name: 'UpdateOrCreateTest' });
      expect(updated.value).toBe(130);
    });

    it('should create a new instance', async () => {
      const querySet = DummyModel.objects.all();

      let data = {
        name: 'CreateTest',
        value: 30,
        related: relatedInstance.pk
      };
      
      const instance = await QueryExecutor.execute(querySet, 'create', { data });
      
      expect(instance).toBeTruthy();
      expect(instance.name).toBe('CreateTest');
      expect(instance.value).toBe(30);
      expect(instance.related.id).toBe(relatedInstance.pk);
      
      // Verify instance was actually created in the database
      const exists = await DummyModel.objects.filter({ name: 'CreateTest' }).exists();
      expect(exists).toBe(true);
    });
  });

  // executeAgg tests
  describe('aggregation operations', () => {
    it('should calculate count correctly', async () => {
      // Create multiple test instances
      await DummyModel.objects.create({
        name: 'AggTest1',
        value: 10,
        related: relatedInstance.pk
      });
      
      await DummyModel.objects.create({
        name: 'AggTest2',
        value: 20,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ name__startswith: 'AggTest' });
      const count = await QueryExecutor.execute(querySet, 'count');
      
      expect(count).toBe(2);
    });

    it('should calculate sum correctly', async () => {
      // Create multiple test instances
      await DummyModel.objects.create({
        name: 'SumTest1',
        value: 30,
        related: relatedInstance.pk
      });
      
      await DummyModel.objects.create({
        name: 'SumTest2',
        value: 40,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ name__startswith: 'SumTest' });
      const sum = await QueryExecutor.execute(querySet, 'sum', {field: 'value'});
      
      expect(sum).toBe(70);
    });

    it('should calculate average correctly', async () => {
      // Create multiple test instances
      await DummyModel.objects.create({
        name: 'AvgTest1',
        value: 50,
        related: relatedInstance.pk
      });
      
      await DummyModel.objects.create({
        name: 'AvgTest2',
        value: 100,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ name__startswith: 'AvgTest' });
      const avg = await QueryExecutor.execute(querySet, 'avg', {field: 'value'});
      
      expect(avg).toBe(75);
    });

    it('should find minimum value correctly', async () => {
      // Create multiple test instances
      await DummyModel.objects.create({
        name: 'MinTest1',
        value: 60,
        related: relatedInstance.pk
      });
      
      await DummyModel.objects.create({
        name: 'MinTest2',
        value: 70,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ name__startswith: 'MinTest' });
      const min = await QueryExecutor.execute(querySet, 'min', {field: 'value'});
      
      expect(min).toBe(60);
    });

    it('should find maximum value correctly', async () => {
      // Create multiple test instances
      await DummyModel.objects.create({
        name: 'MaxTest1',
        value: 80,
        related: relatedInstance.pk
      });
      
      await DummyModel.objects.create({
        name: 'MaxTest2',
        value: 90,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ name__startswith: 'MaxTest' });
      const max = await QueryExecutor.execute(querySet, 'max', {field: 'value'});
      
      expect(max).toBe(90);
    });
  });

  // executeExists tests
  describe('exists operations', () => {
    it('should return true when records exist', async () => {
      // Create a test instance
      await DummyModel.objects.create({
        name: 'ExistsTest',
        value: 10,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ name: 'ExistsTest' });
      const exists = await QueryExecutor.execute(querySet, 'exists');
      
      expect(exists).toBe(true);
    });

    it('should return false when no records exist', async () => {
      const querySet = DummyModel.objects.filter({ name: 'NonExistentRecord' });
      const exists = await QueryExecutor.execute(querySet, 'exists');
      
      expect(exists).toBe(false);
    });
  });

  // executeUpdate tests
  describe('update operations', () => {
    it('should update all matching records', async () => {
      // Create multiple test instances
      await DummyModel.objects.create({
        name: 'UpdateTest1',
        value: 100,
        related: relatedInstance.pk
      });
      
      await DummyModel.objects.create({
        name: 'UpdateTest2',
        value: 100,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ name__startswith: 'UpdateTest' });
      // Add the necessary update data
      const [updatedCount, mapping] = await QueryExecutor.execute(
        querySet,
        'update',
        { data: { value: 200 } }
      );
      
      expect(updatedCount).toBe(2);
      expect(mapping).toHaveProperty('django_app.dummymodel');
      expect(mapping['django_app.dummymodel']).toBe(2);
      
      // Verify instances were actually updated in the database
      const instances = await DummyModel.objects.filter({ name__startswith: 'UpdateTest' }).fetch();
      expect(instances.length).toBe(2);
      expect(instances[0].value).toBe(200);
      expect(instances[1].value).toBe(200);
    });

    it('should return zero when no records match', async () => {
      const querySet = DummyModel.objects.filter({ name: 'NonExistentRecord' });
      // Add the necessary update data
      const [updatedCount, mapping] = await QueryExecutor.execute(
        querySet,
        'update',
        { data: { value: 200 } }
      );
      
      expect(updatedCount).toBe(0);
      expect(mapping).toHaveProperty('django_app.dummymodel');
      expect(mapping['django_app.dummymodel']).toBe(0);
    });

    it('should update a specific instance', async () => {
      // Create a test instance
      const instance = await DummyModel.objects.create({
        name: 'UpdateInstanceTest',
        value: 40,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ id: instance.pk });
      const updated = await QueryExecutor.execute(querySet, 'update_instance', { data: { value: 50 }});
      
      expect(updated).toBeTruthy();
      expect(updated.name).toBe('UpdateInstanceTest');
      expect(updated.value).toBe(50);
      
      // Verify instance was actually updated in the database
      const fromDb = await DummyModel.objects.get({ id: instance.pk });
      expect(fromDb.value).toBe(50);
    });
  });

  // executeDelete tests
  describe('delete operations', () => {
    it('should delete all matching records', async () => {
      // Create multiple test instances
      await DummyModel.objects.create({
        name: 'DeleteTest1',
        value: 10,
        related: relatedInstance.pk
      });
      
      await DummyModel.objects.create({
        name: 'DeleteTest2',
        value: 20,
        related: relatedInstance.pk
      });
      
      // Verify instances exist
      const beforeCount = await DummyModel.objects.filter({ name__startswith: 'DeleteTest' }).count();
      expect(beforeCount).toBe(2);
      
      const querySet = DummyModel.objects.filter({ name__startswith: 'DeleteTest' });
      const [deletedCount, mapping] = await QueryExecutor.execute(querySet, 'delete');
      
      expect(deletedCount).toBe(2);
      expect(mapping).toHaveProperty('django_app.dummymodel');
      expect(mapping['django_app.dummymodel']).toBe(2);
      
      // Verify instances were actually deleted from the database
      const afterCount = await DummyModel.objects.filter({ name__startswith: 'DeleteTest' }).count();
      expect(afterCount).toBe(0);
    });

    it('should return zero when no records match', async () => {
      const querySet = DummyModel.objects.filter({ name: 'NonExistentRecord' });
      const [deletedCount, mapping] = await QueryExecutor.execute(querySet, 'delete');
      
      expect(deletedCount).toBe(0);
      expect(mapping).toHaveProperty('django_app.dummymodel');
      expect(mapping['django_app.dummymodel']).toBe(0);
    });

    it('should delete a specific instance', async () => {
      // Create a test instance
      const instance = await DummyModel.objects.create({
        name: 'DeleteInstanceTest',
        value: 60,
        related: relatedInstance.pk
      });
      
      const querySet = DummyModel.objects.filter({ id: instance.pk });
      const [deletedCount, mapping] = await QueryExecutor.execute(querySet, 'delete_instance', { id: instance.pk });
      
      expect(deletedCount).toBe(1);
      expect(mapping).toHaveProperty('django_app.dummymodel');
      expect(mapping['django_app.dummymodel']).toBe(1);
      
      // Verify instance was actually deleted from the database
      const exists = await DummyModel.objects.filter({ id: instance.pk }).exists();
      expect(exists).toBe(false);
    });
  });

  // execute tests
  describe('execute method', () => {
    it('should throw an error for invalid operation type', async () => {
      const querySet = DummyModel.objects.filter({ name: 'Test' });
      await expect(QueryExecutor.execute(querySet, 'invalid_operation'))
        .rejects.toThrow('Invalid operation type: invalid_operation');
    });
  });
});