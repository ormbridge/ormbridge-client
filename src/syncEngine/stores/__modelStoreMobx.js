import { Operation, operationRegistry } from './operation.js';
import { makeObservable, observable, action, computed, runInAction } from 'mobx';
import { computedFn } from 'mobx-utils';

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
        this.groundTruthArray = initialGroundTruth ? initialGroundTruth.slice() : [];
        if (Array.isArray(initialOperations) && initialOperations.length){
            if (!(initialOperations[0] instanceof Operation)) throw new Error('initialOperatons must be Operations')
        } else {
        
        }
        this.operations = initialOperations

        makeObservable(this, {
            groundTruthArray: observable.deep,
            operations: observable.deep,
            isSyncing: observable,

            addOperation: action,
            updateOperation: action,
            confirm: action,
            reject: action,
            setOperations: action,
            setGroundTruth: action,
            addToGroundTruth: action,
            sync: action,

            pkField: computed,
            groundTruthPks: computed,
        });
        
        // Bind the render method directly to a computed function
        this.render = computedFn(this._renderImplementation.bind(this), {
            keepAlive: false
        });
    }

    get pkField() {
        return this.modelClass.primaryKeyField;
    }

    addOperation(operation) {
        const opInstance = operation instanceof Operation ? operation : new Operation(operation);
        this.operations.push(opInstance);
    }

    updateOperation(operation) {
        const opInstance = operation instanceof Operation ? operation : new Operation(operation);
        let existingIndex = this.operations.findIndex(op => op.operationId === opInstance.operationId);
        if (existingIndex !== -1) {
             this.operations[existingIndex] = opInstance;
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
        const opInstances = Array.isArray(operations)
            ? operations.map(opData => opData instanceof Operation ? opData : new Operation(opData))
            : [];
        this.operations.replace(opInstances);
    }

    setGroundTruth(groundTruth) {
        this.groundTruthArray.replace(Array.isArray(groundTruth) ? groundTruth.slice() : []);
    }

    getGroundTruth(){
        return this.groundTruthArray;
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

        const processedPks = new Set();

        this.groundTruthArray.forEach((existingItem) => {
            if (!existingItem || typeof existingItem !== 'object' || !(pkField in existingItem)) {
                return;
            }
            const pk = existingItem[pkField];
            if (pkMap.has(pk)) {
                Object.assign(existingItem, pkMap.get(pk));
                processedPks.add(pk);
            }
        });

        const newItems = [];
        for (const [pk, item] of pkMap.entries()) {
            if (!processedPks.has(pk)) {
                 if (!this.groundTruthArray.some(existing => existing && existing[pkField] === pk)) {
                    newItems.push(item);
                 }
            }
        }

        if (newItems.length > 0) {
            this.groundTruthArray.push(...newItems);
        }
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
            if (pks === null || pks.has(pk)) {
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
    }

    getTrimmedOperations() {
        const twoMinutesAgo = Date.now() - 1000 * 60 * 2;
        return this.operations.filter(operation => operation.timestamp > twoMinutesAgo);
    }

    _renderImplementation(pks = null) {
        const pksSet = pks === null ? null :
                  (pks instanceof Set ? pks : new Set(Array.isArray(pks) ? pks : [pks]));

        const renderedInstancesMap = this._filteredGroundTruth(pksSet, this.groundTruthArray);
        const relevantOperations = this._filteredOperations(pksSet, this.operations);

        for (const op of relevantOperations) {
            if (op.status !== 'rejected') {
                this.applyOperation(op, renderedInstancesMap);
            }
        }
        return Array.from(renderedInstancesMap.values());
    }
    
    // render is now assigned in the constructor as a computed function

    async sync() {
        const storeIdForLog = this.modelClass.modelName;

        if (this.isSyncing) {
            return;
        }

        runInAction(() => {
            this.isSyncing = true;
        });

        try {
            const currentPks = this.groundTruthPks;

            if (currentPks.length === 0) {
                 const trimmedOps = this.getTrimmedOperations();
                 this.setOperations(trimmedOps);
                 return;
            }

            const newGroundTruth = await this.fetchFn({ pks: currentPks, modelClass: this.modelClass });

            const trimmedOps = this.getTrimmedOperations();

            runInAction(() => {
                this.setGroundTruth(newGroundTruth);
                this.setOperations(trimmedOps);
            });

        } catch (error) {
            console.error(`[ModelStore ${storeIdForLog}] Failed to sync ground truth:`, error);
        } finally {
             runInAction(() => {
                this.isSyncing = false;
            });
        }
    }
}