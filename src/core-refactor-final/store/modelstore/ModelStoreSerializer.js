/**
 * Helper class for serializing and deserializing ModelStore data
 * Manages the conversion between model instances and storable data
 */
export class ModelStoreSerializer {
  /**
   * @param {Object} options Serialization options
   * @param {Function} options.ItemClass Model class constructor
   * @param {string} options.primaryKey Name of primary key field
   */
  constructor(options) {
    this.ItemClass = options.ItemClass;
    this.primaryKey = options.primaryKey;
  }

  /**
   * Serialize ground truth items for storage
   * @param {Array} groundTruth Array of model instances
   * @returns {Array} Serialized ground truth
   */
  serializeGroundTruth(groundTruth) {
    return groundTruth.map(item => this.serializeItem(item));
  }

  /**
   * Deserialize ground truth from storage
   * @param {Array} serialized Serialized ground truth
   * @returns {Array} Deserialized ground truth items
   */
  deserializeGroundTruth(serialized) {
    return serialized.map(item => this.deserializeItem(item));
  }

  /**
   * Serialize operations for storage
   * @param {Map} operations Map of operations
   * @returns {Array} Serialized operations
   */
  serializeOperations(operations) {
    return Array.from(operations.entries()).map(([id, op]) => {
      const serializedOp = { ...op };
      
      // Handle instances which could be objects or primary keys
      serializedOp.instances = op.instances.map(instance => {
        // Handle different types of instances
        return this.serializeInstance(instance, op.type);
      });
      
      return serializedOp;
    });
  }

  /**
   * Deserialize operations from storage
   * @param {Array} serialized Serialized operations
   * @param {Function} Operation Operation class constructor
   * @returns {Map} Map of deserialized operations
   */
  deserializeOperations(serialized, Operation) {
    const operations = new Map();
    
    serialized.forEach(op => {
      // Handle deserialization of instances based on operation type
      const deserializedInstances = op.instances.map(instance => {
        return this.deserializeInstance(instance, op.type);
      });
      
      // Reconstruct operation
      const operation = new Operation({
        operationId: op.operationId,
        type: op.type,
        status: op.status,
        instances: deserializedInstances,
        timestamp: op.timestamp
      });
      
      operations.set(op.operationId, operation);
    });
    
    return operations;
  }

  /**
   * Serialize a single item
   * @param {Object} item Item to serialize
   * @returns {Object} Serialized item
   */
  serializeItem(item) {
    if (item && typeof item === 'object' && typeof item.serialize === 'function') {
      return item.serialize();
    }
    // Simple copy for regular objects
    return { ...item }; 
  }

  /**
   * Deserialize a single item
   * @param {Object} serialized Serialized item
   * @returns {Object} Deserialized item
   */
  deserializeItem(serialized) {
    if (this.ItemClass) {
      return new this.ItemClass(serialized);
    }
    return { ...serialized };
  }

  /**
   * Serialize a single instance
   * @param {Object|any} instance Instance to serialize
   * @param {string} operationType Operation type
   * @returns {Object|any} Serialized instance
   */
  serializeInstance(instance, operationType) {
    if (instance === null || instance === undefined) {
      return instance;
    }
    
    // If it's a primitive (like a primary key), return as is
    if (typeof instance !== 'object') {
      return instance;
    }
    
    // For delete operations, could just extract the primary key
    if (operationType === 'delete' && this.primaryKey && instance[this.primaryKey]) {
      return instance[this.primaryKey];
    }
    
    // For objects, use serialize if available
    if (typeof instance.serialize === 'function') {
      return instance.serialize();
    }
    
    // Otherwise, return a copy
    return { ...instance };
  }

  /**
   * Deserialize a single instance
   * @param {Object|any} serialized Serialized instance
   * @param {string} operationType Operation type
   * @returns {Object|any} Deserialized instance
   */
  deserializeInstance(serialized, operationType) {
    // For delete operations, instances might just be primary keys
    if (operationType === 'delete' && (typeof serialized !== 'object' || serialized === null)) {
      return serialized; // Just keep the primary key as is
    }
    
    // For objects, use ItemClass if available
    if (serialized !== null && typeof serialized === 'object' && this.ItemClass) {
      return new this.ItemClass(serialized);
    }
    
    return serialized;
  }

  /**
   * Prepare the full ModelStore for storage
   * @param {Object} queryState ModelStore to serialize
   * @returns {Object} Serialized state ready for storage
   */
  serialize(queryState) {
    return {
      groundTruth: this.serializeGroundTruth(queryState.groundTruth),
      operations: this.serializeOperations(queryState.operations),
      version: queryState.version,
      timestamp: Date.now()
    };
  }

  /**
   * Deserialize the full ModelStore data
   * @param {Object} data Serialized data
   * @param {Function} Operation Operation class constructor
   * @returns {Object} Deserialized state
   */
  deserialize(data, Operation) {
    return {
      groundTruth: this.deserializeGroundTruth(data.groundTruth),
      operations: this.deserializeOperations(data.operations, Operation),
      version: data.version,
      cachedAt: data.timestamp
    };
  }
}