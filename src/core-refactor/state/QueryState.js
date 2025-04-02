import { v7 as uuidv7 } from "uuid";

/**
 * Operation class represents a single change to the data
 */
export class Operation {
  constructor(data = {}) {
    this.operationId = data.operationId || `op_${uuidv7()}`;
    this.type = data.type; // 'create', 'update', 'delete'
    this.status = data.status || 'inflight'; // 'inflight', 'confirmed', 'rejected'
    this.instances = Array.isArray(data.instances) ? data.instances : [data.instances];
    this.timestamp = data.timestamp || Date.now();
  }
}

export class QueryState {
  constructor(options) {
    this.pkField = options.primaryKey;
    this.ItemClass = options.ItemClass;
    this.fetchGroundTruth = options.fetchGroundTruth;
    this.syncInterval = options.syncInterval || 30000; // 30 seconds default
    
    // Configuration for operation management
    this.maxOperationAge = options.maxOperationAge || 15 * 1000; // Default: 15 seconds
    
    this.groundTruth = [];
    this.operations = new Map(); // id -> Operation 
    this.version = 0;
    
    // Sync state
    this.lastSyncTime = 0;
    this.isSyncing = false;
    this.syncTimer = null;
    
    // Subscription system
    this.subscribers = new Map(); // subscriber ID -> { callback, eventTypes }
    this.nextSubscriberId = 1;
    
    // Start periodic sync if interval provided and fetch function exists
    if (this.syncInterval > 0 && typeof this.fetchGroundTruth === 'function') {
      this._startPeriodicSync();
    }
  }

  // Core data access methods
  getGroundTruth() {
    return [...this.groundTruth];
  }
  
  // Main operation methods
  add(opData) {
    const op = new Operation(opData);
    this.operations.set(op.operationId, op);
    this.version++;
    
    this._notify('operation_added', { operation: op });
    
    return op.operationId;
  }
  
  update(opId, changes) {
    const op = this.operations.get(opId);
    if (!op) return false;
    
    const oldStatus = op.status;
    Object.assign(op, changes);
    this.version++;
    
    this._notify('operation_updated', { 
      operation: op,
      changes,
      oldStatus
    });
    
    if (oldStatus !== op.status) {
      this._notify('status_changed', {
        operation: op,
        oldStatus,
        newStatus: op.status
      });
    }
    
    return true;
  }

  /**
   * Confirm an operation with final instances data
   * @param {string} opId - Operation ID to confirm
   * @param {Array} [instances] - Final list of instances (optional)
   * @returns {boolean} True if the operation was found and updated
   */
  confirm(opId, instances) {
    const op = this.operations.get(opId);
    if (!op) return false;
    
    const changes = { status: 'confirmed' };
    
    // If instances are provided, update them
    if (instances !== undefined) {
      changes.instances = Array.isArray(instances) ? instances : [instances];
    }
    
    return this.update(opId, changes);
  }

  /**
   * Reject an operation
   * @param {string} opId - Operation ID to reject
   * @returns {boolean} True if the operation was found and updated
   */
  reject(opId) {
    return this.update(opId, { status: 'rejected' });
  }
  
  // Set ground truth directly (used internally)
  _setGroundTruth(data) {
    this.groundTruth = data.map(item => 
      this.ItemClass ? new this.ItemClass(item) : { ...item }
    );
    this.version++;
    this._notify('ground_truth_updated', { groundTruth: this.groundTruth });
  }
  
  // Subscription system
  subscribe(callback, eventTypes = null) {
    const id = this.nextSubscriberId++;
    this.subscribers.set(id, {
      callback,
      eventTypes
    });
    
    // Return unsubscribe function
    return () => {
      this.subscribers.delete(id);
    };
  }
  
  _notify(eventType, data) {
    // Combine event data with version
    const eventData = {
      ...data,
      version: this.version
    };
    
    // Notify appropriate subscribers
    for (const [, subscriber] of this.subscribers) {
      const { callback, eventTypes } = subscriber;
      
      // If subscriber listens to all events or specifically to this event type
      if (!eventTypes || eventTypes.includes(eventType)) {
        try {
          callback(eventType, eventData, this);
        } catch (error) {
          console.error('Error in subscriber callback:', error);
        }
      }
    }
  }
  
  // Sync management
  
  /**
   * Start periodic sync
   * @private
   */
  _startPeriodicSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    
    this.syncTimer = setInterval(() => {
      this.sync();
    }, this.syncInterval);
  }
  
  /**
   * Stop periodic sync
   */
  stopSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }
  
  /**
   * Trim operations based on age
   * @private
   */
  _trimOperations() {
    const now = Date.now();
    
    // Remove any operations that are older than the configured age
    // Skip 'inflight' operations as they still need to be processed
    for (const [id, op] of this.operations.entries()) {
      if (op.status !== 'inflight' && now - op.timestamp > this.maxOperationAge) {
        this.operations.delete(id);
        this._notify('operation_removed', { operationId: id, reason: 'age' });
      }
    }
  }
  
  /**
   * Sync with backend
   * @returns {Promise<boolean>} True if sync was successful
   */
  async sync() {
    if (this.isSyncing || !this.fetchGroundTruth) return false;
    
    try {
      this.isSyncing = true;
      this._notify('sync_started', {});
      
      // Fetch fresh data
      const freshData = await this.fetchGroundTruth();
      
      // Update ground truth
      this._setGroundTruth(freshData);
      
      // Trim operations instead of deleting all non-inflight ones
      this._trimOperations();
      
      this.lastSyncTime = Date.now();
      
      this._notify('sync_completed', { 
        success: true,
        time: this.lastSyncTime
      });
      
      return true;
    } catch (error) {
      this._notify('sync_error', { error });
      return false;
    } finally {
      this.isSyncing = false;
    }
  }
  
  /**
   * Force an immediate sync
   * @returns {Promise<boolean>} True if sync was successful
   */
  forceSync() {
    return this.sync();
  }
  
  /**
   * Clean up resources when this QueryState is no longer needed
   */
  destroy() {
    this.stopSync();
    this.subscribers.clear();
  }
}