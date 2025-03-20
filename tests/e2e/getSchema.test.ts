import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { DummyModel } from '../../models/backend1/django_app/dummymodel';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader';

describe('getSchema Method Tests', () => {
  let originalConfig;

  beforeAll(() => {
    loadConfigFromFile();
    originalConfig = {
      getAuthHeaders: () => ({
        'Authorization': 'Token testtoken123'
      })
    };
  });

  beforeEach(() => {
    // Reset config before each test
    setBackendConfig('default', originalConfig);
  });

  afterEach(() => {
    // Reset config after each test
    setBackendConfig('default', originalConfig);
  });

  it('should successfully retrieve schema information', async () => {
    // Execute the method against the real server
    const schema = DummyModel.schema

    // Verify the schema has the expected structure
    expect(schema).toBeDefined();
    
    // Check for essential top-level properties from the example
    expect(schema).toHaveProperty('model_name');
    expect(schema).toHaveProperty('title');
    expect(schema).toHaveProperty('class_name');
    expect(schema).toHaveProperty('plural_title');
    expect(schema).toHaveProperty('primary_key_field');
    expect(schema).toHaveProperty('filterable_fields');
    expect(schema).toHaveProperty('searchable_fields');
    expect(schema).toHaveProperty('ordering_fields');
    expect(schema).toHaveProperty('properties');
    expect(schema).toHaveProperty('relationships');
    expect(schema).toHaveProperty('default_ordering');
    expect(schema).toHaveProperty('definitions');

    // Verify filterable_fields, searchable_fields, and ordering_fields are arrays
    expect(Array.isArray(schema.filterable_fields)).toBe(true);
    expect(Array.isArray(schema.searchable_fields)).toBe(true);
    expect(Array.isArray(schema.ordering_fields)).toBe(true);

    // Verify properties is an object
    expect(typeof schema.properties).toBe('object');
    expect(schema.properties).not.toBeNull();
    
    // Each property should have standard attributes
    const sampleProperty = Object.values(schema.properties)[0];
    expect(sampleProperty).toHaveProperty('type');
    expect(sampleProperty).toHaveProperty('title');
    expect(sampleProperty).toHaveProperty('required');
    
    // Each relationship should have standard attributes if relationships exist
    if (Object.keys(schema.relationships).length > 0) {
      const sampleRelationship = Object.values(schema.relationships)[0];
      expect(sampleRelationship).toHaveProperty('type');
      expect(sampleRelationship).toHaveProperty('model');
    }
  });
});