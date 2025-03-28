import React, { useState, useEffect, useRef } from 'react';
import { liveView } from '../core/liveView.js';

/**
 * Custom hook to use a live metric with React state.
 * This hook properly integrates metrics with React's state system.
 * 
 * @param {Function|null} metricFn - Function that returns a metric promise or null
 * @param {any} defaultValue - Default value to use when metric is not available
 * @returns {any} The current value of the metric
 */
export function useLiveMetric(metricFn, defaultValue = null) {
  const [value, setValue] = useState(defaultValue);
  const metricRef = useRef(null);
  
  useEffect(() => {
    let isMounted = true;
    
    const setupMetric = async () => {
      // Clean up any existing metric connection
      if (metricRef.current && metricRef.current._setState) {
        metricRef.current._setState = null;
      }
      
      try {
        // If no metric function is provided, do nothing
        if (!metricFn) return;
        
        // Get the metric
        const metric = await metricFn();
        
        // If component unmounted during async operation, abort
        if (!isMounted) return;
        
        // Check if we got a valid metric
        if (!metric) return;
        
        // Store reference for cleanup
        metricRef.current = metric;
        
        // Connect to our state
        metric.connect(setValue);
      } catch (error) {
        console.error("Error setting up metric:", error);
      }
    };
    
    setupMetric();
    
    // Cleanup function
    return () => {
      isMounted = false;
      if (metricRef.current && metricRef.current._setState) {
        metricRef.current._setState = null;
      }
    };
  }, [metricFn]);
  
  return value;
}

/**
 * React hook for creating and using a LiveQuerySet.
 *
 * @param {Object|function} queryInput - The QuerySet to make live or a function that returns one
 * @param {object} [options={}] - Options for the LiveQuerySet
 * @param {array} [deps=[]] - Optional explicit dependencies for controlling when the query reinitializes
 * @returns {Array} An array containing [data, query, isLoading]
 */
export function useLiveView(queryInput, options = {}, deps = []) {
  const [data, setData] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const liveQueryRef = useRef(null);
  
  // If explicit deps are provided, use those.
  // Otherwise, generate deps based on options.
  const effectDeps = deps.length > 0
    ? deps
    : [queryInput, ...(typeof options === 'object' ? [JSON.stringify(options)] : [options])];
  
  useEffect(() => {
    let isMounted = true;
    let unsubscribe = null;
    
    // Clean up any existing LiveQuerySet
    if (liveQueryRef.current) {
      if (unsubscribe) unsubscribe();
      liveQueryRef.current.destroy();
      liveQueryRef.current = null;
    }
    
    setIsLoading(true);
    
    const setupLiveView = async () => {
      try {
        // Get the actual query
        const currentQuery = typeof queryInput === 'function'
          ? queryInput()
          : queryInput;
        
        // Create a metric function that will enable React integration
        const createMetricFn = (value) => {
          // For compatibility with the core library
          return {
            // The initial value
            _value: value,
            // React setState will be stored here
            _setState: null,
            
            // Standard property to maintain compatibility with Vue
            get value() {
              return this._value;
            },
            set value(newVal) {
              // Only update if value has actually changed
              if (this._value !== newVal) {
                this._value = newVal;
                
                // Update React state if setState is available
                if (this._setState) {
                  this._setState(newVal);
                }
              }
            },
            
            // Method to connect to component state
            connect: function(setState) {
              this._setState = setState;
              // Initial state update
              setState(this._value);
              return this;
            }
          };
        };
        
        // Initialize the LiveQuerySet with the metric function
        const lqs = await liveView(currentQuery, [], options, createMetricFn);
        
        if (!isMounted) {
          lqs.destroy();
          return;
        }
        
        liveQueryRef.current = lqs;
        
        // Subscribe to changes
        unsubscribe = lqs.subscribe(() => {
          if (isMounted) {
            console.log(`LiveView updated, new data:`, lqs.data);
            setData([...lqs.data]);
            
            // Force update metrics too when data changes - NEW
            if (lqs.metrics) {
              Object.values(lqs.metrics).forEach(metric => {
                if (metric._setState) {
                  metric._setState(metric._value);
                }
              });
            }
          }
        });
        
        // Fetch initial data
        await lqs.fetch();
        
        if (isMounted) {
          setData([...lqs.data]);
          setIsLoading(false);
        }
      } catch (error) {
        console.error("Failed to initialize live view:", error);
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };
    
    setupLiveView();
    
    return () => {
      isMounted = false;
      if (unsubscribe) unsubscribe();
      if (liveQueryRef.current) {
        liveQueryRef.current.destroy();
        liveQueryRef.current = null;
      }
    };
  }, effectDeps);
  
  // Return reactive objects
  return {
    data,
    query,
    isLoading
  };
}