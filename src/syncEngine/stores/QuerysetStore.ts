import { v7 as uuidv7 } from "uuid";
import { getStoreKey } from './utils';
import { IndexedDBStorage } from '../persistence/IndexedDBStorage';
import hash from 'object-hash';

export type FetchFunction<T extends Record<string, any>> = (params: { ast: object, modelClass: any }) => Promise<T[]>;

export type OperationType = 'create' | 'update' | 'delete' | 'update_or_create' | 'get_or_create';
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

export class QuerysetStore<T extends Record<string, any>> {
    private modelClass: ModelClass<T>;
    private fetchFn: Function;
    private ast: object;
    private operations: any[] = [];
    private groundTruth: any[] = [];
    public isReady: boolean;
    public isSyncing: boolean;
    private _storage: IndexedDBStorage;
    private _storeKey: string;
    private _operationsKey: string;
    private _groundTruthKey: string;
    private _initPromise: Promise<void>;

    constructor(modelClass: ModelClass<T>, fetchFn: Function, ast: object, storage: IndexedDBStorage) {
        this.modelClass = modelClass;
        this.fetchFn = fetchFn;
        this.ast = ast;
        this.operations = [];
        this.groundTruth = [];
        this.isReady = false;
        this.isSyncing = false;
        this._storage = storage;
        this._storeKey = `${getStoreKey(modelClass)}::querysetstore::${this.getASTHash(ast)}`
        this._operationsKey = `${this._storeKey}::operations`;
        this._groundTruthKey = `${this._storeKey}::groundtruth`;
        this._initPromise = this._hydrate();
    }

    async whenReady() {
        await this._initPromise;
        return this;
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
                this.groundTruth = persistedGT.data || [];
            }
            this.isReady = true;
        } catch (error) {
            console.error("Hydration error:", error);
            // Optionally mark as ready anyway if hydration fails.
            this.isReady = true;
        }
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

    setGroundTruth(groundTruth: T[]): void {
        this.groundTruth = groundTruth.map(instance => instance[this.pkField] || instance)
        this._storage
        .save({ id: this._groundTruthKey, data: this.groundTruth })
        .catch(error => console.error("Failed to persist ground truth:", error));
    }

    setOperations(operations: Operation<T>[]): void {
        this.operations = operations;
        
        // Persist the operations
        this._storage
            .save({ id: this._operationsKey, data: this.operations })
            .catch(error => console.error("Failed to persist operations:", error));
    }

    getASTHash(ast: object): string {
        return hash(ast);
    }

    get pkField() {
        return this.modelClass.primaryKeyField;
    }

    get operationsMap() {
        return this.operations.reduce((acc, op) => {
            const key = op.operationId;
            acc.set(key, op);
            return acc;
        }, new Map());
    }

    get groundTruthSet() {
        // For the queryset its just an array of the pks, not the full objects
        return new Set(this.groundTruth)
    }

    render(): T[] {
        let groundTruth = this.groundTruthSet;
        for (const op of this.operationsMap.values()) {
            if (op.status !== 'rejected') {
                this.applyOperation(op, groundTruth);
            }
        }
        return Array.from(groundTruth.values());
    }

    applyOperation(operation: Operation<T>, groundTruth: Set<any>): Set<any> {
        for (const instance of operation.instances) {
            const pk = instance[this.pkField];
            switch (operation.type) {
                case 'create':
                case 'get_or_create':
                    if (!groundTruth.has(pk)) {
                        groundTruth.add(pk);
                    }
                    break;
                case 'update':
                case 'update_or_create':
                    if (groundTruth.has(pk)) {
                        break
                    } else {
                        // Upsert behavior: Check if there are any delete operations for this pk
                        const hasDeleteOperation = this.operations.some(op => 
                            op.type === 'delete' && 
                            op.status !== 'rejected' && 
                            op.instances.some(inst => inst[this.pkField] === pk)
                        );
                        
                        // Only upsert if there's no delete operation for this item
                        if (!hasDeleteOperation) {
                            groundTruth.add(pk);
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
            const newGroundTruth = await this.fetchFn({ ast: this.ast });
            this.groundTruth = newGroundTruth;
            this.operations = this.getTrimmedOperations();
            this.isSyncing = false;
            return;
        } catch (error: any) {
            this.isSyncing = false;
            throw new Error(`Failed to sync ground truth: ${error.message}`);
        }
    }

}