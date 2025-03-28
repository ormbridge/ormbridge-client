import * as arrayDiff from "fast-array-diff";

/**
 * Updates an array in place to match the target array with minimal operations
 * Based on comparing items by a primary key
 *
 * @param {Array} sourceArray - The array to update in place
 * @param {Array} targetArray - The target array with new/updated data
 * @param {string|Function} primaryKey - Primary key field name or comparison function
 * @returns {Array} - The updated sourceArray (same reference)
 */
export function updateArrayInPlace(sourceArray, targetArray, primaryKey = "id") {
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
    const compareFunc =
      typeof primaryKey === "function"
        ? primaryKey
        : (a, b) => a[primaryKey] === b[primaryKey];
  
    // Get the patch operations
    const patch = arrayDiff.getPatch(sourceArray, targetArray, compareFunc);
  
    // Apply patches to update the array in place
    for (const op of patch) {
      if (op.type === "remove") {
        sourceArray.splice(op.oldPos, op.items.length);
      } else if (op.type === "add") {
        sourceArray.splice(op.oldPos, 0, ...op.items);
      }
    }
    return sourceArray;
  }