import Pusher from 'pusher-js';
import { Model } from "../flavours/django/model.js";

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
 * Base interface for all event receivers.
 * @typedef {Object} EventReceiver
 * @property {function(): void} connect - Connect to the event source.
 * @property {function(): void} disconnect - Disconnect from the event source.
 * @property {function(string): void} subscribe - Subscribe to events for a specific namespace.
 * @property {function(string): void} unsubscribe - Unsubscribe from events for a specific namespace.
 * @property {function(EventHandler): void} addEventHandler - Add an event handler callback.
 * @property {function(EventHandler): void} removeEventHandler - Remove an event handler callback.
 * @property {function(NamespaceResolver): void} setNamespaceResolver - Set the namespace resolver.
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
    const { appKey, cluster, forceTLS, authEndpoint, getAuthHeaders } = options.clientOptions;
    // Instantiate the Pusher client with auth options.
    this.pusherClient = new Pusher(appKey, {
      cluster,
      forceTLS: forceTLS !== undefined ? forceTLS : true,
      authEndpoint,
      auth: {
        headers: getAuthHeaders ? getAuthHeaders() : {}
      }
    });
    // Set channel formatter.
    this.formatChannelName = options.formatChannelName || ((namespace) => `private-${namespace}`);
    // Set namespace resolver.
    this.namespaceResolver = options.namespaceResolver || ((modelName) => modelName);
    /** @type {Map<string, any>} */
    this.channels = new Map(); // Map of namespace to Pusher channel.
    /** @type {Set<EventHandler>} */
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
  connect() {
    // Pusher manages connection automatically.
  }

  /**
   * Subscribe to events for a specific namespace.
   * @param {string} namespace 
   */
  subscribe(namespace) {
    if (this.channels.has(namespace)) {
      return;
    }
    // Format channel name as expected.
    const channelName = this.formatChannelName(namespace);
    console.log(`Subscribing to channel: ${channelName}`);
    const channel = this.pusherClient.subscribe(channelName);
    // Bind subscription success event.
    channel.bind('pusher:subscription_succeeded', () => {
      console.log(`Subscription succeeded for channel: ${channelName}`);
    });
    // Bind subscription error event.
    channel.bind('pusher:subscription_error', (status) => {
      console.error(`Subscription error for channel: ${channelName}. Status:`, status);
    });
    // Bind each event type and notify all registered event handlers.
    for (const eventType of Object.values(EventType)) {
      channel.bind(eventType, (data) => {
        /** @type {ModelEvent} */
        const event = {
          ...data,
          type: data.event || eventType,
          namespace: namespace
        };
        for (const handler of this.eventHandlers) {
          handler(event);
        }
      });
    }
    // Store the channel.
    this.channels.set(namespace, channel);
  }

  /**
   * Unsubscribe from events for a specific namespace.
   * @param {string} namespace 
   */
  unsubscribe(namespace) {
    if (!this.channels.has(namespace)) {
      return;
    }
    const channel = this.channels.get(namespace);
    // Unbind all event handlers.
    for (const eventType of Object.values(EventType)) {
      channel.unbind(eventType);
    }
    // Unsubscribe from the channel.
    const channelName = this.formatChannelName(namespace);
    this.pusherClient.unsubscribe(channelName);
    this.channels.delete(namespace);
  }

  /**
   * Disconnect from Pusher.
   */
  disconnect() {
    for (const namespace of this.channels.keys()) {
      this.unsubscribe(namespace);
    }
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
