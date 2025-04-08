import { Operation } from './operation.js';

export class ModelStore {
    modelClass;
    fetchFn;
    groundTruthArray;
    operations;
    isSyncing;

    constructor(
        modelClass,
        fetchFn,
        initialGroundTruth,
        initialOperations
    ) {
        this.modelClass = modelClass;
        this.fetchFn = fetchFn;
        this.isSyncing = false;

        this.groundTruthArray = initialGroundTruth ? initialGroundTruth : [];
        this.operations = initialOperations ? initialOperations.map(opData => new Operation(opData)) : [];
    }

    get pkField() {
        return this.modelClass.primaryKeyField;
    }

    // commit optimistic updates

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
            opToConfirm.instances = Array.isArray(instances) ? instances : (instances ? [instances] : []);
            opToConfirm.timestamp = Date.now();
        } else {
             console.warn(`[ModelStore ${this.modelClass.modelName}] Attempted to confirm non-existent operation: ${operationId}`);
        }
    }

    reject(operationId) {
        const opIndex = this.operations.findIndex(op => op.operationId === operationId);
         if (opIndex !== -1) {
            const opToReject = this.operations[opIndex];
            opToReject.status = 'rejected';
            opToReject.timestamp = Date.now();
        } else {
            console.warn(`[ModelStore ${this.modelClass.modelName}] Attempted to reject non-existent operation: ${operationId}`);
        }
    }

    setOperations(operations) {
        this.operations = Array.isArray(operations) ? operations : [];
    }

    // ground truth data

    setGroundTruth(groundTruth) {
        this.groundTruthArray = Array.isArray(groundTruth) ? groundTruth : [];
    }

    get groundTruthPks() {
        const pk = this.pkField;
        return this.groundTruthArray
          .filter(instance => instance && typeof instance === 'object' && pk in instance)
          .map(instance => instance[pk]);
    }

    addToGroundTruth(instances) {
        if (!Array.isArray(instances) || instances.length === 0) return;

        const pkField = this.pkField;
        const pkMap = new Map();

        instances.forEach(inst => {
            if (inst && typeof inst === 'object' && pkField in inst) {
                pkMap.set(inst[pkField], inst);
            } else {
                console.warn(`[ModelStore ${this.modelClass.modelName}] Skipping invalid instance in addToGroundTruth:`, inst);
            }
        });

        if (pkMap.size === 0) return;

        const updatedGroundTruth = [];
        const processedPks = new Set();

        for (const existingItem of this.groundTruthArray) {
             if (!existingItem || typeof existingItem !== 'object' || !(pkField in existingItem)) {
                continue;
            }

            const pk = existingItem[pkField];
            if (pkMap.has(pk)) {
                updatedGroundTruth.push({ ...existingItem, ...pkMap.get(pk) });
                processedPks.add(pk);
                pkMap.delete(pk);
            } else {
                updatedGroundTruth.push(existingItem);
            }
        }

        updatedGroundTruth.push(...Array.from(pkMap.values()));
        this.groundTruthArray = updatedGroundTruth;
    }

    _filteredOperations(pks, operations) {
        if (!pks) return operations;

        const pkField = this.pkField;
        let filteredOps = [];
        for (const op of operations) {
            let relevantInstances = op.instances.filter(instance =>
                instance && typeof instance === 'object' && pkField in instance && pks.has(instance[pkField])
            );
            if (relevantInstances.length > 0) {
                 filteredOps.push(new Operation({
                    ...op,
                    instances: relevantInstances
                }));
            }
        }
        return filteredOps;
    }

    _filteredGroundTruth(pks, groundTruthArray) {
        const pkField = this.pkField;
        let groundTruthMap = new Map();

        for (const instance of groundTruthArray) {
            if (!instance || typeof instance !== 'object' || !(pkField in instance)) {
                continue;
            }
            const pk = instance[pkField];
            if (!pks || pks.has(pk)) {
                groundTruthMap.set(pk, instance);
            }
        }
        return groundTruthMap;
    }

    applyOperation(operation, currentInstances) {
        const pkField = this.pkField;
        for (const instance of operation.instances) {
             if (!instance || typeof instance !== 'object' || !(pkField in instance)) {
                console.warn(`[ModelStore ${this.modelClass.modelName}] Skipping instance in operation ${operation.operationId} during applyOperation due to missing PK field '${String(pkField)}' or invalid format.`);
                continue;
            }
            const pk = instance[pkField];

            switch (operation.type) {
                case 'create':
                case 'get_or_create':
                    if (!currentInstances.has(pk)) {
                        currentInstances.set(pk, instance);
                    }
                    break;
                case 'update': {
                    const existing = currentInstances.get(pk);
                    if (existing) {
                        currentInstances.set(pk, { ...existing, ...instance });
                    } else {
                         const wasDeletedLocally = this.operations.some(op =>
                            op.type === 'delete' &&
                            op.status !== 'rejected' &&
                            op.instances.some(inst => inst && inst[pkField] === pk)
                         );
                         if (!wasDeletedLocally) {
                            currentInstances.set(pk, instance);
                         }
                    }
                    break;
                }
                case 'update_or_create': {
                    const existing = currentInstances.get(pk);
                    if (existing) {
                        currentInstances.set(pk, { ...existing, ...instance });
                    } else {
                        currentInstances.set(pk, instance);
                    }
                    break;
                }
                case 'delete':
                    currentInstances.delete(pk);
                    break;
                default:
                     console.error(`[ModelStore ${this.modelClass.modelName}] Unknown operation type: ${operation.type}`);
            }
        }
        return currentInstances;
    }

    getTrimmedOperations() {
        const twoMinutesAgo = Date.now() - 1000 * 60 * 2;
        return this.operations.filter(operation => operation.timestamp > twoMinutesAgo);
    }

    render(pks = null) {
        const renderedInstancesMap = this._filteredGroundTruth(pks, this.groundTruthArray);
        const relevantOperations = this._filteredOperations(pks, this.operations);

        for (const op of relevantOperations) {
            if (op.status !== 'rejected') {
                this.applyOperation(op, renderedInstancesMap);
            }
        }
        return Array.from(renderedInstancesMap.values());
    }

    // syncing with the server

    async sync() {
        const storeIdForLog = this.modelClass.modelName;
        if (this.isSyncing) {
            console.warn(`[ModelStore ${storeIdForLog}] Already syncing, sync request ignored.`);
            return;
        }
        this.isSyncing = true;
        console.log(`[ModelStore ${storeIdForLog}] Starting sync...`);

        try {
            const currentPks = this.groundTruthPks;
            if (currentPks.length === 0) {
                 console.log(`[ModelStore ${storeIdForLog}] No ground truth PKs to sync. Skipping fetch.`);
                 const trimmedOps = this.getTrimmedOperations();
                 this.setOperations(trimmedOps);
                 return;
            }

            const newGroundTruth = await this.fetchFn({ pks: currentPks, modelClass: this.modelClass });

            this.addToGroundTruth(newGroundTruth);

            const trimmedOps = this.getTrimmedOperations();
            this.setOperations(trimmedOps);

            console.log(`[ModelStore ${storeIdForLog}] Sync completed.`);

        } catch (error) {
            console.error(`[ModelStore ${storeIdForLog}] Failed to sync ground truth:`, error);
        } finally {
             this.isSyncing = false;
        }
    }
}