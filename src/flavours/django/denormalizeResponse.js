/**
 * Transforms a normalized response to a denormalized structure if needed.
 * This function is safe to call on any API response - it will detect if
 * normalization is present and only transform in that case.
 *
 * @param {any} response - The API response, which may be normalized or already denormalized
 * @returns {any} The denormalized response with the same structure as the input
 */
export function denormalizeResponse(response) {
  // If not an object or null/undefined, return as is
  if (!response || typeof response !== 'object') {
    return response;
  }

  // Deep clone the response to avoid mutations
  const result = { ...response };
  
  // Check for both possible normalized structures:
  // 1. Direct normalized structure: response has data and included
  // 2. Nested normalized structure: response.data has data and included
  
  if (result.data && 
      typeof result.data === 'object' && 
      result.included && 
      typeof result.included === 'object') {
       
    // Extract the data and included parts
    const { data, included } = result;
    
    // Memoization cache for circular references
    const memo = new Map();
    
    // Replace the data property with denormalized version
    result.data = denormalizeEntity(data, included, memo);
    
    // Remove the included property as it's no longer needed
    delete result.included;
    
  } else if (result.data && 
            typeof result.data === 'object' &&
            result.data.data &&
            result.data.included) {
    // Handle nested normalized structure
    
    // Extract the nested data and included
    const { data, included } = result.data;
    
    // Memoization cache for circular references
    const memo = new Map();
    
    // Replace the nested data property with denormalized version
    result.data = {
      ...result.data,
      data: denormalizeEntity(data, included, memo)
    };
    
    // Remove the included property
    delete result.data.included;
    
    // Further processing: If result.data now only has a data property,
    // lift it up to replace result.data directly
    if (Object.keys(result.data).length === 1 && 'data' in result.data) {
      result.data = result.data.data;
    }
  }
  return result;
}

/**
 * Recursively denormalizes an entity and its nested references.
 * 
 * @private
 * @param {any} entity - The entity to denormalize
 * @param {Object} included - Lookup table of included entities 
 * @param {Map} memo - Memoization cache for circular references
 * @returns {any} - The denormalized entity
 */
function denormalizeEntity(entity, included, memo) {
  // Handle arrays
  if (Array.isArray(entity)) {
    return entity.map(item => denormalizeEntity(item, included, memo));
  }

  // Handle non-objects
  if (!entity || typeof entity !== 'object') {
    return entity;
  }

  // Handle entity references (must have 'type' and 'id')
  const entityType = entity.type;
  const entityId = entity.id;

  if (entityType && entityId !== undefined) {
    // Create a unique key for memoization
    const entityKey = `${entityType}:${entityId}`;

    // Check if this entity is already being processed (circular reference)
    if (memo.has(entityKey)) {
      return memo.get(entityKey);
    }

    // Determine if this is a reference only
    const isReferenceOnly = Object.keys(entity).length === 2 && 
      'type' in entity && 'id' in entity;

    // Find the full entity data
    let fullEntityData = null;
    
    if (included && 
        included[entityType] && 
        included[entityType][entityId]) {
      // Found in included section
      fullEntityData = included[entityType][entityId];
    } else if (!isReferenceOnly) {
      // This is already the full entity
      fullEntityData = entity;
    } else {
      // Reference without corresponding data - return as is
      return entity;
    }

    // Create the object to populate and store in memo before recursion
    const denormalizedObject = {};
    memo.set(entityKey, denormalizedObject);

    // Recursively denormalize all fields
    for (const [fieldName, fieldValue] of Object.entries(fullEntityData)) {
      denormalizedObject[fieldName] = denormalizeEntity(fieldValue, included, memo);
    }

    return denormalizedObject;
  }

  // Handle generic objects (without type/id)
  const result = {};
  for (const [fieldName, fieldValue] of Object.entries(entity)) {
    result[fieldName] = denormalizeEntity(fieldValue, included, memo);
  }
  return result;
}