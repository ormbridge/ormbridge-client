import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { DeepModelLevel1 } from '../../models/backend1/django_app/deepmodellevel1';
import { DeepModelLevel2 } from '../../models/backend1/django_app/deepmodellevel2'
import { DeepModelLevel3 } from '../../models/backend1/django_app/deepmodellevel3';
import { ComprehensiveModel } from '../../models/backend1/django_app/comprehensivemodel';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader';

describe('Many-to-Many Field Selection Tests', () => {
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
    // Reset config and clear all models before each test.
    setBackendConfig('default', originalConfig);
    await DeepModelLevel1.objects.all().delete();
    await ComprehensiveModel.objects.all().delete();
  });

  afterEach(async () => {
    // Cleanup after each test.
    await DeepModelLevel1.objects.all().delete();
    await ComprehensiveModel.objects.all().delete();
    setBackendConfig('default', originalConfig);
  });

  it('should correctly retrieve many-to-many related models with selective fields', async () => {
    // Create two ComprehensiveModel instances.
    const comp1 = await ComprehensiveModel.objects.create({
      char_field: 'Test Char 1',
      text_field: 'Test Text 1',
      int_field: 101,
      bool_field: true,
      datetime_field: new Date().toISOString(),
      decimal_field: 1.23,
      json_field: { key: 'value1' },
      money_field: { currency: 'USD', amount: 50 }
    });
    
    const comp2 = await ComprehensiveModel.objects.create({
      char_field: 'Test Char 2',
      text_field: 'Test Text 2',
      int_field: 202,
      bool_field: false,
      datetime_field: new Date().toISOString(),
      decimal_field: 4.56,
      json_field: { key: 'value2' },
      money_field: { currency: 'USD', amount: 75 }
    });
    
    const level3 = await DeepModelLevel3.objects.create({ name: 'Level3Test' });
    const level2 = await DeepModelLevel2.objects.create({ name: 'Level2Test', level3: level3.pk });
    const level1 = await DeepModelLevel1.objects.create({ name: 'Test M2M', level2: level2.pk, comprehensive_models: [comp1, comp2] });
    
    // Retrieve the instance using selective fields. Here we select:
    // - The top-level "name" field.
    // - For each related comprehensive model, only "char_field" and "int_field".
    const retrieved = await DeepModelLevel1.objects.filter({id: level1.pk}).first(
      {
        fields: ['name', 'comprehensive_models__char_field', 'comprehensive_models__int_field'],
        depth: 2
      }
    )

    console.log(JSON.stringify(retrieved))
    
    // Verify the top-level field.
    expect(retrieved.name).toBe('Test M2M');
    
    // Verify that the many-to-many field returns an array with only the selected fields.
    expect(Array.isArray(retrieved.comprehensive_models)).toBe(true);
    retrieved.comprehensive_models.forEach((comp: any) => {
      // Automatically included fields.
      expect(comp.id).toBeDefined();
      
      // Selected fields should be present.
      expect(comp.char_field).toBeDefined();
      expect(comp.int_field).toBeDefined();
      
      // Unselected fields should be undefined.
      expect(comp.text_field).toBeUndefined();
      expect(comp.bool_field).toBeUndefined();
      expect(comp.datetime_field).toBeUndefined();
      expect(comp.decimal_field).toBeUndefined();
      expect(comp.json_field).toBeUndefined();
      expect(comp.money_field_currency).toBeUndefined();
      expect(comp.money_field).toBeUndefined();
    });
  });
});
