import { v7 as uuidv7 } from "uuid";
import { isNil } from 'lodash-es'
import mitt from 'mitt';
import { Model } from "../../react-entry";

export const operationEvents = mitt();

export const OperationEventTypes = {
    CREATED: 'operation:created',
    UPDATED: 'operation:updated',
    CONFIRMED: 'operation:confirmed',
    REJECTED: 'operation:rejected',
    CLEAR: 'clear:all',
    MUTATED: 'operation:mutated'
};

export class Operation {
    operationId;
    type;
    status;
    instances;
    queryset; // for info/routing only
    args; // extra data e.g lookup fields for get_or_create
    timestamp;

    constructor(data) {
        if (!data || typeof data !== 'object') {
            throw new Error("Operation constructor requires a data object.");
        }
        if (!data.type) {
            throw new Error("Operation data must include a 'type'.");
        }
        if (!data.instances) {
            throw new Error("Operation data must include 'instances'.");
        }

        this.operationId = data.operationId || `op_${uuidv7()}`;
        this.type = data.type;
        this.status = data.status || 'inflight';
        this.queryset = data.queryset
        this.args = data.args
        let ModelClass = this.queryset.ModelClass
        
        let instances = data.instances

        // guarantee instances is an array
        if (!isNil(instances)){
            instances = Array.isArray(data.instances) ? data.instances : [data.instances];
        }
        
        // make sure they havent provided pks
        let pkField = ModelClass.primaryKeyField;
        if (instances.some(instance => isNil(instance) || typeof instance !== 'object' || !(pkField in instance))) {
            throw new Error(`All operation instances must be objects with the '${pkField}' field`);
        }

        this.instances = instances
        this.timestamp = data.timestamp || Date.now();

        operationRegistry.register(this);

        // Emit operation created event with the entire operation
        operationEvents.emit(OperationEventTypes.CREATED, this);
    }

    /**
     * Get primary keys of all instances in this operation
     * Returns primary keys as simple values (not objects)
     */
    get instancePks() {
        const pkField = this.queryset.ModelClass.primaryKeyField;
        return this.instances.map(instance => instance[pkField]);
    }

    /**
     * Update this operation's status and emit an event
     * @param {string} status - New status ('confirmed', 'rejected', etc.)
     * @param {Array|Object|null} [instances=null] - New instances for the operation
     */
    updateStatus(status, instances = null) {
        this.status = status;
        this.timestamp = Date.now();
        
        if (instances !== null) {
            this.instances = Array.isArray(instances) ? instances : [instances];
        }
        
        // Emit appropriate event based on status
        if (status === 'confirmed') {
            operationEvents.emit(OperationEventTypes.CONFIRMED, this);
        } else if (status === 'rejected') {
            operationEvents.emit(OperationEventTypes.REJECTED, this);
        } else {
            operationEvents.emit(OperationEventTypes.UPDATED, this);
        }
    }

    /**
     * Updates this operation with new data and emits the appropriate event
     * @param {Object} newData - New data to update the operation with
     * @returns {Operation} - Returns this operation instance for chaining
     */
    mutate(newData) {
        // Ensure instances is always an array
        if (newData.instances && !Array.isArray(newData.instances)) {
            newData.instances = [newData.instances];
        }

        // Use Object.assign to update all properties at once
        Object.assign(this, newData);
        
        // Update timestamp
        this.timestamp = Date.now();
        
        // Emit the OPERATION_UPDATED event
        operationEvents.emit(OperationEventTypes.OPERATION_MUTATED, this);
        
        return this;
    }
}

class OperationRegistry {
    constructor() {
        this._operations = new Map();
    }

    /**
     * Registers a pre-constructed Operation instance in the registry.
     * Ensures the operationId is unique within the registry.
     * Throws an Error if the operationId already exists.
     *
     * @param {Operation} operation - The fully instantiated Operation object to register.
     * @throws {Error} If the input is not a valid operation object or if an operation with the same operationId already exists.
     */
    register(operation) {
        if (!(operation instanceof Operation)) {
             throw new Error("OperationRegistry.register requires an Operation object.");
        }

        // Ensure the ID is unique before registering
        if (this._operations.has(operation.operationId)) {
           // Throw an error if the ID is already used.
           console.warn(`OperationId ${operation.operationId} is already used, overriding existing operation!`);
        }

        // Register the provided operation object
        this._operations.set(operation.operationId, operation);
    }

    /**
     * Retrieves an operation by its ID.
     * @param {string} operationId - The ID of the operation.
     * @returns {Operation | undefined} The operation instance or undefined if not found.
     */
    get(operationId) {
        return this._operations.get(operationId);
    }

    /**
     * Checks if an operation with the given ID exists in the registry.
     * @param {string} operationId - The ID of the operation to check.
     * @returns {boolean} True if the operation exists, false otherwise.
     */
    has(operationId) {
        return this._operations.has(operationId);
    }

    /**
     * Clears all operations from the registry.
     */
    clear() {
        console.log("OperationRegistry: Clearing all operations.");
        this._operations.clear();
        operationEvents.emit(OperationEventTypes.CLEAR)
    }
}

export const operationRegistry = new OperationRegistry();