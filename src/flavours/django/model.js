import { Manager } from './manager.js';
import { getConfig } from '../../config.js';
import { ValidationError } from './errors.js';
import { modelStoreRegistry } from '../../syncEngine/registries/modelStoreRegistry.js';
import { isNil } from 'lodash-es';
import { QueryExecutor } from './queryExecutor.js';

/**
 * A constructor for a Model.
 *
 * @typedef {Function} ModelConstructor
 * @param {any} data - Data to initialize the model.
 * @returns {Model}
 *
 * @property {Manager} objects - The model's manager.
 * @property {string} configKey - The configuration key.
 * @property {string} modelName - The model name.
 * @property {string} primaryKeyField - The primary key field (default 'id').
 */

/**
 * Base Model class with integrated API implementation.
 *
 * @abstract
 */
export class Model {
  // Private data store for all field values
  #_data = {};
  #_pk = undefined;

  /**
   * Creates a new Model instance.
   *
   * @param {any} [data={}] - The data for initialization.
   */
  constructor(data = {}) {
    // Initialize internal data store
    this.#_data = {};
    this.#_pk = null
  }

  /**
   * Returns the primary key of the model instance.
   *
   * @returns {number|undefined} The primary key.
   */
  get pk() {
    return this.#_pk
  }

  /**
   * Instantiate a model via the global registry rather than with local data
   */
  static from(data, write = true) {
    // this is the concrete model class (e.g., Product)
    if (write){
      modelStoreRegistry.setEntity(this, data[this.primaryKeyField], data);
    }
    let verify = modelStoreRegistry.getEntity(this, data[this.primaryKeyField])
    const instance = new this();
    instance.#_pk = data[this.primaryKeyField];
    return instance;
  }

  /**
   * Sets the primary key of the model instance.
   *
   * @param {number|undefined} value - The new primary key value.
   */
  set pk(value) {
    this.#_pk = value
  }

  /**
   * Gets a field value from the internal data store
   * 
   * @param {string} field - The field name
   * @returns {any} The field value
   */
  getField(field) {
    const ModelClass = this.constructor
    if (ModelClass.primaryKeyField === field) return this.#_pk;
    
    // check local overrides
    let value = this.#_data[field];
    // if its not been overridden, get it from the store
    if (isNil(value) && !isNil(this.#_pk)){
      let storedValue = modelStoreRegistry.getEntity(ModelClass, this.#_pk)
      if (storedValue) value = storedValue[field]; // if stops null -> undefined
    }

    // relationship fields need special handling
    if (ModelClass.relationshipFields.has(field) && value){
      // fetch the stored value
      let fieldInfo = ModelClass.relationshipFields.get(field)
      let relPkField = fieldInfo.ModelClass.primaryKeyField
      switch (fieldInfo.relationshipType){
        case 'many-to-many':
          // value is an array
          if (!Array.isArray(value) && value) throw new Error(`Data corruption: m2m field for ${ModelClass.modelName} stored as ${value}`)
          // set each pk to the full model object for that pk
          value = value.map(pkOrObj =>
            modelStoreRegistry.getEntity(fieldInfo.ModelClass, pkOrObj[relPkField] || pkOrObj)
            || {[relPkField]: pkOrObj})
          break
        case 'one-to-one':
        case 'foreign-key':
          // set the value to the full model object
          value = value[relPkField] || value
          if (!isNil(value)) value = modelStoreRegistry.getEntity(fieldInfo.ModelClass, value) || {[relPkField]: value}
          break
      }
    }
    return value
  }

  /**
   * Sets a field value in the internal data store
   * 
   * @param {string} field - The field name
   * @param {any} value - The field value to set
   */
  setField(field, value) {
    const ModelClass = this.constructor
    if (ModelClass.primaryKeyField === field){
      this.#_pk = value
    } else {
      this.#_data[field] = value;
    }
  }

  /**
   * Validates that the provided data object only contains keys
   * defined in the model's allowed fields. Supports nested fields
   * using double underscore notation (e.g., author__name).
   *
   * @param {Object} data - The object to validate.
   * @throws {ValidationError} If an unknown key is found.
   */
  static validateFields(data) {
    if (isNil(data)) return;
    const allowedFields = this.fields;
    
    for (const key of Object.keys(data)) {
      if (key === 'repr' || key === 'type') continue;
      
      // Handle nested fields by splitting on double underscore
      // and taking just the base field name
      const baseField = key.split('__')[0];
      
      if (!allowedFields.includes(baseField)) {
        let errorMsg = `Invalid field: ${baseField}. Allowed fields are: ${allowedFields.join(', ')}`
        console.error(errorMsg)
        throw new ValidationError(errorMsg);
      }
    }
  }

  /**
   * Serializes the model instance.
   *
   * By default, it returns all enumerable own properties.
   * Subclasses should override this to return specific keys.
   *
   * @returns {Object} The serialized model data.
   */
  serialize() {
    const serialized = {};
    const ModelClass = this.constructor;
    
    // Include all fields defined in the model
    for (const field of ModelClass.fields) {
      serialized[field] = this.getField(field);
    }
    
    return serialized;
  }

  /**
   * Saves the model instance by either creating a new record or updating an existing one.
   *
   * @returns {Promise<Model>} A promise that resolves to the updated model instance.
   */
  async save() {
    const ModelClass = this.constructor;
    const querySet = ModelClass.objects.newQuerySet();
    
    if (!this.pk) {
      // Create new instance
      const instance = await QueryExecutor.execute(querySet, 'create', {
        data: this.serialize()
      });
      
      this.#_pk = instance.pk;
      this.#_data = {}; // Clear local data as it's now in the store
    } else {
      // Update existing instance
      const querySetWithFilter = ModelClass.objects.newQuerySet().filter({ 
        [ModelClass.primaryKeyField]: this.pk 
      });
      
      await QueryExecutor.execute(querySetWithFilter, 'update_instance', {
        data: this.serialize()
      });
      
      // Clear local data as it's now updated in the store
      this.#_data = {};
    }
    
    return this;
  }

  /**
   * Deletes the instance from the database.
   *
   * Returns a tuple with the number of objects deleted and an object mapping
   * model names to the number of objects deleted, matching Django's behavior.
   *
   * @returns {Promise<[number, Object]>} A promise that resolves to the deletion result.
   * @throws {Error} If the instance has not been saved (no primary key).
   */
  async delete() {
    if (!this.pk) {
      throw new Error('Cannot delete unsaved instance');
    }
    
    const ModelClass = this.constructor;
    const querySet = ModelClass.objects.newQuerySet().filter({ 
      [ModelClass.primaryKeyField]: this.pk 
    });
    
    return await QueryExecutor.execute(querySet, 'delete_instance', {
      [ModelClass.primaryKeyField]: this.pk
    });
  }

  /**
   * Refreshes the model instance with data from the database.
   *
   * @returns {Promise<void>} A promise that resolves when the instance has been refreshed.
   * @throws {Error} If the instance has not been saved (no primary key).
   */
  async refreshFromDb() {
    if (!this.pk) {
      throw new Error('Cannot refresh unsaved instance');
    }
    
    const ModelClass = this.constructor;
    const querySet = ModelClass.objects.newQuerySet().filter({
      [ModelClass.primaryKeyField]: this.pk
    });
    
    const fresh = await QueryExecutor.execute(querySet, 'get');
    
    // Update all fields from the fresh instance
    for (const field of ModelClass.fields) {
      if (fresh && fresh.getField(field) !== undefined) {
        this.setField(field, fresh.getField(field));
      }
    }
  }
}