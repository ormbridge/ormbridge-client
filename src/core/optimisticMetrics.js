/**
 * Optimistic metrics handler for LiveQuerySet
 * Provides optimistic updates for metrics based on local data modifications
 */
export class OptimisticMetricsHandler {
    /**
     * Creates a new OptimisticMetricsHandler
     * @param {LiveQuerySet} liveQuerySet - The LiveQuerySet this handler belongs to
     */
    constructor(liveQuerySet) {
      this.liveQuerySet = liveQuerySet;
      this.handlers = {
        // For count metrics: simple increment/decrement for all operations
        count: {
          // Handle both single item or array of items
          create: (metric, items) => {
            const itemsArray = Array.isArray(items) ? items : [items];
            return { value: metric.value + itemsArray.length };
          },
          delete: (metric, items) => {
            const itemsArray = Array.isArray(items) ? items : [items];
            return { value: metric.value - itemsArray.length };
          },
          update: (metric, oldItems, newItems) => ({ value: metric.value }) // Count doesn't change on update
        },
        
        // For min metrics: update only on create if new value is lower
        min: {
          create: (metric, items, field) => {
            const itemsArray = Array.isArray(items) ? items : [items];
            
            // Find the minimum value in the new items
            let minValue = metric.value;
            for (const item of itemsArray) {
              if (item[field] < minValue) {
                minValue = item[field];
              }
            }
            
            return { value: minValue };
          }
        },
        
        // For max metrics: update only on create if new value is higher
        max: {
          create: (metric, items, field) => {
            const itemsArray = Array.isArray(items) ? items : [items];
            
            // Find the maximum value in the new items
            let maxValue = metric.value;
            for (const item of itemsArray) {
              if (item[field] > maxValue) {
                maxValue = item[field];
              }
            }
            
            return { value: maxValue };
          }
        }
      };
      
      // Define rollback handlers (inverse operations)
      this.rollbackHandlers = {
        count: {
          create: (metric, items) => {
            const itemsArray = Array.isArray(items) ? items : [items];
            return { value: metric.value - itemsArray.length };
          },
          delete: (metric, items) => {
            const itemsArray = Array.isArray(items) ? items : [items];
            return { value: metric.value + itemsArray.length };
          },
          update: (metric, oldItems, newItems) => ({ value: metric.value }) // No change needed for count
        },
        min: {
          create: (metric, items, field, originalValue) => ({ value: originalValue })
        },
        max: {
          create: (metric, items, field, originalValue) => ({ value: originalValue })
        }
      };
    }
  
    /**
     * Updates a metric optimistically based on a change to the data
     * @param {string} operation - The operation type (create, update, delete)
     * @param {string} metricType - The metric type (count, min, max)
     * @param {Object} metric - The metric object to update
     * @param {*} items - Item(s) affected by the operation for create/delete
     * @param {*} [newItems] - New versions of items for update operations
     * @param {string} [field] - Field name for field-specific metrics (min, max)
     * @returns {Object} Updated metric object
     */
    updateMetric(operation, metricType, metric, items, newItems, field) {
      // Skip if we don't have a handler for this metric type
      if (!this.handlers[metricType]) {
        return metric;
      }
  
      // Skip if we don't have a handler for this operation
      const handler = this.handlers[metricType][operation];
      if (!handler) {
        return metric;
      }
      
      // Call the appropriate handler based on operation type
      if (operation === 'update') {
        // For update, we need both old and new items
        const updatedMetric = handler(metric, items, newItems, field);
        return updatedMetric;
      } else {
        // For create/delete, we just need the items
        const updatedMetric = handler(metric, items, field);
        return updatedMetric;
      }
    }
    
    /**
     * Performs a rollback of a metric update
     * @param {string} operation - The original operation type that needs to be rolled back
     * @param {string} metricType - The metric type (count, min, max)
     * @param {Object} metric - The metric object to update
     * @param {*} items - Item(s) affected by the original operation
     * @param {*} [newItems] - New versions of items for update operations
     * @param {string} [field] - Field name for field-specific metrics
     * @param {*} [originalValue] - The original value of the metric before the operation
     * @returns {Object} Updated metric object after rollback
     */
    rollbackMetricUpdate(operation, metricType, metric, items, newItems, field, originalValue) {
      // Skip if we don't have a rollback handler for this metric type
      if (!this.rollbackHandlers[metricType]) {
        return metric;
      }
  
      // Skip if we don't have a rollback handler for this operation
      const handler = this.rollbackHandlers[metricType][operation];
      if (!handler) {
        return metric;
      }
      
      // Call the appropriate rollback handler
      if (operation === 'update') {
        return handler(metric, items, newItems, field, originalValue);
      } else {
        return handler(metric, items, field, originalValue);
      }
    }
  
    /**
     * Get the field name from a metric key
     * @param {string} metricKey - The metric key in format "type:field"
     * @returns {string|null} Field name or null for count with no field
     */
    getFieldFromKey(metricKey) {
      const [_, field] = metricKey.split(':');
      return field || null;
    }
  
    /**
     * Get the metric type from a metric key
     * @param {string} metricKey - The metric key in format "type:field"
     * @returns {string} Metric type (count, sum, etc.)
     */
    getTypeFromKey(metricKey) {
      const [type, _] = metricKey.split(':');
      return type;
    }
  
    /**
     * Updates all active metrics based on a data operation
     * @param {string} operation - The operation type (create, update, delete)
     * @param {*} items - Item(s) affected by the operation (single item or array)
     * @param {*} [newItems] - New versions of items for update operations (single item or array)
     * @returns {Object} Map of original metric values for potential rollback
     */
    updateAllMetrics(operation, items, newItems) {
      if (this.liveQuerySet.activeMetrics.size === 0) {
        return new Map();
      }
  
      // Ensure items is always an array
      const itemsArray = Array.isArray(items) ? items : [items];
      
      // For update operations, ensure newItems is also an array of matching length
      let newItemsArray = null;
      if (operation === 'update' && newItems) {
        newItemsArray = Array.isArray(newItems) ? newItems : [newItems];
        // Make sure we have the same number of old and new items
        if (itemsArray.length !== newItemsArray.length) {
          console.error('Mismatch between old and new items in updateAllMetrics');
          return new Map();
        }
      }
  
      // Only process items that match our filter
      const filteredItems = itemsArray.filter(item => this.liveQuerySet.filterFn(item));
  
      // Skip if no relevant items after filtering
      if (filteredItems.length === 0) {
        return new Map();
      }
  
      // For update operations, filter new items based on the same filter logic
      const filteredNewItems = newItemsArray ? 
        newItemsArray.filter(item => this.liveQuerySet.filterFn(item)) : null;
  
      // Store original values for potential rollback
      const originalValues = new Map();
  
      // Update each active metric
      for (const [key, metric] of this.liveQuerySet.activeMetrics.entries()) {
        const metricType = this.getTypeFromKey(key);
        const field = this.getFieldFromKey(key);
        
        // Store original value
        originalValues.set(key, metric.value);
        
        const updatedMetric = this.updateMetric(
          operation, 
          metricType, 
          metric, 
          filteredItems,
          filteredNewItems,
          field
        );
        
        // Update the metric if changed
        if (updatedMetric && updatedMetric.value !== metric.value) {
          Object.assign(metric, updatedMetric);
        }
      }
      
      return originalValues;
    }
    
    /**
     * Rollback metrics updates using original values
     * @param {string} operation - The original operation to roll back
     * @param {*} items - The items involved in the original operation
     * @param {*} [newItems] - New versions of items for update operations
     * @param {Map} originalValues - Map of original metric values
     */
    rollbackMetricUpdates(operation, items, newItems, originalValues) {
      if (this.liveQuerySet.activeMetrics.size === 0 || originalValues.size === 0) {
        return;
      }
      
      // Ensure items is always an array
      const itemsArray = Array.isArray(items) ? items : [items];
      
      // For update operations, ensure newItems is also an array
      let newItemsArray = null;
      if (operation === 'update' && newItems) {
        newItemsArray = Array.isArray(newItems) ? newItems : [newItems];
      }
  
      // Only process items that match our filter
      const filteredItems = itemsArray.filter(this.liveQuerySet.filterFn);
      const filteredNewItems = newItemsArray ? 
        newItemsArray.filter(this.liveQuerySet.filterFn) : null;
  
      // Skip if no relevant items after filtering
      if (filteredItems.length === 0) {
        return;
      }
      
      // Roll back each affected metric
      for (const [key, metric] of this.liveQuerySet.activeMetrics.entries()) {
        if (!originalValues.has(key)) continue;
        
        const metricType = this.getTypeFromKey(key);
        const field = this.getFieldFromKey(key);
        const originalValue = originalValues.get(key);
        
        if (operation === 'update' && filteredNewItems) {
          const rolledBackMetric = this.rollbackMetricUpdate(
            operation,
            metricType,
            metric,
            filteredItems,
            filteredNewItems,
            field,
            originalValue
          );
          
          // Apply rollback if handler provided a result
          if (rolledBackMetric && rolledBackMetric.value !== metric.value) {
            Object.assign(metric, rolledBackMetric);
          } else {
            // Otherwise just restore the original value
            metric.value = originalValue;
          }
        } else {
          const rolledBackMetric = this.rollbackMetricUpdate(
            operation,
            metricType,
            metric,
            filteredItems,
            null,
            field,
            originalValue
          );
          
          // Apply rollback if handler provided a result
          if (rolledBackMetric && rolledBackMetric.value !== metric.value) {
            Object.assign(metric, rolledBackMetric);
          } else {
            // Otherwise just restore the original value
            metric.value = originalValue;
          }
        }
      }
    }
  }