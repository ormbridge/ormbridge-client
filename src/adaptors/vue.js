// adaptors/vue.js
import { liveView } from "../core/liveView.js";

// Create placeholder functions that will be replaced if Vue is available
let ref = () => {
  throw new Error('Vue is required for Vue adaptors but was not found');
};

let onMounted = () => {
  throw new Error('Vue is required for Vue adaptors but was not found');
};

let onBeforeUnmount = () => {
  throw new Error('Vue is required for Vue adaptors but was not found');
};

// Try to load Vue using dynamic import - this won't block bundling
(async () => {
  try {
    const Vue = await import('vue');
    // If we get here, Vue is available, so update the functions
    ref = Vue.ref;
    onMounted = Vue.onMounted;
    onBeforeUnmount = Vue.onBeforeUnmount;
  } catch (e) {
    // Vue isn't available, keep using the placeholders
    console.debug('Vue not available, Vue adaptors will throw if used');
  }
})();

/**
 * Creates a Vue 3 Composition API compatible LiveQuerySet.
 *
 * @param {QuerySet} qs - The QuerySet to make live.
 * @param {object|Array} refValue - A Vue ref (object with a 'value' property) or a raw array to sync with.
 * @param {any} [options] - Options for the LiveQuerySet.
 * @returns {Promise<any>} Promise that resolves to a LiveQuerySet instance.
 */
export async function createVueLiveView(qs, refValue, options) {
  // Determine if we're given a ref (an object with a 'value' property)
  const isRef = typeof refValue === "object" && "value" in refValue;
  const reactiveArray = isRef ? refValue.value : refValue;
  
  // Create the LiveQuerySet with the reactive array
  const lqs = await liveView(qs, reactiveArray, options);
  
  // For Vue 3, reactivity is automatic via proxies
  return lqs;
}

/**
 * Vue 3 Composition API hook for using LiveQuerySet.
 *
 * @param {QuerySet} qs - The QuerySet to make live.
 * @param {any} [options] - Options for the LiveQuerySet.
 * @returns {Function} A function that, when called, returns an object with `data`, `query` and `loading` refs.
 */
export function useVueLiveView(qs, options) {
  // Return a composable function to be used in setup()
  return function useComposable() {
    const data = ref([]);
    const query = ref(null);
    const loading = ref(true);
    
    onMounted(async () => {
      try {
        query.value = await createVueLiveView(qs, data, options);
        await query.value.fetch();
      } finally {
        loading.value = false;
      }
    });
    
    onBeforeUnmount(() => {
      if (query.value) {
        query.value.destroy();
      }
    });
    
    return {
      data,
      query,
      loading
    };
  };
}

/**
 * Vue 3 Options API mixin for using LiveQuerySet.
 *
 * @param {QuerySet} qs - The QuerySet to make live.
 * @param {string} [propName='items'] - The data property name for the items.
 * @param {string} [queryName='itemsQuery'] - The data property name for the query.
 * @param {any} [options] - Options for the LiveQuerySet.
 * @returns {object} A Vue mixin object.
 */
export function createVueOptionsMixin(qs, propName = "items", queryName = "itemsQuery", options) {
  return {
    data() {
      const dataObj = {};
      dataObj[propName] = [];
      dataObj[queryName] = null;
      dataObj[`${propName}Loading`] = true;
      return dataObj;
    },
    
    async mounted() {
      try {
        // Use the reactive array from the component's data
        const reactiveArray = this[propName];
        // Create the LiveQuerySet
        this[queryName] = await liveView(qs, reactiveArray, options);
        // Fetch initial data
        await this[queryName].fetch();
      } finally {
        this[`${propName}Loading`] = false;
      }
    },
    
    beforeUnmount() {
      if (this[queryName]) {
        this[queryName].destroy();
        this[queryName] = null;
      }
    }
  };
}