import { QuerySet } from "../flavours/django/querySet";
import { liveView } from "../core/liveView";

// Import Vue directly - the parent entry point (src/vue.js) will handle the error checking
// We can use a regular import here since this file will only be used when Vue is available
import * as Vue from "vue";

/**
 * Creates a Vue 3 Composition API compatible LiveQuerySet.
 *
 * @param {QuerySet} qs - The QuerySet to make live.
 * @param {object|Array} refValue - A Vue ref (object with a 'value' property) or a raw array to sync with.
 * @param {any} [options] - Options for the LiveQuerySet.
 * @returns {Promise<any>} Promise that resolves to a LiveQuerySet instance.
 *
 * @example
 * // In a Vue component using the Composition API:
 * import { ref, onBeforeUnmount } from 'vue';
 * import { User } from '@/models';
 * import { createVueLiveView } from '@ormbridge/core/vue';
 * 
 * const users = ref([]);
 * let usersQuery = null;
 * 
 * createVueLiveView(User.objects.all(), users)
 *   .then(query => {
 *     usersQuery = query;
 *   });
 * 
 * onBeforeUnmount(() => {
 *   if (usersQuery) {
 *     usersQuery.destroy();
 *   }
 * });
 *
 * const addUser = async () => {
 *   await usersQuery.create({ name: 'New User' });
 * };
 */
export async function createVueLiveView(qs, refValue, options) {
  // Determine if we're given a ref (an object with a 'value' property)
  const isRef = typeof refValue === "object" && "value" in refValue;
  const reactiveArray = isRef ? refValue.value : refValue;
  
  // Create the LiveQuerySet with the reactive array.
  const lqs = await liveView(qs, reactiveArray, options);
  
  // For Vue 3, reactivity is automatic via proxies.
  return lqs;
}

/**
 * Vue 3 Composition API hook for using LiveQuerySet.
 *
 * @param {QuerySet} qs - The QuerySet to make live.
 * @param {any} [options] - Options for the LiveQuerySet.
 * @returns {Promise<Function>} A function that, when called, returns an object with `data`, `query` and `loading` refs.
 *
 * @example
 * // In a Vue component using the Composition API:
 * import { User } from '@/models';
 * import { useVueLiveView } from '@ormbridge/core/vue';
 * 
 * const useComposable = await useVueLiveView(User.objects.all());
 * const { data: users, query: usersQuery, loading } = useComposable();
 *
 * const addUser = async () => {
 *   await usersQuery.value.create({ name: 'New User' });
 * };
 */
export async function useVueLiveView(qs, options) {
  const { ref, onMounted, onBeforeUnmount } = Vue;
  
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
 * @returns {Promise<object>} A Vue mixin object.
 *
 * @example
 * // In a Vue Options API component:
 * import { User } from '@/models';
 * import { createVueOptionsMixin } from '@ormbridge/core/vue';
 * 
 * export default {
 *   mixins: [await createVueOptionsMixin(User.objects.all())],
 *   methods: {
 *     async addUser() {
 *       await this.itemsQuery.create({ name: 'New User' });
 *     }
 *   }
 * };
 */
export async function createVueOptionsMixin(qs, propName = "items", queryName = "itemsQuery", options) {
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
        // Use the reactive array from the component's data.
        const reactiveArray = this[propName];
        // Create the LiveQuerySet.
        this[queryName] = await liveView(qs, reactiveArray, options);
        // Fetch initial data.
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