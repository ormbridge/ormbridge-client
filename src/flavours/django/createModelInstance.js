import { Model } from './model.js';

/**
 * Helper method to create the correct model instance.
 *
 * If the provided data is not an object (e.g. a number or string), it returns the data as-is.
 * Otherwise, it instantiates and returns a model instance.
 *
 * @param {Function} modelCtor - The model's constructor.
 *   It is expected to have a static property `primaryKeyField` (optional) that denotes the primary key field name.
 * @param {*} data - The data from the API.
 * @returns {(Object|string|number|boolean)} An instance of the model or the original non-object data.
 */
export function createModelInstance(modelCtor, data) {
  if (data === null || typeof data !== 'object') {
    return data;
  }
  
  return new modelCtor(data);
}