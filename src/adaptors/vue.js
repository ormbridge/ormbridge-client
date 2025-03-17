import { ref, onBeforeUnmount } from 'vue';
import { liveView } from "../core/liveView";

/**
 * Vue 3 hook for creating and using a LiveQuerySet.
 *
 * @param {QuerySet} querySet - The QuerySet to make live.
 * @param {Object} [options] - Options for the LiveQuerySet.
 * @returns {Object} An object containing:
 *  - data: A ref containing an array of model instances.
 *  - query: A ref containing the LiveQuerySet instance (or null if not yet initialized).
 *  - isLoading: A ref indicating if data is still loading.
 *
 * @example
 * // In a Vue component:
 * import { User } from '@/models';
 * import { useLiveView } from '@/adaptors/vue';
 * 
 * setup() {
 *   const { data: users, query, isLoading } = useLiveView(User.objects.all());
 *   return { users, query, isLoading };
 * }
 * 
 * // In the template:
 * // <div v-if="isLoading">Loading...</div>
 * // <div v-for="user in users" :key="user.id">{{ user.name }}</div>
 */
export function useLiveView(querySet, options) {
  // Use ref for the data array to ensure proper reactivity with mutations
  const data = ref([]);
  const isLoading = ref(true);
  const query = ref(null);
  
  // Initialize the live query
  (async () => {
    try {
      let createMetricFn = (value) => ref(value);

      // Create the LiveQuerySet with the reactive array
      // Pass data.value to work with the underlying array
      query.value = await liveView(querySet, data.value, options, createMetricFn);
      
      // Fetch initial data
      await query.value.fetch();
      
    } catch (error) {
      console.error("Failed to initialize live view:", error);
    } finally {
      isLoading.value = false;
    }
  })();
  
  // Set up cleanup on component unmount
  onBeforeUnmount(() => {
    if (query.value) {
      query.value.destroy();
    }
  });
  
  // Return reactive objects
  return {
    data,
    query,
    isLoading
  };
}