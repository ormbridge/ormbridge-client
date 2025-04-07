import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { DummyModel } from '../../models/backend1/django_app/dummymodel';
import { DummyRelatedModel } from '../../models/backend1/django_app/dummyrelatedmodel';
import { setBackendConfig } from '../../src/config';
import { loadConfigFromFile } from '../../src/cli/configFileLoader';
import { configInstance } from '../../src/config'
import { Store, getStore } from '../../src/syncEngine/stores/Store';
import axios from 'axios';

import { 
  DoesNotExist, 
  ValidationError, 
  MultipleObjectsReturned,
  PermissionDenied,
  ConfigError,
  parseORMBridgeError
} from '../../src/flavours/django/errors';

// This test will use the frontend models to create, query and manipulate data
describe('Store Integration Tests Using Model Queries', () => {
  let store;
  let relatedInstance;
  let modelInstance;
  let originalConfig;

  beforeAll(async () => {
    // Load the config
    loadConfigFromFile();
    
    // Set up configuration - follow the same pattern as the working example
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
    
    // Create a dummy model that references the related model
    modelInstance = await DummyModel.objects.create({ 
      name: 'TestModel', 
      value: 42, 
      related: relatedInstance.id 
    });
  });

  afterEach(async () => {
    // Ensure the database is cleaned up after each test
    await DummyModel.objects.all().delete();
    await DummyRelatedModel.objects.all().delete();
    
    // Reset config after each test
    setBackendConfig('default', originalConfig);
  });

  // Function to manually execute query without using fetch()
  async function executeQuery(modelClass, queryObject) {
    const config = configInstance.getConfig();
    const backend = config.backendConfigs[modelClass.configKey];
    
    if (!backend) {
      throw new Error(`No backend configuration found for key: ${modelClass.configKey}`);
    }
    
    const payload = {
      ast: {
        query: queryObject,
        serializerOptions: {depth: 1}
      }
    };
    
    const baseUrl = backend.API_URL.replace(/\/+$/, '');
    const finalUrl = `${baseUrl}/${modelClass.modelName}/`;
    const headers = backend.getAuthHeaders ? backend.getAuthHeaders() : {};
    
    try {
      const response = await axios.post(finalUrl, payload, { headers });
      // Return raw response without denormalization
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        const parsedError = parseORMBridgeError(error.response.data);
        if (Error.captureStackTrace) {
          Error.captureStackTrace(parsedError, executeQuery);
        }
        throw parsedError;
      }
      throw new Error(`API call failed: ${error.message}`);
    }
  }

  it('should query models and store them in the Store', async () => {
    // Define our direct fetch functions without denormalization
    const modelFetchFn = async (params) => {
      // Build the query object
      const queryBuilder = params.modelClass.objects.filter({ 
        [`${params.modelClass.primaryKeyField}__in`]: params.pks 
      });
      
      // Get the query object using build() and add type: 'read'
      const queryObject = { ...queryBuilder.build(), type: 'read' };
      
      // Execute the query directly
      return await executeQuery(params.modelClass, queryObject);
    };
    
    const qsFetchFn = async (params) => {
      // Build the query using model's queryBuilder
      const queryBuilder = params.modelClass.objects.all();
      
      // Get the query object using build()
      const queryObject = { ...queryBuilder.build(), type: 'read' };
      
      // Execute the query directly
      return await executeQuery(params.modelClass, queryObject);
    };
    
    // Create the store instance
    store = new Store(
      {
        'django_app.dummymodel': DummyModel,
        'django_app.dummyrelatedmodel': DummyRelatedModel
      },
      'default',
      modelFetchFn,
      qsFetchFn
    );
    
    // Build a simple AST for all models
    const ast = { type: 'all', materialized: true };
    
    // Execute the query directly
    const queryBuilder = DummyModel.objects.all();
    const queryObject = { ...queryBuilder.build(), type: 'read' };
    const response = await executeQuery(DummyModel, queryObject);
    
    // Ingest the raw response
    store.injestResponse(response, ast);
    
    // Get all models from the store's queryset
    const queryset = await store.getQueryset(ast, DummyModel);
    expect(queryset).toBeDefined();
    expect(queryset.length).toBeGreaterThan(0);
    
    // Get the specific model we created
    const models = await store.getModels(new Set([modelInstance.id]), DummyModel);
    
    // Verify the model data
    expect(models.length).toBe(1);
    expect(models[0].id).toBe(modelInstance.id);
    expect(models[0].name).toBe('TestModel');
    expect(models[0].value).toBe(42);
    expect(models[0].related.id).toBe(relatedInstance.id);
    expect(models[0].related.name).toBe('ValidRelated');
  });

  it('should create new models and retrieve them through the store', async () => {
    // Create a new related model
    const newRelated = await DummyRelatedModel.objects.create({ 
      name: 'NewRelated' 
    });
    
    // Create a new model
    const newModel = await DummyModel.objects.create({
      name: 'NewModel',
      value: 99,
      related: newRelated.id
    });
    
    // Define our direct fetch functions
    const modelFetchFn = async (params) => {
      const queryBuilder = params.modelClass.objects.filter({ 
        [`${params.modelClass.primaryKeyField}__in`]: params.pks 
      });
      const queryObject = { ...queryBuilder.build(), type: 'read' };
      return await executeQuery(params.modelClass, queryObject);
    };
    
    const qsFetchFn = async (params) => {
      const queryBuilder = params.modelClass.objects.all();
      const queryObject = { ...queryBuilder.build(), type: 'read' };
      return await executeQuery(params.modelClass, queryObject);
    };
    
    // Create the store
    store = new Store(
      {
        'django_app.dummymodel': DummyModel,
        'django_app.dummyrelatedmodel': DummyRelatedModel
      },
      'default',
      modelFetchFn,
      qsFetchFn
    );
    
    // Create a query AST to get all models
    const ast = { type: 'all', materialized: true };
    
    // Execute the query directly
    const queryBuilder = DummyModel.objects.all();
    const queryObject = { ...queryBuilder.build(), type: 'read' };
    const response = await executeQuery(DummyModel, queryObject);
    
    // Ingest the response
    store.injestResponse(response, ast);
    
    // Get the models from the store
    const queryset = await store.getQueryset(ast, DummyModel);
    const models = await store.getModels(new Set(queryset), DummyModel);
    
    // Verify our new model is in the results
    const retrievedModel = models.find(model => model.id === newModel.id);
    expect(retrievedModel).toBeDefined();
    expect(retrievedModel.name).toBe('NewModel');
    expect(retrievedModel.value).toBe(99);
    expect(retrievedModel.related.id).toBe(newRelated.id);
    expect(retrievedModel.related.name).toBe('NewRelated');
  });

  it('should handle filtering queries correctly', async () => {
    // Create several models with different names
    await DummyModel.objects.create({
      name: 'FilterTest1',
      value: 10,
      related: relatedInstance.id
    });
    
    await DummyModel.objects.create({
      name: 'FilterTest2',
      value: 20,
      related: relatedInstance.id
    });
    
    await DummyModel.objects.create({
      name: 'OtherTest',
      value: 30,
      related: relatedInstance.id
    });
    
    // Define our direct fetch functions
    const modelFetchFn = async (params) => {
      const queryBuilder = params.modelClass.objects.filter({ 
        [`${params.modelClass.primaryKeyField}__in`]: params.pks 
      });
      const queryObject = { ...queryBuilder.build(), type: 'read' };
      return await executeQuery(params.modelClass, queryObject);
    };
    
    const qsFetchFn = async (params) => {
      let queryBuilder;
      const ast = params.ast;
      const modelClass = params.modelClass;
      
      if (ast.type === 'all') {
        queryBuilder = modelClass.objects.all();
      } else if (ast.type === 'filter') {
        if (ast.op === 'eq') {
          let filter = {};
          filter[ast.field] = ast.value;
          queryBuilder = modelClass.objects.filter(filter);
        } else if (ast.op === 'startswith') {
          let filter = {};
          filter[`${ast.field}__startswith`] = ast.value;
          queryBuilder = modelClass.objects.filter(filter);
        }
      }
      
      const queryObject = queryBuilder._queryObject;
      return await executeQuery(modelClass, queryObject);
    };
    
    // Create the store
    store = new Store(
      {
        'django_app.dummymodel': DummyModel,
        'django_app.dummyrelatedmodel': DummyRelatedModel
      },
      'default',
      modelFetchFn,
      qsFetchFn
    );
    
    // Create a filter AST to get models with name starting with "FilterTest"
    const ast = {
      type: 'filter',
      field: 'name',
      op: 'startswith',
      value: 'FilterTest',
      materialized: true
    };
    
    // Execute the query directly with the filter
    const queryBuilder = DummyModel.objects.filter({ 'name__startswith': 'FilterTest' });
    const queryObject = queryBuilder._queryObject;
    const response = await executeQuery(DummyModel, queryObject);
    
    // Ingest the response
    store.injestResponse(response, ast);
    
    // Get the filtered models from the store
    const queryset = await store.getQueryset(ast, DummyModel);
    const models = await store.getModels(new Set(queryset), DummyModel);
    
    // Verify we got the right models
    expect(models.length).toBe(2);
    expect(models.every(model => model.name.startsWith('FilterTest'))).toBe(true);
    expect(models.every(model => model.related.id === relatedInstance.id)).toBe(true);
  });

  it('should handle model updates and reflect them in the store', async () => {
    // Create a model to update
    const updateModel = await DummyModel.objects.create({
      name: 'UpdateTest',
      value: 50,
      related: relatedInstance.id
    });
    
    // Set up the store with direct fetch functions
    const modelFetchFn = async (params) => {
      const queryBuilder = params.modelClass.objects.filter({ 
        [`${params.modelClass.primaryKeyField}__in`]: params.pks 
      });
      const queryObject = queryBuilder._queryObject;
      return await executeQuery(params.modelClass, queryObject);
    };
    
    const qsFetchFn = async (params) => {
      const queryBuilder = params.modelClass.objects.all();
      const queryObject = queryBuilder._queryObject;
      return await executeQuery(params.modelClass, queryObject);
    };
    
    store = new Store(
      {
        'django_app.dummymodel': DummyModel,
        'django_app.dummyrelatedmodel': DummyRelatedModel
      },
      'default',
      modelFetchFn,
      qsFetchFn
    );
    
    // Initial query to get all models
    const ast = { type: 'all', materialized: true };
    const queryBuilder = DummyModel.objects.all();
    const queryObject = queryBuilder._queryObject;
    let response = await executeQuery(DummyModel, queryObject);
    
    store.injestResponse(response, ast);
    
    // Get the model from the store
    let queryset = await store.getQueryset(ast, DummyModel);
    let models = await store.getModels(new Set([updateModel.id]), DummyModel);
    
    // Verify initial state
    expect(models[0].name).toBe('UpdateTest');
    expect(models[0].value).toBe(50);
    
    // Update the model
    await DummyModel.objects.filter({ id: updateModel.id }).update({
      name: 'Updated',
      value: 100
    });
    
    // Query again to refresh the store using direct execution
    response = await executeQuery(DummyModel, queryObject);
    store.injestResponse(response, ast);
    
    // Get the updated model from the store
    queryset = await store.getQueryset(ast, DummyModel);
    models = await store.getModels(new Set([updateModel.id]), DummyModel);
    
    // Verify the update was reflected
    expect(models[0].name).toBe('Updated');
    expect(models[0].value).toBe(100);
  });

  it('should handle errors correctly', async () => {
    // Test DoesNotExist error
    try {
      // Build query object
      const queryBuilder = DummyModel.objects.filter({ id: 99999 });
      const queryObject = queryBuilder._queryObject;
      
      // Execute directly
      await executeQuery(DummyModel, queryObject);
      fail('Should have thrown DoesNotExist');
    } catch (error) {
      expect(error).toBeInstanceOf(DoesNotExist);
    }
    
    // Create duplicate models to test MultipleObjectsReturned
    await DummyModel.objects.create({
      name: 'Duplicate',
      value: 1,
      related: relatedInstance.id
    });
    
    await DummyModel.objects.create({
      name: 'Duplicate',
      value: 2,
      related: relatedInstance.id
    });
    
    // Test MultipleObjectsReturned error using direct execution
    try {
      const queryBuilder = DummyModel.objects.filter({ name: 'Duplicate' });
      const queryObject = queryBuilder._queryObject;
      
      // Add a flag to indicate we're expecting a single result
      queryObject.expectSingle = true;
      
      await executeQuery(DummyModel, queryObject);
      fail('Should have thrown MultipleObjectsReturned');
    } catch (error) {
      expect(error).toBeInstanceOf(MultipleObjectsReturned);
    }
  });
});