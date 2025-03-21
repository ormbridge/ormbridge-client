// modelsync-client/src/core/liveView/metricsManager.js

/**
 * A class to manage metrics for a LiveQuerySet.
 * Encapsulates metric creation, caching, and refreshing logic.
 */
export class MetricsManager {
    /**
     * Creates a new MetricsManager instance.
     * @param {QuerySet} qs - The base QuerySet to use for metrics operations.
     * @param {function(value: any): Object} createMetricFn - Function to create metric result objects.
     */
    constructor(qs, createMetricFn) {
      this.qs = qs;
      this.createMetricFn = createMetricFn || (value => ({ value }));
      this.activeMetrics = new Map();
      this._metricsDebounceTimer = null;
    }
  
    /**
     * Refreshes all active metrics.
     * @returns {Promise<void>}
     */
    async refreshMetrics() {
      if (this.activeMetrics.size === 0) {
        return;
      }
      
      // Clear any existing debounce timer (for cleanup)
      if (this._metricsDebounceTimer) {
        clearTimeout(this._metricsDebounceTimer);
        this._metricsDebounceTimer = null;
      }
      
      // Immediately refresh metrics without debouncing
      const refreshPromises = [];
      for (const [key, metric] of this.activeMetrics.entries()) {
        const [type, field] = key.split(':');
        const refreshPromise = (async () => {
          try {
            let newValue;
            switch (type) {
              case 'count':
                newValue = await this.qs.count(field || undefined);
                break;
              case 'sum':
                newValue = await this.qs.sum(field);
                break;
              case 'avg':
                newValue = await this.qs.avg(field);
                break;
              case 'min':
                newValue = await this.qs.min(field);
                break;
              case 'max':
                newValue = await this.qs.max(field);
                break;
            }
            if (newValue !== undefined) {
              metric.value = newValue;
            }
          }
          catch (error) {
            console.error(`Error refreshing metric ${key}:`, error);
          }
        })();
        refreshPromises.push(refreshPromise);
      }
      return Promise.all(refreshPromises);
    }
    
    /**
     * Helper method to create or retrieve a metric object
     * @param {String} metricKey - The key for the metric
     * @param {Number} value - The metric value
     * @returns {Object} - The metric object
     * @private
     */
    _getOrCreateMetric(metricKey, value) {
      const existing = this.activeMetrics.get(metricKey);
      if (existing) {
        existing.value = value;
        return existing;
      }
    
      const result = this.createMetricFn(value);
      this.activeMetrics.set(metricKey, result);
      return result;
    }
  
    /**
     * Returns the count metric.
     * @param {string} [field] - Field to count.
     * @returns {Promise<Object>} The count metric.
     */
    async count(field) {
      const value = await this.qs.count(field);
      const metricKey = `count:${String(field || '')}`;
      return this._getOrCreateMetric(metricKey, value);
    }
  
    /**
     * Returns the sum metric.
     * @param {string} field - Field to sum.
     * @returns {Promise<Object>} The sum metric.
     */
    async sum(field) {
      const value = await this.qs.sum(field);
      const metricKey = `sum:${String(field)}`;
      return this._getOrCreateMetric(metricKey, value);
    }
  
    /**
     * Returns the average metric.
     * @param {string} field - Field to average.
     * @returns {Promise<Object>} The average metric.
     */
    async avg(field) {
      const value = await this.qs.avg(field);
      const metricKey = `avg:${String(field)}`;
      return this._getOrCreateMetric(metricKey, value);
    }
  
    /**
     * Returns the minimum metric.
     * @param {string} field - Field to find the minimum.
     * @returns {Promise<Object>} The minimum metric.
     */
    async min(field) {
      const value = await this.qs.min(field);
      const metricKey = `min:${String(field)}`;
      return this._getOrCreateMetric(metricKey, value);
    }
  
    /**
     * Returns the maximum metric.
     * @param {string} field - Field to find the maximum.
     * @returns {Promise<Object>} The maximum metric.
     */
    async max(field) {
      const value = await this.qs.max(field);
      const metricKey = `max:${String(field)}`;
      return this._getOrCreateMetric(metricKey, value);
    }
  
    /**
     * Clears all active metrics.
     */
    clear() {
      this.activeMetrics.clear();
      if (this._metricsDebounceTimer) {
        clearTimeout(this._metricsDebounceTimer);
        this._metricsDebounceTimer = null;
      }
    }
  
    /**
     * Updates the QuerySet used for metrics operations.
     * @param {QuerySet} qs - The new QuerySet.
     */
    updateQuerySet(qs) {
      this.qs = qs;
    }
  }
  
  /**
   * Creates a new MetricsManager with sensible defaults.
   * @param {QuerySet} qs - The QuerySet to use for operations.
   * @param {function} [createMetricFn] - Custom metric creator function.
   * @returns {MetricsManager} A new MetricsManager instance.
   */
  export function createMetricsManager(qs, createMetricFn) {
    return new MetricsManager(qs, createMetricFn);
  }