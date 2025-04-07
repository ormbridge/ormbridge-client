import { v7 as uuidv7 } from "uuid";
import { IndexedDBStorage } from '../persistence/IndexedDBStorage'
import { getStoreKey } from './utils'
import { OperationType, OperationStatus, OperationData, Operation } from './operation'

export interface ModelClass<T extends Record<string, any>> {
    primaryKeyField: keyof T;
    configKey: string;
    modelName: string;
}

export type FetchFunction<T extends Record<string, any>> = (params: { pks: any[], modelClass: any }) => Promise<T[]>;



export class ModelStore<T extends Record<string, any>> {
    public modelClass: ModelClass<T>;
    public fetchFn: FetchFunction<T>;
    public groundTruthArray: T[];
    public operations: Operation<T>[];
    public isSyncing: boolean;

    private _storage: IndexedDBStorage;
    private _storeKey: string;
    private _operationsKey: string;
    private _groundTruthKey: string;


    constructor(
        modelClass: ModelClass<T>,
        fetchFn: FetchFunction<T>,
        storage: IndexedDBStorage,
        initialGroundTruth: T[],
        initialOperations: OperationData<T>[]
    ) {
        this.modelClass = modelClass;
        this.fetchFn = fetchFn;
        this.isSyncing = false;

        this._storeKey = getStoreKey(modelClass);
        this._operationsKey = `modelstore::${this._storeKey}::operations`;
        this._groundTruthKey = `modelstore::${this._storeKey}::groundtruth`;

        this._storage = storage;

        this.groundTruthArray = initialGroundTruth ? initialGroundTruth : [];
        this.operations = initialOperations ? initialOperations.map(opData => new Operation<T>(opData)) : [];
    }

    get pkField(): keyof T {
        return this.modelClass.primaryKeyField;
    }

    get groundTruthPks(): any[] {
        return this.groundTruthArray.map(instance => instance[this.pkField]);
    }

    private _persistOperations(): void {
        this._storage
            .save({ id: this._operationsKey, data: this.operations })
            .catch(error => console.error("Failed to persist operations:", error));
    }

    private _persistGroundTruth(): void {
         this._storage
            .save({ id: this._groundTruthKey, data: this.groundTruthArray })
            .catch(error => console.error("Failed to persist ground truth:", error));
    }

    // used for optimistic behaviour

    addOperation(operation: Operation<T>): void {
        this.operations.push(operation);
        this._persistOperations();
    }

    updateOperation(operation: Operation<T>): boolean {
        let existingIndex = this.operations.findIndex(op => op.operationId === operation.operationId);
        if (existingIndex !== -1) {
             this.operations[existingIndex] = operation;

            this._persistOperations();
            return true;
        }
        return false;
    }

    confirm(operationId: string, instances: T[]): void {
        const opIndex = this.operations.findIndex(op => op.operationId === operationId);
        if (opIndex !== -1) {
            const opToConfirm = this.operations[opIndex];
            opToConfirm.status = 'confirmed';
            opToConfirm.instances = instances;
            opToConfirm.timestamp = Date.now();
            this._persistOperations();
        } else {
             console.warn(`Attempted to confirm non-existent operation: ${operationId}`);
        }
    }

    reject(operationId: string): void {
        const opIndex = this.operations.findIndex(op => op.operationId === operationId);
         if (opIndex !== -1) {
            const opToReject = this.operations[opIndex];
            opToReject.status = 'rejected';
            opToReject.timestamp = Date.now();
            this._persistOperations();
        } else {
            console.warn(`Attempted to reject non-existent operation: ${operationId}`);
        }
    }

    setOperations(operations: Operation<T>[]): void {
        this.operations = operations;
        this._persistOperations();
    }

    // used for caching data returned by the backend

    setGroundTruth(groundTruth: T[]): void {
        this.groundTruthArray = groundTruth;
        this._persistGroundTruth();
    }

    addToGroundTruth(instances: T[]): void {
        if (!instances?.length) return;

        const pkMap = new Map(instances.map(i => [i[this.pkField], i]));

        const updatedGroundTruth: T[] = [];
        const existingPks = new Set();

        for (const item of this.groundTruthArray) {
            const pk = item[this.pkField];
            existingPks.add(pk);
            if (pkMap.has(pk)) {
                updatedGroundTruth.push({ ...item, ...pkMap.get(pk) });
                pkMap.delete(pk);
            } else {
                updatedGroundTruth.push(item);
            }
        }

        updatedGroundTruth.push(...Array.from(pkMap.values()));

        this.groundTruthArray = updatedGroundTruth;
        this._persistGroundTruth();
    }

    async sync(): Promise<void> {
        if (this.isSyncing) {
            console.warn('Already syncing, sync request ignored.');
            return;
        }
        this.isSyncing = true;

        try {
            const currentPks = this.groundTruthPks;
            const newGroundTruth = await this.fetchFn({ pks: currentPks, modelClass: this.modelClass });

            this.setGroundTruth(newGroundTruth);

            const trimmedOps = this.getTrimmedOperations();
            this.setOperations(trimmedOps);

            console.log(`Sync completed for ${this.modelClass.modelName}.`);

        } catch (error: any) {
            console.error(`Failed to sync ground truth for ${this.modelClass.modelName}:`, error);
        } finally {
             this.isSyncing = false;
        }
    }


    // Rendering

    private filteredOperations(pks: Set<any> | null, operations: Operation<T>[]): Operation<T>[] {
        if (!pks) return operations;

        let filteredOps: Operation<T>[] = [];
        for (const op of operations) {
            let relevantInstances = op.instances.filter(instance => pks.has(instance[this.pkField]));
            if (relevantInstances.length > 0) {
                 filteredOps.push(new Operation<T>({
                    ...op,
                    instances: relevantInstances
                }));
            }
        }
        return filteredOps;
    }

    private filteredGroundTruth(pks: Set<any> | null, groundTruthArray: T[]): Map<any, T> {
        let filteredArray = groundTruthArray;
        if (pks) {
            filteredArray = groundTruthArray.filter(instance => pks.has(instance[this.pkField]));
        }

        let groundTruthMap = filteredArray.reduce((acc, item) => {
            acc.set(item[this.pkField], item);
            return acc;
        }, new Map<any, T>());

        return groundTruthMap;
    }

    applyOperation(operation: Operation<T>, groundTruth: Map<any, T>): Map<any, T> {
        for (const instance of operation.instances) {
            const pk = instance[this.pkField];
            switch (operation.type) {
                case 'create':
                case 'get_or_create':
                    if (!groundTruth.has(pk)) {
                        groundTruth.set(pk, instance);
                    }
                    break;
                case 'update':
                    if (groundTruth.has(pk)) {
                        groundTruth.set(pk, { ...groundTruth.get(pk), ...instance });
                    } else {
                        const hasDeleteOperation = this.operations.some(op => 
                            op.type === 'delete' && 
                            op.status !== 'rejected' && 
                            op.instances.some(inst => inst[this.pkField] === pk)
                        );
                        
                        if (!hasDeleteOperation) {
                            groundTruth.set(pk, instance);
                        }
                    }
                    break;
                    case 'update_or_create':
                        if (groundTruth.has(pk)) {
                            groundTruth.set(pk, { ...groundTruth.get(pk)!, ...instance });
                        } else {
                            groundTruth.set(pk, instance);
                        }
                        break;
                case 'delete':
                    if (groundTruth.has(pk)) {
                        groundTruth.delete(pk);
                    }
                    break;
                default:
                    throw new Error(`Unknown operation type: ${operation.type}`);
            }
        }
        return groundTruth;
    }

    getTrimmedOperations(): Operation<T>[] {
        const twoMinutesAgo = Date.now() - 1000 * 60 * 2;
        return this.operations.filter(operation => operation.timestamp > twoMinutesAgo);
    }

    render(pks: Set<any> | null = null): T[] {
        const filteredGroundTruthMap = this.filteredGroundTruth(pks, this.groundTruthArray);
        const filteredOperationsMap = this.filteredOperations(pks, this.operations);
        for (const op of filteredOperationsMap.values()) {
            if (op.status !== 'rejected') {
                this.applyOperation(op, filteredGroundTruthMap);
            }
        }
        return Array.from(filteredGroundTruthMap.values());
    }
}