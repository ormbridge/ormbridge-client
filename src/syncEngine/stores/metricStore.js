import { MetricStrategyFactory } from './metricOptCalcs.js';

/**
 * Represents a single metric that maintains both ground truth and optimistic values.
 * It provides optimistic calculations based on a provided strategy and must be
 * manually synced when needed.
 */
export class MetricStore {
  /**
   * @param {object} options
   * @param {Function} options.fetchMetricValue - Async function () => Promise<any> to get the ground truth value
   * @param {string} options.metricType - The type of metric e.g. min, max, sum, count, etc.
   * @param {Function} options.ModelClass - Model class for strategy creation
   * @param {string|null} options.field - Field name to use for calculations (fixed for this metric)
   * @param {any} [options.initialValue=null] - Optional initial value for the metric's ground truth
   * @param {string} [options.name='UnnamedMetric'] - Optional name for logging/debugging
   */
  constructor(options) {
    if (!options || !options.fetchMetricValue || !options.metricType || !options.ModelClass) {
      throw new Error("MetricStore requires options: fetchMetricValue, metricType, ModelClass");
    }
    
    this.fetchMetricValue = options.fetchMetricValue;
    this.metricType = options.metricType;
    this.field = options.field || null;
    this.name = options.name || 'UnnamedMetric';
    
    // Get the appropriate strategy directly using the metricType and ModelClass
    this.strategy = MetricStrategyFactory.getStrategy(
      this.metricType, 
      options.ModelClass
    );
    
    // Ground truth value
    this.value = options.initialValue !== undefined ? options.initialValue : null;
    
    // Data slices
    this.groundTruthDataSlice = [];
    this.optimisticDataSlice = [];
    
    // State management
    this.isSyncing = false;
    this.lastSyncError = null;
  }

  /**
   * Fetches the ground truth value for this specific metric.
   * Must be called manually when a sync is needed.
   * @returns {Promise<void>}
   */
  async sync() {
    if (this.isSyncing) return;
    this.isSyncing = true;
    this.lastSyncError = null;
    
    try {
      const freshValue = await this.fetchMetricValue();
      // Update internal value if it changed
      if (this.value !== freshValue) {
        this.value = freshValue;
      }
    } catch (error) {
      console.error(`MetricStore [${this.name}] sync failed:`, error);
      this.lastSyncError = error;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Returns the current ground truth value of the metric.
   * @returns {any}
   */
  getGroundTruth() {
    return this.value;
  }

  /**
   * Gets the ground truth value directly.
   * @returns {any}
   */
  getValue() {
    return this.value;
  }
  
  /**
   * Sets the ground truth value directly.
   * @param {any} value - The value to set
   * @returns {MetricStore} This instance for chaining
   */
  setValue(value) {
    if (this.value !== value) {
      this.value = value;
    }
    return this;
  }

  /**
   * Sets the ground truth data slice
   * @param {Array} data - The ground truth data array
   */
  setGroundTruthData(data) {
    this.groundTruthDataSlice = Array.isArray(data) ? data : [];
    return this;
  }

  /**
   * Sets the optimistic data slice
   * @param {Array} data - The optimistic data array
   */
  setOptimisticData(data) {
    this.optimisticDataSlice = Array.isArray(data) ? data : [];
    return this;
  }

  /**
   * Calculates and returns the optimistic value based on the current state
   * and the strategy's calculation method.
   * 
   * @returns {any} The calculated optimistic value
   */
  render() {
    // Calculate the value using the strategy
    return this.strategy.calculate(
      this.value,
      this.groundTruthDataSlice,
      this.optimisticDataSlice,
      this.field
    );
  }

  /**
   * Cleans up resources used by this metric
   */
  destroy() {
    this.strategy = null;
    this.groundTruthDataSlice = null;
    this.optimisticDataSlice = null;
  }
}