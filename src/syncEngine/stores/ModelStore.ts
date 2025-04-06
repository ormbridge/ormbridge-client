import { v7 as uuidv7 } from "uuid";
import { IndexedDBStorage } from '../persistence/IndexedDBStorage'
import { getStoreKey } from './utils'

export type OperationType = 'create' | 'update' | 'delete';
export type OperationStatus = 'inflight' | 'confirmed' | 'rejected';

export interface OperationData<T extends Record<string, any>> {
    operationId?: string;
    type: OperationType;
    status?: OperationStatus;
    instances: T | T[];
    timestamp?: number;
}

export class Operation<T extends Record<string, any>> {
    public operationId: string;
    public type: OperationType;
    public status: OperationStatus;
    public instances: T[];
    public timestamp: number;

    constructor(data: OperationData<T>) {
        this.operationId = data.operationId || `op_${uuidv7()}`;
        this.type = data.type;
        this.status = data.status || 'inflight';
        this.instances = Array.isArray(data.instances) ? data.instances : [data.instances];
        this.timestamp = data.timestamp || Date.now();
    }
}

export interface ModelClass<T extends Record<string, any>> {
    primaryKeyField: keyof T;
    configKey: string;
    modelName: string;
}

export type FetchFunction<T extends Record<string, any>> = (params: { pks: any[] }) => Promise<T[]>;



export class ModelStore<T extends Record<string, any>> {
    public modelClass: ModelClass<T>;
    public fetchFunction: FetchFunction<T>;
    public groundTruthArray: T[];
    public operations: Operation<T>[];
    public isSyncing: boolean;
    public isReady: boolean;

    private _storage: IndexedDBStorage;
    private _storeKey: string;
    private _operationsKey: string;
    private _groundTruthKey: string;

    constructor(modelClass: ModelClass<T>, fetchFunction: FetchFunction<T>, storage: IndexedDBStorage) {       
        this.modelClass = modelClass;
        this.fetchFunction = fetchFunction;
        this.groundTruthArray = [];
        this.operations = [];
        this.isSyncing = false;
        this.isReady = false;

        // Set up key names
        this._storeKey = getStoreKey(modelClass);
        this._operationsKey = `modelstore::${this._storeKey}::operations`;
        this._groundTruthKey = `modelstore::${this._storeKey}::groundtruth`;
        
        // Store the provided storage instance
        this._storage = storage;
        this._hydrate()
    }

    async _hydrate(): Promise<void> {
        try {
            // Load persisted operations and ground truth.
            const persistedOps = await this._storage.load(this._operationsKey);
            const persistedGT = await this._storage.load(this._groundTruthKey);
            
            if (persistedOps && persistedOps.data) {
                this.operations = persistedOps.data || [];
            }
            if (persistedGT && persistedGT.data) {
                this.groundTruthArray = persistedGT.data || [];
            }
            this.isReady = true;
        } catch (error) {
            console.error("Hydration error:", error);
            // Optionally mark as ready anyway if hydration fails.
            this.isReady = true;
        }
    }

    get pkField(): keyof T {
        return this.modelClass.primaryKeyField;
    }

    get groundTruthPks(): any[] {
        // Returns the primary keys of the ground truth instances
        return this.groundTruthArray.map(instance => instance[this.pkField]);
    }

    addOperation(operation: Operation<T>): void {
        this.operations.push(operation);
        this._storage
            .save({ id: this._operationsKey, data: this.operations })
            .catch(error => console.error("Failed to persist operations:", error));
    }

    updateOperation(operation: Operation<T>): boolean {
        let existing = this.operations.findIndex(op => op.operationId === operation.operationId);
        if (existing !== -1) {
            this.operations[existing] = new Operation<T>({
                ...this.operations[existing],
                status: operation.status,
                instances: operation.instances,
                timestamp: operation.timestamp
            });
            
            // Persist the updated operations
            this._storage
                .save({ id: this._operationsKey, data: this.operations })
                .catch(error => console.error("Failed to persist updated operations:", error));
                
            return true;
        }
        return false;
    }

    confirm(operationId: String, instances: T[]): void {
        // helper wrapper around updateOperation to confirm the operation
        this.updateOperation(new Operation<T>({
            operationId: operationId,
            status: 'confirmed',
            instances: instances,
            timestamp: Date.now()
        } as OperationData<T>));
    }

    reject(operationId: String, instances: T[]): void {
        // helper wrapper around updateOperation to reject the operation
        this.updateOperation(new Operation<T>({
            operationId: operationId,
            status: 'rejected',
            timestamp: Date.now()
        } as OperationData<T>));
    }

    setOperations(operations: Operation<T>[]): void {
        this.operations = operations;
        
        // Persist the operations
        this._storage
            .save({ id: this._operationsKey, data: this.operations })
            .catch(error => console.error("Failed to persist operations:", error));
    }

    setGroundTruth(groundTruth: T[]): void {
        this.groundTruthArray = groundTruth;
        this._storage
            .save({ id: this._groundTruthKey, data: this.groundTruthArray })
            .catch(error => console.error("Failed to persist ground truth:", error));
    }

    filteredOperations(pks: Set<any> | null, operations: Operation<T>[]): Map<string, Operation<T>> | Operation<T>[] {
        if (!pks) return operations;

        let filteredOperationsMap = new Map<string, Operation<T>>();
        for (const op of operations) {
            let instances = op.instances.filter(instance => pks.has(instance[this.pkField]));
            if (instances.length > 0) {
                filteredOperationsMap.set(op.operationId, new Operation<T>({
                    ...op,
                    instances: instances
                }));
            }
        }
        return filteredOperationsMap;
    }

    filteredGroundTruth(pks: Set<any> | null, groundTruthArray: T[]): Map<any, T> {
        if (pks) {
            groundTruthArray = groundTruthArray.filter(instance => pks.has(instance[this.pkField]));
        }

        let groundTruthMap = groundTruthArray.reduce((acc, item) => {
            acc.set(item[this.pkField], item);
            return acc;
        }, new Map<any, T>());

        return groundTruthMap;
    }

    render(pks: Set<any> | null = null): T[] {
        if (!this.isReady) throw new Error('ModelStore is not ready yet');
        const filteredGroundTruthMap = this.filteredGroundTruth(pks, this.groundTruthArray);
        const filteredOperationsMap = this.filteredOperations(pks, this.operations);
        for (const op of filteredOperationsMap.values()) {
            if (op.status !== 'rejected') {
                this.applyOperation(op, filteredGroundTruthMap);
            }
        }
        return Array.from(filteredGroundTruthMap.values());
    }

    applyOperation(operation: Operation<T>, groundTruth: Map<any, T>): Map<any, T> {
        for (const instance of operation.instances) {
            const pk = instance[this.pkField];
            switch (operation.type) {
                case 'create':
                    if (!groundTruth.has(pk)) {
                        groundTruth.set(pk, instance);
                    }
                    break;
                case 'update':
                    if (groundTruth.has(pk)) {
                        // Merge existing instance with updates
                        groundTruth.set(pk, { ...groundTruth.get(pk), ...instance });
                    } else {
                        // Upsert behavior: Check if there are any delete operations for this pk
                        const hasDeleteOperation = this.operations.some(op => 
                            op.type === 'delete' && 
                            op.status !== 'rejected' && 
                            op.instances.some(inst => inst[this.pkField] === pk)
                        );
                        
                        // Only upsert if there's no delete operation for this item
                        if (!hasDeleteOperation) {
                            groundTruth.set(pk, instance);
                        }
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
        const currentTime = Date.now();
        return this.operations.filter(operation => operation.timestamp > currentTime - 1000 * 60 * 2);
    }

    async sync(): Promise<void> {
        if (this.isSyncing) throw new Error('Already syncing, cannot sync again');
        this.isSyncing = true;

        try {
            const newGroundTruth = await this.fetchFunction({ pks: this.groundTruthPks });
            this.groundTruthArray = newGroundTruth;
            this.operations = this.getTrimmedOperations();
            this.isSyncing = false;
            return;
        } catch (error: any) {
            this.isSyncing = false;
            throw new Error(`Failed to sync ground truth: ${error.message}`);
        }
    }
}