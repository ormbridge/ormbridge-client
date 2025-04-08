import { ModelInstance, Operation } from './ModelStore';

/**
 * Interface for serializer constructor options
 */
export interface ModelStoreSerializerOptions {
  ItemClass?: new (data: any) => ModelInstance;
  ModelClass?: new (data: any) => ModelInstance;
  primaryKey: string;
}

/**
 * Interface for serialized model store data
 */
export interface SerializedModelStore {
  id?: string;
  groundTruth: any[];
  operations: any[];
  version: number;
  timestamp: number;
  cachedAt?: number;
}

/**
 * Interface for deserialized model store data
 */
export interface DeserializedModelStore {
  groundTruth: ModelInstance[];
  operations: Map<string, Operation>;
  version: number;
  cachedAt?: number | null;
}

/**
 * Helper class for serializing and deserializing ModelStore data
 * Manages the conversion between model instances and storable data
 */
export class ModelStoreSerializer {
  private ItemClass?: new (data: any) => ModelInstance;
  private primaryKey: string;
  
  /**
   * @param {ModelStoreSerializerOptions} options Serialization options
   */
  constructor(options: ModelStoreSerializerOptions) {
    this.ItemClass = options.ItemClass || options.ModelClass;
    this.primaryKey = options.primaryKey;
  }

  /**
   * Serialize ground truth items for storage
   * @param {ModelInstance[]} groundTruth Array of model instances
   * @returns {any[]} Serialized ground truth
   */
  serializeGroundTruth(groundTruth: ModelInstance[]): any[] {
    return groundTruth.map(item => this.serializeItem(item));
  }

  /**
   * Deserialize ground truth from storage
   * @param {any[]} serialized Serialized ground truth
   * @returns {ModelInstance[]} Deserialized ground truth items
   */
  deserializeGroundTruth(serialized: any[]): ModelInstance[] {
    return serialized.map(item => this.deserializeItem(item));
  }

  /**
   * Serialize operations for storage
   * @param {Map<string, Operation>} operations Map of operations
   * @returns {any[]} Serialized operations
   */
  serializeOperations(operations: Map<string, Operation>): any[] {
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
   * @param {any[]} serialized Serialized operations
   * @param {new (data: any) => Operation} OperationClass Operation class constructor
   * @returns {Map<string, Operation>} Map of deserialized operations
   */
  deserializeOperations(serialized: any[], OperationClass: new (data: any) => Operation): Map<string, Operation> {
    const operations = new Map<string, Operation>();
    
    serialized.forEach(op => {
      // Handle deserialization of instances based on operation type
      const deserializedInstances = op.instances.map((instance: any) => {
        return this.deserializeInstance(instance, op.type);
      });
      
      // Reconstruct operation
      const operation = new OperationClass({
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
   * @param {ModelInstance} item Item to serialize
   * @returns {any} Serialized item
   */
  serializeItem(item: ModelInstance): any {
    if (item && typeof item === 'object' && typeof (item as any).serialize === 'function') {
      return (item as any).serialize();
    }
    // Simple copy for regular objects
    return { ...item }; 
  }

  /**
   * Deserialize a single item
   * @param {any} serialized Serialized item
   * @returns {ModelInstance} Deserialized item
   */
  deserializeItem(serialized: any): ModelInstance {
    if (this.ItemClass) {
      return new this.ItemClass(serialized);
    }
    return { ...serialized };
  }

  /**
   * Serialize a single instance
   * @param {ModelInstance | any} instance Instance to serialize
   * @param {string} operationType Operation type
   * @returns {any} Serialized instance
   */
  serializeInstance(instance: ModelInstance | any, operationType: string): any {
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
    if (typeof (instance as any).serialize === 'function') {
      return (instance as any).serialize();
    }
    
    // Otherwise, return a copy
    return { ...instance };
  }

  /**
   * Deserialize a single instance
   * @param {any} serialized Serialized instance
   * @param {string} operationType Operation type
   * @returns {ModelInstance | any} Deserialized instance
   */
  deserializeInstance(serialized: any, operationType: string): ModelInstance | any {
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
   * @param {any} queryState ModelStore to serialize
   * @returns {SerializedModelStore} Serialized state ready for storage
   */
  serialize(queryState: any): SerializedModelStore {
    return {
      groundTruth: this.serializeGroundTruth(queryState.groundTruth),
      operations: this.serializeOperations(queryState.operations),
      version: queryState.version,
      timestamp: Date.now()
    };
  }

  /**
   * Deserialize the full ModelStore data
   * @param {any} data Serialized data
   * @param {new (data: any) => Operation} OperationClass Operation class constructor
   * @returns {DeserializedModelStore} Deserialized state
   */
  deserialize(data: any, OperationClass: new (data: any) => Operation): DeserializedModelStore {
    return {
      groundTruth: this.deserializeGroundTruth(data.groundTruth),
      operations: this.deserializeOperations(data.operations, OperationClass),
      version: data.version,
      cachedAt: data.timestamp
    };
  }
}