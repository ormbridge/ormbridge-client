import { operationEvents, OperationEventTypes } from './operation.js';
import { modelStoreRegistry } from '../registries/modelStoreRegistry.js';
import { querysetStoreRegistry } from '../registries/querysetStoreRegistry.js';
import { metricStoreRegistry } from '../registries/metricStoreRegistry.js';

/**
 * Initialize the operation event handler system by setting up event listeners
 */
export function initEventHandler() {
  // Handler for operation creation
  operationEvents.on(OperationEventTypes.CREATED, handleOperationCreated);
  
  // Handler for operation updates
  operationEvents.on(OperationEventTypes.UPDATED, handleOperationUpdated);
  
  // Handler for operation confirmations
  operationEvents.on(OperationEventTypes.CONFIRMED, handleOperationConfirmed);
  
  // Handler for operation rejections
  operationEvents.on(OperationEventTypes.REJECTED, handleOperationRejected);

  // Handler for operation mutations
  operationEvents.on(OperationEventTypes.MUTATED, handleOperationMutated);
  
  console.log('Operation event handler initialized');
}

/**
 * Clean up by removing all event listeners
 */
export function cleanupEventHandler() {
  operationEvents.off(OperationEventTypes.CREATED, handleOperationCreated);
  operationEvents.off(OperationEventTypes.UPDATED, handleOperationUpdated);
  operationEvents.off(OperationEventTypes.CONFIRMED, handleOperationConfirmed);
  operationEvents.off(OperationEventTypes.REJECTED, handleOperationRejected);
  operationEvents.off(OperationEventTypes.MUTATED, handleOperationMutated);
  
  console.log('Operation event handler cleaned up');
}

/**
 * Handle an operation that was directly updated via updateOperation
 * @param {Operation} operation - The operation that was updated
 */
function handleOperationMutated(operation) {
  if (!operation || !operation.queryset || !operation.queryset.ModelClass) return;
  
  const ModelClass = operation.queryset.ModelClass;
  
  // Update in ModelStore
  const modelStore = modelStoreRegistry.getStore(ModelClass);
  if (modelStore) {
    modelStore.updateOperation(operation);
  }
  
  // For update and delete operations, apply to all querysets for this model
  // For create operations, only apply to the originating queryset
  if (operation.type === 'create') {
    // Update in originating QuerysetStore only
    const querysetStore = querysetStoreRegistry.getStore(operation.queryset);
    if (querysetStore) {
      querysetStore.updateOperation(operation);
    }
  } else if (operation.type === 'update' || operation.type === 'delete') {
    // Update in ALL QuerysetStores for this model
    const allQuerysetStores = querysetStoreRegistry.getAllStoresForModel(ModelClass);
    allQuerysetStores.forEach(store => {
      store.updateOperation(operation);
    });
  }
  
  console.log(`Operation mutated for ${ModelClass.modelName}:`, operation.operationId);
}

/**
 * Handle a newly created operation
 * @param {Operation} operation - The operation that was created
 */
function handleOperationCreated(operation) {
  if (!operation || !operation.queryset || !operation.queryset.ModelClass) {
    console.warn('Received invalid operation in handleOperationCreated', operation);
    return;
  }
  
  const ModelClass = operation.queryset.ModelClass;
  
  // Add to ModelStore (using existing registry)
  const modelStore = modelStoreRegistry.getStore(ModelClass);
  if (modelStore) {
    modelStore.addOperation(operation);
  }
  
  // For create operations, only add to the originating queryset
  // For all other operation types, add to all querysets for this model
  if (operation.type === 'create') {
    // Add to originating QuerysetStore only
    const querysetStore = querysetStoreRegistry.getStore(operation.queryset);
    if (querysetStore) {
      querysetStore.addOperation(operation);
    }
  } else {
    // Add to ALL QuerysetStores for this model
    const allQuerysetStores = querysetStoreRegistry.getAllStoresForModel(ModelClass);
    allQuerysetStores.forEach(store => {
      store.addOperation(operation);
    });
  }
  
  console.log(`Operation created for ${ModelClass.modelName}:`, operation.operationId);
}

/**
 * Handle an updated operation
 * @param {Operation} operation - The operation that was updated
 */
function handleOperationUpdated(operation) {
  if (!operation || !operation.queryset || !operation.queryset.ModelClass) return;
  
  const ModelClass = operation.queryset.ModelClass;
  
  // Update in ModelStore
  const modelStore = modelStoreRegistry.getStore(ModelClass);
  if (modelStore) {
    modelStore.updateOperation(operation);
  }
  
  // For create operations, only update in the originating queryset
  // For all other operation types, update in all querysets for this model
  if (operation.type === 'create') {
    // Update in originating QuerysetStore only
    const querysetStore = querysetStoreRegistry.getStore(operation.queryset);
    if (querysetStore) {
      querysetStore.updateOperation(operation);
    }
  } else {
    // Update in ALL QuerysetStores for this model
    const allQuerysetStores = querysetStoreRegistry.getAllStoresForModel(ModelClass);
    allQuerysetStores.forEach(store => {
      store.updateOperation(operation);
    });
  }
  
  console.log(`Operation updated for ${ModelClass.modelName}:`, operation.operationId);
}

/**
 * Handle a confirmed operation
 * @param {Operation} operation - The operation that was confirmed
 */
function handleOperationConfirmed(operation) {
  if (!operation || !operation.queryset || !operation.queryset.ModelClass) return;
  
  const ModelClass = operation.queryset.ModelClass;
  
  // Confirm in ModelStore
  const modelStore = modelStoreRegistry.getStore(ModelClass);
  if (modelStore) {
    modelStore.confirm(operation.operationId, operation.instances);
  }
  
  // For create operations, only confirm in the originating queryset
  // For all other operation types, confirm in all querysets for this model
  if (operation.type === 'create') {
    // Confirm in originating QuerysetStore only
    const querysetStore = querysetStoreRegistry.getStore(operation.queryset);
    if (querysetStore) {
      querysetStore.confirm(operation.operationId, operation.instances);
    }
  } else {
    // Confirm in ALL QuerysetStores for this model
    const allQuerysetStores = querysetStoreRegistry.getAllStoresForModel(ModelClass);
    allQuerysetStores.forEach(store => {
      store.confirm(operation.operationId, operation.instances);
    });
  }
  
  console.log(`Operation confirmed for ${ModelClass.modelName}:`, operation.operationId);
}

/**
 * Handle a rejected operation
 * @param {Operation} operation - The operation that was rejected
 */
function handleOperationRejected(operation) {
  if (!operation || !operation.queryset || !operation.queryset.ModelClass) return;
  
  const ModelClass = operation.queryset.ModelClass;
  
  // Reject in ModelStore
  const modelStore = modelStoreRegistry.getStore(ModelClass);
  if (modelStore) {
    modelStore.reject(operation.operationId);
  }
  
  // For create operations, only reject in the originating queryset
  // For all other operation types, reject in all querysets for this model
  if (operation.type === 'create') {
    // Reject in originating QuerysetStore only
    const querysetStore = querysetStoreRegistry.getStore(operation.queryset);
    if (querysetStore) {
      querysetStore.reject(operation.operationId);
    }
  } else {
    // Reject in ALL QuerysetStores for this model
    const allQuerysetStores = querysetStoreRegistry.getAllStoresForModel(ModelClass);
    allQuerysetStores.forEach(store => {
      store.reject(operation.operationId);
    });
  }
  
  console.log(`Operation rejected for ${ModelClass.modelName}:`, operation.operationId);
}