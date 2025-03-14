import { QuerySet } from "../flavours/django/querySet";
import { Model } from "../flavours/django/model";
import { LiveQuerySet, LiveQuerySetOptions } from "../core/liveView";

/**
 * Vue 3 hook for creating and using a LiveQuerySet.
 *
 * @param querySet - The QuerySet to make live.
 * @param options - Options for the LiveQuerySet.
 * @returns A tuple containing:
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
export function useLiveView<T extends Model = any>(
  querySet: QuerySet<T, any, any, any>,
  options?: LiveQuerySetOptions
): Promise<[T[], LiveQuerySet<T> | null, boolean]>;