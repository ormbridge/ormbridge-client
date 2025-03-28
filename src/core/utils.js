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

/**
 * Helper function to refetch items after delete operations, excluding items already present.
 * @param {LiveQuerySet} liveQuerySet - The LiveQuerySet instance.
 * @param {number} deletedCount - Number of deleted items to replace.
 * @param {string} operationId - Operation identifier for tracking.
 * @returns {Promise<void>}
 */
export async function refetchAfterDelete(liveQuerySet, deletedCount, operationId) {
  // Only refetch if we have a limit configured and a positive deleted count
  if (!liveQuerySet._serializerOptions?.limit || deletedCount <= 0) {
    return;
  }
  
  try {
    // Get the primary key field name
    const pkField = liveQuerySet.ModelClass.primaryKeyField || "id";
    
    // Get existing IDs from the current data array
    const existingIds = liveQuerySet.dataArray.map(item => item[pkField]);
    
    // Find the root queryset for refetching
    const rootQs = liveQuerySet.parent ? liveQuerySet._findRootQuerySet() : liveQuerySet.qs;
    
    // Build serializer options with a limit of deletedCount
    const serializerOptions = {
      ...liveQuerySet._serializerOptions,
      limit: deletedCount,
    };
    
    // Use the ORM's built-in exclude behavior to exclude existing IDs
    const newItems = await rootQs
      .exclude({ [`${pkField}__in`]: existingIds })
      .fetch(serializerOptions);
    
    if (newItems.length > 0) {
      // Insert the new items using the operations manager
      liveQuerySet.operationsManager.insert(`${operationId}_refetch`, newItems, {
        position: "append",
        limit: liveQuerySet._serializerOptions.limit,
        fixedPageSize: false
      });
    }
  } catch (refetchError) {
    console.warn("Error refetching items after delete:", refetchError);
  }
}