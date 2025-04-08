/**
 * Utility functions for metric strategies
 */

/**
 * Extracts numeric values from data objects for a specific field
 * @param {Array} data - Array of data objects
 * @param {string} field - Field name to extract
 * @returns {Array<number>} Array of numeric values
 */
export function getNumericValues(data, field) {
    if (!field) return [];
    return data
      .filter(item => item && typeof item === 'object')
      .map(item => item[field])
      .filter(value => value !== null && value !== undefined && !isNaN(parseFloat(value)))
      .map(value => parseFloat(value));
  }
  
  /**
   * Calculates sum of values for a field
   */
  export function calculateSum(data, field) {
    const values = getNumericValues(data, field);
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0);
  }
  
  /**
   * Calculates minimum value for a field
   */
  export function calculateMin(data, field) {
    const values = getNumericValues(data, field);
    if (values.length === 0) return null;
    return Math.min(...values);
  }
  
  /**
   * Calculates maximum value for a field
   */
  export function calculateMax(data, field) {
    const values = getNumericValues(data, field);
    if (values.length === 0) return null;
    return Math.max(...values);
  }
  
  /**
   * Base class for metric calculation strategies
   */
  export class MetricCalculationStrategy {
    /**
     * Calculate the optimistic metric value
     * @param {any} groundTruthMetricValue - Current ground truth value
     * @param {Array} filteredGroundTruthDataSlice - Ground truth data slice
     * @param {Array} filteredOptimisticDataSlice - Optimistic data slice
     * @param {string|null} field - Optional field parameter
     * @returns {any} Calculated metric value
     */
    calculate(groundTruthMetricValue, filteredGroundTruthDataSlice, filteredOptimisticDataSlice, field) {
      throw new Error('MetricCalculationStrategy.calculate must be implemented by subclass');
    }
  }
  
  /**
   * Strategy for counting items
   */
  export class CountStrategy extends MetricCalculationStrategy {
    calculate(groundTruthMetricValue, filteredGroundTruthDataSlice, filteredOptimisticDataSlice, field = null) {
      let groundTruthSliceCount;
      let optimisticSliceCount;
  
      if (field) {
        groundTruthSliceCount = filteredGroundTruthDataSlice.filter(item => 
          item && typeof item === 'object' && item[field] !== null && item[field] !== undefined
        ).length;
        
        optimisticSliceCount = filteredOptimisticDataSlice.filter(item => 
          item && typeof item === 'object' && item[field] !== null && item[field] !== undefined
        ).length;
      } else {
        groundTruthSliceCount = filteredGroundTruthDataSlice.length;
        optimisticSliceCount = filteredOptimisticDataSlice.length;
      }
  
      const countDifference = optimisticSliceCount - groundTruthSliceCount;
      const baseValue = groundTruthMetricValue === null ? 0 : groundTruthMetricValue;
      return Math.max(0, baseValue + countDifference);
    }
  }
  
  /**
   * Strategy for calculating sum of values
   */
  export class SumStrategy extends MetricCalculationStrategy {
    calculate(groundTruthMetricValue, filteredGroundTruthDataSlice, filteredOptimisticDataSlice, field) {
      if (field === null) {
        throw new Error('SumStrategy requires a field parameter');
      }
  
      const groundTruthSliceSum = calculateSum(filteredGroundTruthDataSlice, field);
      const optimisticSliceSum = calculateSum(filteredOptimisticDataSlice, field);
      const sumDifference = optimisticSliceSum - groundTruthSliceSum;
      const baseValue = groundTruthMetricValue === null ? 0 : groundTruthMetricValue;
      return baseValue + sumDifference;
    }
  }
  
  /**
   * Strategy for calculating minimum value
   */
  export class MinStrategy extends MetricCalculationStrategy {
    calculate(groundTruthMetricValue, filteredGroundTruthDataSlice, filteredOptimisticDataSlice, field) {
      if (field === null) {
        throw new Error('MinStrategy requires a field parameter');
      }
  
      // Calculate the minimum only within the optimistic slice
      const optimisticSliceMin = calculateMin(filteredOptimisticDataSlice, field);
  
      // If the optimistic slice is empty or has no valid numbers, we can't make a guess
      if (optimisticSliceMin === null) {
        return groundTruthMetricValue;
      }
  
      // If the ground truth is unknown (null), use the optimistic slice minimum as the best guess
      if (groundTruthMetricValue === null) {
        return optimisticSliceMin;
      }
  
      // If the minimum found in the optimistic slice is strictly less than the known ground truth,
      // we can confidently say we have a new minimum optimistically
      if (optimisticSliceMin < groundTruthMetricValue) {
        return optimisticSliceMin;
      }
  
      // Otherwise, stick with the known ground truth value until the next sync
      return groundTruthMetricValue;
    }
  }
  
  /**
   * Strategy for calculating maximum value
   */
  export class MaxStrategy extends MetricCalculationStrategy {
    calculate(groundTruthMetricValue, filteredGroundTruthDataSlice, filteredOptimisticDataSlice, field) {
      if (field === null) {
        throw new Error('MaxStrategy requires a field parameter');
      }
  
      // Calculate the maximum only within the optimistic slice
      const optimisticSliceMax = calculateMax(filteredOptimisticDataSlice, field);
  
      // If the optimistic slice is empty or has no valid numbers, we can't make a guess
      if (optimisticSliceMax === null) {
        return groundTruthMetricValue;
      }
  
      // If the ground truth is unknown (null), use the optimistic slice maximum as the best guess
      if (groundTruthMetricValue === null) {
        return optimisticSliceMax;
      }
  
      // If the maximum found in the optimistic slice is strictly greater than the known ground truth,
      // we can confidently say we have a new maximum optimistically
      if (optimisticSliceMax > groundTruthMetricValue) {
        return optimisticSliceMax;
      }
  
      // Otherwise, stick with the known ground truth value until the next sync
      return groundTruthMetricValue;
    }
  }
  
  /**
   * Factory for creating common metric calculation strategies
   */
  export class MetricStrategyFactory {
    /**
     * Create a strategy for counting items
     */
    static createCountStrategy() {
      return new CountStrategy();
    }
  
    /**
     * Create a strategy for summing a field
     */
    static createSumStrategy() {
      return new SumStrategy();
    }
  
    /**
     * Create a strategy for getting minimum value of a field
     */
    static createMinStrategy() {
      return new MinStrategy();
    }
  
    /**
     * Create a strategy for getting maximum value of a field
     */
    static createMaxStrategy() {
      return new MaxStrategy();
    }
  }