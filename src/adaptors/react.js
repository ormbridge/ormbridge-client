import React, { useState, useEffect, useRef, useMemo } from 'react';
import { liveView } from '../core/liveView.js';

/**
 * React hook for creating and using a LiveQuerySet.
 *
 * @param {Object|function} queryInput - The QuerySet to make live or a function that returns one
 * @param {object} [options={}] - Options for the LiveQuerySet
 * @param {array} [deps=[]] - Optional explicit dependencies for controlling when the query reinitializes
 * @returns {[Array, Object|null, boolean]} A tuple containing data, query, and loading state
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
        
        // Initialize the LiveQuerySet
        const lqs = await liveView(currentQuery, [], options);
        
        if (!isMounted) {
          lqs.destroy();
          return;
        }
        
        liveQueryRef.current = lqs;
        
        // Subscribe to changes
        unsubscribe = lqs.subscribe(() => {
          if (isMounted) {
            setData([...lqs.data]);
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
  
  return [data, liveQueryRef.current, isLoading];
}