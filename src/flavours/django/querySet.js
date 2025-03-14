/**
 * @typedef {'count'|'sum'|'avg'|'min'|'max'} AggregateFunction
 */

/**
 * @typedef {Object} Aggregation
 * @property {AggregateFunction} function - The aggregation function.
 * @property {string} field - The field to aggregate.
 * @property {string} [alias] - Optional alias for the aggregated field.
 */

/**
 * @typedef {'filter'|'or'|'and'|'not'|'exclude'|'get'|'create'|'update'|'delete'|'get_or_create'|'update_or_create'|'first'|'last'|'exists'|'search'} QueryOperationType
 */

/**
 * @typedef {Object} QueryNode
 * @property {QueryOperationType} type - The operation type.
 * @property {Object.<string, any>} [conditions] - Filter conditions.
 * @property {QueryNode[]} [children] - Child query nodes.
 * @property {any} [lookup] - Extra parameter for operations that need it.
 * @property {Partial<any>} [defaults] - Default values for create operations.
 * @property {number} [pk] - Primary key value.
 * @property {any} [data] - Data payload.
 * @property {string} [searchQuery] - Search term for search operations.
 * @property {string[]} [searchFields] - Optional array of field names for search.
 */

/**
 * @typedef {Object} SerializerOptions
 * @property {number} [depth] - How deep to serialize nested objects.
 * @property {string[]} [fields] - Fields to include.
 * @property {number} [limit] - Limit for pagination.
 * @property {number} [offset] - Offset for pagination.
 */

/**
 * @template T
 * @typedef {Object.<string, any>} FieldLookup
 */

/**
 * @template T
 * @typedef {Object.<string, any>} ObjectLookup
 */

/**
 * Django-specific Q helper type.
 *
 * A QCondition is either a partial object of type T or a combination
 * of partial field and object lookups.
 *
 * @template T
 * @typedef {Partial<T> | (Partial<FieldLookup<T>> & Partial<ObjectLookup<T>>)} QCondition
 */

/**
 * Django-specific Q helper type representing a logical grouping of conditions.
 *
 * @template T
 * @typedef {Object} QObject
 * @property {'AND'|'OR'} operator - The logical operator.
 * @property {Array<QCondition<T>|QObject<T>>} conditions - An array of conditions or nested Q objects.
 */

/**
 * Creates a Q object for combining conditions.
 *
 * @template T
 * @param {'AND'|'OR'} operator - The operator to combine conditions.
 * @param {...(QCondition<T>|QObject<T>)} conditions - The conditions to combine.
 * @returns {QObject<T>} The combined Q object.
 */
export function Q(operator, ...conditions) {
  return {
    operator,
    conditions,
  };
}

import { MultipleObjectsReturned, DoesNotExist, parseORMBridgeError } from './errors.js';
import { Model } from './model.js';
import axios from 'axios';
import { getConfig } from '../../config.js';

/**
 * A QuerySet provides a fluent API for constructing and executing queries.
 *
 * @template T
 */
export class QuerySet {
  /**
   * Creates a new QuerySet.
   *
   * @param {ModelConstructor} ModelClass - The model constructor.
   * @param {Object} [config={}] - The configuration for the QuerySet.
   * @param {QueryNode[]} [config.nodes] - Array of query nodes.
   * @param {Array<{ field: string, direction: 'asc'|'desc' }>} [config.orderBy] - Ordering configuration.
   * @param {Set<string>} [config.fields] - Set of fields to retrieve.
   * @param {Aggregation[]} [config.aggregations] - Aggregation operations.
   * @param {string[]} [config.selectRelated] - Related fields to select.
   * @param {string[]} [config.prefetchRelated] - Related fields to prefetch.
   * @param {string} [config.initialQueryset] - The initial queryset identifier.
   * @param {SerializerOptions} [config.serializerOptions] - Serializer options.
   * @param {boolean} [config.materialized] - Whether the queryset is materialized.
   * @param {T[]|null} [config.resultCache] - Cached results.
   */
  constructor(ModelClass, config = {}) {
    this.ModelClass = ModelClass;
    this.nodes = config.nodes || [];
    this._orderBy = config.orderBy;
    this._fields = config.fields || new Set();
    this._aggregations = config.aggregations || [];
    this._selectRelated = config.selectRelated || [];
    this._prefetchRelated = config.prefetchRelated || [];
    this._initialQueryset = config.initialQueryset;
    this._serializerOptions = config.serializerOptions || {};
    this._materialized = config.materialized || false;
    this._resultCache = config.resultCache || null;
  }

  /**
   * Clones this QuerySet, creating a new instance with the same configuration.
   *
   * @returns {QuerySet} A new QuerySet instance.
   */
  clone() {
    return new QuerySet(this.ModelClass, {
      nodes: [...this.nodes],
      orderBy: this._orderBy ? [...this._orderBy] : undefined,
      fields: new Set(this._fields),
      aggregations: [...this._aggregations],
      selectRelated: [...this._selectRelated],
      prefetchRelated: [...this._prefetchRelated],
      initialQueryset: this._initialQueryset,
      serializerOptions: { ...this._serializerOptions },
      materialized: this._materialized,
      resultCache: this._resultCache
    });
  }

  /**
   * Ensures the QuerySet is still lazy (not materialized).
   *
   * @private
   * @throws {Error} If the QuerySet is already materialized.
   */
  ensureNotMaterialized() {
    if (this._materialized) {
      throw new Error("Cannot chain further operations on a materialized QuerySet.");
    }
  }

  /**
   * Returns the model constructor for this QuerySet.
   *
   * @returns {ModelConstructor} The model constructor.
   */
  get modelClass() {
    return this.ModelClass;
  }

  /**
   * Filters the QuerySet with the provided conditions.
   *
   * @param {Object} conditions - The filter conditions.
   * @returns {QuerySet} A new QuerySet with the filter applied.
   */
  filter(conditions) {
    this.ensureNotMaterialized();
    
    const { Q: qConditions, ...filters } = conditions;
    const newNodes = [...this.nodes];
    
    if (Object.keys(filters).length > 0) {
      newNodes.push({
        type: 'filter',
        conditions: filters
      });
    }

    if (qConditions && qConditions.length) {
      newNodes.push({
        type: 'and',
        children: qConditions.map(q => this.processQObject(q))
      });
    }

    return new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      nodes: newNodes
    });
  }

  /**
   * Excludes the specified conditions from the QuerySet.
   *
   * @param {Object} conditions - The conditions to exclude.
   * @returns {QuerySet} A new QuerySet with the exclusion applied.
   */
  exclude(conditions) {
    this.ensureNotMaterialized();
    
    const { Q: qConditions, ...filters } = conditions;
    const newNodes = [...this.nodes];
    
    let childNode = null;
  
    if (Object.keys(filters).length > 0 && qConditions && qConditions.length) {
      childNode = {
        type: 'and',
        children: [
          { type: 'filter', conditions: filters },
          { type: 'and', children: qConditions.map(q => this.processQObject(q)) }
        ]
      };
    } else if (Object.keys(filters).length > 0) {
      childNode = {
        type: 'filter',
        conditions: filters
      };
    } else if (qConditions && qConditions.length) {
      childNode = {
        type: 'and',
        children: qConditions.map(q => this.processQObject(q))
      };
    }
  
    const excludeNode = {
      type: 'exclude',
      child: childNode
    };
  
    newNodes.push(excludeNode);
    
    return new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      nodes: newNodes
    });
  }

  /**
   * Specifies related fields to select.
   *
   * @param {...string} fields - The related fields.
   * @returns {QuerySet} A new QuerySet with selectRelated applied.
   */
  selectRelated(...fields) {
    this.ensureNotMaterialized();
    
    return new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      selectRelated: [...this._selectRelated, ...fields]
    });
  }

  /**
   * Specifies related fields to prefetch.
   *
   * @param {...string} fields - The related fields.
   * @returns {QuerySet} A new QuerySet with prefetchRelated applied.
   */
  prefetchRelated(...fields) {
    this.ensureNotMaterialized();
    
    return new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      prefetchRelated: [...this._prefetchRelated, ...fields]
    });
  }

  /**
   * Orders the QuerySet by the specified fields.
   *
   * @param {...string} fields - Fields to order by.
   * @returns {QuerySet} A new QuerySet with ordering applied.
   */
  orderBy(...fields) {
    this.ensureNotMaterialized();
    
    return new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      orderBy: fields
    });
  }

  /**
   * Applies a search to the QuerySet using the specified search query and fields.
   *
   * @param {string} searchQuery - The search query.
   * @param {string[]} [searchFields] - The fields to search.
   * @returns {QuerySet} A new QuerySet with the search applied.
   */
  search(searchQuery, searchFields) {
    this.ensureNotMaterialized();
    const newNodes = [...this.nodes];
    newNodes.push({
      type: 'search',
      searchQuery,
      searchFields: searchFields
    });
    return new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      nodes: newNodes
    });
  }

  /**
   * Processes a Q object or condition into a QueryNode.
   *
   * @private
   * @param {QObject|QCondition} q - The query object or condition.
   * @returns {QueryNode} The processed QueryNode.
   */
  processQObject(q) {
    if ('operator' in q && 'conditions' in q) {
      return {
        type: q.operator === 'AND' ? 'and' : 'or',
        children: Array.isArray(q.conditions) 
          ? q.conditions.map(c => this.processQObject(c))
          : []
      };
    } else {
      return {
        type: 'filter',
        conditions: q
      };
    }
  }

  /**
   * Aggregates the QuerySet using the specified function.
   *
   * @param {AggregateFunction} fn - The aggregation function.
   * @param {string} field - The field to aggregate.
   * @param {string} [alias] - An optional alias for the aggregated field.
   * @returns {QuerySet} A new QuerySet with the aggregation applied.
   */
  aggregate(fn, field, alias) {
    this.ensureNotMaterialized();
    
    return new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      aggregations: [...this._aggregations, {
        function: fn,
        field: field,
        alias
      }]
    });
  }

  /**
   * Executes a count query on the QuerySet.
   *
   * @param {string} [field] - The field to count.
   * @returns {Promise<number>} A promise that resolves to the count.
   */
  async count(field) {
    this.ensureNotMaterialized();
    
    const newQs = new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      materialized: true
    });
    
    const response = await newQs.executeQuery({
      ...newQs.build(),
      type: 'count',
      field: field || 'pk'
    });
    
    return response.data;
  }

  /**
   * Executes a sum aggregation on the QuerySet.
   *
   * @param {string} field - The field to sum.
   * @returns {Promise<number>} A promise that resolves to the sum.
   */
  async sum(field) {
    this.ensureNotMaterialized();
    
    const newQs = new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      materialized: true
    });
    
    const response = await newQs.executeQuery({
      ...newQs.build(),
      type: 'sum',
      field: field
    });
    
    return response.data;
  }

  /**
   * Executes an average aggregation on the QuerySet.
   *
   * @param {string} field - The field to average.
   * @returns {Promise<number>} A promise that resolves to the average.
   */
  async avg(field) {
    this.ensureNotMaterialized();
    
    const newQs = new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      materialized: true
    });
    
    const response = await newQs.executeQuery({
      ...newQs.build(),
      type: 'avg',
      field: field
    });
    
    return response.data;
  }

  /**
   * Executes a min aggregation on the QuerySet.
   *
   * @param {string} field - The field to find the minimum value for.
   * @returns {Promise<any>} A promise that resolves to the minimum value.
   */
  async min(field) {
    this.ensureNotMaterialized();
    
    const newQs = new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      materialized: true
    });
    
    const response = await newQs.executeQuery({
      ...newQs.build(),
      type: 'min',
      field: field
    });
    
    return response.data;
  }

  /**
   * Executes a max aggregation on the QuerySet.
   *
   * @param {string} field - The field to find the maximum value for.
   * @returns {Promise<any>} A promise that resolves to the maximum value.
   */
  async max(field) {
    this.ensureNotMaterialized();
    
    const newQs = new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      materialized: true
    });
    
    const response = await newQs.executeQuery({
      ...newQs.build(),
      type: 'max',
      field: field
    });
    
    return response.data;
  }

  /**
   * Retrieves the first record of the QuerySet.
   *
   * @param {SerializerOptions} [serializerOptions] - Optional serializer options.
   * @returns {Promise<T|null>} A promise that resolves to the first record or null.
   */
  async first(serializerOptions) {
    this.ensureNotMaterialized();
    
    const newQs = new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      serializerOptions: serializerOptions ? { ...this._serializerOptions, ...serializerOptions } : this._serializerOptions,
      materialized: true
    });
    
    const response = await newQs.executeQuery({
      ...newQs.build(),
      type: 'first'
    });
    
    if (Array.isArray(response.data)) {
      return response.data.length ? new this.ModelClass(response.data[0]) : null;
    }
    
    return response.data ? new this.ModelClass(response.data) : null;
  }

  /**
   * Retrieves the last record of the QuerySet.
   *
   * @param {SerializerOptions} [serializerOptions] - Optional serializer options.
   * @returns {Promise<T|null>} A promise that resolves to the last record or null.
   */
  async last(serializerOptions) {
    this.ensureNotMaterialized();
    
    const newQs = new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      serializerOptions: serializerOptions ? { ...this._serializerOptions, ...serializerOptions } : this._serializerOptions,
      materialized: true
    });
    
    const response = await newQs.executeQuery({
      ...newQs.build(),
      type: 'last'
    });
    
    if (Array.isArray(response.data)) {
      return response.data.length ? new this.ModelClass(response.data[response.data.length - 1]) : null;
    }
    
    return response.data ? new this.ModelClass(response.data) : null;
  }

  /**
   * Checks if any records exist in the QuerySet.
   *
   * @returns {Promise<boolean>} A promise that resolves to true if records exist, otherwise false.
   */
  async exists() {
    this.ensureNotMaterialized();
    
    const newQs = new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      materialized: true
    });
    
    const response = await newQs.executeQuery({
      ...newQs.build(),
      type: 'exists'
    });
    
    return Boolean(response.data);
  }

  /**
   * Applies serializer options to the QuerySet.
   *
   * @param {SerializerOptions} [serializerOptions] - Optional serializer options.
   * @returns {QuerySet} A new QuerySet with the serializer options applied.
   */
  all(serializerOptions) {
    this.ensureNotMaterialized();
    
    if (serializerOptions) {
      return new QuerySet(this.ModelClass, {
        ...this._getConfig(),
        serializerOptions: { ...this._serializerOptions, ...serializerOptions }
      });
    }
    
    return this;
  }

  /**
   * Updates records in the QuerySet.
   *
   * @param {Object} updates - The fields to update.
   * @returns {Promise<[number, Object]>} A promise that resolves to a tuple with the number of updated records and a mapping of model names to counts.
   */
  async update(updates) {
    if (arguments.length > 1){
        throw new Error('Update accepts only accepts an object of the updates to apply. Use filter() before calling update() to select elements.');
    }
    this.ensureNotMaterialized();
    
    const newQs = new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      materialized: true
    });
    
    const response = await newQs.executeQuery({
      ...newQs.build(),
      type: "update",
      data: updates,
    });
    
    const modelName = this.ModelClass.modelName;
    const updatedCount = response.metadata.rows_updated;
    
    return [updatedCount, { [modelName]: updatedCount }];
  }

  /**
   * Deletes records in the QuerySet.
   *
   * @returns {Promise<[number, Object]>} A promise that resolves to a tuple with the number of deleted records and a mapping of model names to counts.
   */
  async delete() {
    if (arguments.length > 0){
      throw new Error('delete() does not accept arguments and will delete the entire queryset. Use filter() before calling delete() to select elements.');
    }
    this.ensureNotMaterialized();
    
    const newQs = new QuerySet(this.ModelClass, {
      ...this._getConfig(),
      materialized: true
    });
    
    const response = await newQs.executeQuery({
      ...newQs.build(),
      type: "delete",
    });
    
    const modelName = this.ModelClass.modelName;
    const deletedCount = response.metadata.rows_deleted;
    
    return [deletedCount, { [modelName]: deletedCount }];
  }

  /**
   * Retrieves a single record from the QuerySet.
   *
   * @param {Object} [filters] - Optional filters to apply.
   * @param {SerializerOptions} [serializerOptions] - Optional serializer options.
   * @returns {Promise<T>} A promise that resolves to the retrieved record.
   * @throws {MultipleObjectsReturned} If more than one record is found.
   * @throws {DoesNotExist} If no records are found.
   */
  async get(filters, serializerOptions) {
    this.ensureNotMaterialized();
    
    let newQs = this;
    
    if (filters) {
      newQs = this.filter(filters);
    }
    
    if (serializerOptions) {
      newQs = new QuerySet(this.ModelClass, {
        ...newQs._getConfig(),
        serializerOptions: { ...newQs._serializerOptions, ...serializerOptions }
      });
    }
    
    const materializedQs = new QuerySet(this.ModelClass, {
      ...newQs._getConfig(),
      materialized: true
    });
    
    const response = await materializedQs.executeQuery({
      ...materializedQs.build(),
      type: 'get',
    });
    
    if (Array.isArray(response.data)) {
      if (response.data.length > 1) {
        throw new MultipleObjectsReturned();
      }
      if (response.data.length === 0) {
        throw new DoesNotExist();
      }
      return new this.ModelClass(response.data[0]);
    }
    
    return new this.ModelClass(response.data);
  }

  /**
   * Builds the final query object to be sent to the backend.
   *
   * @returns {Object} The final query object.
   */
  build() {
    let searchData = null;
    const nonSearchNodes = [];
    
    for (const node of this.nodes) {
      if (node.type === 'search') {
        searchData = {
          searchQuery: node.searchQuery || '',
          searchFields: node.searchFields
        };
      } else {
        nonSearchNodes.push(node);
      }
    }
    
    const filterNode = nonSearchNodes.length === 0 ? null :
      nonSearchNodes.length === 1 ? nonSearchNodes[0] : {
        type: 'and',
        children: nonSearchNodes
      };
  
    return {
      filter: filterNode,
      search: searchData,
      aggregations: this._aggregations,
      selectRelated: this._selectRelated,
      prefetchRelated: this._prefetchRelated,
      orderBy: this._orderBy,
      serializerOptions: this._serializerOptions
    };
  }

  /**
   * Executes the query against the backend.
   *
   * @param {Object} query - The query object.
   * @returns {Promise<Object>} A promise that resolves to the backend response.
   * @throws {Error} If the backend configuration is not found or the API call fails.
   */
  async executeQuery(query) {
    const config = getConfig();
    const backend = config.backendConfigs[this.ModelClass.configKey];
    if (!backend) {
      throw new Error(`No backend configuration found for key: ${this.ModelClass.configKey}`);
    }
    
    const { serializerOptions, ...restOfQuery } = query;
    
    const payload = { 
      ast: { 
        query: restOfQuery,
        serializerOptions 
      } 
    };
    
    const baseUrl = backend.API_URL.replace(/\/+$/, '');
    const finalUrl = `${baseUrl}/${this.ModelClass.modelName}/`;
    const headers = backend.getAuthHeaders ? backend.getAuthHeaders() : {};
    
    try {
      const response = await axios.post(finalUrl, payload, { headers });
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        const parsedError = parseORMBridgeError(error.response.data);
        if (Error.captureStackTrace) {
          Error.captureStackTrace(parsedError, this.executeQuery);
        }
        throw parsedError;
      }
      throw new Error(`API call failed: ${error.message}`);
    }
  }

  /**
   * Returns the current configuration of the QuerySet.
   *
   * @private
   * @returns {Object} The current QuerySet configuration.
   */
  _getConfig() {
    return {
      nodes: this.nodes,
      orderBy: this._orderBy,
      fields: this._fields,
      aggregations: this._aggregations,
      selectRelated: this._selectRelated,
      prefetchRelated: this._prefetchRelated,
      initialQueryset: this._initialQueryset,
      serializerOptions: this._serializerOptions
    };
  }

  /**
   * Materializes the QuerySet into an array of model instances.
   *
   * @param {SerializerOptions} [serializerOptions] - Optional serializer options.
   * @returns {Promise<T[]>} A promise that resolves to an array of model instances.
   */
  async fetch(serializerOptions) {
    if (this._resultCache) {
      return this._resultCache;
    }
    
    let querySet = this;
    
    if (serializerOptions) {
      querySet = new QuerySet(this.ModelClass, {
        ...this._getConfig(),
        serializerOptions: { ...this._serializerOptions, ...serializerOptions }
      });
    }
    
    const materializedQs = new QuerySet(this.ModelClass, {
      ...querySet._getConfig(),
      materialized: true
    });
    
    const response = await materializedQs.executeQuery({
      ...materializedQs.build(),
      type: 'read'
    });
    
    const results = response.data.map(item => new this.ModelClass(item));
    
    this._resultCache = results;
    
    return results;
  }
  
  /**
   * Implements the async iterator protocol so that you can iterate over the QuerySet.
   *
   * @returns {AsyncIterator<T>} An async iterator over the model instances.
   */
  async *[Symbol.asyncIterator]() {
    const items = await this.fetch();
    for (const item of items) {
      yield item;
    }
  }
}
