import { Model } from './model.js';
import { Manager } from './manager.js';

/**
 * @typedef {Object} ModelConstructor
 * @property {(...args: any[]) => Model} new - Constructor function that creates a new Model.
 * @property {Object} objects - The manager or repository associated with the Model.
 */

/**
 * @typedef {Object} ModelSummaryFields
 * @property {(number|string)} id - The identifier.
 * @property {{ str: string, img?: string }} repr - The representation object.
 */

/**
 * @typedef {Function} ModelSummaryConstructor
 * @param {Object} data - The partial data for initializing the summary.
 * @returns {ModelSummary}
 *
 * @property {string} configKey - The configuration key.
 * @property {string} modelName - The model name.
 * @property {string} [primaryKeyField] - The primary key field (defaults to 'id' if not provided).
 * @property {ModelConstructor} fullModelConstructor - The constructor for the full model.
 */

/**
 * Base Summary class.
 * Note that this class does not extend Model.
 *
 * @abstract
 */
export class ModelSummary {
  /**
   * Creates a new ModelSummary instance.
   *
   * @param {Object} [data={}] - The summary data.
   */
  constructor(data = {}) {
    Object.assign(this, data);
    const SummaryClass = this.constructor;
    const pkField = SummaryClass.primaryKeyField || 'id';
    
    if (this[pkField] === undefined) {
      throw new Error(`Summary data must include '${pkField}' field.`);
    }
    
    if (
      !('repr' in this) ||
      typeof this.repr !== 'object' ||
      !('str' in this.repr)
    ) {
      throw new Error(
        `Summary data must include a 'repr' object with a 'str' property, but was: ${JSON.stringify(data)}`
      );
    }
  }

  /**
   * Getter for the primary key.
   *
   * @returns {(number|string)} The primary key value.
   */
  get pk() {
    const SummaryClass = this.constructor;
    const pkField = SummaryClass.primaryKeyField || 'id';
    return this[pkField];
  }

  /**
   * Converts this summary into a full model instance.
   *
   * @returns {Promise<Model>} A promise that resolves to the full model instance.
   */
  async toFullModel() {
    const SummaryClass = this.constructor;
    const fullModelCtor = SummaryClass.fullModelConstructor;
    const pkField = SummaryClass.primaryKeyField || 'id';
    return await fullModelCtor.objects.get({ [pkField]: this[pkField] });
  }

  /**
   * Serializes the summary instance.
   *
   * @returns {Partial<ModelSummaryFields>} An object containing the primary key field.
   */
  serialize() {
    const SummaryClass = this.constructor;
    const pkField = SummaryClass.primaryKeyField || 'id';
    return { [pkField]: this[pkField] };
  }
}
