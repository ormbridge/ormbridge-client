import { 
    MetricStrategyFactory,
    CountStrategy,
    SumStrategy,
    MinStrategy,
    MaxStrategy,
    MetricCalculationStrategy
  } from '../../src/syncEngine/stores/metricOptCalcs.js';
  import { describe, test, expect, beforeEach, afterEach } from 'vitest';
  
  // Define test model classes with different configurations
  class TestModel {
    static modelName = 'TestModel';
    static configKey = 'test';
    static primaryKeyField = 'id';
  }
  
  class AnotherTestModel {
    static modelName = 'AnotherTestModel';
    static configKey = 'another';
    static primaryKeyField = 'id';
  }
  
  // Create a custom strategy for testing overrides
  class CustomStrategy extends MetricCalculationStrategy {
    calculate(groundTruthMetricValue, filteredGroundTruthDataSlice, filteredOptimisticDataSlice, field) {
      // Simple custom calculation - doubles the count strategy result
      const countStrategy = new CountStrategy();
      const baseCount = countStrategy.calculate(
        groundTruthMetricValue, 
        filteredGroundTruthDataSlice, 
        filteredOptimisticDataSlice, 
        field
      );
      return baseCount * 2;
    }
  }
  
  describe('MetricStrategyFactory Override Behavior', () => {
    beforeEach(() => {
      // Clear any custom strategies before each test
      MetricStrategyFactory.clearCustomStrategies();
    });
  
    describe('Default Strategy Selection', () => {
      test('should return the correct default strategy based on metric type', () => {
        // Get default strategies
        const countStrategy = MetricStrategyFactory.getStrategy('testMetric', TestModel, 'count');
        const sumStrategy = MetricStrategyFactory.getStrategy('testMetric', TestModel, 'sum');
        const minStrategy = MetricStrategyFactory.getStrategy('testMetric', TestModel, 'min');
        const maxStrategy = MetricStrategyFactory.getStrategy('testMetric', TestModel, 'max');
        
        // Verify correct strategy types
        expect(countStrategy).toBeInstanceOf(CountStrategy);
        expect(sumStrategy).toBeInstanceOf(SumStrategy);
        expect(minStrategy).toBeInstanceOf(MinStrategy);
        expect(maxStrategy).toBeInstanceOf(MaxStrategy);
      });
  
      test('should default to count strategy when type is unknown', () => {
        const strategy = MetricStrategyFactory.getStrategy('testMetric', TestModel, 'unknown');
        expect(strategy).toBeInstanceOf(CountStrategy);
      });
  
      test('should default to count strategy when type is omitted', () => {
        const strategy = MetricStrategyFactory.getStrategy('testMetric', TestModel);
        expect(strategy).toBeInstanceOf(CountStrategy);
      });
    });
  
    describe('Model-Specific Strategy Overrides', () => {
      test('should use a model-specific strategy override when available', () => {
        // Create a custom strategy
        const customStrategy = new CustomStrategy();
        
        // Register it as an override for a specific metric/model
        MetricStrategyFactory.overrideStrategy('salesCount', TestModel, customStrategy);
        
        // Get the strategy
        const strategy = MetricStrategyFactory.getStrategy('salesCount', TestModel);
        
        // Verify it's the custom one
        expect(strategy).toBe(customStrategy);
        expect(strategy).toBeInstanceOf(CustomStrategy);
      });
  
      test('should not apply overrides across different models', () => {
        // Create a custom strategy
        const customStrategy = new CustomStrategy();
        
        // Register it as an override for only one model
        MetricStrategyFactory.overrideStrategy('commonMetric', TestModel, customStrategy);
        
        // Get strategy for both models
        const testModelStrategy = MetricStrategyFactory.getStrategy('commonMetric', TestModel);
        const anotherModelStrategy = MetricStrategyFactory.getStrategy('commonMetric', AnotherTestModel);
        
        // Verify only the specified model gets the override
        expect(testModelStrategy).toBe(customStrategy);
        expect(testModelStrategy).toBeInstanceOf(CustomStrategy);
        
        // The other model should get the default
        expect(anotherModelStrategy).toBeInstanceOf(CountStrategy);
      });
  
      test('should handle multiple model-specific overrides independently', () => {
        // Create different custom strategies
        const customStrategyA = new CustomStrategy();
        const sumStrategy = new SumStrategy();
        
        // Register different overrides for different metrics
        MetricStrategyFactory.overrideStrategy('metricA', TestModel, customStrategyA);
        MetricStrategyFactory.overrideStrategy('metricB', TestModel, sumStrategy);
        
        // Get both strategies
        const strategyA = MetricStrategyFactory.getStrategy('metricA', TestModel);
        const strategyB = MetricStrategyFactory.getStrategy('metricB', TestModel);
        
        // Verify each metric gets its specific override
        expect(strategyA).toBe(customStrategyA);
        expect(strategyB).toBe(sumStrategy);
      });
    });
  
    describe('Generic Strategy Overrides', () => {
      test('should use a generic strategy override when available', () => {
        // Create a custom strategy
        const customStrategy = new CustomStrategy();
        
        // Register it as a generic override (no model specified)
        MetricStrategyFactory.overrideStrategy('genericMetric', null, customStrategy);
        
        // Get the strategy for different models
        const testModelStrategy = MetricStrategyFactory.getStrategy('genericMetric', TestModel);
        const anotherModelStrategy = MetricStrategyFactory.getStrategy('genericMetric', AnotherTestModel);
        
        // Verify the generic override is applied to both models
        expect(testModelStrategy).toBe(customStrategy);
        expect(anotherModelStrategy).toBe(customStrategy);
      });
  
      test('should prioritize model-specific overrides over generic ones', () => {
        // Create different custom strategies
        const genericStrategy = new CustomStrategy();
        const specificStrategy = new SumStrategy();
        
        // Register both generic and specific overrides
        MetricStrategyFactory.overrideStrategy('priorityMetric', null, genericStrategy);
        MetricStrategyFactory.overrideStrategy('priorityMetric', TestModel, specificStrategy);
        
        // Get strategies for different models
        const testModelStrategy = MetricStrategyFactory.getStrategy('priorityMetric', TestModel);
        const anotherModelStrategy = MetricStrategyFactory.getStrategy('priorityMetric', AnotherTestModel);
        
        // Verify model-specific override takes precedence
        expect(testModelStrategy).toBe(specificStrategy);
        
        // The other model falls back to the generic override
        expect(anotherModelStrategy).toBe(genericStrategy);
      });
    });
  
    describe('Strategy Override Edge Cases', () => {
      test('should throw error when overriding with invalid strategy', () => {
        // Try to override with something that's not a strategy
        const invalidStrategy = { calculate: () => {} };
        
        // This should throw an error
        expect(() => {
          MetricStrategyFactory.overrideStrategy('badMetric', TestModel, invalidStrategy);
        }).toThrow();
      });
  
      test('should throw error when overriding without required parameters', () => {
        const validStrategy = new CustomStrategy();
        
        // Missing metric name
        expect(() => {
          MetricStrategyFactory.overrideStrategy(null, TestModel, validStrategy);
        }).toThrow();
        
        // Missing strategy
        expect(() => {
          MetricStrategyFactory.overrideStrategy('metricName', TestModel, null);
        }).toThrow();
      });
  
      test('should handle clearing of custom strategies', () => {
        // Create and register a custom strategy
        const customStrategy = new CustomStrategy();
        MetricStrategyFactory.overrideStrategy('clearTest', TestModel, customStrategy);
        
        // Verify the override works
        let strategy = MetricStrategyFactory.getStrategy('clearTest', TestModel);
        expect(strategy).toBe(customStrategy);
        
        // Clear all custom strategies
        MetricStrategyFactory.clearCustomStrategies();
        
        // Now should get the default
        strategy = MetricStrategyFactory.getStrategy('clearTest', TestModel);
        expect(strategy).toBeInstanceOf(CountStrategy);
      });
    });
  
    describe('Strategy Calculation Behavior', () => {
      test('should correctly use custom calculation logic', () => {
        // Create test data
        const groundTruthData = [{ id: 1 }, { id: 2 }];
        const optimisticData = [{ id: 1 }, { id: 2 }, { id: 3 }];
        
        // Create a custom strategy with doubled count
        const customStrategy = new CustomStrategy();
        
        // Register as override
        MetricStrategyFactory.overrideStrategy('doubleCount', TestModel, customStrategy);
        
        // Get and apply the custom strategy
        const strategy = MetricStrategyFactory.getStrategy('doubleCount', TestModel);
        const result = strategy.calculate(0, groundTruthData, optimisticData, null);
        
        // Custom strategy doubles the count difference
        // Ground truth: 2, Optimistic: 3, Difference: 1, Doubled: 2
        expect(result).toBe(2);
        
        // Compare with standard count strategy
        const standardStrategy = new CountStrategy();
        const standardResult = standardStrategy.calculate(0, groundTruthData, optimisticData, null);
        expect(standardResult).toBe(1);
      });
    });
  });