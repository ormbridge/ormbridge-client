// index.js - Main entry point with simple dynamic imports

// Core exports - these are always available
export * from './core/eventReceivers.js';
export * from './core/liveView.js';

// Export Django flavor modules - always available
export * from './flavours/django/q.js';
export * from './flavours/django/errors.js';
export * from './flavours/django/querySet.js';
export * from './flavours/django/manager.js';
export * from './flavours/django/model.js';
export * from './flavours/django/createModelInstance.js';
export * from './flavours/django/modelSummary.js';
export * from './config.js';

// React adaptor export with dynamic import
export function useReactLiveView(...args) {
  // Attempt to dynamically import React
  return import('react')
    .then(() => import('./adaptors/react.js'))
    .then(module => module.useReactLiveView(...args))
    .catch(e => {
      throw new Error('React is required for useReactLiveView');
    });
}

// Vue adaptor exports with dynamic imports
export function useVueLiveView(...args) {
  return import('vue')
    .then(() => import('./adaptors/vue.js'))
    .then(module => module.useVueLiveView(...args))
    .catch(e => {
      throw new Error('Vue is required for useVueLiveView');
    });
}

export function createVueLiveView(...args) {
  return import('vue')
    .then(() => import('./adaptors/vue.js'))
    .then(module => module.createVueLiveView(...args))
    .catch(e => {
      throw new Error('Vue is required for createVueLiveView');
    });
}

export function createVueOptionsMixin(...args) {
  return import('vue')
    .then(() => import('./adaptors/vue.js'))
    .then(module => module.createVueOptionsMixin(...args))
    .catch(e => {
      throw new Error('Vue is required for createVueOptionsMixin');
    });
}