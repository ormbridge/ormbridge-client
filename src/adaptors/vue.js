import { ref, onBeforeUnmount } from 'vue';
import { QuerySet } from "../flavours/django/querySet";
import { Model } from "../flavours/django/model";
import { liveView } from "../core/liveView";

/**
 * Vue 3 hook for creating and using a LiveQuerySet.
 *
 * @param {QuerySet} querySet - The QuerySet to make live.
 * @param {Object} [options] - Options for the LiveQuerySet.
 * @returns {Promise<[Array, Object, boolean]>} A tuple containing:
 *  - data: An array of model instances.
 *  - query: The LiveQuerySet instance (or null if not yet initialized).
 *  - isLoading: A boolean indicating if data is still loading.
 *
 * @example
 * // In a Vue component:
 * import { User } from '@/models';
 * import { useLiveView } from '@/adaptors/vue';
 * 
 * const [users, query, isLoading] = await useLiveView(User.objects.all());
 * 
 * // In the template:
 * // <div v-if="isLoading">Loading...</div>
 * // <div v-for="user in users" :key="user.id">{{ user.name }}</div>
 */
export async function useLiveView(querySet, options) {
  // Create reactive data array
  const data = ref([]);
  const isLoading = ref(true);
  let liveQuerySet = null;
  
  try {
    // Create the LiveQuerySet with the reactive array
    liveQuerySet = await liveView(querySet, data.value, options);
    
    // Fetch initial data
    await liveQuerySet.fetch();
    
    // Set up cleanup on component unmount
    onBeforeUnmount(() => {
      if (liveQuerySet) {
        liveQuerySet.destroy();
      }
    });
  } catch (error) {
    console.error("Failed to initialize live view:", error);
    throw error;
  } finally {
    isLoading.value = false;
  }
  
  // Return the same structure as React's useReactLiveView
  return [data.value, liveQuerySet, isLoading.value];
}