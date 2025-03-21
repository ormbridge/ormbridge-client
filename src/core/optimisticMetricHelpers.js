/**
 * Helper functions for optimistic metric updates
 */

/**
 * Gets filtered items from an array or single item
 * @param {Array|Object} items - Items to filter
 * @param {Function} filterFn - Filter function
 * @returns {Array} Filtered items
 */
export function getFilteredItems(items, filterFn) {
    const itemsArray = Array.isArray(items) ? items : [items];
    return filterFn ? itemsArray.filter(filterFn) : itemsArray;
  }
  
  /**
   * Operations and their effects on different metric types
   */
  const metricEffects = {
    create: {
      // Count increases by the number of items
      count: (items) => items.length,
      
      // Sum increases by the sum of the field values
      sum: (items, field) => items.reduce((sum, item) => {
        const val = Number(item[field]);
        return sum + (isNaN(val) ? 0 : val);
      }, 0),
      
      // Max only changes if new items contain a higher value
      max: (items, field, currentMax) => {
        const maxVal = Math.max(...items.map(item => Number(item[field]) || -Infinity));
        return maxVal > currentMax ? maxVal - currentMax : null;
      },
      
      // Min only changes if new items contain a lower value
      min: (items, field, currentMin) => {
        const minVal = Math.min(...items.map(item => Number(item[field]) || Infinity));
        return minVal < currentMin ? minVal - currentMin : null;
      },
      
      // No optimistic updates for average
      avg: () => null
    },
    
    delete: {
      // Count decreases by the number of items
      count: (items) => -items.length,
      
      // Sum decreases by the sum of the field values
      sum: (items, field) => items.reduce((sum, item) => {
        const val = Number(item[field]);
        return sum - (isNaN(val) ? 0 : val);
      }, 0),
      
      // No optimistic updates for max or min on delete
      max: () => null,
      min: () => null,
      avg: () => null
    },
    
    // Currently no metric updates for update operations
    update: {
      count: () => null,
      sum: () => null,
      max: () => null,
      min: () => null,
      avg: () => null
    }
  };
  
  /**
   * Calculates metric deltas for an operation
   * 
   * @param {string} operation - Operation type ('create', 'update', 'delete')
   * @param {Object|Array} items - Items involved in the operation
   * @param {Map} activeMetrics - Active metrics map
   * @param {Function} filterFn - Filter function
   * @returns {Map<string, number>} Map of metric keys to deltas
   */
  export function calculateMetricDeltas(operation, items, activeMetrics, filterFn) {
    const filteredItems = getFilteredItems(items, filterFn);
    if (filteredItems.length === 0) return new Map();
  
    const effects = metricEffects[operation];
    if (!effects) return new Map();
    
    const deltas = new Map();
    
    for (const [metricKey, metric] of activeMetrics.entries()) {
      const [type, field] = metricKey.split(':');
      const calculator = effects[type];
      
      if (!calculator) continue;
      
      // Calculate delta based on metric type
      const delta = type === 'count' 
        ? calculator(filteredItems)
        : calculator(filteredItems, field, metric.value);
      
      // Only add non-null and non-zero deltas
      if (delta !== null && delta !== 0) {
        deltas.set(metricKey, delta);
      }
    }
    
    return deltas;
  }
  
  /**
   * Calculates metric deltas for create operations
   */
  export function calculateCreateMetricDeltas(items, activeMetrics, filterFn) {
    return calculateMetricDeltas('create', items, activeMetrics, filterFn);
  }
  
  /**
   * Calculates metric deltas for delete operations
   */
  export function calculateDeleteMetricDeltas(items, activeMetrics, filterFn) {
    return calculateMetricDeltas('delete', items, activeMetrics, filterFn);
  }
  
  /**
   * Calculates metric deltas for update operations
   * Currently returns empty map as per requirements
   */
  export function calculateUpdateMetricDeltas(items, updates, activeMetrics, filterFn) {
    // Ignoring updates parameter as it's not used yet
    return calculateMetricDeltas('update', items, activeMetrics, filterFn);
  }
  
  /**
   * Applies metric deltas to a LiveQuerySet and all its parents
   * 
   * @param {LiveQuerySet} liveQs - The LiveQuerySet to update
   * @param {Map<string, number>} deltas - The metric deltas to apply
   * @returns {Function} A rollback function that reverts all applied changes
   */
  export function applyMetricDeltas(liveQs, deltas) {
    // No updates needed if no deltas or no metrics
    if (!deltas || deltas.size === 0 || !liveQs || !liveQs.activeMetrics || liveQs.activeMetrics.size === 0) {
      return () => {}; // Return empty rollback function
    }
  
    // Helper to apply deltas to a single LiveQuerySet instance
    function applyToInstance(instance, deltasToApply) {
      if (!instance || !instance.activeMetrics || instance.activeMetrics.size === 0) {
        return;
      }
      
      // Apply deltas to each matching metric
      for (const [metricKey, delta] of deltasToApply.entries()) {
        const metric = instance.activeMetrics.get(metricKey);
        if (metric !== undefined) {
          metric.value += delta;
        }
      }
      
      // Recursively apply to parent if it exists
      if (instance.parent) {
        applyToInstance(instance.parent, deltasToApply);
      }
    }
  
    // Start applying from the current LiveQuerySet
    applyToInstance(liveQs, deltas);
  
    // Return rollback function that applies negated deltas
    return function rollbackMetricChanges() {
      // Create negated deltas for rollback
      const negatedDeltas = new Map();
      for (const [key, value] of deltas.entries()) {
        negatedDeltas.set(key, -value);
      }
      
      // Apply negated deltas to current LiveQuerySet and parents
      applyToInstance(liveQs, negatedDeltas);
    };
  }
  
  /**
   * Applies optimistic metric updates for a create operation
   * 
   * @param {LiveQuerySet} liveQs - The LiveQuerySet
   * @param {Object|Array} items - The item(s) being created
   * @returns {Function} A rollback function
   */
  export function applyOptimisticMetricCreate(liveQs, items) {
    const deltas = calculateCreateMetricDeltas(items, liveQs.activeMetrics, liveQs.filterFn);
    return applyMetricDeltas(liveQs, deltas);
  }
  
  /**
   * Applies optimistic metric updates for a delete operation
   * 
   * @param {LiveQuerySet} liveQs - The LiveQuerySet
   * @param {Object|Array} items - The item(s) being deleted
   * @returns {Function} A rollback function
   */
  export function applyOptimisticMetricDelete(liveQs, items) {
    const deltas = calculateDeleteMetricDeltas(items, liveQs.activeMetrics, liveQs.filterFn);
    return applyMetricDeltas(liveQs, deltas);
  }
  
  /**
   * Applies optimistic metric updates for an update operation
   * Currently a no-op as per requirements
   * 
   * @param {LiveQuerySet} liveQs - The LiveQuerySet
   * @param {Object|Array} items - The item(s) being updated
   * @param {Object} updates - The update values
   * @returns {Function} A rollback function
   */
  export function applyOptimisticMetricUpdate(liveQs, items, updates) {
    const deltas = calculateUpdateMetricDeltas(items, updates, liveQs.activeMetrics, liveQs.filterFn);
    return applyMetricDeltas(liveQs, deltas);
  }