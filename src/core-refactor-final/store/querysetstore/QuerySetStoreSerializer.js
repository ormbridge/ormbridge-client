/**
 * Serializer for QuerySetStore to handle caching
 */
export class QuerySetStoreSerializer {
    /**
     * Create a new QuerySetStoreSerializer
     * @param {Object} options - Configuration options
     * @param {string} options.queryName - Name of the queryset being serialized
     */
    constructor(options = {}) {
      this.queryName = options.queryName || 'default_query';
    }
  
    /**
     * Serialize a QuerySetStore instance for storage
     * @param {QuerySetStore} querySetStore - The store to serialize
     * @returns {Object} Serialized representation
     */
    serialize(querySetStore) {
      // Create a serialized representation of operations
      const serializedOperations = {};
      
      for (const [opId, operation] of querySetStore.operations.entries()) {
        serializedOperations[opId] = {
          operationId: operation.operationId,
          type: operation.type,
          status: operation.status,
          ids: [...operation.ids],
          timestamp: operation.timestamp
        };
      }
      
      // Create the full serialized object
      return {
        id: querySetStore._cacheStoreName,
        queryName: this.queryName,
        groundTruthIds: [...querySetStore.groundTruthIds],
        operations: serializedOperations,
        version: querySetStore.version,
        cachedAt: Date.now()
      };
    }
  
    /**
     * Deserialize data from storage into a form usable by QuerySetStore
     * @param {Object} data - The serialized data
     * @param {Function} OperationClass - The operation class constructor to use
     * @returns {Object} Deserialized object with properties to apply to a QuerySetStore
     */
    deserialize(data, OperationClass) {
      if (!data) {
        throw new Error('Cannot deserialize null or undefined data');
      }
      
      // Validate required fields
      if (!data.groundTruthIds || !data.operations || !data.version) {
        throw new Error('Serialized data missing required fields');
      }
      
      // Convert operations back to Map with proper instances
      const operationsMap = new Map();
      
      for (const [opId, opData] of Object.entries(data.operations)) {
        operationsMap.set(opId, new OperationClass({
          operationId: opData.operationId,
          type: opData.type,
          status: opData.status,
          ids: opData.ids,
          timestamp: opData.timestamp
        }));
      }
      
      // Return structured object that can be used to update a QuerySetStore
      return {
        groundTruthIds: [...data.groundTruthIds],
        operations: operationsMap,
        version: data.version,
        cachedAt: data.cachedAt
      };
    }
  }