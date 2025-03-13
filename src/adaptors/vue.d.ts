import { QuerySet } from "../flavours/django/querySet";
import { Model } from "../flavours/django/model";
import { LiveQuerySet, LiveQuerySetOptions } from "../core/liveView";
import type { Ref } from "vue";

/**
 * Creates a Vue 3 Composition API compatible LiveQuerySet.
 *
 * @param qs - The QuerySet to make live.
 * @param refValue - A Vue ref or raw array to sync with.
 * @param options - Options for the LiveQuerySet.
 * @returns A promise that resolves to a LiveQuerySet instance.
 */
export function createVueLiveView<T extends Model>(
  qs: QuerySet<T>,
  refValue: Ref<T[]> | T[],
  options?: LiveQuerySetOptions
): Promise<LiveQuerySet<T>>;

/**
 * Vue 3 Composition API hook for using LiveQuerySet.
 *
 * @param qs - The QuerySet to make live.
 * @param options - Options for the LiveQuerySet.
 * @returns A promise that resolves to a composable function. When invoked, it returns an object with `data`, `query`, and `loading` refs.
 *
 * @example
 * import { User } from '@/models';
 * import { useVueLiveView } from 'your-library/adaptors/vue';
 *
 * const useComposable = await useVueLiveView(User.objects.all());
 * const { data: users, query: usersQuery, loading } = useComposable();
 */
export function useVueLiveView<T extends Model>(
  qs: QuerySet<T>,
  options?: LiveQuerySetOptions
): Promise<() => {
  data: Ref<T[]>;
  query: Ref<LiveQuerySet<T> | null>;
  loading: Ref<boolean>;
}>;

/**
 * Vue 3 Options API mixin for using LiveQuerySet.
 *
 * @param qs - The QuerySet to make live.
 * @param propName - The data property name for the items. Defaults to 'items'.
 * @param queryName - The data property name for the query. Defaults to 'itemsQuery'.
 * @param options - Options for the LiveQuerySet.
 * @returns A promise that resolves to a Vue mixin object.
 *
 * @example
 * import { User } from '@/models';
 * import { createVueOptionsMixin } from 'your-library/adaptors/vue';
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
export function createVueOptionsMixin<T extends Model>(
  qs: QuerySet<T>,
  propName?: string,
  queryName?: string,
  options?: LiveQuerySetOptions
): Promise<{
  data: () => Record<string, any>;
  mounted: () => Promise<void>;
  beforeUnmount: () => void;
}>;
