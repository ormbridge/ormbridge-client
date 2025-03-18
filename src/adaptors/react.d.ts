import { QuerySet } from "../flavours/django/querySet";
import { Model } from "../flavours/django/model";
import { LiveQuerySet, LiveQuerySetOptions } from "../core/liveView";

/**
 * Custom hook to use a live metric with React state.
 *
 * @param metricFn - Function that returns a metric promise or null.
 * @param defaultValue - Default value to use when metric is not available.
 * @returns The current value of the metric.
 */
export declare function useLiveMetric<T = any>(
  metricFn: (() => Promise<any>) | null,
  defaultValue?: T
): T | null;

/**
 * React hook for creating and using a LiveQuerySet with reactive queries.
 *
 * @param queryInput - The QuerySet to make live or a function that returns a QuerySet.
 * @param options - Options for the LiveQuerySet.
 * @param deps - Optional array of dependencies to control when the hook should reinitialize.
 * @returns A tuple containing:
 *  - data: An array of model instances.
 *  - query: The LiveQuerySet instance (or null if not yet initialized).
 *  - isLoading: A boolean indicating if data is still loading.
 *
 * @example
 * // With a static query
 * function UserList() {
 *   const [users, query, isLoading] = useLiveView(User.objects.all());
 *   if (isLoading) return <p>Loading...</p>;
 *   return (
 *     <div>
 *       {users.map(user => (
 *         <div key={user.id}>{user.name}</div>
 *       ))}
 *       <button onClick={() => query?.create({ name: 'New User' })}>
 *         Add User
 *       </button>
 *     </div>
 *   );
 * }
 * 
 * // With a reactive query
 * function FilteredUserList({ departmentId }) {
 *   const [users, query, isLoading] = useLiveView(
 *     () => User.objects.filter({ department: departmentId }).all(),
 *     { limit: 20 }
 *   );
 * }
 * 
 * // With explicit dependencies
 * function UserPosts({ userId, pageSize }) {
 *   const queryFn = () => Post.objects.filter({ author: userId }).all();
 *   const [posts, query, isLoading] = useLiveView(
 *     queryFn,
 *     { limit: pageSize },
 *     [userId, pageSize]
 *   );
 * }
 */
export declare function useLiveView<T extends Model>(
  queryInput: QuerySet<any, any, T, any> | (() => QuerySet<any, any, T, any>),
  options?: LiveQuerySetOptions,
  deps?: readonly any[]
): [T[], LiveQuerySet<T> | null, boolean];
