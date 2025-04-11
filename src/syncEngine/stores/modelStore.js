import { Operation } from './operation.js';
import { makeObservable, observable, action, computed, reaction } from 'mobx';
import { computedFn } from 'mobx-utils';
import sift from 'sift';
import { isNil } from 'lodash-es'

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

    getGroundTruth(){
        return this.groundTruthArray
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
                pks.has(instance[pkField] || instance)
            );
            if (relevantInstances.length > 0) {
                 filteredOps.push({
                    operationId: op.operationId,
                    instances: relevantInstances,
                    timestamp: op.timestamp,
                    queryset: op.queryset,
                    type: op.type,
                    status: op.status,
                    args: op.args
                 });
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

    /**
     * Handles get_or_create operation in optimistic updates
     * 
     * @param {Object} operation - The operation object
     * @param {Map} currentInstances - Map of current instances
     * @param {Object} instance - Current instance being processed
     * @param {any} pk - Primary key of the instance
     * @private
     */
    _handleGetOrCreate(operation, currentInstances, instance, pk) {
        if (!operation.args?.lookup) {
            // Lookup is required for get_or_create, do nothing if not provided
            console.warn(`[ModelStore ${this.modelClass.modelName}] Missing required lookup fields for get_or_create operation ${operation.operationId}. Operation will be ignored for optimistic updates.`);
            return;
        }
        
        const pkField = this.pkField;
        const lookup = operation.args.lookup;
        const defaults = operation.args.defaults || {};
        
        // Try to find an existing instance that matches all lookup fields
        const matchingInstance = this._findMatchingInstance(currentInstances, lookup);

        if (isNil(matchingInstance)) {
            // No matching instance found, create a new one
            const newInstance = { ...lookup, ...defaults, [pkField]: pk };
            currentInstances.set(pk, newInstance);
        }
        // If matching instance found, do nothing (get_or_create doesn't modify existing)
    }

    /**
     * Handles update_or_create operation in optimistic updates
     * 
     * @param {Object} operation - The operation object
     * @param {Map} currentInstances - Map of current instances
     * @param {Object} instance - Current instance being processed
     * @param {any} pk - Primary key of the instance
     * @private
     */
    _handleUpdateOrCreate(operation, currentInstances, instance, pk) {
        if (!operation.args?.lookup) {
            // Lookup is required for update_or_create, do nothing if not provided
            console.warn(`[ModelStore ${this.modelClass.modelName}] Missing required lookup fields for update_or_create operation ${operation.operationId}. Operation will be ignored for optimistic updates.`);
            return;
        }
        
        const pkField = this.pkField;
        const lookup = operation.args.lookup;
        const defaults = operation.args.defaults || {};
        
        // Try to find an existing instance that matches all lookup fields
        const matchResult = this._findMatchingInstance(currentInstances, lookup, true);
        
        if (matchResult.instance) {
            // Found matching instance, update it with defaults
            currentInstances.set(matchResult.key, { ...matchResult.instance, ...defaults });
        } else {
            // No matching instance found, create a new one
            const newInstance = { ...lookup, ...defaults, [pkField]: pk };
            currentInstances.set(pk, newInstance);
        }
    }

    /**
     * Finds an instance matching lookup criteria using sift.js
     * 
     * @param {Map} currentInstances - Map of current instances
     * @param {Object} lookup - Lookup fields to match
     * @returns {Object} - Object containing matching instance and its key, or nulls if no match
     * @private
     */
    _findMatchingInstance(currentInstances, lookup) {
        // Convert instances Map to array of [key, instance] pairs
        const instancesArray = Array.from(currentInstances.entries());
        
        // Use sift.js to find the first matching instance
        const matchingPair = instancesArray.find(([_, instance]) => sift(lookup)(instance));
        
        if (matchingPair) {
            return {
                key: matchingPair[0],
                instance: matchingPair[1]
            };
        }
        
        return null
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
                    if (!currentInstances.has(pk)) {
                        currentInstances.set(pk, instance);
                    }
                    break;
                case 'get_or_create':
                    this._handleGetOrCreate(operation, currentInstances, instance, pk);
                    break;
                case 'update_instance':
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
                    this._handleUpdateOrCreate(operation, currentInstances, instance, pk);
                    break;
                }
                case 'delete_instance':
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

    // caching - store the render result, with the pks used to generate it in a cache

    render(pks = null) {
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

    // syncing with the server

    async sync() {
        const storeIdForLog = this.modelClass.modelName;
        if (this.isSyncing) return;
        this.isSyncing = true;

        try {
            const currentPks = this.groundTruthPks;
            if (currentPks.length === 0) {
                 const trimmedOps = this.getTrimmedOperations();
                 this.setOperations(trimmedOps);
                 return;
            }

            const newGroundTruth = await this.fetchFn({ pks: currentPks, modelClass: this.modelClass });
            this.setGroundTruth(newGroundTruth);
            
            const trimmedOps = this.getTrimmedOperations();
            this.setOperations(trimmedOps);

        } catch (error) {
            console.error(`[ModelStore ${storeIdForLog}] Failed to sync ground truth:`, error);
        } finally {
             this.isSyncing = false;
        }
    }
}