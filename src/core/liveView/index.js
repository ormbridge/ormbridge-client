import { QuerySet } from "../../flavours/django/querySet.js";
import { Model } from "../../flavours/django/model.js";
import { initializeEventReceiver } from '../../config.js';
import axios from 'axios';
import { EventType, getEventReceiver, setEventReceiver, setNamespaceResolver } from '../eventReceivers.js';
import { LiveQuerySet } from './liveQuerySet.js';
import { handleModelEvent, defaultNamespaceResolver } from './registry.js';
import { activeOperationIds, withOperationId } from './utils.js';

// --------------------
// Type Definitions
// --------------------
/**
 * @typedef {Object} SerializerOptions
 * @property {number} [depth] - How deep to serialize nested objects.
 * @property {string[]} [fields] - List of fields to include.
 * @property {number} [limit] - Maximum number of items to retrieve.
 * @property {number} [offset] - Offset for pagination.
 */

/**
 * @typedef {Object} LiveQuerySetOptions
 * @property {boolean} [strictMode] - @deprecated Use fixedPageSize instead.
 * @property {boolean} [fixedPageSize] - Fixed page size keeps the page size constant by removing items when new ones are added.
 * @property {function(): string} [operationIdGenerator] - Custom operation ID generator function.
 * @property {string} [customNamespace] - Custom namespace to append to the model name.
 * @property {SerializerOptions} [serializer] - Serializer options.
 */

/**
 * @typedef {Object} MetricResult
 * @property {number|any} value - The metric value.
 */

// --------------------
// Factory Functions
// --------------------
/**
 * Creates a LiveQuerySet with the given reactive array.
 * @param {QuerySet} qs - The QuerySet.
 * @param {Array} reactiveArray - Reactive array for data.
 * @param {LiveQuerySetOptions} [options] - Options for live view.
 * @param {function(value: any): MetricResult} [createMetricFn] - Function to create metric results.
 * @returns {Promise<LiveQuerySet>} A promise resolving to a LiveQuerySet.
 */
export async function liveView(qs, reactiveArray, options, createMetricFn) {
  const backendKey = qs.modelClass.configKey;
  if (!backendKey) {
    throw new Error(`No configKey found on model class ${qs.modelClass.modelName}`);
  }
  
  const customNamespace = options && options.customNamespace;
  const namespaceResolver = (modelName) => 
    customNamespace ? `${modelName}::${customNamespace}` : modelName;
  
  const eventReceiver = getEventReceiver();
  if (!eventReceiver) {
    const receiver = initializeEventReceiver(backendKey);
    if (receiver) {
      receiver.setNamespaceResolver(namespaceResolver);
      receiver.addEventHandler(handleModelEvent);
    }
  } else {
    setNamespaceResolver(namespaceResolver);
  }
  
  const queryState = qs.build();
  const initialData = await qs.fetch(options?.serializer || {});
  
  if (reactiveArray.length === 0 && initialData.length > 0) {
    reactiveArray.push(...initialData);
  }
  
  return new LiveQuerySet(
    qs, 
    reactiveArray, 
    options, 
    undefined, 
    queryState.filter && queryState.filter.conditions, 
    createMetricFn
  );
}

/**
 * Backward compatibility function for existing code.
 * @deprecated Use liveView with an explicit array instead.
 * @param {QuerySet} qs - The QuerySet.
 * @param {LiveQuerySetOptions} [options] - Options.
 * @returns {Promise<LiveQuerySet>} A promise resolving to a LiveQuerySet.
 */
export async function legacyLiveView(qs, options) {
  const dataArray = [];
  return liveView(qs, dataArray, options);
}

// --------------------
// Axios Interceptor & QuerySet Override
// --------------------
// Axios interceptor for operation IDs
axios.interceptors.request.use((config) => {
  if (activeOperationIds.size > 0) {
    let operationId = config.data && config.data.ast && config.data.ast.query && config.data.ast.query.operationId;
    if (!operationId) {
      operationId = activeOperationIds.values().next().value;
    }
    config.headers = config.headers || {};
    config.headers['X-Operation-ID'] = operationId;
  }
  return config;
});

// Override QuerySet.prototype.executeQuery to add an operationId if one does not exist.
const originalExecuteQuery = QuerySet.prototype.executeQuery;
QuerySet.prototype.executeQuery = async function (query) {
  if (activeOperationIds.size > 0 && !query.operationId) {
    query.operationId = activeOperationIds.values().next().value;
  }
  return originalExecuteQuery.call(this, query);
};

// Export everything needed for the public API
export {
  LiveQuerySet,
  withOperationId,
  activeOperationIds,
  defaultNamespaceResolver,
  handleModelEvent
};