import { QuerySet } from './querySet.js';
import { Model } from './model.js';
import axios from 'axios';
import { getConfig } from '../../config.js';

/**
 * @typedef {Object} SerializerOptions
 * @property {number} [depth] - How deep to serialize nested objects.
 * @property {string[]} [fields] - List of fields to include.
 * @property {number} [limit] - Maximum number of items to retrieve.
 * @property {number} [offset] - Offset for pagination.
 */

/**
 * A custom data structure that behaves as an augmented array.
 * It stores [instance, created] and also provides named properties for clarity.
 *
 * @class ResultTuple
 * @extends {Array}
 */
export class ResultTuple extends Array {
  /**
   * Creates a new ResultTuple.
   *
   * @param {*} instance - The model instance.
   * @param {boolean} created - Whether the instance was created.
   */
  constructor(instance, created) {
    // Create an array with length 2.
    super(2);
    // Set array indices directly instead of using push.
    this[0] = instance;
    this[1] = created;
    // Set named properties.
    this.instance = instance;
    this.created = created;
  }
}

/**
 * Manager class providing helper methods to work with QuerySets and models.
 *
 * @class Manager
 */
export class Manager {
  /**
   * Creates a new Manager.
   *
   * @param {Function} ModelClass - The model's constructor.
   * @param {Function} [QuerySetClass=QuerySet] - The QuerySet class to use.
   */
  constructor(ModelClass, QuerySetClass = QuerySet) {
    this.ModelClass = ModelClass;
    this.QuerySetClass = QuerySetClass;
  }
  
  /**
   * Creates a new QuerySet instance.
   *
   * @returns {QuerySet} A new QuerySet instance for the model.
   */
  newQuerySet() {
    return new this.QuerySetClass(this.ModelClass);
  }

  /**
   * Creates a new custom QuerySet instance with an initial name.
   *
   * @param {string} name - The initial queryset name.
   * @returns {QuerySet} A new QuerySet instance for the model.
   */
  customQueryset(name) {
    return new this.QuerySetClass(this.ModelClass, {
      initialQueryset: name
    });
  }

  /**
   * Retrieves a single model instance matching the provided filters.
   *
   * @param {Object} [filters] - The filters to apply.
   * @param {SerializerOptions} [serializerOptions] - Options for serialization.
   * @returns {Promise<Model>} A promise that resolves to the model instance.
   */
  async get(filters, serializerOptions) {
    return this.newQuerySet().get(filters, serializerOptions);
  }

  /**
   * Filters the QuerySet based on the provided conditions.
   *
   * @param {*} conditions - The filter conditions.
   * @returns {QuerySet} A new QuerySet instance with the filters applied.
   */
  filter(conditions) {
    return this.newQuerySet().filter(conditions);
  }

  /**
   * Excludes the specified conditions from the QuerySet.
   *
   * @param {*} conditions - The conditions to exclude.
   * @returns {QuerySet} A new QuerySet instance with the conditions excluded.
   */
  exclude(conditions) {
    return this.newQuerySet().exclude(conditions);
  }

  /**
   * Returns a QuerySet representing all records.
   *
   * @returns {QuerySet} A new QuerySet instance.
   */
  all() {
    return this.newQuerySet();
  }

  /**
   * Deletes records in the QuerySet.
   *
   * @returns {Promise<[number, Object]>} A promise that resolves to an array where the first element is
   * the number of records deleted and the second is an object with details.
   */
  delete() {
    return this.newQuerySet().delete();
  }

  /**
   * Orders the QuerySet by the provided fields.
   *
   * @param {...(string|any)} fields - The fields to order by. Supports nested paths and descending order
   * (prefix field with '-').
   * @returns {QuerySet} A new QuerySet instance with the order applied.
   */
  orderBy(...fields) {
    return this.newQuerySet().orderBy(...fields);
  }

  /**
   * Creates a new model instance using the provided data, then saves it.
   *
   * @param {*} data - The data to create the model instance.
   * @returns {Promise<*>} A promise that resolves to the newly created model instance.
   */
  async create(data) {
    const instance = new this.ModelClass(data);
    await instance.save();
    return instance;
  }

  /**
   * Fetches all records using the current QuerySet.
   *
   * @param {SerializerOptions} [serializerOptions] - Options for serialization.
   * @returns {Promise<Array<*>>} A promise that resolves to an array of model instances.
   */
  async fetch(serializerOptions) {
    return this.all().fetch(serializerOptions);
  }

  /**
   * Retrieves or creates a model instance based on lookup fields and defaults.
   *
   * @param {*} lookupFields - The fields to lookup the model.
   * @param {Object} [options={}] - Options including defaults.
   * @param {*} [options.defaults={}] - Default values to use when creating a new instance.
   * @returns {Promise<ResultTuple>} A promise that resolves to a ResultTuple containing the model instance
   * and a boolean indicating whether it was created.
   */
  async getOrCreate(lookupFields, options = {}) {
    const { defaults = {} } = options;
    // Build the query node for get_or_create.
    const query = {
      type: 'get_or_create',
      lookup: lookupFields,
      defaults,
    };
    // Execute the query directly.
    const result = await this.ModelClass.objects.newQuerySet().executeQuery(query);
    const instance = new this.ModelClass(result.data);
    const created = result.metadata.created;
    return new ResultTuple(instance, created);
  }

  /**
   * Updates or creates a model instance based on lookup fields and defaults.
   *
   * @param {*} lookupFields - The fields to lookup the model.
   * @param {Object} [options={}] - Options including defaults.
   * @param {*} [options.defaults={}] - Default values to use when updating or creating the instance.
   * @returns {Promise<ResultTuple>} A promise that resolves to a ResultTuple containing the model instance
   * and a boolean indicating whether it was created.
   */
  async updateOrCreate(lookupFields, options = {}) {
    const { defaults = {} } = options;
    // Build the query node for update_or_create.
    const query = {
      type: 'update_or_create',
      lookup: lookupFields,
      defaults,
    };
    // Execute the query directly.
    const result = await this.ModelClass.objects.newQuerySet().executeQuery(query);
    const instance = new this.ModelClass(result.data);
    const created = result.metadata.created;
    return new ResultTuple(instance, created);
  }

  /**
   * Applies a search to the QuerySet using the specified search query and fields.
   *
   * @param {string} searchQuery - The search query.
   * @param {string[]} [searchFields] - The fields to search in.
   * @returns {QuerySet} A new QuerySet instance with the search applied.
   */
  search(searchQuery, searchFields) {
    return this.newQuerySet().search(searchQuery, searchFields);
  }
}
