import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { DeepModelLevel1 } from '../../models/backend1/django_app/deepmodellevel1';
import { DeepModelLevel2 } from '../../models/backend1/django_app/deepmodellevel2';
import { DeepModelLevel3 } from '../../models/backend1/django_app/deepmodellevel3';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader';

describe('Nested Field Selection Tests', () => {
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
    // Reset config and clear all models before each test
    setBackendConfig('default', originalConfig);
    await DeepModelLevel1.objects.all().delete();
    await DeepModelLevel2.objects.all().delete();
    await DeepModelLevel3.objects.all().delete();
  });

  afterEach(async () => {
    // Cleanup after each test
    await DeepModelLevel1.objects.all().delete();
    await DeepModelLevel2.objects.all().delete();
    await DeepModelLevel3.objects.all().delete();
    setBackendConfig('default', originalConfig);
  });

  it('should correctly retrieve nested model instance with selective fields', async () => {
    // Create instances for the deep models
    const level3 = await DeepModelLevel3.objects.create({ name: 'Level3Test' });
    const level2 = await DeepModelLevel2.objects.create({ name: 'Level2Test', level3: level3.pk });
    const level1 = await DeepModelLevel1.objects.create({ name: 'Level1Test', level2: level2.pk });
    
    // Query Level1 and use serializerOptions to select only the "name" field on the nested Level2.
    // The double underscore notation ("level2__name") tells the serializer to include the "name"
    // field for the related Level2 model.
    const retrieved = await DeepModelLevel1.objects.get({
      id: level1.pk,
    }, {
      fields: ['name', 'level2__name'],
      depth: 1
    });

    // Verify the top-level field
    expect(retrieved.name).toBe('Level1Test');
    
    // Verify that the nested Level2 model is returned and its "name" field is populated
    expect(retrieved.level2).toBeDefined();
    expect(retrieved.level2.name).toBe('Level2Test');
    
    // Since we did not select the "level3" field in Level2, it should be null
    expect(retrieved.level2.level3).toBeUndefined();

    // Query Level1 and use serializerOptions to select only the "name" field on the nested Level2.
    // The double underscore notation ("level2__name") tells the serializer to include the "name"
    // field for the related Level2 model.
    const retrievedWithoutDepth = await DeepModelLevel1.objects.get({
      id: level1.pk,
    }, {
      fields: ['name', 'level2__name', 'level2__level3__name'],
      depth: 2
    });

    // Verify the top-level field
    expect(retrievedWithoutDepth.name).toBe('Level1Test');
    
    // Verify that the nested Level2 model is returned and its "name" field is populated
    expect(retrievedWithoutDepth.level2).toBeDefined();
    expect(retrievedWithoutDepth.level2.name).toBe('Level2Test');
    
    // Since we did not select the "level3" field in Level2, it should be null
    expect(retrievedWithoutDepth.level2.level3.id).toBe(level3.id);
  });
});