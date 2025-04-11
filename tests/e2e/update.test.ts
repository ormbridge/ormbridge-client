import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { DummyModel } from '../../models/backend1/django_app/dummymodel';
import { DummyRelatedModel } from '../../models/backend1/django_app/dummyrelatedmodel';
import { setBackendConfig } from '../../src/config';
import { ValidationError, DoesNotExist } from '../../src/flavours/django/errors';
import { loadConfigFromFile } from '../../src/cli/configFileLoader'
import { initEventHandler, cleanupEventHandler } from '../../src/syncEngine/stores/operationEventHandlers';

describe('update() Method Tests (Revised)', () => {
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
    setBackendConfig('default', originalConfig);
    await DummyModel.objects.all().delete();
    await DummyRelatedModel.objects.all().delete();
    // Optional pause to ease potential SQLite locking.
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Create a valid related instance for FK fields.
    relatedInstance = await DummyRelatedModel.objects.create({ name: 'ValidRelated' });
  });

  afterEach(async () => {
    await DummyModel.objects.all().delete();
    await DummyRelatedModel.objects.all().delete();
    setBackendConfig('default', originalConfig);
    // Optional pause.
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  afterAll(async () => {
    cleanupEventHandler()
  })
  // ------------------------------------------------------------
  // Instance save() method tests.
  // ------------------------------------------------------------

  it('should update an existing instance with save() without re-sending foreign key data', async () => {
    const instance = await DummyModel.objects.create({
      name: 'UpdateTest',
      value: 50,
      related: relatedInstance.pk
    });

    // Only update a non-foreign-key field.
    instance.value = 75;
    await instance.save();

    const updatedInstance = await DummyModel.objects.get({ id: instance.pk });
    expect(updatedInstance.value).toBe(75);
    // The related field should remain valid.
    expect(updatedInstance.related.id).toBe(relatedInstance.pk);
  });

  it('should update multiple fields simultaneously with save()', async () => {
    const instance = await DummyModel.objects.create({
      name: 'MultiFieldUpdate',
      value: 100,
      related: relatedInstance.pk
    });

    // Update multiple fields – note that we leave "related" unchanged.
    instance.name = 'UpdatedName';
    instance.value = 150;
    await instance.save();

    const updatedInstance = await DummyModel.objects.get({ id: instance.pk });
    expect(updatedInstance.name).toBe('UpdatedName');
    expect(updatedInstance.value).toBe(150);
  });

  it('should update a related field correctly with save()', async () => {
    // Create another related instance.
    const newRelated = await DummyRelatedModel.objects.create({ name: 'NewRelated' });

    const instance = await DummyModel.objects.create({
      name: 'RelatedUpdateTest',
      value: 200,
      related: relatedInstance.pk
    });

    // Update the related field.
    instance.related = newRelated.pk;
    await instance.save();

    const updatedInstance = await DummyModel.objects.get({ id: instance.pk });
    // Verify that the summary object's id matches.
    expect(updatedInstance.related.id).toBe(newRelated.pk);
  });

  it('should throw ValidationError if updating with invalid field data using save()', async () => {
    const instance = await DummyModel.objects.create({
      name: 'InvalidUpdateTest',
      value: 300,
      related: relatedInstance.pk
    });

    // Attempt to update with an invalid value type.
    instance.value = "not_a_number" as any;
    await expect(instance.save()).rejects.toBeInstanceOf(ValidationError);
  });

  // ------------------------------------------------------------
  // QuerySet update() method tests.
  // ------------------------------------------------------------

  it('should update all matching records using update() method', async () => {
    // Create two instances with the same name.
    const instance1 = await DummyModel.objects.create({
      name: 'BulkUpdateTest',
      value: 10,
      related: relatedInstance.pk
    });
    const instance2 = await DummyModel.objects.create({
      name: 'BulkUpdateTest',
      value: 20,
      related: relatedInstance.pk
    });

    // Update all records with name 'BulkUpdateTest'
    const [updatedCount, mapping] = await DummyModel.objects
      .filter({ name: 'BulkUpdateTest' })
      .update({ value: 100 });

    expect(updatedCount).toBe(2);
    expect(mapping).toEqual({ [DummyModel.modelName]: 2 });

    const updatedInstance1 = await DummyModel.objects.get({ id: instance1.pk });
    const updatedInstance2 = await DummyModel.objects.get({ id: instance2.pk });
    expect(updatedInstance1.value).toBe(100);
    expect(updatedInstance2.value).toBe(100);
  });

  it('should update only filtered records using update() method', async () => {
    // Create three instances, only two matching the filter.
    await DummyModel.objects.create({
      name: 'FilterUpdate',
      value: 30,
      related: relatedInstance.pk
    });
    await DummyModel.objects.create({
      name: 'FilterUpdate',
      value: 40,
      related: relatedInstance.pk
    });
    const noUpdateInstance = await DummyModel.objects.create({
      name: 'NoUpdate',
      value: 50,
      related: relatedInstance.pk
    });

    const [updatedCount, mapping] = await DummyModel.objects
      .filter({ name: 'FilterUpdate' })
      .update({ value: 200 });

    expect(updatedCount).toBe(2);
    expect(mapping).toEqual({ [DummyModel.modelName]: 2 });

    // Verify that the non-matching instance remains unchanged.
    const unchangedInstance = await DummyModel.objects.get({ id: noUpdateInstance.pk });
    expect(unchangedInstance.value).toBe(50);
  });

  it('should return 0 when no records match using update() method', async () => {
    const [updatedCount, mapping] = await DummyModel.objects
      .filter({ name: 'NonExistent' })
      .update({ value: 999 });
    expect(updatedCount).toBe(0);
    expect(mapping).toEqual({ [DummyModel.modelName]: 0 });
  });

  it('should update a foreign key field correctly using update() method', async () => {
    // Create a new related instance to update the FK field.
    const newRelated = await DummyRelatedModel.objects.create({ name: 'NewRelatedForUpdate' });
    const instance = await DummyModel.objects.create({
      name: 'FKUpdateTest',
      value: 60,
      related: relatedInstance.pk
    });

    const [updatedCount, mapping] = await DummyModel.objects
      .filter({ id: instance.pk })
      .update({ related: newRelated.pk });

    expect(updatedCount).toBe(1);
    expect(mapping).toEqual({ [DummyModel.modelName]: 1 });

    const updatedInstance = await DummyModel.objects.get({ id: instance.pk });
    // Verify that the foreign key update is reflected correctly.
    expect(updatedInstance.related.id).toBe(newRelated.pk);
  });

  it('should update multiple fields simultaneously using update() method', async () => {
    const instance = await DummyModel.objects.create({
      name: 'MultiFieldUpdateTest',
      value: 70,
      related: relatedInstance.pk
    });

    const [updatedCount, mapping] = await DummyModel.objects
      .filter({ id: instance.pk })
      .update({ name: 'UpdatedName', value: 85 });

    expect(updatedCount).toBe(1);
    expect(mapping).toEqual({ [DummyModel.modelName]: 1 });

    const updatedInstance = await DummyModel.objects.get({ id: instance.pk });
    expect(updatedInstance.name).toBe('UpdatedName');
    expect(updatedInstance.value).toBe(85);
  });

  it('should throw ValidationError if updating with invalid field data using update() method', async () => {
    const instance = await DummyModel.objects.create({
      name: 'InvalidUpdateTest',
      value: 80,
      related: relatedInstance.pk
    });

    await expect(
      DummyModel.objects.filter({ id: instance.pk }).update({ value: "not_a_number" as any })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});