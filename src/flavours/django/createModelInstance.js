import { Model } from './model.js';
import { ModelSummary } from './modelSummary.js';
import { isEqual, intersection } from 'lodash-es';

/**
 * Helper method to create the correct model instance.
 *
 * If the provided data is not an object (e.g. a number or string), it returns the data as-is.
 * Otherwise, if the data only contains the summary keys, it instantiates and returns a summary model;
 * otherwise, it instantiates and returns a full model.
 *
 * @param {Function} fullModelCtor - The full model's constructor.
 *   It is expected to have a static property `primaryKeyField` (optional) that denotes the primary key field name.
 * @param {Function} summaryModelCtor - The summary model's constructor.
 * @param {*} data - The data from the API.
 * @returns {(Object|string|number|boolean)} An instance of the full model, or the summary model, or the original non-object data.
 */
export function createModelInstance(fullModelCtor, summaryModelCtor, data) {
  if (data === null || typeof data !== 'object') {
    return data;
  }
  
  const pkField = fullModelCtor.primaryKeyField || 'id';
  const summaryKeys = [pkField, 'repr'].sort();
  const dataKeys = Object.keys(data).sort();
  
  const isExactlySummary = isEqual(dataKeys, summaryKeys);
  
  if (isExactlySummary) {
    return new summaryModelCtor(data);
  } else {
    return new fullModelCtor(data);
  }
}