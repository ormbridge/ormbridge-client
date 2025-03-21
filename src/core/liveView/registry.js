// modelsync-client/src/core/liveView/registry.js
import { EventType, getEventReceiver } from '../eventReceivers.js';
import { activeOperationIds } from './utils.js';

/**
 * Default namespace resolver.
 * @param {string} modelName - The model name.
 * @returns {string} The resolved namespace.
 */
export const defaultNamespaceResolver = (modelName) => modelName;

/**
 * Registry to track active LiveQuerySet instances by namespace
 */
class LiveQueryRegistry {
  constructor() {
    /** @type {Map<string, Set<LiveQuerySet>>} */
    this.namespaceRegistry = new Map();
  }

  /**
   * Registers a LiveQuerySet under the given namespace.
   * @param {string} namespace
   * @param {LiveQuerySet} liveQuerySet
   */
  register(namespace, liveQuerySet) {
    if (!this.namespaceRegistry.has(namespace)) {
      this.namespaceRegistry.set(namespace, new Set());
    }
    this.namespaceRegistry.get(namespace).add(liveQuerySet);
  }

  /**
   * Unregisters a LiveQuerySet from the given namespace.
   * @param {string} namespace
   * @param {LiveQuerySet} liveQuerySet
   */
  unregister(namespace, liveQuerySet) {
    if (this.namespaceRegistry.has(namespace)) {
      this.namespaceRegistry.get(namespace).delete(liveQuerySet);
      if (this.namespaceRegistry.get(namespace).size === 0) {
        this.namespaceRegistry.delete(namespace);
      }
    }
  }

  /**
   * Gets all LiveQuerySets registered for the namespace.
   * @param {string} namespace
   * @returns {Set<LiveQuerySet>} The set of LiveQuerySets.
   */
  getForNamespace(namespace) {
    return this.namespaceRegistry.get(namespace) || new Set();
  }

  /**
   * Handle an external create event
   * @param {LiveQuerySet} liveQuerySet - The LiveQuerySet instance
   * @param {Object} item - The item data
   */
  handleExternalCreateEvent(liveQuerySet, item) {
    // Skip if the item was created by an active operation
    if (item.operationId && activeOperationIds.has(item.operationId)) return;
    
    const pkField = liveQuerySet.ModelClass.primaryKeyField || 'id';
    const existingIndex = liveQuerySet.dataArray.findIndex(x => x[pkField] === item[pkField]);
    
    if (existingIndex !== -1) {
      return this.handleExternalUpdateEvent(liveQuerySet, item);
    }
    
    return liveQuerySet._processSingleItem(item, false, 'create');
  }

  /**
   * Handle an external update event
   * @param {LiveQuerySet} liveQuerySet - The LiveQuerySet instance
   * @param {Object} item - The item data
   */
  handleExternalUpdateEvent(liveQuerySet, item) {
    if (item.operationId && activeOperationIds.has(item.operationId)) return;
    return liveQuerySet._processSingleItem(item, false, 'update');
  }

  /**
   * Handle an external delete event
   * @param {LiveQuerySet} liveQuerySet - The LiveQuerySet instance
   * @param {string|number} itemId - The ID of the item to delete
   */
  handleExternalDeleteEvent(liveQuerySet, itemId) {
    if (activeOperationIds.has(itemId)) return;
    return liveQuerySet._processMultipleItems([itemId], false, 'delete');
  }

  /**
   * Handle an external bulk update event
   * @param {LiveQuerySet} liveQuerySet - The LiveQuerySet instance
   * @param {Array} instanceIds - Array of instance IDs to update
   * @param {string} pkField - The primary key field
   * @returns {Promise<void>}
   */
  async handleExternalBulkUpdateEvent(liveQuerySet, instanceIds, pkField = liveQuerySet.ModelClass.primaryKeyField) {
    if (!instanceIds || instanceIds.length === 0) return;
    
    try {
      const filterCondition = {};
      filterCondition[`${pkField}__in`] = instanceIds;
      const updatedInstances = await liveQuerySet.qs.filter(filterCondition).fetch();
      
      if (updatedInstances?.length > 0) {
        liveQuerySet._processMultipleItems(updatedInstances, false, 'update');
      }
    } catch (err) {
      console.error('Error handling bulk update event:', err);
    }
  }

  /**
   * Handle an external bulk create event
   * @param {LiveQuerySet} liveQuerySet - The LiveQuerySet instance
   * @param {Array} items - Array of items to create
   */
  handleExternalBulkCreateEvent(liveQuerySet, items) {
    return liveQuerySet._processMultipleItems(items, false, 'create');
  }

  /**
   * Handle an external bulk delete event
   * @param {LiveQuerySet} liveQuerySet - The LiveQuerySet instance
   * @param {Array} instanceIds - Array of instance IDs to delete
   * @param {string} pkField - The primary key field
   */
  handleExternalBulkDeleteEvent(liveQuerySet, instanceIds, pkField = liveQuerySet.ModelClass.primaryKeyField) {
    return liveQuerySet._processMultipleItems(instanceIds, false, 'delete');
  }
}

// Create a singleton instance of the registry
export const liveQueryRegistry = new LiveQueryRegistry();

/**
 * Handles a model event coming from the backend.
 *
 * @param {Object} event - The model event.
 * @returns {Promise<void>}
 */
export const handleModelEvent = async (event) => {
  // Normalize operation ID and event type
  event.operationId = event.operationId || event.operation_id;
  const eventType = event.type || event.event;
  
  if (!eventType) {
    console.error('Event received with no type/event field:', event);
    return;
  }

  // Normalize event type once
  const eventTypeMap = {
    'create': EventType.CREATE,
    [EventType.CREATE]: EventType.CREATE,
    'update': EventType.UPDATE,
    [EventType.UPDATE]: EventType.UPDATE,
    'delete': EventType.DELETE,
    [EventType.DELETE]: EventType.DELETE,
    'bulk_update': EventType.BULK_UPDATE,
    [EventType.BULK_UPDATE]: EventType.BULK_UPDATE,
    'bulk_delete': EventType.BULK_DELETE,
    [EventType.BULK_DELETE]: EventType.BULK_DELETE
  };

  const normalizedEventType = eventTypeMap[eventType];
  if (!normalizedEventType) {
    console.warn(`Unknown event type: ${eventType}`);
    return;
  }

  if (!event.namespace) {
    console.warn('Event received with no namespace:', event);
    return;
  }

  const liveQuerySets = liveQueryRegistry.getForNamespace(event.namespace);
  if (liveQuerySets.size === 0) {
    return;
  }

  const isBulkEvent = normalizedEventType === EventType.BULK_UPDATE || 
                       normalizedEventType === EventType.BULK_DELETE;

  // Validate bulk events once
  if (isBulkEvent && (!event.instances || !Array.isArray(event.instances) || event.instances.length === 0)) {
    console.error("Invalid bulk event: missing or empty instances array", event);
    return;
  }

  for (const lqs of liveQuerySets) {
    // Skip if model doesn't match
    if (event.model && lqs.ModelClass && lqs.ModelClass.modelName !== event.model) {
      continue;
    }
    
    // Refresh metrics for all relevant live query sets
    lqs.refreshMetrics().catch(error => {
      console.error('Error refreshing metrics:', error);
    });
    
    // Skip if operation is already being handled locally
    if (event.operationId && activeOperationIds.has(event.operationId)) {
      continue;
    }
    
    const pkField = lqs.ModelClass.primaryKeyField;
    
    // For non-bulk events, validate PK once per live query set
    if (!isBulkEvent) {
      const pkValue = event[pkField];
      if (pkValue == null) {
        console.error("Null primary key value in non-bulk event", event);
        continue;
      }
    }
    
    try {
      switch (normalizedEventType) {
        case EventType.CREATE: {
          const pkValue = event[pkField];
          const model = await lqs.qs.get({ [pkField]: pkValue });
          liveQueryRegistry.handleExternalCreateEvent(lqs, model);
          break;
        }
        case EventType.UPDATE: {
          const pkValue = event[pkField];
          const model = await lqs.qs.get({ [pkField]: pkValue });
          liveQueryRegistry.handleExternalUpdateEvent(lqs, model);
          break;
        }
        case EventType.DELETE: {
          const pkValue = event[pkField];
          liveQueryRegistry.handleExternalDeleteEvent(lqs, pkValue);
          break;
        }
        case EventType.BULK_UPDATE: {
          const updatePkFieldName = event.pk_field_name || pkField;
          await liveQueryRegistry.handleExternalBulkUpdateEvent(lqs, event.instances, updatePkFieldName);
          break;
        }
        case EventType.BULK_DELETE: {
          const deletePkFieldName = event.pk_field_name || pkField;
          liveQueryRegistry.handleExternalBulkDeleteEvent(lqs, event.instances, deletePkFieldName);
          break;
        }
      }
    } catch (err) {
      console.error(`Error processing ${normalizedEventType} event:`, err);
    }
  }
};