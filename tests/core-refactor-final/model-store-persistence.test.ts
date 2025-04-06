// modelsync-client/tests/core/storage.test.ts
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
// Import fake-indexeddb/auto to auto-patch all required IndexedDB interfaces
import 'fake-indexeddb/auto';

import { ModelStore, Operation } from '../../src/core-refactor-final/store/modelstore/ModelStore.js';

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
    await state1.ensureInitialized(); // Wait for initial load attempt
    await state1.sync(); // Populates GT and triggers save
    await state1.destroy();

    // Phase 2: Load from Cache
    const loadingFetchMock = vi.fn();
    let state2 = createCachedModelStore({ fetchGroundTruth: loadingFetchMock });
    // Wait for the constructor's async cache load to complete
    await state2.ensureInitialized(); // Crucial: wait for loading promise

    // Verify data was loaded from cache
    expect(state2.getGroundTruth()).toEqual(initialData);
    expect(loadingFetchMock).not.toHaveBeenCalled();

    await state2.destroy();
  });

  test('should fetch ground truth if cache is empty', async () => {
    // Cache should be empty due to afterEach cleanup
    const state = createCachedModelStore();
    // Wait for the initial load attempt (which finds nothing)
    await state.ensureInitialized();

    expect(state.getGroundTruth()).toEqual([]);

    // Trigger sync
    await state.sync(); // Await the actual async operation

    // Assertions after sync completes
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.getGroundTruth()).toEqual(initialData);

    await state.destroy();
  });

  test('should save state to cache after successful sync', async () => {
    // Phase 1: Sync and Save
    const state1 = createCachedModelStore();
    await state1.ensureInitialized();
    state1.add({ type: 'create', instances: [{ id: 3, name: 'Charlie', version: 1 }] });
    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(updatedData)));

    await state1.sync(); // Await the fetch and subsequent save

    expect(state1.getGroundTruth()).toEqual(updatedData);
    await state1.destroy();

    // Phase 2: Load and Verify
    const state2 = createCachedModelStore({ fetchGroundTruth: vi.fn() });
    await state2.ensureInitialized(); // Wait for load

    expect(state2.getGroundTruth()).toEqual(updatedData);

    await state2.destroy();
  });

  test('should load operations from cache', async () => {
    // Phase 1: Populate Cache with Operations
    const state1 = createCachedModelStore();
    await state1.ensureInitialized();
    await state1.sync(); // Get initial GT & save

    const opIdCreate = state1.add({ type: 'create', instances: [{ id: 3, name: 'Charlie', version: 1 }] });
    const opIdUpdate = state1.add({ type: 'update', instances: [{ id: 1, name: 'Alice V2' }] });

    // Explicitly save the state including operations
    await state1._saveToCache(); // Await the save operation

    const versionBeforeDestroy = state1.version;
    await state1.destroy();

    // Phase 2: Load from Cache
    const state2 = createCachedModelStore({ fetchGroundTruth: vi.fn() });
    await state2.ensureInitialized(); // Wait for load

    expect(state2.getGroundTruth()).toEqual(initialData);
    expect(state2.operations.size).toBe(2);
    expect(state2.operations.has(opIdCreate)).toBe(true);
    expect(state2.operations.get(opIdCreate)?.type).toBe('create');
    expect(state2.operations.has(opIdUpdate)).toBe(true);
    expect(state2.operations.get(opIdUpdate)?.type).toBe('update');
    expect(state2.version).toBe(versionBeforeDestroy);

    // Verify rendering with direct render() method
    const rendered = state2.render();
    expect(rendered).toContainEqual({ id: 3, name: 'Charlie', version: 1 });
    expect(rendered).toContainEqual({ id: 1, name: 'Alice V2', version: 1 });
    expect(rendered).toContainEqual(initialData[1]);
    expect(rendered.length).toBe(3);

    await state2.destroy();
  });

  test('should update data after sync', async () => {
    // Phase 1: Populate Cache
    const state1 = createCachedModelStore();
    await state1.ensureInitialized();
    await state1.sync();
    await state1.destroy();

    // Phase 2: Load and Check
    const state2 = createCachedModelStore();
    await state2.ensureInitialized(); // Wait for load

    // Phase 3: Sync and Check Updated Data
    fetchMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(updatedData)));
    await state2.sync(); // Await sync

    expect(state2.getGroundTruth()).toEqual(updatedData);

    await state2.destroy();
  });

  test('should clear cache via clearCache() method', async () => {
    // Phase 1: Populate Cache
    const state1 = createCachedModelStore();
    await state1.ensureInitialized();
    await state1.sync();
    expect(state1.getGroundTruth()).toEqual(initialData);

    // Phase 2: Clear Cache
    await state1.clearCache(); // Await the async clear operation
    await state1.destroy();

    // Phase 3: Verify Cache is Empty
    const loadAfterClearFetchMock = vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(initialData)));
    const state2 = createCachedModelStore({fetchGroundTruth: loadAfterClearFetchMock});
    await state2.ensureInitialized(); // Wait for load attempt

    expect(state2.getGroundTruth()).toEqual([]); // Should be empty
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
    await state1.ensureInitialized();
    await state1.sync(); // Save initialData
    await state1.destroy();

    // Phase 2: Load, Add Mixed Operations, Manipulate Timestamp
    const state2 = createCachedModelStore({ maxOperationAge: testMaxOperationAge });
    await state2.ensureInitialized(); // Wait for load from cache

    expect(state2.getGroundTruth()).toEqual(initialData);

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

    await state2.destroy(); // Saves the state with only the inflight op

    // Phase 4: Verify Saved State (Load again)
    const state3 = createCachedModelStore({
        maxOperationAge: testMaxOperationAge,
        fetchGroundTruth: vi.fn() // Prevent network call on load
    });
    await state3.ensureInitialized(); // Wait for load

    // Verify final state loaded from cache reflects the trimmed operations
    expect(state3.getGroundTruth()).toEqual(updatedData);       // Latest GT saved
    expect(state3.operations.size).toBe(1);                  // Only inflight op should persist in cache
    expect(state3.operations.has(opIdInflight)).toBe(true);          // The inflight one is there
    expect(state3.operations.get(opIdInflight)?.status).toBe('inflight');
    expect(state3.operations.has(opIdCompletedOld)).toBe(false);        // The old/completed one is NOT there

    await state3.destroy();
  });

  test('should handle errors during cache load and propagate rejection', async () => {
    // --- Phase 1: Setup corrupted data ---
    const state1 = createCachedModelStore();
    await state1.ensureInitialized(); // Wait for initial empty cache load (resolves false)
    await state1.sync(); // Save valid initialData

    // Corrupt the data manually
    const db = await state1._storage._getDb();
    const storeName = state1._cacheStoreName;
    const key = state1._cacheStoreName; // Assuming storeName is used as the key
    try {
      const corruptData = {
        id: key, // Match keyPath ('id')
        groundTruth: "this string will break deserialization", // Invalid type
        operations: "also invalid", // Invalid type
        version: "not a number", // Invalid type
        cachedAt: "bad date"
      };
      await db.put(storeName, corruptData); // Overwrite with bad data
      console.log("Corrupted data injected into IndexedDB for key:", key);
    } catch (e) {
      console.error("Error during manual put for corruption:", e);
      throw new Error("Test setup failed: Could not corrupt data."); // Fail test if setup breaks
    }
    // Destroy state1 AFTER corruption, releasing DB connection
    await state1.destroy();
    activeStates = activeStates.filter(s => s !== state1); // Manually remove from tracking

    // --- Phase 2: Attempt to Load Corrupted Data (First Time) ---
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // Suppress expected error logs
    let state2;
    try {
      console.log("Creating state2, expecting initialization failure...");
      state2 = createCachedModelStore();
      // ensureInitialized() returns the _initialLoadPromise created in constructor
      await state2.ensureInitialized();
      // If we reach here, the test failed because it should have rejected
      throw new Error("ensureInitialized should have rejected but did not.");
    } catch (error) {
      console.log("Caught expected error during state2 initialization:", error.message);
      // Verify the rejection was due to the expected cause
      expect(error).toBeInstanceOf(Error);
      // Check for the specific wrapped error or the cause if available
      expect(error.message).toMatch(/Cache deserialization failed|Failed to fetch/); // Be flexible
      // Check internal state reset (important!)
      expect(state2.getGroundTruth()).toEqual([]);
      expect(state2.operations.size).toBe(0);
      expect(state2.version).toBe(0);
    } finally {
        consoleErrorSpy.mockRestore(); // Restore console.error
        // Attempt destroy, but don't let it fail the test if it errors
        if (state2) {
            try { await state2.destroy(); } catch(e) { console.warn("Error destroying state2 after failed init:", e)}
            activeStates = activeStates.filter(s => s !== state2);
        }
    }


    // --- Phase 3: Attempt to Load Corrupted Data (Second Time) ---
    // Create a new instance - it will try to load the *same* bad data
    const consoleErrorSpy2 = vi.spyOn(console, 'error').mockImplementation(() => {});
    let state3;
    try {
      console.log("Creating state3, expecting initialization failure again...");
      state3 = createCachedModelStore();
      await state3.ensureInitialized();
      throw new Error("state3.ensureInitialized should have rejected but did not.");
    } catch (error) {
      console.log("Caught expected error during state3 initialization:", error.message);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/Cache deserialization failed|Failed to fetch/);
      // Verify state is reset again
      expect(state3.getGroundTruth()).toEqual([]);
      expect(state3.operations.size).toBe(0);
    } finally {
        consoleErrorSpy2.mockRestore();
    }

    // --- Phase 4: Verify Sync also fails ---
    // Sync calls ensureInitialized internally, so it should also reject
    console.log("Attempting state3.sync(), expecting rejection...");
    await expect(state3.sync()).rejects.toThrow(/Cache deserialization failed|Failed to fetch/);

    // --- Phase 5: Clear the cache ---
    console.log("Clearing cache via state3...");
    let cleared = false;
    try {
        cleared = await state3.clearCache();
    } catch (clearError) {
        console.error("Failed to clear cache:", clearError);
        // If clearCache fails, the rest of the test might be invalid
        // Depending on requirements, you might want to throw here or just log
    }
    expect(cleared).toBe(true); // clearCache should work even if init failed

    // Destroy state3 *after* clearing cache
    if (state3) {
        try { await state3.destroy(); } catch(e) { console.warn("Error destroying state3:", e)}
        activeStates = activeStates.filter(s => s !== state3);
    }

    // --- Phase 6: Verify normal operation after cache clear ---
    console.log("Creating state4 after cache clear...");
    const state4 = createCachedModelStore(); // Uses the default fetchMock
    // Ensure initialized should now resolve false (empty cache)
    const loadedFromCache = await state4.ensureInitialized();
    expect(loadedFromCache).toBe(false);
    expect(state4.getGroundTruth()).toEqual([]); // State should be empty

    fetchMock.mockClear();

    // Sync should now work and fetch fresh data
    console.log("Attempting state4.sync()...");
    const syncResult = await state4.sync();
    expect(syncResult).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // fetchMock was reset in beforeEach
    expect(state4.getGroundTruth()).toEqual(initialData);
  });

// Also slightly adjust the save error test:
  test('should raise errors during cache save', async () => {
    const state = createCachedModelStore();
    // We MUST wait for initialization to complete (even if it's loading empty)
    // before we can reliably mock the storage method for the *correct* instance.
    await state.ensureInitialized(); // Wait for initial load attempt (empty cache -> resolves false)

    // Mock the storage layer's save method *after* initialization
    const saveError = new Error("TEST: Failed to write IndexedDB");
    // Ensure _storage exists before spying
    expect(state._storage).toBeDefined();
    vi.spyOn(state._storage, 'save').mockRejectedValueOnce(saveError);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Trigger a sync, which fetches (ok) then attempts to save (fail)
    await expect(state.sync()).rejects.toThrow(saveError); // Expect the specific error

    consoleErrorSpy.mockRestore();
  });
});