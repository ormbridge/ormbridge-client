import { v7 as uuidv7 } from 'uuid';
import { ModelStore } from './ModelStore'
import { QuerysetStore } from './QuerysetStore'

export type OperationType = 'create' | 'update' | 'delete' | 'read' | 'list' | 'get_or_create' | 
                           'update_or_create' | 'first' | 'last' | 'min' | 'max' | 'count' | 
                           'sum' | 'avg' | 'exists' | 'search';
export type OperationStatus = 'inflight' | 'confirmed' | 'rejected';
export type OperationCategory = 'mutation' | 'read' | 'read::agg';

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

export interface QueryAst {
    type?: OperationType;
    filter?: any;
    search?: { searchQuery: string; searchFields?: string[] };
    aggregations?: any[];
    selectRelated?: string[];
    prefetchRelated?: string[];
    orderBy?: any;
    serializerOptions?: any;
    data?: any;
    lookup?: any;
    defaults?: any;
    field?: string;
}

export class StateZeroStore<T extends Record<string, any>> {
    private modelStore: ModelStore<T>;
    private querysetStore: QuerysetStore<T>;
    public modelFetchFn: Function;
    public querysetFetchFn: Function;

    constructor(modelStore: ModelStore<T>, querysetStore: QuerysetStore<T>, modelFetchFn: Function, querysetFetchFn: Function){
        this.modelStore = modelStore;
        this.querysetStore = querysetStore;
        this.modelFetchFn = modelFetchFn;
        this.querysetFetchFn = querysetFetchFn;
    }

    getOperationType(ast: QueryAst, isMaterialized: boolean): OperationType {
        // Check if the query is materialized
        if (!isMaterialized) throw new Error("Cannot execute a non-materialized query. Call a terminal operation first.");
        if (!ast.type) throw new Error("Cannot execute a query without a type");
        return ast.type;
    }

    getOperationCategory(operationType: OperationType): OperationCategory {
        switch(operationType) {
            case 'create':
            case 'delete':
            case 'update':
            case 'update_or_create':
            case 'get_or_create':
                return 'mutation';
            case 'first':
            case 'last':
            case 'list':
            case 'read':
            case 'search':
                return 'read';
            case 'min':
            case 'max':
            case 'count':
            case 'sum':
            case 'avg':
            case 'exists':
                return 'read::agg';
            default:
                throw new Error(`Unknown operation type: ${operationType}`);
        }
    }

    async commit(ast: QueryAst, optimistic: boolean = false) {
        // The main thing, it commits an ast to the store...
        let operationType = this.getOperationType(ast, true); // Assuming the query is materialized
        let operationCategory = this.getOperationCategory(operationType);
        let result;
        
        switch (operationCategory) {
            case 'mutation':
                result = await this.handleMutation(ast, optimistic);
                break;
            case 'read':
                result = await this.handleReadOperation(ast, optimistic);
                break;
            case 'read::agg':
                result = await this.handleReadAggregation(ast, optimistic);
                break;
        }
        
        return result;
    }

    async handleReadOperation(ast: QueryAst, optimistic: boolean) {
        // handles read, list, first, last etc.
        // Implementation details here
    }

    async handleReadAggregation(ast: QueryAst, optimistic: boolean) {
        // sum, max, min, exists etc.
        // Implementation details here
    }

    async handleMutation(ast: QueryAst, optimistic: boolean) {
        // handles create, update, delete etc.
        // Implementation details here
    }
}