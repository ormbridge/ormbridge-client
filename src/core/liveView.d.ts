/**
 * Serializer options for serializing nested objects.
 */
export interface SerializerOptions {
    /** How deep to serialize nested objects. */
    depth?: number;
    /** List of fields to include. */
    fields?: string[];
    /** Maximum number of items to retrieve. */
    limit?: number;
    /** Offset for pagination. */
    offset?: number;
  }
  
  /**
   * Options for configuring a LiveQuerySet.
   */
  export interface LiveQuerySetOptions {
    /**
     * Custom operation ID generator function.
     */
    operationIdGenerator?: () => string;
    /**
     * Custom namespace to append to the model name.
     */
    customNamespace?: string;
    /**
     * Serializer options.
     */
    serializer?: SerializerOptions;
    /**
     * Overfetch size - this is a cache of items that is maintained in sync with the db to immediately replace deleted items
     */
    overfetchSize?: number;
  }
  