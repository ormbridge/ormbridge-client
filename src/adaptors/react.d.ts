/**
 * React hook for creating and using a LiveQuerySet with reactive queries.
 *
 * @param queryInput - The QuerySet to make live or a function that returns a QuerySet.
 * @param options - Options for the LiveQuerySet.
 * @param deps - Optional array of dependencies to control when the hook should reinitialize.
 * @returns An object containing:
 *  - data: An array of model instances.
 *  - query: The LiveQuerySet instance (or null if not yet initialized).
 *  - isLoading: A boolean indicating if data is still loading.
 *
 * @example
 * // With a static query
 * function UserList() {
 *   const { data: users, query, isLoading } = useLiveView(User.objects.all());
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
 *   const { data: users, query, isLoading } = useLiveView(
 *     () => User.objects.filter({ department: departmentId }).all(),
 *     { limit: 20 }
 *   );
 * }
 * 
 * // With explicit dependencies
 * function UserPosts({ userId, pageSize }) {
 *   const queryFn = () => Post.objects.filter({ author: userId }).all();
 *   const { data: posts, query, isLoading } = useLiveView(
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
): {
  data: T[],
  query: LiveQuerySet<T> | null,
  isLoading: boolean
};