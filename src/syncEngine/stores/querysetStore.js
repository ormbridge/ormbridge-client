import { Operation } from './operation.js';
import { modelStoreRegistry } from '../registries/modelStoreRegistry.js';

export class QuerysetStore {
    modelClass;
    fetchFn;
    ast;
    operations;
    groundTruthPks;
    isSyncing;

    constructor(
        modelClass,
        fetchFn,
        ast,
        initialGroundTruthPks,
        initialOperations,
    ) {
        this.modelClass = modelClass;
        this.fetchFn = fetchFn;
        this.ast = ast;
        this.isSyncing = false;

        this.groundTruthPks = initialGroundTruthPks ? initialGroundTruthPks : [];
        this.operations = initialOperations ? initialOperations.map(opData => new Operation(opData)) : [];
    }

    addOperation(operation) {
        this.operations.push(operation);
    }

    updateOperation(operation) {
        let existingIndex = this.operations.findIndex(op => op.operationId === operation.operationId);
        if (existingIndex !== -1) {
             this.operations[existingIndex] = operation;
             return true;
        }
        return false;
    }

    confirm(operationId, instances) {
        const opIndex = this.operations.findIndex(op => op.operationId === operationId);
        if (opIndex !== -1) {
            const opToConfirm = this.operations[opIndex];
            opToConfirm.status = 'confirmed';
            opToConfirm.instances = Array.isArray(instances) ? instances : [instances];
            opToConfirm.timestamp = Date.now();
        } else {
            console.warn(`[QuerysetStore ${this.modelClass.modelName}] Attempted to confirm non-existent operation: ${operationId}`);
        }
    }

    reject(operationId) {
        const opIndex = this.operations.findIndex(op => op.operationId === operationId);
        if (opIndex !== -1) {
            const opToReject = this.operations[opIndex];
            opToReject.status = 'rejected';
            opToReject.timestamp = Date.now();
        } else {
            console.warn(`[QuerysetStore ${this.modelClass.modelName}] Attempted to reject non-existent operation: ${operationId}`);
        }
    }

    setGroundTruth(groundTruthPks) {
        this.groundTruthPks = Array.isArray(groundTruthPks) ? groundTruthPks : [];
    }

    setOperations(operations) {
        this.operations = Array.isArray(operations) ? operations : [];
    }

    get pkField() {
        return this.modelClass.primaryKeyField;
    }

    get groundTruthSet() {
        return new Set(this.groundTruthPks);
    }

    render() {
        let renderedPks = this.groundTruthSet;

        for (const op of this.operations) {
            if (op.status !== 'rejected') {
                this.applyOperation(op, renderedPks);
            }
        }
        return Array.from(renderedPks.values());
    }

    applyOperation(operation, currentPks) {
        const pkField = this.pkField;

        // Special handling for get_or_create and update_or_create
        if ((operation.type === 'get_or_create' || operation.type === 'update_or_create') && 
            operation.args?.lookup && operation.instances && operation.instances.length > 0) {
            return this._handleSpecialOperation(operation, currentPks);
        }

        const pks = operation.instancePks;
        for (const pk of pks) {
            switch (operation.type) {
                case 'create':
                case 'get_or_create':
                case 'update_or_create':
                    currentPks.add(pk);
                    break;
                case 'update':
                     if (!currentPks.has(pk)) {
                        const wasDeletedLocally = this.operations.some(op =>
                            op.type === 'delete' &&
                            op.status !== 'rejected' &&
                            op.instances.some(inst => inst && inst[pkField] === pk)
                        );
                        if (!wasDeletedLocally) {
                            currentPks.add(pk);
                        }
                    }
                    break;
                case 'delete':
                    currentPks.delete(pk);
                    break;
                default:
                    console.error(`[QuerysetStore ${this.modelClass.modelName}] Unknown operation type: ${operation.type}`);
            }
        }
        return currentPks;
    }

    /**
     * Handles get_or_create and update_or_create operations using ModelStore
     */
    _handleSpecialOperation(operation, currentPks) {
        // Get the ModelStore for this model class
        const modelStore = modelStoreRegistry.getStore(this.modelClass);
        const pkField = this.pkField;
        
        // Get current instances based on our current PKs
        const currentPksArray = Array.from(currentPks);
        const currentInstances = new Map();
        
        // Convert current rendered instances to a Map
        const modelInstances = modelStore.render(currentPksArray);
        for (const instance of modelInstances) {
            currentInstances.set(instance[pkField], instance);
        }
        
        // Get instance from operation
        const instance = operation.instances[0];
        const pk = instance[pkField];
        
        // Create a copy of currentInstances to work with
        const workingInstances = new Map(currentInstances);
        
        // Apply the operation using ModelStore's specialized methods
        if (operation.type === 'get_or_create') {
            modelStore._handleGetOrCreate(operation, workingInstances, instance, pk);
        } else if (operation.type === 'update_or_create') {
            modelStore._handleUpdateOrCreate(operation, workingInstances, instance, pk);
        }
        
        if (workingInstances.has(pk) && !currentPks.has(pk)){
            currentPks.add(pk)
        }
        
        return currentPks;
    }

    getTrimmedOperations() {
       const twoMinutesAgo = Date.now() - 1000 * 60 * 2;
        return this.operations.filter(operation => operation.timestamp > twoMinutesAgo);
    }

    async sync() {
        const storeIdForLog = `${this.modelClass.modelName}`;
        if (this.isSyncing) {
            console.warn(`[QuerysetStore ${storeIdForLog}] Already syncing, request ignored.`);
            return;
        }
        this.isSyncing = true;
        console.log(`[QuerysetStore ${storeIdForLog}] Starting sync...`);

        try {
            const newGroundTruthInstances = await this.fetchFn({ ast: this.ast, modelClass: this.modelClass });

            const validInstances = Array.isArray(newGroundTruthInstances)
                ? newGroundTruthInstances.filter(inst => inst && typeof inst === 'object' && this.pkField in inst)
                : [];
            if (Array.isArray(newGroundTruthInstances) && validInstances.length !== newGroundTruthInstances.length) {
                 console.warn(`[QuerysetStore ${storeIdForLog}] Sync fetch returned some invalid instances.`);
            }

            const newGroundTruthPks = validInstances.map(instance => instance[this.pkField]);

            this.setGroundTruth(newGroundTruthPks);

            const trimmedOps = this.getTrimmedOperations();
            this.setOperations(trimmedOps);

            console.log(`[QuerysetStore ${storeIdForLog}] Sync completed.`);

        } catch (error) {
            console.error(`[QuerysetStore ${storeIdForLog}] Failed to sync ground truth:`, error);
        } finally {
            this.isSyncing = false;
        }
    }
}