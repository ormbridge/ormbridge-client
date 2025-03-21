import * as arrayDiff from 'fast-array-diff';
import { v4 as uuidv4 } from 'uuid';

/**
 * Updates an array in place to match the target array with minimal operations
 * Based on comparing items by a primary key
 * 
 * @param {Array} sourceArray - The array to update in place
 * @param {Array} targetArray - The target array with new/updated data
 * @param {string|Function} primaryKey - Primary key field name or comparison function
 * @returns {Array} - The updated sourceArray (same reference)
 */
export function updateArrayInPlace(sourceArray, targetArray, primaryKey = 'id') {
  // Handle empty arrays
  if (targetArray.length === 0) {
    sourceArray.length = 0;
    return sourceArray;
  }
  
  if (sourceArray.length === 0) {
    sourceArray.push(...targetArray);
    return sourceArray;
  }
  
  // Create comparison function
  const compareFunc = typeof primaryKey === 'function' 
    ? primaryKey 
    : (a, b) => a[primaryKey] === b[primaryKey];
  
  // Get the patch operations
  const patch = arrayDiff.getPatch(sourceArray, targetArray, compareFunc);
  
  // Apply patches to update the array in place
  for (const op of patch) {
    if (op.type === 'remove') {
      sourceArray.splice(op.oldPos, op.items.length);
    } else if (op.type === 'add') {
      sourceArray.splice(op.oldPos, 0, ...op.items);
    }
  }
  return sourceArray;
}

/**
 * Helper function to handle item insertion logic consistently
 * 
 * @param {Array} dataArray - The array to insert items into
 * @param {Array|Object} items - Single item or array of items to insert
 * @param {'prepend'|'append'} position - Where to insert items (beginning or end)
 * @param {Object} options - Additional options
 * @param {number} [options.limit] - Maximum number of items
 * @param {boolean} [options.fixedPageSize] - Whether to maintain fixed page size
 * @param {boolean} [options.strictMode] - Legacy option for fixed page size
 * @param {Function} notifyCallback - Function to call to notify of changes
 * @returns {boolean} - Whether any items were actually inserted
 */
export function handleItemInsertion(dataArray, items, position, options, notifyCallback) {
  // Convert single item to array for consistent handling
  const itemsArray = Array.isArray(items) ? items : [items];
  if (itemsArray.length === 0) return false;
  
  const limit = options.limit;
  const hasFixedSize = options.fixedPageSize || options.strictMode;
  
  // If we're appending and at limit with fixed size, don't add new items
  if (position === 'append' && limit !== undefined && hasFixedSize && dataArray.length >= limit) {
    return false;
  }
  
  // For prepend with fixed size, make room by removing from the end
  if (position === 'prepend' && limit !== undefined && hasFixedSize) {
    const availableSpace = Math.max(0, limit - dataArray.length);
    
    if (availableSpace === 0) {
      // Remove items from the end to make space for new ones
      const itemsToRemove = Math.min(itemsArray.length, dataArray.length);
      dataArray.splice(dataArray.length - itemsToRemove);
      notifyCallback('delete');
    } else if (itemsArray.length > availableSpace) {
      // Remove just enough items from the end
      dataArray.splice(dataArray.length - (itemsArray.length - availableSpace));
      notifyCallback('delete');
    }
  }
  
  // Insert the items according to position
  if (position === 'prepend') {
    // Add items to the beginning
    dataArray.unshift(...itemsArray);
  } else {
    // Add items to the end, respecting the limit
    if (limit !== undefined && !hasFixedSize) {
      const remainingSpace = limit - dataArray.length;
      if (remainingSpace > 0) {
        // Only add up to the remaining space
        dataArray.push(...itemsArray.slice(0, remainingSpace));
      } else {
        return false; // No space left
      }
    } else {
      // No limit or has fixed size, add all items
      dataArray.push(...itemsArray);
    }
  }
  
  notifyCallback('create');
  return true;
}

/**
 * Generates a new operation ID.
 * @returns {string} The generated operation ID.
 */
export function generateOperationId() {
  return 'op_' + uuidv4();
}

/**
 * A mutable set to track all active operation IDs.
 * @type {Set<string>}
 */
export const activeOperationIds = new Set();

/**
 * Wrap an async function with a generated operationId.
 * The operationId is added to the global set and removed once the operation completes.
 *
 * @template T
 * @param {function(string): Promise<T>} fn - An async function that accepts an operationId.
 * @returns {Promise<T>} The result of the function.
 */
export async function withOperationId(fn) {
  const operationId = generateOperationId();
  activeOperationIds.add(operationId);
  try {
    return await fn(operationId);
  }
  finally {
    activeOperationIds.delete(operationId);
  }
}