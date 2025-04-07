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