export class MetricRenderEngine {
  constructor(modelStore, metric, strategy, renderEngine) {
    if (!modelStore || !metric || !strategy || !renderEngine) {
       throw new Error("MetricRenderEngine requires modelStore, metric, strategy, and renderEngine");
    }
    this.modelStore = modelStore;
    this.metric = metric;
    this.strategy = strategy;
    this.renderEngine = renderEngine;
    this._cache = new Map();

    // FilterFn removed for now based on feedback
    // this._filterFn = this.strategy.filterFn || (() => true);

    this._unsubscribeFromQueryState = this.modelStore.subscribe(() => {
       if (this._cache) this._cache.clear(); // Check if cache exists before clearing
    });
  }

    // Inside MetricRenderEngine.render method:
    render(field = null) {
      const cacheKey = field === null ? 'no_field' : field;
  
      if (this._canUseCache(cacheKey)) {
        return this._cache.get(cacheKey).metricValue;
      }
  
      const groundTruthMetricValue = this.metric.getValue();
      const groundTruthDataSlice = this.modelStore.getGroundTruth() || [];
      const optimisticDataSlice = this.renderEngine.render({
        offset: 0,
        limit: null
      }) || [];

      const filteredGroundTruthSlice = groundTruthDataSlice;
      const filteredOptimisticSlice = optimisticDataSlice;
  
      const calculatedValue = this.strategy.calculate(
        groundTruthMetricValue,
        filteredGroundTruthSlice,
        filteredOptimisticSlice,
        field
      );
  
      this._updateCache(cacheKey, calculatedValue);
      return calculatedValue;
    }

   _canUseCache(cacheKey) {
      if (!this._cache || !this._cache.has(cacheKey)) { // Add null check
         return false;
      }
      const cacheEntry = this._cache.get(cacheKey);
      return cacheEntry.modelStoreVersion === this.modelStore.version;
   }

   _updateCache(cacheKey, value) {
      if (!this._cache) return; // Add null check
      this._cache.set(cacheKey, {
         modelStoreVersion: this.modelStore.version,
         metricValue: value
      });
   }

   destroy() {
      if (this._unsubscribeFromQueryState) {
         this._unsubscribeFromQueryState();
         this._unsubscribeFromQueryState = null;
      }
      if (this._cache) {
         this._cache.clear();
         this._cache = null;
      }
      this.modelStore = null;
      this.metric = null;
      this.strategy = null;
      this.renderEngine = null;
   }
}

function getNumericValues(data, field) {
  if (!field) return [];
  // Added check for item itself being non-null/object
  return data
    .filter(item => item && typeof item === 'object')
    .map(item => item[field])
    .filter(value => value !== null && value !== undefined && !isNaN(parseFloat(value)))
    .map(value => parseFloat(value));
}

function calculateSumInternal(data, field) {
  const values = getNumericValues(data, field);
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0);
}

function calculateMinInternal(data, field) {
  const values = getNumericValues(data, field);
  if (values.length === 0) return null;
  return Math.min(...values);
}

function calculateMaxInternal(data, field) {
  const values = getNumericValues(data, field);
  if (values.length === 0) return null;
  return Math.max(...values);
}

export class MetricCalculationStrategy {
   // FilterFn removed for now
   /*
   constructor(options = {}) {
       this.filterFn = options.filterFn || (() => true);
   }
   */
   calculate(groundTruthMetricValue, filteredGroundTruthDataSlice, filteredOptimisticDataSlice, field) {
       throw new Error('MetricCalculationStrategy.calculate must be implemented by subclass');
   }
}

export class CountStrategy extends MetricCalculationStrategy {
  calculate(groundTruthMetricValue, filteredGroundTruthDataSlice, filteredOptimisticDataSlice, field = null) {
    let groundTruthSliceCount;
    let optimisticSliceCount;

    if (field) {
      groundTruthSliceCount = filteredGroundTruthDataSlice.filter(item => item && typeof item === 'object' && item[field] !== null && item[field] !== undefined).length;
      optimisticSliceCount = filteredOptimisticDataSlice.filter(item => item && typeof item === 'object' && item[field] !== null && item[field] !== undefined).length;
    } else {
      groundTruthSliceCount = filteredGroundTruthDataSlice.length;
      optimisticSliceCount = filteredOptimisticDataSlice.length;
    }

    const countDifference = optimisticSliceCount - groundTruthSliceCount;
    const baseValue = groundTruthMetricValue === null ? 0 : groundTruthMetricValue;
    return Math.max(0, baseValue + countDifference);
  }
}

export class SumStrategy extends MetricCalculationStrategy {
  calculate(groundTruthMetricValue, filteredGroundTruthDataSlice, filteredOptimisticDataSlice, field) {
    if (field === null) {
      throw new Error('SumStrategy requires a field parameter');
    }

    const groundTruthSliceSum = calculateSumInternal(filteredGroundTruthDataSlice, field);
    const optimisticSliceSum = calculateSumInternal(filteredOptimisticDataSlice, field);
    const sumDifference = optimisticSliceSum - groundTruthSliceSum;
    const baseValue = groundTruthMetricValue === null ? 0 : groundTruthMetricValue;
    return baseValue + sumDifference;
  }
}

export class MinStrategy extends MetricCalculationStrategy {
  calculate(groundTruthMetricValue, filteredGroundTruthDataSlice, filteredOptimisticDataSlice, field) {
    if (field === null) {
      throw new Error('MinStrategy requires a field parameter');
    }

    // Calculate the minimum *only within the optimistic slice*
    const optimisticSliceMin = calculateMinInternal(filteredOptimisticDataSlice, field);

    // If the optimistic slice is empty or has no valid numbers, we can't make a guess.
    if (optimisticSliceMin === null) {
      return groundTruthMetricValue;
    }

    // If the ground truth is unknown (null), use the optimistic slice minimum as the best guess.
    if (groundTruthMetricValue === null) {
      return optimisticSliceMin;
    }

    // If the minimum found in the optimistic slice is strictly less than the known ground truth,
    // we can confidently say we have a new minimum optimistically.
    if (optimisticSliceMin < groundTruthMetricValue) {
      return optimisticSliceMin;
    }

    // Otherwise (optimisticSliceMin >= groundTruthMetricValue, or the original min was potentially removed),
    // we cannot reliably determine the *next* minimum just from the slice.
    // Stick with the known ground truth value until the next sync.
    return groundTruthMetricValue;
  }
}

export class MaxStrategy extends MetricCalculationStrategy {
  calculate(groundTruthMetricValue, filteredGroundTruthDataSlice, filteredOptimisticDataSlice, field) {
    if (field === null) {
      throw new Error('MaxStrategy requires a field parameter');
    }

    // Calculate the maximum *only within the optimistic slice*
    const optimisticSliceMax = calculateMaxInternal(filteredOptimisticDataSlice, field);

    // If the optimistic slice is empty or has no valid numbers, we can't make a guess.
    if (optimisticSliceMax === null) {
      return groundTruthMetricValue;
    }

    // If the ground truth is unknown (null), use the optimistic slice maximum as the best guess.
    if (groundTruthMetricValue === null) {
      return optimisticSliceMax;
    }

    // If the maximum found in the optimistic slice is strictly greater than the known ground truth,
    // we can confidently say we have a new maximum optimistically.
    if (optimisticSliceMax > groundTruthMetricValue) {
      return optimisticSliceMax;
    }

    // Otherwise (optimisticSliceMax <= groundTruthMetricValue, or the original max was potentially removed),
    // we cannot reliably determine the *next* maximum just from the slice.
    // Stick with the known ground truth value until the next sync.
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
  // FilterFn parameter removed for now
  static createCountStrategy(/* filterFn */) {
    // return new CountStrategy({ filterFn });
    return new CountStrategy();
  }

  /**
   * Create a strategy for summing a field
   */
  // FilterFn parameter removed for now
  static createSumStrategy(/* filterFn */) {
    // return new SumStrategy({ filterFn });
     return new SumStrategy();
  }

  /**
   * Create a strategy for getting minimum value of a field
   */
   // FilterFn parameter removed for now
  static createMinStrategy(/* filterFn */) {
    // return new MinStrategy({ filterFn });
     return new MinStrategy();
  }

  /**
   * Create a strategy for getting maximum value of a field
   */
   // FilterFn parameter removed for now
  static createMaxStrategy(/* filterFn */) {
    // return new MaxStrategy({ filterFn });
     return new MaxStrategy();
  }
}