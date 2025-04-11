import axios from 'axios';
import { getConfig } from '../../config.js';
import { parseORMBridgeError, MultipleObjectsReturned, DoesNotExist } from './errors.js';
import { modelStoreRegistry } from '../../syncEngine/registries/modelStoreRegistry.js';
import { querysetStoreRegistry } from '../../syncEngine/registries/querysetStoreRegistry.js';
import { metricStoreRegistry } from '../../syncEngine/registries/metricStoreRegistry.js';
import { Operation, create } from '../../syncEngine/stores/operation.js';
import { isNil } from 'lodash-es'
import { Model } from './model.js';
import { v7 as uuid7 } from 'uuid';
import { logger } from 'handlebars';

/**
 * A custom data structure that behaves as an augmented array.
 * It stores [instance, created] and also provides named properties for clarity.
 *
 * @class ResultTuple
 * @extends {Array}
 */
export class ResultTuple extends Array {
    /**
     * Creates a new ResultTuple.
     *
     * @param {*} instance - The model instance.
     * @param {boolean} created - Whether the instance was created.
     */
    constructor(instance, created) {
      // Create an array with length 2.
      super(2);
      // Set array indices directly instead of using push.
      this[0] = instance;
      this[1] = created;
      // Set named properties.
      this.instance = instance;
      this.created = created;
    }
}

/**
 * Handles query execution against the backend, and parsing the response into the correct format.
 */
export class QueryExecutor {
    
    /**
     * Makes an API call to the backend with the given QuerySet.
     * 
     * @param {QuerySet} querySet - The QuerySet to execute.
     * @param {string} operationType - The type of operation to perform.
     * @param {Object} args - Additional arguments for the operation.
     * @returns {Promise<Object>} The API response.
     */
    static async _makeApiCall(querySet, operationType, args = {}) {
        const ModelClass = querySet.ModelClass;
        const config = getConfig();
        const backend = config.backendConfigs[ModelClass.configKey];
        if (!backend) {
            throw new Error(`No backend configuration found for key: ${ModelClass.configKey}`);
        }
        
        // Build the base query
        let query = {
            ...querySet.build(),
            type: operationType
        };
        
        // Add args to the query if provided
        if (args && Object.keys(args).length > 0) {
            query = {
                ...query,
                ...args
            };
        }
        
        const { serializerOptions, ...restOfQuery } = query;
        
        const payload = { 
            ast: { 
                query: restOfQuery,
                serializerOptions
            } 
        };
        
        const baseUrl = backend.API_URL.replace(/\/+$/, '');
        const finalUrl = `${baseUrl}/${ModelClass.modelName}/`;
        const headers = backend.getAuthHeaders ? backend.getAuthHeaders() : {};
        
        try {
            let response = await axios.post(finalUrl, payload, { headers });
            return response.data
        } catch (error) {
            if (error.response && error.response.data) {
                const parsedError = parseORMBridgeError(error.response.data);
                if (Error.captureStackTrace) {
                    Error.captureStackTrace(parsedError, QueryExecutor._makeApiCall);
                }
                throw parsedError;
            }
            throw new Error(`API call failed: ${error.message}`);
        }
    }

    /**
     * Injest included entities from a response and register them in the model store
     * 
     * @param {Object} included - The included entities object from the response
     * @param {Function} ModelClass - The model class to register the entities with
     */
    static _injestIncludedEntities(included, ModelClass) {
      if (!included) return;
      
      // Loop through each type of entity in included
      Object.values(included).forEach(entityMap => {
        // Loop through each entity instance
        Object.values(entityMap).forEach(entity => {
          if (entity.id !== undefined) {
            modelStoreRegistry.setEntity(ModelClass, entity[ModelClass.primaryKeyField], entity);
          }
        });
      });
    }

    /**
     * Executes a get operation (get, first, last) with the QuerySet.
     * 
     * @param {QuerySet} querySet - The QuerySet to execute.
     * @param {string} operationType - The specific get operation type.
     * @param {Object} args - Additional arguments for the operation.
     * @returns {Promise<Object>} The model instance.
     */
    static async executeGet(querySet, operationType, args = {}) {
      // get, first, last
      let apiCallArgs = {};
      let ModelClass = querySet.ModelClass
      const response = await this._makeApiCall(querySet, operationType, apiCallArgs);
      let { data, included } = response.data

      if (isNil(data)) return null;

      if (operationType === 'get' && (!data || typeof data !== 'object')){
        throw new Error(`Invalid response format for ${operationType} operation. Expected data.data to be an object.`);
      }

      // Add all the included entities to the model store
      this._injestIncludedEntities(included, ModelClass)
      
      // Create the instance with full data
      let instance = new ModelClass(data);
      
      return instance;
    }

    /**
     * Executes a list operation with the QuerySet.
     * 
     * @param {QuerySet} querySet - The QuerySet to execute.
     * @param {string} operationType - The operation type (always 'list' for this method).
     * @param {Object} args - Additional arguments for the operation.
     * @returns {Promise<Array>} Array of model instances.
     */
    static async executeList(querySet, operationType = 'list', args = {}) {
      // list
      let apiCallArgs = {};
      let ModelClass = querySet.ModelClass;
      const response = await this._makeApiCall(querySet, operationType, apiCallArgs);
      let { data, included } = response.data;
      
      if (isNil(data)) return [];
      
      if (!Array.isArray(data)) {
          throw new Error(`Invalid response format for list operation. Expected data.data to be an array.`);
      }
      
      // Process included entities
      this._injestIncludedEntities(included, ModelClass);
      
      // Create instances from the data array
      let instances = data.map(item => {
        // Create instance with full data
        return new ModelClass(item);
      });
      
      return instances;
    }

    /**
     * Executes a get_or_create or update_or_create operation with the QuerySet.
     * 
     * @param {QuerySet} querySet - The QuerySet to execute.
     * @param {string} operationType - The specific operation type ('get_or_create' or 'update_or_create').
     * @param {Object} args - Additional arguments for the operation.
     * @returns {Promise<ResultTuple>} Tuple with instance and created flag.
     */
    static async executeOrCreate(querySet, operationType, args = {}) {
      // get_or_create, update_or_create
      let ModelClass = querySet.ModelClass;

      const apiCallArgs = {
        lookup: args.lookup || {},
        defaults: args.defaults || {}
      };
      
      // Pass args to _makeApiCall
      const response = await this._makeApiCall(querySet, operationType, apiCallArgs);
      let { data, included } = response.data;
      let created = response.metadata.created;
      
      if (isNil(data)) {
        throw new Error(`Invalid response for ${operationType} operation. Expected data to be present.`);
      }
      
      // Process included entities
      this._injestIncludedEntities(included, ModelClass);
      
      // Create the instance with full data
      let instance = new ModelClass(data);
      
      // Return a ResultTuple with the instance and created flag
      return new ResultTuple(instance, created);
    }

    /**
     * Executes an aggregation operation with the QuerySet.
     * 
     * @param {QuerySet} querySet - The QuerySet to execute.
     * @param {string} operationType - The specific aggregation operation type.
     * @param {Object} args - Additional arguments for the operation.
     * @returns {Promise<number>} The aggregation result.
     */
    static async executeAgg(querySet, operationType, args = {}) {  
        const apiCallArgs = {
          field: operationType === 'count' ? 
            (args.field || querySet.ModelClass.primaryKeyField) : 
            args.field
        };

        // Only include defined properties
        if (apiCallArgs.field === undefined) {
          throw new Error(`Field parameter is required for ${operationType} operation`);
        }

        const response = await this._makeApiCall(querySet, operationType, apiCallArgs);
        
        // Handle aggregation response
        let value = response.data || 0;
        
        // Return aggregation value
        return value;
    }

    /**
     * Executes an exists operation with the QuerySet.
     * 
     * @param {QuerySet} querySet - The QuerySet to execute.
     * @param {string} operationType - The operation type (always 'exists' for this method).
     * @param {Object} args - Additional arguments for the operation.
     * @returns {Promise<boolean>} Whether records exist.
     */
    static async executeExists(querySet, operationType = 'exists', args = {}) {
        // exists
        const apiCallArgs = {};
        const response = await this._makeApiCall(querySet, operationType, apiCallArgs);        
        return response.data || false;
    }

    /**
     * Executes an update operation with the QuerySet.
     *       
     * @param {QuerySet} querySet - The QuerySet to execute.
     * @param {string} operationType - The operation type (always 'update' for this method).
     * @param {Object} args - Additional arguments for the operation.
     * @returns {Promise<Array>} Tuple with count and model counts map.
     */
    static async executeUpdate(querySet, operationType = 'update', args = {}) {
      const ModelClass = querySet.ModelClass;
      const modelName = ModelClass.modelName;
      const primaryKeyField = ModelClass.primaryKeyField;
      let querysetPks = querysetStoreRegistry.getEntity(querySet);

      const apiCallArgs = {
        filter: args.filter,
        data: args.data || {}
      };
        
      const operation = new Operation({
        type: operationType,
        instances: querysetPks.map(pk => typeof pk === 'object' ? pk : { ...apiCallArgs.data, [primaryKeyField]: pk }),
        queryset: querySet
      });
      
      let response;
      try {
        response = await this._makeApiCall(querySet, operationType, apiCallArgs);
      } catch (error) {
        operation.updateStatus('rejected');
        throw error;
      }

      let data;
      let included;
      if (response.data){
        ({ data, included } = response.data);
      }
      
      operation.updateStatus('confirmed', data);
      const updatedCount = response.metadata?.rows_updated || 0;
      return [updatedCount, { [modelName]: updatedCount }];
    }

    /**
     * Executes a delete operation with the QuerySet.
     * 
     * @param {QuerySet} querySet - The QuerySet to execute.
     * @param {string} operationType - The operation type (always 'delete' for this method).
     * @param {Object} args - Additional arguments for the operation.
     * @returns {Promise<Array>} Tuple with count and model counts map.
     */
    static async executeDelete(querySet, operationType = 'delete', args = {}) {
        const ModelClass = querySet.ModelClass;
        const modelName = ModelClass.modelName;
        const primaryKeyField = ModelClass.primaryKeyField;
        let querysetPks = querysetStoreRegistry.getEntity(querySet);

        let apiCallArgs = {}

        const operation = new Operation({
          type: operationType,
          instances: querysetPks.map(pk => typeof pk === 'object' ? pk : { [primaryKeyField]: pk }),
          queryset: querySet
        });
        
        let response;
        try {
          response = await this._makeApiCall(querySet, operationType, apiCallArgs);
        } catch (err){
          operation.updateStatus('rejected')
          throw err
        }
        
        let deletedCount = response.metadata.deleted_count;
        let deletedPks = response.data
        operation.updateStatus('confirmed', deletedPks)
        return [deletedCount, { [modelName]: deletedCount }];
    }

    /**
     * Executes a create operation with the QuerySet.
     * 
     * @param {QuerySet} querySet - The QuerySet to execute.
     * @param {string} operationType - The operation type (always 'create' for this method).
     * @param {Object} args - Additional arguments for the operation.
     * @returns {Promise<Object>} The created model instance.
     */
    static async executeCreate(querySet, operationType = 'create', args = {}) {
      // create
      const ModelClass = querySet.ModelClass;
      const modelName = ModelClass.modelName;
      const primaryKeyField = ModelClass.primaryKeyField;
      let operationId = `${uuid7()}`

      const apiCallArgs = {
        data: args.data || {}
      };

      // set the data so the operationId matches
      if (isNil(args.data)){
        console.warn(`executeCreate was called with null data`)
        args.data = {}
      }
      
      // Create an operation record
      const operation = new Operation({
          operationId: operationId,
          type: operationType,
          instances: [{ ...apiCallArgs.data, [primaryKeyField]: operationId }],
          queryset: querySet
      });
      
      let response;
      try {
          response = await this._makeApiCall(querySet, operationType, apiCallArgs);
      } catch (error) {
          operation.updateStatus('rejected');
          throw error;
      }
      
      // Handle create response
      let { data, included } = response.data;
      
      // Update operation status to confirmed
      operation.mutate({
        instances: [data],
        status: 'confirmed'
      });

      let instance = ModelClass.from(data, false)
      // Return model instance
      return instance;
    }

    
    /**
     * Executes an update_instance operation with the QuerySet.
     * 
     * @param {QuerySet} querySet - The QuerySet to execute.
     * @param {string} operationType - The operation type (always 'update_instance' for this method).
     * @param {Object} args - Additional arguments for the operation.
     * @returns {Promise<Object>} The updated model instance.
     */
    static async executeUpdateInstance(querySet, operationType = 'update_instance', args = {}) {
      const ModelClass = querySet.ModelClass;
      const primaryKeyField = ModelClass.primaryKeyField;
      let querysetPks = querysetStoreRegistry.getEntity(querySet);
      
      const apiCallArgs = {
        data: args.data || {}
      };

      const operation = new Operation({
        type: operationType,
        instances: querysetPks.map(pk => typeof pk === 'object' ? pk : { ...apiCallArgs.data, [primaryKeyField]: pk }),
        queryset: querySet
      });
      
      let response;
      try {
        response = await this._makeApiCall(querySet, operationType, apiCallArgs);
      } catch (error) {
        operation.updateStatus('rejected');
        throw error;
      }

      // Handle update_instance response
      let { data, included } = response.data;
      
      // Update operation status to confirmed
      operation.updateStatus('confirmed', [data]);
      
      // Create instance using from method with write=false
      let instance = ModelClass.from(data, false);
      
      // Return model instance
      return instance;
    }

  /**
   * Executes a delete_instance operation with the QuerySet.
   * 
   * @param {QuerySet} querySet - The QuerySet to execute.
   * @param {string} operationType - The operation type (always 'delete_instance' for this method).
   * @param {Object} args - Additional arguments for the operation.
   * @returns {Promise<Array>} Tuple with count and model counts map.
   */
  static async executeDeleteInstance(querySet, operationType = 'delete_instance', args = {}) {
    const ModelClass = querySet.ModelClass;
    const modelName = ModelClass.modelName;
    const primaryKeyField = ModelClass.primaryKeyField;
    let querysetPks = querysetStoreRegistry.getEntity(querySet);
    let apiCallArgs = {}

    const operation = new Operation({
      type: operationType,
      instances: querysetPks.map(pk => typeof pk === 'object' ? pk : { [primaryKeyField]: pk }),
      queryset: querySet
    });
    
    let response;
    try {
      response = await this._makeApiCall(querySet, operationType, apiCallArgs);
    } catch (err){
      operation.updateStatus('rejected')
      throw err
    }
    
    let deletedCount = response.metadata.deleted_count;
    let deletedPks = response.data
    operation.updateStatus('confirmed', deletedPks)
    return [deletedCount, { [modelName]: deletedCount }];
  }

    /**
     * Executes a delete_instance operation with the QuerySet.
     * 
     * @param {QuerySet} querySet - The QuerySet to execute.
     * @param {string} operationType - The operation type (always 'delete_instance' for this method).
     * @param {Object} args - Additional arguments for the operation.
     * @returns {Promise<Array>} Tuple with count and model counts map.
     */
    static async executeDeleteInstance(querySet, operationType = 'delete_instance', args = {}) {
      const ModelClass = querySet.ModelClass;
      const modelName = ModelClass.modelName;
      const primaryKeyField = ModelClass.primaryKeyField;
      
      // Extract instance primary key from args
      const pkField = ModelClass.primaryKeyField;
      const instanceId = args[pkField];
      
      if (!instanceId) {
          throw new Error(`${pkField} is required for delete_instance operation`);
      }
      
      // Create an operation record
      const operation = new Operation({
          type: operationType,
          instances: [{ [primaryKeyField]: instanceId }],
          queryset: querySet
      });
      
      let response;
      try {
          response = await this._makeApiCall(querySet, operationType, args);
      } catch (error) {
          operation.updateStatus('rejected');
          throw error;
      }
      
      // Handle delete_instance response
      let deletedCount = response.data || 0;
      
      // Update operation status to confirmed
      operation.updateStatus('confirmed', [{ [primaryKeyField]: instanceId }]);
      
      // Return tuple [count, {modelName: count}]
      return [deletedCount, { [modelName]: deletedCount }];
    }

    /**
     * Executes a query operation with the QuerySet.
     * 
     * @param {QuerySet} querySet - The QuerySet to execute.
     * @param {string} operationType - The operation type to perform.
     * @param {Object} args - Additional arguments for the operation.
     * @returns {Promise<any>} The operation result.
     */
    static async execute(querySet, operationType = 'list', args = {}) {
        // execute the query and return the result
        switch (operationType) {
          case 'get':
          case 'first':
          case 'last': 
            return this.executeGet(querySet, operationType, args);
          case 'update_instance':
            return this.executeUpdateInstance(querySet, operationType, args);
          case 'delete_instance':
            return this.executeDeleteInstance(querySet, operationType, args);
          case 'update':
            return this.executeUpdate(querySet, operationType, args);
          case 'delete':
            return this.executeDelete(querySet, operationType, args);
          case 'create':
            return this.executeCreate(querySet, operationType, args);
          case 'get_or_create':
          case 'update_or_create':
            return this.executeOrCreate(querySet, operationType, args);
          case 'min':
          case 'max':
          case 'avg':
          case 'sum':
          case 'count':
            return this.executeAgg(querySet, operationType, args);
          case 'exists':
            return this.executeExists(querySet, operationType, args);
          case 'list':
            return this.executeList(querySet, operationType, args);
        }
        throw new Error(`Invalid operation type: ${operationType}`)
    }
}