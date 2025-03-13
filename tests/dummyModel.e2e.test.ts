import { describe, it, expect, beforeAll } from 'vitest';
import { DummyModel } from '../models/backend1/django_app/dummymodel';
import { setBackendConfig } from '../src/config';
import { loadConfigFromFile } from '../src/cli/configFileLoader'

describe('Simplified End-to-End Test with Actual Django Backend', () => {
  beforeAll(async () => {
    loadConfigFromFile();
    setBackendConfig('default', {
      getAuthHeaders: () => ({
        'Authorization': 'Token testtoken123'
      })
    });
  });

  it('should create, get_or_create, and update_or_create a DummyModel instance', async () => {
    // 1. Create a DummyModel instance.
    const createResult = await DummyModel.objects.create({
      name: 'Test Second Simplified',
      value: 40,
      related: { id: 1 }
    });
    console.log("Created instance:", createResult);
    expect(createResult.id).toBeDefined();

    // 2. Test get_or_create using array destructuring (tuple style).
    const [goInstance, goCreated] = await DummyModel.objects.getOrCreate({
      name: 'Test Second Simplified',
      value: 40,
      related: { id: 1 }
    });
    console.log("get_or_create (array destructuring):", goInstance, "wasCreated:", goCreated);
    expect(goInstance.id).toBeDefined();
    expect(typeof goCreated).toBe('boolean');

    // 3. Test get_or_create using object destructuring.
    const { instance: goInstanceObj, created: goCreatedObj } = await DummyModel.objects.getOrCreate({
      name: 'Test Second Simplified',
      value: 40,
      related: { id: 1 }
    });
    console.log("get_or_create (object destructuring):", goInstanceObj, "wasCreated:", goCreatedObj);
    expect(goInstanceObj.id).toBeDefined();
    expect(typeof goCreatedObj).toBe('boolean');

    // 4. Test update_or_create using array destructuring.
    const [uoInstance, uoCreated] = await DummyModel.objects.updateOrCreate(
      { name: 'Test Second Simplified' },
      { defaults: { value: 50 } }
    );
    console.log("update_or_create (array destructuring):", uoInstance, "wasCreated:", uoCreated);
    expect(uoInstance.value).toBe(50);
    expect(typeof uoCreated).toBe('boolean');

    // 5. Test update_or_create using object destructuring.
    const { instance: uoInstanceObj, created: uoCreatedObj } = await DummyModel.objects.updateOrCreate(
      { name: 'Test Second Simplified' },
      { defaults: { value: 60 } }
    );
    console.log("update_or_create (object destructuring):", uoInstanceObj, "wasCreated:", uoCreatedObj);
    expect(uoInstanceObj.value).toBe(60);
    expect(typeof uoCreatedObj).toBe('boolean');
  });
});