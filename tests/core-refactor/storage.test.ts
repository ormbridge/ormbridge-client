// modelsync-client/tests/core/storage.test.ts
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
// Import fake-indexeddb/auto to auto-patch all required IndexedDB interfaces
import 'fake-indexeddb/auto';

import { ModelStore, Operation } from '../../src/core-refactor/state/ModelStore.js';
import { RenderEngine } from '../../src/core-refactor/rendering/RenderEngine.js';

// --- Test Data and Setup ---
const initialData = [
  { id: 1, name: 'Alice', version: 1 },
  { id: 2, name: 'Bob', version: 1 },
];
const updatedData = [
  { id: 1, name: 'Alice Smith', version: 2 },
  { id: 2, name: 'Bob', version: 1 },
  { id: 3, name: 'Charlie', version: 1 },
];
let fetchMock;
// Keep track of ModelStore instances created in tests to ensure they are destroyed
let activeStates = [];

// --- Vitest Setup ---
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(initialData)));
  activeStates = []; // Reset for each test
});

afterEach(async () => {
  // --- Ensure all created states are destroyed ---
  // This helps prevent blocked DB deletion if a test fails mid-way
  for (const state of activeStates) {
      if (state && typeof state.destroy === 'function') {
         try {
              // Check if destroy is async (it should be)
              const maybePromise = state.destroy();
              if (maybePromise instanceof Promise) {
                  await maybePromise;
              }
         } catch (e) {
             console.error("Error destroying state in afterEach:", e);
         }
      }
  }
  activeStates = []; // Clear the list

  // --- Database Cleanup Phase (using the fake DB) ---
  const dbName = 'test_modelsync_cache'; // Ensure this matches createCachedModelStore
  try {
    await new Promise((resolve, reject) => {
      const deleteRequest = indexedDB.deleteDatabase(dbName);
      deleteRequest.onsuccess = () => resolve(true);
      deleteRequest.onerror = (e) => reject(deleteRequest.error);
      deleteRequest.onblocked = (e) => {
          console.warn(`!!! IndexedDB delete blocked for ${dbName}. Test states might not have been destroyed properly. !!!`);
          // Resolve anyway to avoid hanging tests due to cleanup issues
          resolve(false);
      };
    });
  } catch (error) {
     if (error.name !== 'InvalidStateError' && !error.message?.includes('blocked')) {
       console.error(`Error deleting test database ${dbName}:`, error);
     }
  }

  // --- Vitest Teardown Phase ---
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// --- Helper ---
const createCachedModelStore = (options = {}) => {
  const defaults = {
    primaryKey: 'id',
    fetchGroundTruth: fetchMock,
    syncInterval: 0,         // Disable periodic sync
    cacheAutoSync: false,    // Disable auto-sync after load
    cacheSyncDelay: 1,       // Minimal delay if auto-sync is enabled
    maxOperationAge: 15 * 1000, // Keep this reasonable
    enableCache: true,
    cacheDbName: 'test_modelsync_cache',
    cacheStoreName: 'test_query_state',
  };
  const finalOptions = { ...defaults, ...options };
  // Ensure fetchGroundTruth is explicitly passed or uses the default mock
  if(!options.fetchGroundTruth) {
      finalOptions.fetchGroundTruth = fetchMock;
  }

  const newState = new ModelStore(finalOptions);
  activeStates.push(newState); // Track for cleanup
  return newState;
};

// --- Test Suite ---
describe('ModelStore with IndexedDB Cache Integration (Real Timers)', () => {

  test('should load data from cache if available', async () => {
    // Phase 1: Populate Cache
    let state1 = createCachedModelStore();
    // ensureCacheLoaded waits for the initial load/save logic associated with constructor/sync
    await state1.ensureCacheLoaded(); // Wait for initial load attempt
    await state1.sync(); // Populates GT and triggers save
    await state1.destroy();

    // Phase 2: Load from Cache
    const loadingFetchMock = vi.fn();
    let state2 = createCachedModelStore({ fetchGroundTruth: loadingFetchMock });
    // Wait for the constructor's async cache load to complete
    await state2.ensureCacheLoaded(); // Crucial: wait for loading promise

    // Verify data was loaded from cache
    expect(state2.getGroundTruth()).toEqual(initialData);
    expect(loadingFetchMock).not.toHaveBeenCalled();
    expect(state2.isStale).toBe(true);

    await state2.destroy();
  });

  test('should fetch ground truth if cache is empty', async () => {
    // Cache should be empty due to afterEach cleanup
    const state = createCachedModelStore();
    // Wait for the initial load attempt (which finds nothing)
    await state.ensureCacheLoaded();

    expect(state.getGroundTruth()).toEqual([]);
    expect(state.isStale).toBe(false);

    // Trigger sync
    await state.sync(); // Await the actual async operation

    // Assertions after sync completes
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.getGroundTruth()).toEqual(initialData);
    expect(state.isStale).toBe(false);

    await state.destroy();
  });

  test('should save state to cache after successful sync', async () => {
    // Phase 1: Sync and Save
    const state1 = createCachedModelStore();
    await state1.ensureCacheLoaded();
    state1.add({ type: 'create', instances: [{ id: 3, name: 'Charlie', version: 1 }] });
    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(updatedData)));

    await state1.sync(); // Await the fetch and subsequent save

    expect(state1.getGroundTruth()).toEqual(updatedData);
    await state1.destroy();

    // Phase 2: Load and Verify
    const state2 = createCachedModelStore({ fetchGroundTruth: vi.fn() });
    await state2.ensureCacheLoaded(); // Wait for load

    expect(state2.getGroundTruth()).toEqual(updatedData);
    expect(state2.isStale).toBe(true);

    await state2.destroy();
  });

  test('should load operations from cache', async () => {
    // Phase 1: Populate Cache with Operations
    const state1 = createCachedModelStore();
    await state1.ensureCacheLoaded();
    await state1.sync(); // Get initial GT & save

    const opIdCreate = state1.add({ type: 'create', instances: [{ id: 3, name: 'Charlie', version: 1 }] });
    const opIdUpdate = state1.add({ type: 'update', instances: [{ id: 1, name: 'Alice V2' }] });

    // Explicitly save the state including operations
    await state1._saveToCache(); // Await the save operation

    const versionBeforeDestroy = state1.version;
    await state1.destroy();

    // Phase 2: Load from Cache
    const state2 = createCachedModelStore({ fetchGroundTruth: vi.fn() });
    await state2.ensureCacheLoaded(); // Wait for load

    expect(state2.getGroundTruth()).toEqual(initialData);
    expect(state2.operations.size).toBe(2);
    expect(state2.operations.has(opIdCreate)).toBe(true);
    expect(state2.operations.get(opIdCreate)?.type).toBe('create');
    expect(state2.operations.has(opIdUpdate)).toBe(true);
    expect(state2.operations.get(opIdUpdate)?.type).toBe('update');
    expect(state2.version).toBe(versionBeforeDestroy);
    expect(state2.isStale).toBe(true);

    // Verify rendering
    const renderEngine = new RenderEngine(state2);
    const rendered = renderEngine.render({ offset: 0, limit: 10 });
    expect(rendered).toContainEqual({ id: 3, name: 'Charlie', version: 1 });
    expect(rendered).toContainEqual({ id: 1, name: 'Alice V2', version: 1 });
    expect(rendered).toContainEqual(initialData[1]);
    expect(rendered.length).toBe(3);
    renderEngine.destroy();

    await state2.destroy();
  });

  test('should update staleness flag correctly', async () => {
    // Phase 1: Populate Cache
    const state1 = createCachedModelStore();
    await state1.ensureCacheLoaded();
    await state1.sync();
    await state1.destroy();

    // Phase 2: Load and Check Stale
    const state2 = createCachedModelStore();
    await state2.ensureCacheLoaded(); // Wait for load
    expect(state2.isStale).toBe(true);

    // Phase 3: Sync and Check Not Stale
    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(updatedData)));
    await state2.sync(); // Await sync

    expect(state2.isStale).toBe(false);
    expect(state2.getGroundTruth()).toEqual(updatedData);

    await state2.destroy();
  });

  test('should auto-sync after cache load if configured', async () => {
    // Phase 1: Populate Cache
    const state1 = createCachedModelStore();
    await state1.ensureCacheLoaded();
    await state1.sync();
    await state1.destroy();

    // Phase 2: Load and Auto-Sync (using subscription)
    const autoSyncFetchMock = vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(updatedData)));
    const syncDelay = 5; // Use a small but non-zero delay

    let syncCompleted = false;
    const syncPromise = new Promise(resolve => {
        const state2 = createCachedModelStore({
            fetchGroundTruth: autoSyncFetchMock,
            cacheAutoSync: true,
            cacheSyncDelay: syncDelay, // Use the short delay
        });

        // Wait for initial load FIRST
        state2.ensureCacheLoaded().then(loaded => {
            expect(loaded).toBe(true); // Should have loaded from cache
            expect(state2.getGroundTruth()).toEqual(initialData);
            expect(state2.isStale).toBe(true);
            expect(autoSyncFetchMock).not.toHaveBeenCalled();

             // Now subscribe to wait for the auto-sync triggered by the delay
             const unsubscribe = state2.subscribe((eventType) => {
                if (eventType === 'sync_completed') {
                    syncCompleted = true;
                    unsubscribe(); // Clean up subscriber
                    resolve(state2); // Resolve promise with the state instance
                } else if (eventType === 'sync_error') {
                     unsubscribe();
                     reject(new Error("Auto-sync failed"));
                }
            }, ['sync_completed', 'sync_error']);
        });
    });


    // Wait for the sync_completed event (or timeout)
    // Vitest's default test timeout should be sufficient here unless syncDelay is large
    const state2 = await syncPromise; // Get the state instance back

    // Verify state after auto-sync
    expect(syncCompleted).toBe(true);
    expect(autoSyncFetchMock).toHaveBeenCalledTimes(1);
    expect(state2.isStale).toBe(false);
    expect(state2.getGroundTruth()).toEqual(updatedData);

    await state2.destroy();
  });


  test('should clear cache via clearCache() method', async () => {
    // Phase 1: Populate Cache
    const state1 = createCachedModelStore();
    await state1.ensureCacheLoaded();
    await state1.sync();
    expect(state1.getGroundTruth()).toEqual(initialData);

    // Phase 2: Clear Cache
    await state1.clearCache(); // Await the async clear operation
    await state1.destroy();

    // Phase 3: Verify Cache is Empty
    const loadAfterClearFetchMock = vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(initialData)));
    const state2 = createCachedModelStore({fetchGroundTruth: loadAfterClearFetchMock});
    await state2.ensureCacheLoaded(); // Wait for load attempt

    expect(state2.getGroundTruth()).toEqual([]); // Should be empty
    expect(state2.isStale).toBe(false);
    expect(loadAfterClearFetchMock).not.toHaveBeenCalled();

    // Trigger sync
    await state2.sync(); // Await sync

    expect(loadAfterClearFetchMock).toHaveBeenCalledTimes(1);
    expect(state2.getGroundTruth()).toEqual(initialData);

    await state2.destroy();
  });

  test('should handle mixed operations (inflight/completed) after cache load', async () => {
    // Get maxOperationAge from defaults to manipulate timestamps realistically
    // Using the value from the helper's defaults directly here
    const testMaxOperationAge = 15 * 1000;

    // Phase 1: Populate Cache (Initial Data)
    const state1 = createCachedModelStore({ maxOperationAge: testMaxOperationAge });
    await state1.ensureCacheLoaded();
    await state1.sync(); // Save initialData
    await state1.destroy();

    // Phase 2: Load, Add Mixed Operations, Manipulate Timestamp
    const state2 = createCachedModelStore({ maxOperationAge: testMaxOperationAge });
    await state2.ensureCacheLoaded(); // Wait for load from cache

    expect(state2.getGroundTruth()).toEqual(initialData);
    expect(state2.isStale).toBe(true);

    // Add an operation that will remain inflight (recent timestamp)
    const opIdInflight = state2.add({ type: 'create', instances: [{ id: 3, name: 'Charlie', version: 1 }] });

    // Add an operation that will be marked completed AND made old
    const opIdCompletedOld = state2.add({ type: 'update', instances: [{ id: 1, name: 'Alice V2' }] });

    // --- Make the second operation "old" and "completed" ---
    // 1. Mark it as completed (confirmed or rejected)
    state2.update(opIdCompletedOld, { status: 'confirmed' });
    // 2. Manually set its timestamp to be older than maxOperationAge
    const completedOp = state2.operations.get(opIdCompletedOld);
    if (!completedOp) throw new Error("Test setup failed: Could not find opIdCompletedOld");
    completedOp.timestamp = Date.now() - testMaxOperationAge - 5000; // Make it definitely older

    // Verify both operations exist before sync/trimming
    expect(state2.operations.size).toBe(2);
    expect(state2.operations.has(opIdInflight)).toBe(true);
    expect(state2.operations.has(opIdCompletedOld)).toBe(true);
    expect(state2.operations.get(opIdInflight)?.status).toBe('inflight');
    expect(state2.operations.get(opIdCompletedOld)?.status).toBe('confirmed');

    // Phase 3: Sync (Fetches new GT, trims old/completed ops, saves remaining state)
    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(updatedData)));
    await state2.sync(); // Sync fetches updatedData, calls _trimOperations, then _saveToCache

    // Verify state *immediately after* sync (before destroy)
    expect(state2.getGroundTruth()).toEqual(updatedData); // GT updated
    expect(state2.operations.size).toBe(1); // Trim should have removed the old/completed one
    expect(state2.operations.has(opIdInflight)).toBe(true); // Inflight should remain
    expect(state2.operations.has(opIdCompletedOld)).toBe(false); // Old/completed should be gone
    expect(state2.isStale).toBe(false); // Sync just completed

    await state2.destroy(); // Saves the state with only the inflight op

    // Phase 4: Verify Saved State (Load again)
    const state3 = createCachedModelStore({
        maxOperationAge: testMaxOperationAge,
        fetchGroundTruth: vi.fn() // Prevent network call on load
    });
    await state3.ensureCacheLoaded(); // Wait for load

    // Verify final state loaded from cache reflects the trimmed operations
    expect(state3.getGroundTruth()).toEqual(updatedData);       // Latest GT saved
    expect(state3.operations.size).toBe(1);                  // Only inflight op should persist in cache
    expect(state3.operations.has(opIdInflight)).toBe(true);          // The inflight one is there
    expect(state3.operations.get(opIdInflight)?.status).toBe('inflight');
    expect(state3.operations.has(opIdCompletedOld)).toBe(false);        // The old/completed one is NOT there
    expect(state3.isStale).toBe(true);                           // Loaded from cache

    await state3.destroy();
  });

  test('should handle errors during cache load gracefully', async () => {
    // Phase 1: Setup corrupted data
    const state1 = createCachedModelStore();
    await state1.ensureCacheLoaded();
    await state1.sync(); // Save valid initialData first

    // Corrupt with an object matching keyPath but invalid content
    const db = await state1._storage._getDb();
    try {
        const corruptData = {
            id: state1._cacheStoreName, // Match keyPath ('id') using the store name as key
            groundTruth: "this string will break deserialization", // Invalid type
            operations: "also invalid", // Invalid type
            version: "not a number", // Invalid type
            cachedAt: "bad date"
        };
        // Use put with the corrupt object
        await db.put(state1._storage.storeName, corruptData);
    } catch (e) {
        console.error("Error during manual put for corruption:", e)
    }
    await state1.destroy(); // Close connection

    // Phase 2: Attempt to Load with Corrupted Data
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state2 = createCachedModelStore();

    // Wait for the load attempt, which should now fail deserialization
    await state2.ensureCacheLoaded();

    // Verify it didn't load data and error was logged
    expect(state2.getGroundTruth()).toEqual([]); // Should now be empty
    expect(state2.isStale).toBe(false);         // Should be false if load failed
    expect(consoleErrorSpy).toHaveBeenCalledWith(
         expect.stringContaining('Error deserializing cached data:'), // Error from serializer block
         expect.any(Error)
    );
    // Also check the outer catch block's log in _loadFromCache
    expect(consoleErrorSpy).toHaveBeenCalledWith(
         expect.stringContaining('Error during _loadFromCache:'),
         expect.any(Error)
    );


    // Verify it can still function (fetch new data)
    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(initialData))); // Use the default mock
    fetchMock.mockClear();
    await state2.sync(); // Await recovery sync

    expect(fetchMock).toHaveBeenCalledTimes(1); // Default mock was called
    expect(state2.getGroundTruth()).toEqual(initialData); // Can recover by fetching
    expect(state2.isStale).toBe(false); // Not stale after successful sync

    consoleErrorSpy.mockRestore();
    await state2.destroy();
 });

   test('should handle errors during cache save gracefully', async () => {
    const state = createCachedModelStore();
    await state.ensureCacheLoaded(); // Wait for initial load attempt

    // Mock the storage layer's save method to fail
    const saveError = new Error("TEST: Failed to write IndexedDB");
    vi.spyOn(state._storage, 'save').mockRejectedValueOnce(saveError);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Trigger a sync, which attempts to save afterward
    await state.sync(); // Await the sync (fetch works, save fails)

    // Verify sync completed functionally despite save error
    expect(state.getGroundTruth()).toEqual(initialData);
    expect(state.isStale).toBe(false); // Sync fetch/update GT worked

    // Expect the error logged by the sync() method's catch block
    expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Sync completed but cache save failed:', // Message from ModelStore.sync
        saveError // The specific error instance
    );

    // Also check that the lower-level error from storage was logged
    expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Sync completed but cache save failed:", // Message from ModelStore.sync
        saveError
    );

    consoleErrorSpy.mockRestore();
    await state.destroy();
 });
});