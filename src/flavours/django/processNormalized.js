import { modelStoreRegistry } from '../../syncEngine/registries/modelStoreRegistry.js';
import { Model } from './model.js';

/**
 * Process a normalized response by adding included entities to the registry
 * and returning model instances for the primary data.
 *
 * @param {Object} response - The normalized API response
 * @param {Function} ModelClass - The model class for the primary data
 * @returns {(Object|Array)} Model instance(s) for the primary data
 */
export function processNormalized(response, ModelClass) {
  const { data, included } = response;
  
  // Process included entities
  if (included) {
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

  let processedData;

  // Process primary data
  if (Array.isArray(data)) {
    // Handle list of entities
    processedData = data.map(item => {
      // If it's just a reference with type and id
      if (item.type && item.id !== undefined) {
        return ModelClass.from({ id: item.id }).serialize();
      }
      // If it's a full entity
      if (item.id !== undefined) {
        return ModelClass.from(item).serialize();
      }
      return item;
    });
    
    return { ...processedData, metadata: data.metadata }

  } else if (data && typeof data === 'object') {
    // Handle single entity
    if (data.id !== undefined) {
      processedData = ModelClass.from(data).serialize();
    }
    return { data: processedData, metadata: data.metadata }
  }
  
  // Fallback to returning the original data
  return response
}