import React, { useState, useEffect, useRef } from 'react';
import { QuerySet } from "../flavours/django/querySet.js";
import { Model } from "../flavours/django/model.js";
import { LiveQuerySet, liveView } from '../core/liveView.js';

/**
 * React hook for creating and using a LiveQuerySet.
 *
 * @param {QuerySet} querySet - The QuerySet to make live.
 * @param {object} [options] - Options for the LiveQuerySet.
 * @returns {[Array, (LiveQuerySet|null), boolean]} A tuple containing:
 *   - data: An array of model instances.
 *   - query: The LiveQuerySet instance (or null if not yet initialized).
 *   - isLoading: A boolean indicating if data is still loading.
 *
 * @example
 * // Example usage in a React component:
 * function UserList() {
 *   const [users, query, isLoading] = useReactLiveView(User.objects.all());
 *   
 *   if (isLoading) return <p>Loading...</p>;
 *   
 *   return (
 *     <div>
 *       {users.map(user => (
 *         <div key={user.id}>{user.name}</div>
 *       ))}
 *       <button onClick={() => query && query.create({ name: 'New User' })}>
 *         Add User
 *       </button>
 *     </div>
 *   );
 * }
 */
export function useReactLiveView(querySet, options) {
  const [data, setData] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const liveQueryRef = useRef(null);
  
  useEffect(() => {
    let isMounted = true;
    let unsubscribe = null;
    
    const setupLiveView = async () => {
      try {
        // Initialize the LiveQuerySet with an empty array
        const lqs = await liveView(querySet, [], options);
        
        if (!isMounted) {
          lqs.destroy();
          return;
        }
        
        liveQueryRef.current = lqs;
        
        // Subscribe to changes using the callback system
        unsubscribe = lqs.subscribe((eventType) => {
          if (isMounted) {
            // Create a new array reference to trigger React's state update
            setData([...lqs.data]);
          }
        });
        
        // Trigger initial fetch
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
      if (unsubscribe) {
        unsubscribe();
      }
      if (liveQueryRef.current) {
        liveQueryRef.current.destroy();
        liveQueryRef.current = null;
      }
    };
  }, []); // Empty dependency array assumes querySet is stable
  
  return [data, liveQueryRef.current, isLoading];
}