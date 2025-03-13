/**
 * Minimal type definitions for field lookups.
 *
 * @template T
 * @typedef {Object.<string, any>} FieldLookup
 */

/**
 * Minimal type definitions for object lookups.
 *
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
