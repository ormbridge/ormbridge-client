import * as yup from 'yup';
import { ConfigError } from './flavours/django/errors.js';
import {
  PusherEventReceiver,
  setEventReceiver
} from './core/eventReceivers.js';

// The live configuration object. By default it is empty.
export let liveConfig = {
  backendConfigs: {}
};

// --- Yup Schemas ---

const pusherSchema = yup.object({
  clientOptions: yup.object({
    appKey: yup.string().required('Pusher appKey is required'),
    cluster: yup.string().required('Pusher cluster is required'),
    forceTLS: yup.boolean(),
    authEndpoint: yup.string().url().required('Pusher authentication endpoint URL is required'),
    getAuthHeaders: yup.mixed().test(
      'isFunction',
      'getAuthHeaders must be a function if provided',
      (value) => value === undefined || typeof value === 'function'
    )
  }).required()
});

const eventConfigSchema = yup.object({
  type: yup.string().oneOf(['websocket', 'pusher', 'none']).required(),
  websocketUrl: yup.string().url().when('type', {
    is: 'websocket',
    then: (schema) => schema.required('WebSocket URL is required for WebSocket event receiver')
  }),
  pusher: yup.object().when('type', {
    is: 'pusher',
    then: (schema) => pusherSchema.required('Pusher configuration is required for Pusher event receiver')
  })
});

const backendSchema = yup.object({
  API_URL: yup.string().url().required(),
  GENERATED_TYPES_DIR: yup.string().required(),
  getAuthHeaders: yup.mixed().test(
    'isFunction',
    'getAuthHeaders must be a function if provided',
    (value) => value === undefined || typeof value === 'function'
  ),
  eventInterceptor: yup.mixed().test(
    'isFunction',
    'eventInterceptor must be a function if provided',
    (value) => value === undefined || typeof value === 'function'
  ),
  events: yup.lazy((value) =>
    value === undefined ? yup.mixed().notRequired() : eventConfigSchema
  )
});

const configSchema = yup.object({
  backendConfigs: yup.object().test(
    'backendConfigsSchema',
    'Each backend config must be valid',
    function (value) {
      if (typeof value !== 'object' || value === null) return false;
      for (const [key, backend] of Object.entries(value)) {
        try {
          backendSchema.validateSync(backend, { abortEarly: false });
        } catch (err) {
          return this.createError({
            message: `Backend "${key}" is invalid: ${err.errors.join(', ')}`
          });
        }
      }
      return true;
    }
  ).required()
});

// Internal variable to hold the validated configuration.
let config = null;

/**
 * Sets the entire configuration, validating it before storing.
 * If the configuration is invalid, it throws a ConfigError.
 */
export function setConfig(newConfig) {
  liveConfig = newConfig;
  try {
    config = configSchema.validateSync(liveConfig, { abortEarly: false });
  } catch (error) {
    throw new ConfigError(`Error setting configuration: ${error.message}`);
  }
}

/**
 * Retrieves the validated configuration.
 * If no configuration has been set, it throws a ConfigError.
 */
export function getConfig() {
  if (!config) {
    throw new ConfigError('Configuration not set. Please call setConfig() with a valid configuration.');
  }
  return config;
}

/**
 * Merges a partial override into an existing backend config.
 */
export function setBackendConfig(backendKey, newConfig) {
  try {
    const cfg = getConfig();
    if (!cfg.backendConfigs[backendKey]) {
      throw new ConfigError(`Backend "${backendKey}" not found in configuration.`);
    }
    const merged = { ...cfg.backendConfigs[backendKey], ...newConfig };
    const validated = backendSchema.validateSync(merged, { abortEarly: false });
    cfg.backendConfigs[backendKey] = validated;
  } catch (error) {
    throw new ConfigError(error.message || 'Invalid backend configuration');
  }
}

/**
 * Initializes the event receiver based on the configuration.
 */
export function initializeEventReceiver(backendKey = 'default') {
  try {
    const cfg = getConfig();
    if (!cfg.backendConfigs[backendKey]) {
      throw new ConfigError(`Backend "${backendKey}" not found in configuration.`);
    }
    const backendConfig = cfg.backendConfigs[backendKey];
    if (!backendConfig.events) {
      return null;
    }
    let receiver = null;
    switch (backendConfig.events.type) {
      case 'pusher':
        if (!backendConfig.events.pusher || !backendConfig.events.pusher.clientOptions) {
          throw new ConfigError('Pusher client options are required for Pusher event receiver.');
        }
        if (!backendConfig.events.pusher.clientOptions.authEndpoint) {
          throw new ConfigError('Pusher auth endpoint is required for Pusher event receiver.');
        }
        const clientOptions = {
          ...backendConfig.events.pusher.clientOptions,
          getAuthHeaders: backendConfig.events.pusher.clientOptions.getAuthHeaders || backendConfig.getAuthHeaders
        };
        receiver = new PusherEventReceiver({ clientOptions });
        break;
      case 'none':
        return null;
      default:
        throw new ConfigError(`Unknown event receiver type: ${backendConfig.events.type}`);
    }
    if (receiver) {
      setEventReceiver(receiver);
    }
    return receiver;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(`Failed to initialize event receiver: ${error.message}`);
  }
}

/**
 * Exposes a singleton object for configuration functionality.
 */
export const configInstance = {
  setConfig,
  getConfig,
  setBackendConfig,
  initializeEventReceiver
};

export default configInstance;
