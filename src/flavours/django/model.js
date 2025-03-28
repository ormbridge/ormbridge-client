import { Manager } from './manager.js';
import { getConfig } from '../../config.js';
import { ValidationError } from './errors.js';

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
  /**
   * Creates a new Model instance.
   *
   * @param {any} [data={}] - The data for initialization.
   */
  constructor(data = {}) {
    // The constructor doesnt need to do anything, as the data is assigned in the subclass constructor
  }

  /**
   * Returns the primary key of the model instance.
   *
   * @returns {number|undefined} The primary key.
   */
  get pk() {
    const ModelClass = this.constructor;
    return this[ModelClass.primaryKeyField];
  }

  /**
   * Sets the primary key of the model instance.
   *
   * @param {number|undefined} value - The new primary key value.
   */
  set pk(value) {
    const ModelClass = this.constructor;
    this[ModelClass.primaryKeyField] = value;
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
    const allowedFields = this.fields;
    
    for (const key of Object.keys(data)) {
      if (key === 'repr') continue;
      
      // Handle nested fields by splitting on double underscore
      // and taking just the base field name
      const baseField = key.split('__')[0];
      
      if (!allowedFields.includes(baseField)) {
        throw new ValidationError(
          `Invalid field: ${baseField}. Allowed fields are: ${allowedFields.join(', ')}`
        );
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
    return { ...this };
  }

  /**
   * Saves the model instance by either creating a new record or updating an existing one.
   *
   * @returns {Promise<Model>} A promise that resolves to the updated model instance.
   */
  async save() {
    const ModelClass = this.constructor;
    
    if (!this.pk) {
      // Create new instance
      const result = await ModelClass.objects.newQuerySet().executeQuery({
        type: 'create',
        data: this.serialize()
      });
      const newInstance = new ModelClass(result.data);
      Object.assign(this, newInstance);
    } else {
      // Update existing instance
      const result = await ModelClass.objects.newQuerySet().executeQuery({
        type: 'update_instance',
        filter: {
          type: 'filter',
          conditions: { [ModelClass.primaryKeyField]: this.pk }
        },
        data: this.serialize()
      });
      const newInstance = new ModelClass(result.data);
      Object.assign(this, newInstance);
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
    const modelName = ModelClass.modelName;
    const response = await ModelClass.objects.newQuerySet().executeQuery({
      type: 'delete_instance',
      filter: {
        type: 'filter',
        conditions: { [ModelClass.primaryKeyField]: this.pk }
      }
    });
    
    // The ASTParser._handle_delete_instance method returns the deleted count in response.data
    const deletedCount = response.data ? Number(response.data) : 0;
    
    // Format the response like Django's delete() return value
    return [deletedCount, { [modelName]: deletedCount }];
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
    const fresh = await ModelClass.objects.get({ [ModelClass.primaryKeyField]: this.pk });
    Object.assign(this, fresh);
  }
}
