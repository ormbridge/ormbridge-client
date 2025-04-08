import { Operation } from './operation.js';

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
        initialOperations
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
        for (const instance of operation.instances) {
             if (!instance || typeof instance !== 'object' || !(pkField in instance)) {
                console.warn(`[QuerysetStore ${this.modelClass.modelName}] Skipping instance in operation ${operation.operationId} due to missing PK field '${String(pkField)}' or invalid format.`);
                continue;
            }
            const pk = instance[pkField];
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