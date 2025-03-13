// adaptors/react.js
import { liveView } from '../core/liveView.js';

// Create placeholder functions that will be replaced if React is available
let useState = () => {
  throw new Error('React is required for useReactLiveView but was not found');
};

let useEffect = () => {
  throw new Error('React is required for useReactLiveView but was not found');
};

let useRef = () => {
  throw new Error('React is required for useReactLiveView but was not found');
};

// Try to load React using dynamic import - this won't block bundling
(async () => {
  try {
    const React = await import('react');
    // If we get here, React is available, so update the hooks
    useState = React.useState;
    useEffect = React.useEffect;
    useRef = React.useRef;
  } catch (e) {
    // React isn't available, keep using the placeholders
    console.debug('React not available, useReactLiveView will throw if used');
  }
})();

/**
 * React hook for creating and using a LiveQuerySet.
 *
 * @param {QuerySet} querySet - The QuerySet to make live.
 * @param {object} [options] - Options for the LiveQuerySet.
 * @returns {[Array, (LiveQuerySet|null), boolean]} A tuple containing:
 *   - data: An array of model instances.
 *   - query: The LiveQuerySet instance (or null if not yet initialized).
 *   - isLoading: A boolean indicating if data is still loading.
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