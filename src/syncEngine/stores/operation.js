import { v7 as uuidv7 } from "uuid";

export class Operation {
    operationId;
    type;
    status;
    instances;
    timestamp;

    constructor(data) {
        if (!data || typeof data !== 'object') {
            throw new Error("Operation constructor requires a data object.");
        }
        if (!data.type) {
            throw new Error("Operation data must include a 'type'.");
        }
        if (!data.instances) {
            throw new Error("Operation data must include 'instances'.");
        }

        this.operationId = data.operationId || `op_${uuidv7()}`;
        this.type = data.type;
        this.status = data.status || 'inflight';
        this.instances = Array.isArray(data.instances) ? data.instances : [data.instances];
        this.timestamp = data.timestamp || Date.now();
    }
}