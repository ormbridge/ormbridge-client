import { calculators } from "./metricsPatchCalculator";
import { metricsCoordinator } from "./metricsCoordinator";

/**
 * Manages metrics calculations for a query set.
 * This class is designed to be stateless - all required references are passed as parameters to each method.
 */
class MetricsManager {
  /**
   * Refreshes all active metrics.
   * @param {Object} qs - The query set to run metrics on.
   * @param {Map} activeMetrics - The active metrics map.
   * @returns {Promise<void>}
   */
  static async refreshMetrics(qs, activeMetrics) {
    if (activeMetrics.size === 0) {
      return;
    }

    try {
      // Immediately refresh metrics without debouncing
      const refreshPromises = [];
      for (const [key, metric] of activeMetrics.entries()) {
        const [type, field] = key.split(":");
        const refreshPromise = (async () => {
          try {
            let newValue;
            const oldValue = metric.value;
            switch (type) {
              case "count":
                newValue = await qs.count(field || undefined);
                break;
              case "sum":
                newValue = await qs.sum(field);
                break;
              case "avg":
                newValue = await qs.avg(field);
                break;
              case "min":
                newValue = await qs.min(field);
                break;
              case "max":
                newValue = await qs.max(field);
                break;
            }
            if (newValue !== undefined) {
              metric.value = newValue;
            }
          } catch (error) {
            console.error(`Error refreshing metric ${key}:`, error);
          }
        })();
        refreshPromises.push(refreshPromise);
      }
      return Promise.all(refreshPromises);
    } catch (error) {
      console.error("Error refreshing metrics:", error);
      throw error;
    }
  }

  /**
   * Gets or creates a metric.
   * @param {Map} activeMetrics - The active metrics map.
   * @param {String} metricKey - The metric key.
   * @param {Number} value - The metric value.
   * @param {Function} createMetricFn - Function to create a metric object.
   * @returns {Object} The metric.
   * @private
   */
  static _getOrCreateMetric(activeMetrics, metricKey, value, createMetricFn) {
    const existing = activeMetrics.get(metricKey);
    if (existing) {
      existing.value = value;
      return existing;
    }

    const result = createMetricFn(value);
    activeMetrics.set(metricKey, result);
    return result;
  }

  /**
   * Returns the count metric.
   * @param {Object} qs - The query set to run the count on.
   * @param {Map} activeMetrics - The active metrics map.
   * @param {Function} createMetricFn - Function to create a metric object.
   * @param {string} [field] - Field to count.
   * @returns {Promise<MetricResult>} The count metric.
   */
  static async count(qs, activeMetrics, createMetricFn, field) {
    const value = await qs.count(field);
    const metricKey = `count:${String(field || "")}`;
    return this._getOrCreateMetric(
      activeMetrics,
      metricKey,
      value,
      createMetricFn
    );
  }

  /**
   * Returns the sum metric.
   * @param {Object} qs - The query set to run the sum on.
   * @param {Map} activeMetrics - The active metrics map.
   * @param {Function} createMetricFn - Function to create a metric object.
   * @param {string} field - Field to sum.
   * @returns {Promise<MetricResult>} The sum metric.
   */
  static async sum(qs, activeMetrics, createMetricFn, field) {
    const value = await qs.sum(field);
    const metricKey = `sum:${String(field)}`;
    return this._getOrCreateMetric(
      activeMetrics,
      metricKey,
      value,
      createMetricFn
    );
  }

  /**
   * Returns the average metric.
   * @param {Object} qs - The query set to run the average on.
   * @param {Map} activeMetrics - The active metrics map.
   * @param {Function} createMetricFn - Function to create a metric object.
   * @param {string} field - Field to average.
   * @returns {Promise<MetricResult>} The average metric.
   */
  static async avg(qs, activeMetrics, createMetricFn, field) {
    const value = await qs.avg(field);
    const metricKey = `avg:${String(field)}`;
    return this._getOrCreateMetric(
      activeMetrics,
      metricKey,
      value,
      createMetricFn
    );
  }

  /**
   * Returns the minimum metric.
   * @param {Object} qs - The query set to find the minimum on.
   * @param {Map} activeMetrics - The active metrics map.
   * @param {Function} createMetricFn - Function to create a metric object.
   * @param {string} field - Field to find the minimum.
   * @returns {Promise<MetricResult>} The minimum metric.
   */
  static async min(qs, activeMetrics, createMetricFn, field) {
    const value = await qs.min(field);
    const metricKey = `min:${String(field)}`;
    return this._getOrCreateMetric(
      activeMetrics,
      metricKey,
      value,
      createMetricFn
    );
  }

  /**
   * Returns the maximum metric.
   * @param {Object} qs - The query set to find the maximum on.
   * @param {Map} activeMetrics - The active metrics map.
   * @param {Function} createMetricFn - Function to create a metric object.
   * @param {string} field - Field to find the maximum.
   * @returns {Promise<MetricResult>} The maximum metric.
   */
  static async max(qs, activeMetrics, createMetricFn, field) {
    const value = await qs.max(field);
    const metricKey = `max:${String(field)}`;
    return this._getOrCreateMetric(
      activeMetrics,
      metricKey,
      value,
      createMetricFn
    );
  }

  /**
   * Calculates optimistic updates for metrics based on patches
   *
   * @param {string} eventType - Type of event ('create', 'update', or 'delete')
   * @param {Array} updatedState - The array after it was updated
   * @param {Array} originalState - The original data state before patches
   * @param {Map} activeMetrics - The active metrics map
   * @param {String} operationId - Operation id that is shared between the frontend and backend
   * @returns {Object} Object with metricKey -> newValue mapping that can be applied later
   */
  static optimisticUpdate(
    eventType,
    updatedState,
    originalState,
    activeMetrics,
    operationId
  ) {
    // Skip optimistic updates if a refresh is in progress
    if (metricsCoordinator.isRefreshing()) {
      return {};
    }

    // Note that we had an update
    metricsCoordinator.touch();

    const metricUpdates = {};

    // Iterate through all active metrics
    for (const [metricKey, metric] of activeMetrics.entries()) {
      // Extract metric type and field
      const [metricType, field] = metricKey.split(":");

      // Skip if we don't have a calculator for this metric type
      if (!calculators[metricType]) {
        continue;
      }

      // Get the calculator for this metric type
      const calculator = calculators[metricType];

      // Calculate the new value
      const currentValue = metric.value;
      const newValue = calculator.calculate(
        field || undefined,
        eventType,
        updatedState,
        originalState,
        currentValue
      );

      // Add to updates if value changed
      if (newValue !== currentValue) {
        metricUpdates[metricKey] = newValue;
      }
    }

    return metricUpdates;
  }

  /**
   * Applies previously calculated optimistic updates to metrics
   *
   * @param {Object} metricUpdates - Object with metricKey -> newValue mapping
   * @param {Map} activeMetrics - The active metrics map
   */
  static applyOptimisticUpdates(metricUpdates, activeMetrics) {
    // Skip if refresh is in progress
    if (metricsCoordinator.isRefreshing()) {
      return;
    }

    for (const [metricKey, newValue] of Object.entries(metricUpdates)) {
      const metric = activeMetrics.get(metricKey);
      if (metric) {
        metric.value = newValue;
      }
    }
  }

  /**
   * Schedule a refresh of metrics after a sequence of operations
   *
   * @param {Object} qs - The query set to run metrics on
   * @param {Map} activeMetrics - The active metrics map
   * @returns {Promise<void>}
   */
  static scheduleRefresh(qs, activeMetrics) {
    if (activeMetrics.size === 0) {
      return Promise.resolve();
    }

    return metricsCoordinator.scheduleRefresh(() =>
      this.refreshMetrics(qs, activeMetrics)
    );
  }
}

export default MetricsManager;
