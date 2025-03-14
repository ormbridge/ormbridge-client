import { QuerySet } from "../flavours/django/querySet";
import { Model } from "../flavours/django/model";
import { LiveQuerySet, LiveQuerySetOptions } from "../core/liveView";

/**
 * React hook for creating and using a LiveQuerySet.
 *
 * @param querySet - The QuerySet to make live.
 * @param options - Options for the LiveQuerySet.
 * @returns A tuple containing:
 *  - data: An array of model instances.
 *  - query: The LiveQuerySet instance (or null if not yet initialized).
 *  - isLoading: A boolean indicating if data is still loading.
 *
 * @example
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
 */
export function useLiveView(
  querySet: QuerySet<any, any, any, any>,
  options?: LiveQuerySetOptions
): [any[], LiveQuerySet<any> | null, boolean];