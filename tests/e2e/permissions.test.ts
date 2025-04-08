import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader'
import { CustomPKModel } from '../../models/backend1/django_app/custompkmodel';
import { ModelWithCustomPKRelation } from '../../models/backend1/django_app/modelwithcustompkrelation';
import { NameFilterCustomPKModel } from '../../models/backend1/django_app/namefiltercustompkmodel';
import { DoesNotExist, PermissionDenied } from '../../src/flavours/django/errors';

const adminConfig = {
  getAuthHeaders: () => ({
    'Authorization': 'Token testtoken123'
  })
};
const nonAdminConfig = {
  getAuthHeaders: () => ({
    'Authorization': 'Token nonadmintoken123'
  })
};

describe('Permission and Custom PK Tests (admin user)', () => {
  let originalConfig: any;
  let customPKInstance: any;

  beforeAll(async () => {
    loadConfigFromFile();
    originalConfig = adminConfig;
    setBackendConfig('default', originalConfig);
  });

  beforeEach(async () => {
    setBackendConfig('default', adminConfig);
    try {
      await CustomPKModel.objects.all().delete();
      await ModelWithCustomPKRelation.objects.all().delete();
      await NameFilterCustomPKModel.objects.all().delete();
    } catch (error) {
      // ignore cleanup errors
    }
    // Admin can create normally.
    customPKInstance = await CustomPKModel.objects.create({
      name: 'Test Custom PK'
    });
  });

  afterEach(async () => {
    try {
      await CustomPKModel.objects.all().delete();
      await ModelWithCustomPKRelation.objects.all().delete();
      await NameFilterCustomPKModel.objects.all().delete();
    } catch (error) {
      // ignore cleanup errors
    }
    setBackendConfig('default', adminConfig);
  });

  // --- ReadOnlyPermission Tests for CustomPKModel (admin) ---
  describe('ReadOnlyPermission Tests (admin)', () => {
    it('should allow reading CustomPKModel', async () => {
      const instance = await CustomPKModel.objects.get({ custom_pk: customPKInstance.pk });
      expect(instance.name).toBe('Test Custom PK');
      expect(instance.pk).toBe(customPKInstance.pk);
    });

    it('should not allow writing to the pk field of CustomPKModel', async () => {
      // Fetch the instance created in beforeEach
      const instance = await CustomPKModel.objects.get({ custom_pk: customPKInstance.pk });
      
      await CustomPKModel.objects.filter({ custom_pk: instance.pk }).update({ custom_pk: 555, name: "updated" })

      let updated = await CustomPKModel.objects.get({ custom_pk: instance.pk })

      try {
        updated.custom_pk = 555
        await updated.save()
      } catch {
        console.log("Expected to error because we are trying to write to the pk")
      }

      // refresh - can't do refresh from db because it will fail
      updated = await CustomPKModel.objects.get({ custom_pk: instance.pk })
      
      await expect(
        CustomPKModel.objects.get({ custom_pk: 555, name: "updated" })
      ).rejects.toThrow(DoesNotExist);
      
      // Assert that the pk remains unchanged
      expect(updated.pk).toBe(instance.pk);
      expect(updated.name).toBe("updated")
    });
    
    it('should allow creating a new CustomPKModel', async () => {
      const newInstance = await CustomPKModel.objects.create({ name: 'New Custom PK' });
      expect(newInstance.pk).toBeDefined();
      expect(newInstance.name).toBe('New Custom PK');
    });
    
    it('should allow updating CustomPKModel', async () => {
      const instance = await CustomPKModel.objects.get({ custom_pk: customPKInstance.pk });
      instance.name = 'Updated Name';
      const updated = await instance.save();
      expect(updated.name).toBe('Updated Name');
    });
    
    it('should allow deleting CustomPKModel', async () => {
      const instance = await CustomPKModel.objects.get({ custom_pk: customPKInstance.pk });
      await instance.delete();
      await expect(CustomPKModel.objects.get({ custom_pk: customPKInstance.pk })).rejects.toBeInstanceOf(DoesNotExist);
    });
    
    it('should get CustomPKModel by custom_pk field', async () => {
      const instance = await CustomPKModel.objects.get({ custom_pk: customPKInstance.pk });
      expect(instance.pk).toBe(customPKInstance.pk);
    });
    
    it('should get CustomPKModel by pk property', async () => {
      const instance = await CustomPKModel.objects.get({ pk: customPKInstance.pk });
      expect(instance.name).toBe('Test Custom PK');
    });
  });
  
  // --- RestrictedFieldsPermission Tests for ModelWithCustomPKRelation (admin) ---
  describe('RestrictedFieldsPermission Tests (admin)', () => {
    let relationInstance: any;
    
    beforeEach(async () => {
      relationInstance = await ModelWithCustomPKRelation.objects.create({
        name: 'Test Relation',
        custom_pk_related: customPKInstance.pk
      });
    });
    
    it('should only show visible fields', async () => {
      const instance = await ModelWithCustomPKRelation.objects.get({ pk: relationInstance.pk });
      expect(instance.name).toBe('Test Relation');
      expect(instance.pk).toBeDefined();
      // In admin mode the full relation is returned.
      expect(instance.custom_pk_related).toBeDefined();
      if (typeof instance.custom_pk_related === 'object') {
        expect(instance.custom_pk_related.custom_pk).toBe(customPKInstance.custom_pk);
      } else {
        expect(instance.custom_pk_related).toBe(customPKInstance.custom_pk);
      }
    });
    
    it('should allow updating all fields (admin bypasses field restrictions)', async () => {
      const instance = await ModelWithCustomPKRelation.objects.get({ pk: relationInstance.pk });
      instance.name = 'Updated Relation';
      const newCustomPK = await CustomPKModel.objects.create({ name: 'New Custom PK for relation' });
      instance.custom_pk_related = newCustomPK.pk;
      await instance.save();
      const afterUpdate = await ModelWithCustomPKRelation.objects.get({ pk: instance.pk });
      expect(afterUpdate.name).toBe('Updated Relation');
      if (typeof afterUpdate.custom_pk_related === 'object') {
        expect(afterUpdate.custom_pk_related.custom_pk).toBe(newCustomPK.custom_pk);
      } else {
        expect(afterUpdate.custom_pk_related).toBe(newCustomPK.custom_pk);
      }
    });
    
    it('should allow creating with all fields (admin bypasses creation restrictions)', async () => {
      const newInstance = await ModelWithCustomPKRelation.objects.create({
        name: 'New Relation',
        custom_pk_related: customPKInstance.pk
      });
      expect(newInstance.pk).toBeDefined();
      expect(newInstance.name).toBe('New Relation');
      expect(newInstance.custom_pk_related).toBeDefined();
    });
  });
  
  // --- NameFilterPermission Tests for NameFilterCustomPKModel (admin) ---
  describe('Name Filter Permission Tests (admin)', () => {
    beforeEach(async () => {
      await NameFilterCustomPKModel.objects.create({ name: 'Allowed Prefix Item' });
      await NameFilterCustomPKModel.objects.create({ name: 'Denied Prefix Item' });
    });
    
    it('should filter objects based on name prefix', async () => {
      const items = await NameFilterCustomPKModel.objects.all().fetch();
      expect(items.length).toBe(1);
      expect(items[0].name).toBe('Allowed Prefix Item');
      await expect(
        NameFilterCustomPKModel.objects.get({ name: 'Denied Prefix Item' })
      ).rejects.toBeInstanceOf(DoesNotExist);
    });
    
    it('should allow actions on objects with wrong name prefix for admin', async () => {
      let deniedItem = (await NameFilterCustomPKModel.objects.filter({}).fetch())
        .find(item => item.name === 'Denied Prefix Item');
      if (!deniedItem) {
        deniedItem = await NameFilterCustomPKModel.objects.create({ name: 'Denied Prefix Item' });
      }
      deniedItem.name = 'Denied Prefix Updated';
      const updated = await deniedItem.save();
      expect(updated.name).toBe('Denied Prefix Updated');
      await deniedItem.delete();
      await expect(NameFilterCustomPKModel.objects.get({ pk: deniedItem.pk })).rejects.toBeInstanceOf(DoesNotExist);
    });
  });
  
  // --- Combined Filter & Field Permissions (admin) ---
  describe('Combined Permission Tests (admin)', () => {
    it('should properly handle combined permission restrictions for admin', async () => {
      const newItem = await CustomPKModel.objects.create({ name: 'Allowed ReadOnly Item' });
      expect(newItem.pk).toBeDefined();
      expect(newItem.name).toBe('Allowed ReadOnly Item');
      
      newItem.name = 'Allowed Updated Item';
      const updated = await newItem.save();
      expect(updated.name).toBe('Allowed Updated Item');
    });
  });
  
  // --- Nested Custom PK Relation Tests (admin) ---
  describe('Nested Custom PK Relation Tests (admin)', () => {
    let relationInstance: any;
    
    beforeEach(async () => {
      relationInstance = await ModelWithCustomPKRelation.objects.create({
        name: 'Nested Relation Test',
        custom_pk_related: customPKInstance.pk
      });
    });
    
    it('should correctly navigate nested relations with custom PKs', async () => {
      const results = await ModelWithCustomPKRelation.objects.filter({
        'custom_pk_related__name': 'Test Custom PK'
      }).fetch();
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Nested Relation Test');
      expect(results[0].pk).toBe(relationInstance.pk);
    });
    
    it('should correctly filter by nested custom PK field', async () => {
      const results = await ModelWithCustomPKRelation.objects.filter({
        'custom_pk_related__custom_pk': customPKInstance.custom_pk
      }).fetch();
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Nested Relation Test');
    });
  });
});

describe('Permission and Custom PK Tests (non-admin user)', () => {
  let customPKInstance: any;

  // Pre-create all necessary objects using admin credentials
  beforeAll(async () => {
    loadConfigFromFile();
    // Use admin config for creation
    setBackendConfig('default', adminConfig);
    const instances = await CustomPKModel.objects.all().fetch();
    if (instances.length === 0) {
      customPKInstance = await CustomPKModel.objects.create({ name: 'Test Custom PK' });
    } else {
      customPKInstance = instances[0];
    }
    // Pre-create a ModelWithCustomPKRelation instance using admin credentials
    await ModelWithCustomPKRelation.objects.all().delete();
    await ModelWithCustomPKRelation.objects.create({
      name: 'Test Relation',
      custom_pk_related: customPKInstance.pk
    });
    // Pre-create NameFilter items
    await NameFilterCustomPKModel.objects.all().delete();
    await NameFilterCustomPKModel.objects.create({ name: 'Allowed Prefix Item' });
    await NameFilterCustomPKModel.objects.create({ name: 'Denied Prefix Item' });
    // Switch to non-admin config for subsequent tests
    setBackendConfig('default', nonAdminConfig);
  });

  beforeEach(async () => {
    setBackendConfig('default', nonAdminConfig);
    try {
      await ModelWithCustomPKRelation.objects.all().delete();
      await NameFilterCustomPKModel.objects.all().delete();
    } catch (error) {
      // ignore cleanup errors
    }
  });

  afterEach(async () => {
    try {
      await ModelWithCustomPKRelation.objects.all().delete();
      await NameFilterCustomPKModel.objects.all().delete();
    } catch (error) {
      // ignore cleanup errors
    }
    setBackendConfig('default', nonAdminConfig);
  });

  // --- ReadOnlyPermission Tests for CustomPKModel (non-admin) ---
  describe('ReadOnlyPermission Tests (non-admin)', () => {
    it('should allow reading CustomPKModel', async () => {
      const instance = await CustomPKModel.objects.get({ custom_pk: customPKInstance.pk });
      expect(instance.name).toBe('Test Custom PK');
      expect(instance.pk).toBe(customPKInstance.pk);
    });

    it('should NOT allow creating a new CustomPKModel', async () => {
      await expect(
        CustomPKModel.objects.create({ name: 'New Custom PK' })
      ).rejects.toBeInstanceOf(PermissionDenied);
    });
    
    it('should NOT allow updating CustomPKModel', async () => {
      const instance = await CustomPKModel.objects.get({ custom_pk: customPKInstance.pk });
      instance.name = 'Updated Name';
      await expect(instance.save()).rejects.toBeInstanceOf(PermissionDenied);
    });
    
    it('should NOT allow deleting CustomPKModel', async () => {
      const instance = await CustomPKModel.objects.get({ custom_pk: customPKInstance.pk });
      await expect(instance.delete()).rejects.toBeInstanceOf(PermissionDenied);
    });
  });
  
  // --- RestrictedFieldsPermission Tests for ModelWithCustomPKRelation (non-admin) ---
  describe('RestrictedFieldsPermission Tests (non-admin)', () => {
    let relationInstance: any;
    
    beforeEach(async () => {
      // Create the instance using admin credentials, then switch back
      setBackendConfig('default', adminConfig);
      relationInstance = await ModelWithCustomPKRelation.objects.create({
        name: 'Test Relation',
        custom_pk_related: customPKInstance.pk
      });
      setBackendConfig('default', nonAdminConfig);
    });
    
    it('should only show allowed visible fields in summary representation', async () => {
      const instance = await ModelWithCustomPKRelation.objects.get({ pk: relationInstance.pk });
      console.log(instance)
      expect(instance.name).toBe('Test Relation');
      expect(instance.pk).toBeDefined();
      // For non-admin users the summary representation returns the related field.
      expect(instance.custom_pk_related).toBeDefined();
      if (typeof instance.custom_pk_related === 'object') {
        expect(instance.custom_pk_related.custom_pk).toBe(customPKInstance.custom_pk);
      } else {
        expect(instance.custom_pk_related).toBe(customPKInstance.custom_pk);
      }
    });
    
    it('should allow updating allowed fields only (non-admin)', async () => {
      const instance = await ModelWithCustomPKRelation.objects.get({ pk: relationInstance.pk });
      // Update only the allowed field ("name")
      instance.name = 'Updated Relation';
      const updated = await instance.save();
      expect(updated.name).toBe('Updated Relation');
      console.log(`Updated: ${JSON.stringify(updated)}`)
      // The summary representation returns the relation field, so verify it remains unchanged.
      if (typeof updated.custom_pk_related === 'object') {
        expect(updated.custom_pk_related.custom_pk).toBe(customPKInstance.custom_pk);
      } else {
        expect(updated.custom_pk_related).toBe(customPKInstance.custom_pk);
      }
    });    
    
    it('should NOT allow creating ModelWithCustomPKRelation with allowed fields only', async () => {
      // Since ModelWithCustomPKRelation requires the custom_pk_related field,
      // attempting to create without it should result in a validation error.
      await expect(
        ModelWithCustomPKRelation.objects.create({
          name: 'New Relation'
          // custom_pk_related is intentionally omitted
        })
      ).rejects.toThrow(); // Expect a validation error
    });
    
    it('should NOT allow deleting ModelWithCustomPKRelation (non-admin)', async () => {
      await expect(relationInstance.delete()).rejects.toBeInstanceOf(PermissionDenied);
    });
  });
  
  // --- Extra: Related Model Field Permission Tests (non-admin) ---
  describe('Related Model Field Permission Tests (non-admin)', () => {
    let relationInstance: any;
    beforeEach(async () => {
      // Create the parent instance using admin credentials, then switch back to non-admin
      setBackendConfig('default', adminConfig);
      relationInstance = await ModelWithCustomPKRelation.objects.create({
        name: 'Relation For Nested Test',
        custom_pk_related: customPKInstance.pk
      });
      setBackendConfig('default', nonAdminConfig);
    });
    
    it('should not allow non-admin user to update restricted fields on the related model', async () => {
      const instance = await ModelWithCustomPKRelation.objects.get({ pk: relationInstance.pk });
      
      // Attempt a nested update: change the related model's name.
      if (typeof instance.custom_pk_related === 'object') {
        instance.custom_pk_related.name = 'Hacked Name';
        
        // Optional: Log what we're trying to update
        console.log('Attempting to update with:', JSON.stringify(instance.custom_pk_related));
      }
      
      // Save the parent instance.
      const updated = await instance.save();
      console.log('After update, custom_pk_related:', JSON.stringify(updated.custom_pk_related));
      
      // Check what we can - the custom_pk is still there
      if (typeof updated.custom_pk_related === 'object') {
        expect(updated.custom_pk_related.custom_pk).toBe(1);
        
        // Fetch the related model directly to verify its name wasn't changed
        const relatedModel = await CustomPKModel.objects.get({ pk: updated.custom_pk_related.custom_pk });
        expect(relatedModel.name).toBe('Test Custom PK'); // Original name, not "Hacked Name"
      }
    });
  });
  
  // --- Name Filter Permission Tests for NameFilterCustomPKModel (non-admin) ---
  describe('Name Filter Permission Tests (non-admin)', () => {
    beforeEach(async () => {
      // Create items using admin config and then switch back
      setBackendConfig('default', adminConfig);
      await NameFilterCustomPKModel.objects.all().delete();
      await NameFilterCustomPKModel.objects.create({ name: 'Allowed Prefix Item' });
      await NameFilterCustomPKModel.objects.create({ name: 'Denied Prefix Item' });
      setBackendConfig('default', nonAdminConfig);
    });
    
    it('should filter objects based on name prefix', async () => {
      const items = await NameFilterCustomPKModel.objects.all().fetch();
      expect(items.length).toBe(1);
      expect(items[0].name).toBe('Allowed Prefix Item');
      await expect(
        NameFilterCustomPKModel.objects.get({ name: 'Denied Prefix Item' })
      ).rejects.toBeInstanceOf(DoesNotExist);
    });
    
    it('should NOT allow actions on objects with wrong name prefix for non-admin', async () => {
      let deniedItem = (await NameFilterCustomPKModel.objects.filter({}).fetch())
        .find(item => item.name === 'Denied Prefix Item');
      if (!deniedItem) {
        setBackendConfig('default', adminConfig);
        deniedItem = await NameFilterCustomPKModel.objects.create({ name: 'Denied Prefix Item' });
        setBackendConfig('default', nonAdminConfig);
      }
      deniedItem.name = 'Denied Prefix Updated';
      await expect(deniedItem.save()).rejects.toBeInstanceOf(PermissionDenied);
      await expect(deniedItem.delete()).rejects.toBeInstanceOf(PermissionDenied);
    });
  });
});