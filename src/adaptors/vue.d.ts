import { QuerySet } from "../flavours/django/querySet";
import { Model } from "../flavours/django/model";
import { LiveQuerySet, LiveQuerySetOptions } from "../core/liveView";
import { Ref } from 'vue';

/**
 * Vue 3 hook for creating and using a LiveQuerySet.
 *
 * @param querySet - The QuerySet to make live.
 * @param options - Options for the LiveQuerySet.
 * @returns An object containing:
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
export function useLiveView<T extends Model = any>(
  querySet: QuerySet<T, any, any, any>,
  options?: LiveQuerySetOptions
): {
  data: Ref<T[]>;
  query: Ref<LiveQuerySet<T> | null>;
  isLoading: Ref<boolean>;
};