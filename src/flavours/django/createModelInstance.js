import { modelStoreRegistry } from '../../syncEngine/registries/modelStoreRegistry.js';

import { Model } from './model.js';

/**
 * Helper method to create the correct model instance.
 *
 * If the provided data is not an object (e.g. a number or string), it returns the data as-is.
 * Otherwise, it instantiates and returns a model instance.
 *
 * @param {Function} ModelClass - The model's constructor.
 *   It is expected to have a static property `primaryKeyField` (optional) that denotes the primary key field name.
 * @param {*} data - The data from the API.
 * @returns {(Object|string|number|boolean)} An instance of the model or the original non-object data.
 */
export function createModelInstance(ModelClass, data) {
  // just the primary key has been set
  if (data === null || typeof data !== 'object') {
    return data;
  }

  const pkField = ModelClass.primaryKeyField;

  // Standard backend format is {type: x, [pkField]: y}
  if (data.type && data[pkField] !== undefined) {
    return data[pkField];
  }

  // For full objects, store them in the registry
  if (data[pkField]) {
    modelStoreRegistry.setEntity(ModelClass, data[pkField], data);
    return data[pkField];
  }
  
  throw new Error(`Cannot create model instance: missing primary key ${pkField}`);
}