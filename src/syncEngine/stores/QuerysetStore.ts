import { v7 as uuidv7 } from "uuid";
import { getStoreKey } from './utils';
import { IndexedDBStorage } from '../persistence/IndexedDBStorage';
import hash from 'object-hash';

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

export type FetchFunction<T extends Record<string, any>> = (params: { ast: object, modelClass: ModelClass<T> }) => Promise<T[]>;

export class QuerysetStore<T extends Record<string, any>> {
    private modelClass: ModelClass<T>;
    private fetchFn: FetchFunction<T>;
    private ast: object;
    private operations: Operation<T>[];
    private groundTruthPks: any[];
    public isSyncing: boolean;
    private _storage: IndexedDBStorage;
    private _storeKey: string;
    private _operationsKey: string;
    private _groundTruthKey: string;

    constructor(
        modelClass: ModelClass<T>,
        fetchFn: FetchFunction<T>,
        ast: object,
        storage: IndexedDBStorage,
        initialGroundTruthPks: any[],
        initialOperations: OperationData<T>[]
    ) {
        this.modelClass = modelClass;
        this.fetchFn = fetchFn;
        this.ast = ast;
        this.isSyncing = false;
        this._storage = storage;

        this._storeKey = `${getStoreKey(modelClass)}::querysetstore::${this.getASTHash(ast)}`;
        this._operationsKey = `${this._storeKey}::operations`;
        this._groundTruthKey = `${this._storeKey}::groundtruth`;

        this.groundTruthPks = initialGroundTruthPks ? initialGroundTruthPks : [];
        this.operations = initialOperations ? initialOperations.map(opData => new Operation<T>(opData)) : [];
    }

    private _persistOperations(): void {
        this._storage
            .save({ id: this._operationsKey, data: this.operations })
            .catch(error => console.error("Failed to persist operations:", error));
    }

    private _persistGroundTruth(): void {
         this._storage
            .save({ id: this._groundTruthKey, data: this.groundTruthPks })
            .catch(error => console.error("Failed to persist ground truth:", error));
    }

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
            console.warn(`[QuerysetStore] Attempted to confirm non-existent operation: ${operationId}`);
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
            console.warn(`[QuerysetStore] Attempted to reject non-existent operation: ${operationId}`);
        }
    }


    setGroundTruth(groundTruthPks: any[]): void {
        this.groundTruthPks = groundTruthPks;
        this._persistGroundTruth();
    }

    setOperations(operations: Operation<T>[]): void {
        this.operations = operations;
        this._persistOperations();
    }

    getASTHash(ast: object): string {
        return hash(ast);
    }

    get pkField(): keyof T {
        return this.modelClass.primaryKeyField;
    }

    get groundTruthSet(): Set<any> {
        return new Set(this.groundTruthPks);
    }

    render(): any[] {
        let renderedPks = this.groundTruthSet;

        for (const op of this.operations) {
            if (op.status !== 'rejected') {
                this.applyOperation(op, renderedPks);
            }
        }
        return Array.from(renderedPks.values());
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
                    if (groundTruth.has(pk)) {
                        break;
                    } else {
                        const hasDeleteOperation = this.operations.some(op => 
                            op.type === 'delete' && 
                            op.status !== 'rejected' && 
                            op.instances.some(inst => inst[this.pkField] === pk)
                        );
                        
                        if (!hasDeleteOperation) {
                            groundTruth.add(pk);
                        }
                    }
                    break;
                case 'update_or_create':
                    if (!groundTruth.has(pk)) {
                        groundTruth.add(pk);
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

    async sync(): Promise<void> {
        if (this.isSyncing) {
            console.warn(`[QuerysetStore ${this._storeKey}] Already syncing, request ignored.`);
            return;
        }
        this.isSyncing = true;
         console.log(`[QuerysetStore ${this._storeKey}] Starting sync...`);

        try {
            const newGroundTruthInstances = await this.fetchFn({ ast: this.ast, modelClass: this.modelClass });

            const newGroundTruthPks = newGroundTruthInstances.map(instance => instance[this.pkField]);

            this.setGroundTruth(newGroundTruthPks);

            const trimmedOps = this.getTrimmedOperations();
            this.setOperations(trimmedOps);

            console.log(`[QuerysetStore ${this._storeKey}] Sync completed.`);

        } catch (error: any) {
            console.error(`[QuerysetStore ${this._storeKey}] Failed to sync ground truth:`, error);
        } finally {
            this.isSyncing = false;
        }
    }
}