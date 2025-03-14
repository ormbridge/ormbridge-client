
// Main entry point re-exporting core modules
export * from './core/eventReceivers.js';
export * from './core/liveView.js';

// Export Django flavor modules
export * from './flavours/django/q.js';
export * from './flavours/django/errors.js';
export * from './flavours/django/querySet.js';
export * from './flavours/django/manager.js';
export * from './flavours/django/model.js';
export * from './flavours/django/createModelInstance.js';
export * from './flavours/django/modelSummary.js';
export * from './config.js';

// These imports are needed to ensure correct module initialization order
// due to circular dependencies - DO NOT REMOVE even if unused
import { useLiveView as useReactLiveView } from './adaptors/react.js';
import { useLiveView as useVueLiveView } from './adaptors/vue.js';