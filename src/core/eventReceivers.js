import Pusher from 'pusher-js';

/**
 * Structure of events received from the server.
 * @typedef {Object} ModelEvent
 * @property {string} [type] - Support both frontend (type) and backend (event) naming conventions.
 * @property {string} [event]
 * @property {string} model
 * @property {any} [data]
 * @property {string} [operationId]
 * @property {string} [namespace]
 * @property {(string|number)[]} [instances] - For bulk events.
 * @property {string} [pk_field_name]
 * @property {any} [key] - Additional open-ended keys.
 */

/**
 * Event types that can be received from the server.
 * @readonly
 * @enum {string}
 */
export const EventType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  BULK_UPDATE: 'bulk_update',
  BULK_DELETE: 'bulk_delete'
};

/**
 * Callback for handling model events.
 * @callback EventHandler
 * @param {ModelEvent} event - The event object.
 */

/**
 * A namespace resolver function.
 * @callback NamespaceResolver
 * @param {string} modelName - The model name.
 * @returns {string} The namespace.
 */

/**
 * Options for instantiating a Pusher client.
 * @typedef {Object} PusherClientOptions
 * @property {string} appKey
 * @property {string} cluster
 * @property {boolean} [forceTLS]
 * @property {string} authEndpoint
 * @property {function(): Object<string, string>} [getAuthHeaders]
 */

/**
 * Configuration options for Pusher event receivers.
 * @typedef {Object} PusherReceiverOptions
 * @property {PusherClientOptions} clientOptions
 * @property {function(string): string} [formatChannelName] - Optional channel name formatter. Default: (namespace) => `private-${namespace}`
 * @property {NamespaceResolver} [namespaceResolver] - Optional namespace resolver. Default: (modelName) => modelName.
 */

/**
 * Implementation of EventReceiver that uses Pusher.
 */
export class PusherEventReceiver {
  /**
   * @param {PusherReceiverOptions} options 
   */
  constructor(options) {
    const { clientOptions, formatChannelName, namespaceResolver } = options;

    this.pusherClient = new Pusher(clientOptions.appKey, {
      cluster: clientOptions.cluster,
      forceTLS: clientOptions.forceTLS ?? true,
      authEndpoint: clientOptions.authEndpoint,
      auth: { headers: clientOptions.getAuthHeaders?.() || {} }
    });

    this.formatChannelName = formatChannelName ?? (ns => `private-${ns}`);
    this.namespaceResolver = namespaceResolver ?? (modelName => modelName);

    this.channels = new Map();
    this.eventHandlers = new Set();
  }

  /**
   * Set the namespace resolver function.
   * @param {NamespaceResolver} resolver 
   */
  setNamespaceResolver(resolver) {
    this.namespaceResolver = resolver;
  }

  /**
   * Connect to Pusher (no-op since Pusher handles connection automatically).
   */
  connect() {}

  /**
   * Subscribe to events for a specific namespace.
   * @param {string} namespace 
   */
  subscribe(namespace) {
    if (this.channels.has(namespace)) return;

    const channelName = this.formatChannelName(namespace);
    console.log(`Subscribing to channel: ${channelName}`);
    const channel = this.pusherClient.subscribe(channelName);

    channel.bind('pusher:subscription_succeeded', () => {
      console.log(`Subscription succeeded for channel: ${channelName}`);
    });

    channel.bind('pusher:subscription_error', status => {
      console.error(`Subscription error for channel: ${channelName}. Status:`, status);
    });

    Object.values(EventType).forEach(eventType => {
      channel.bind(eventType, data => {
        const event = { ...data, type: data.event || eventType, namespace };
        this.eventHandlers.forEach(handler => handler(event));
      });
    });

    this.channels.set(namespace, channel);
  }

  /**
   * Unsubscribe from events for a specific namespace.
   * @param {string} namespace 
   */
  unsubscribe(namespace) {
    const channel = this.channels.get(namespace);
    if (!channel) return;

    Object.values(EventType).forEach(eventType => channel.unbind(eventType));

    this.pusherClient.unsubscribe(this.formatChannelName(namespace));
    this.channels.delete(namespace);
  }

  /**
   * Disconnect from Pusher.
   */
  disconnect() {
    [...this.channels.keys()].forEach(ns => this.unsubscribe(ns));
    this.pusherClient.disconnect();
  }

  /**
   * Add an event handler callback.
   * @param {EventHandler} handler 
   */
  addEventHandler(handler) {
    this.eventHandlers.add(handler);
  }

  /**
   * Remove an event handler callback.
   * @param {EventHandler} handler 
   */
  removeEventHandler(handler) {
    this.eventHandlers.delete(handler);
  }

  /**
   * Get namespace from model name using the resolver.
   * @param {string} modelName 
   * @returns {string}
   */
  getNamespace(modelName) {
    return this.namespaceResolver(modelName);
  }
}

// Global instance management.
let currentEventReceiver = null;

/**
 * Set the global event receiver instance.
 * @param {EventReceiver} receiver 
 */
export function setEventReceiver(receiver) {
  if (currentEventReceiver) {
    currentEventReceiver.disconnect();
  }
  currentEventReceiver = receiver;
  currentEventReceiver.connect();
}

/**
 * Get the current global event receiver instance.
 * @returns {EventReceiver|null}
 */
export function getEventReceiver() {
  return currentEventReceiver;
}

/**
 * Set a custom namespace resolver function.
 * @param {NamespaceResolver} resolver 
 */
export function setNamespaceResolver(resolver) {
  const receiver = getEventReceiver();
  if (receiver) {
    receiver.setNamespaceResolver(resolver);
  }
}