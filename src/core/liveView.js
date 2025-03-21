// This is the main entry point that maintains backward compatibility
// It re-exports everything from the refactored implementation

import { 
    LiveQuerySet, 
    liveView, 
    legacyLiveView, 
    withOperationId, 
    activeOperationIds, 
    defaultNamespaceResolver, 
    handleModelEvent 
  } from './liveView/index.js';
  
  import { updateArrayInPlace, handleItemInsertion } from './liveView/utils.js';
  
  // Re-export everything for backward compatibility
  export {
    LiveQuerySet,
    liveView,
    legacyLiveView,
    withOperationId,
    activeOperationIds,
    defaultNamespaceResolver,
    handleModelEvent,
    updateArrayInPlace,
    handleItemInsertion
  };
  
  // For backward compatibility, we also export legacyLiveView as the default
  export default legacyLiveView;