import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncedArray } from '../src/core/SyncedArray'; // Adjust path as needed
import { nanoid } from 'nanoid';

// Utility for creating delays that simulate network latency
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Test item class
class TestItem {
  constructor(data) {
    Object.assign(this, data);
  }

  serialize() {
    return JSON.stringify(this);
  }
}

// Mock server that simulates network latency and responses
class MockServer {
  constructor(initialData = [], latencyRange = [50, 150]) {
    this.data = [...initialData];
    this.latencyRange = latencyRange;
    this.nextId = 1000; // Server generates IDs starting from 1000
    this.listeners = new Set();
    this.pendingChanges = [];
    this.processingInterval = null;
    this.shouldFailRandomly = false;
    this.failureRate = 0.1; // 10% chance of failure by default
  }

  // Subscribe to server events
  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  // Notify all listeners about a server event
  notifyListeners(event) {
    this.listeners.forEach(listener => listener(event));
  }

  // Get random latency within range
  getRandomLatency() {
    const [min, max] = this.latencyRange;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // Should this operation randomly fail?
  shouldFail() {
    if (!this.shouldFailRandomly) return false;
    return Math.random() < this.failureRate;
  }

  // Start processing server events in background
  startProcessing() {
    if (this.processingInterval) return;

    this.processingInterval = setInterval(() => {
      if (this.pendingChanges.length > 0) {
        const change = this.pendingChanges.shift();
        this.notifyListeners(change);
      }
    }, 30); // Process a batch every 30ms
  }

  // Stop processing server events
  stopProcessing() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
  }

  // Queue a server event to be processed
  queueChange(change) {
    this.pendingChanges.push(change);
  }

  // Process an operation with simulated latency
  async processOperation(operation) {
    // Simulate network latency
    const latency = this.getRandomLatency();
    await delay(latency);

    // Random failure if enabled
    if (this.shouldFail()) {
      throw new Error('Server operation failed');
    }

    switch (operation.type) {
      case 'create': {
        const serverData = { ...operation.data };
        // Replace temporary ID with server-generated ID if needed
        // Use 'id' as the primary key consistently
        if (!serverData.id || serverData.id.startsWith('temp_')) {
          serverData.id = `server_${this.nextId++}`;
        }
        // Ensure it's treated as an object for consistency
        const newItem = new TestItem(serverData);
        this.data.push(newItem);
        return newItem; // Return the TestItem instance
      }
      case 'update': {
        const idx = this.data.findIndex(item => item.id === operation.key);
        if (idx === -1) throw new Error(`Item with ID ${operation.key} not found`);

        // Apply updates immutably and return new instance
        this.data[idx] = new TestItem({ ...this.data[idx], ...operation.data });
        return this.data[idx];
      }
      case 'delete': {
        const idx = this.data.findIndex(item => item.id === operation.key);
        if (idx === -1) throw new Error(`Item with ID ${operation.key} not found`);

        const deleted = this.data[idx];
        this.data.splice(idx, 1);
        return deleted;
      }
      default:
        throw new Error(`Unknown operation type: ${operation.type}`);
    }
  }
}

// Simulates client-side operations and server confirmations
class ClientSimulator {
  constructor(arrayState, server) {
    this.arrayState = arrayState;
    this.server = server;
    this.completedOperations = 0;
    this.failedOperations = 0;
    this.pendingOperations = new Map();
  }

  async createItem(data, position) {
    const opId = `temp_${nanoid(8)}`;

    try {
      // Apply optimistic update locally
      this.arrayState.createOptimistic({ id: opId, position }, data);
      this.pendingOperations.set(opId, { type: 'create', data });

      // Send to server
      const serverData = await this.server.processOperation({
        type: 'create',
        data // Send the raw data
      });

      // Confirm optimistic update with server result
      this.arrayState.confirmOptimisticOp(opId, serverData); // Pass the TestItem instance
      this.pendingOperations.delete(opId);
      this.completedOperations++;

      return serverData; // Return the TestItem instance
    } catch (error) {
      // Handle server failure - remove optimistic operation
      this.arrayState.removeOptimisticOp(opId);
      this.pendingOperations.delete(opId);
      this.failedOperations++;
      // console.error(`Client Create Failed (opId: ${opId}):`, error); // Optional logging
      throw error;
    }
  }

  async updateItem(key, data) {
    const opId = `temp_${nanoid(8)}`;

    try {
      // Apply optimistic update locally
      this.arrayState.updateOptimistic({ id: opId, key }, data);
      this.pendingOperations.set(opId, { type: 'update', key, data });

      // Send to server
      const serverData = await this.server.processOperation({
        type: 'update',
        key,
        data
      });

      // Confirm optimistic update with server result
      this.arrayState.confirmOptimisticOp(opId, serverData); // Pass the TestItem instance
      this.pendingOperations.delete(opId);
      this.completedOperations++;

      return serverData; // Return the TestItem instance
    } catch (error) {
      // Handle server failure - remove optimistic operation
      this.arrayState.removeOptimisticOp(opId);
      this.pendingOperations.delete(opId);
      this.failedOperations++;
       // console.error(`Client Update Failed (opId: ${opId}, key: ${key}):`, error); // Optional logging
      throw error;
    }
  }

  async deleteItem(key) {
    const opId = `temp_${nanoid(8)}`;

    try {
      // Apply optimistic update locally
      this.arrayState.deleteOptimistic({ id: opId, key });
      this.pendingOperations.set(opId, { type: 'delete', key });

      // Send to server
      const serverData = await this.server.processOperation({
        type: 'delete',
        key
      });

      // Confirm optimistic update with server result
      // Pass null or serverData, confirm handles it
      this.arrayState.confirmOptimisticOp(opId, null);
      this.pendingOperations.delete(opId);
      this.completedOperations++;

      return serverData; // Return the deleted item instance
    } catch (error) {
      // Handle server failure - remove optimistic operation
      this.arrayState.removeOptimisticOp(opId);
      this.pendingOperations.delete(opId);
      this.failedOperations++;
       // console.error(`Client Delete Failed (opId: ${opId}, key: ${key}):`, error); // Optional logging
      throw error;
    }
  }

  // Process a server event
  processServerEvent(event) {
    // Make sure data is wrapped in TestItem if needed
    const eventData = event.data instanceof TestItem ? event.data : new TestItem(event.data || {});

    switch (event.type) {
      case 'create':
        // Pass data directly, createDirect handles ItemClass instantiation
        this.arrayState.createDirect({}, event.data);
        break;
      case 'update':
        // Pass data directly, updateDirect handles merging
        this.arrayState.updateDirect({ key: event.key }, event.data);
        break;
      case 'delete':
        this.arrayState.deleteDirect({ key: event.key });
        break;
    }
  }

  // Get stats about operations
  getStats() {
    return {
      completed: this.completedOperations,
      failed: this.failedOperations,
      pending: this.pendingOperations.size
    };
  }
}

describe('SyncedArray ACID Tests', () => {
  let arrayState;
  let server;
  let client;
  let initialData;
  let onChangeHandler;

  beforeEach(() => {
    vi.useFakeTimers();

    initialData = [
      { id: '1', name: 'Item 1', value: 100 },
      { id: '2', name: 'Item 2', value: 200 },
      { id: '3', name: 'Item 3', value: 300 },
    ].map(item => new TestItem(item)); // Use TestItem instances

    onChangeHandler = vi.fn();

    // Create new state and server instances for each test
    arrayState = new SyncedArray({
      initialData: [...initialData], // Pass copy
      primaryKey: 'id',
      onChange: onChangeHandler,
      ItemClass: TestItem
    });

    // Pass copy to server as well
    server = new MockServer([...initialData].map(item => new TestItem(item)));
    client = new ClientSimulator(arrayState, server);

    // Set up server subscription
    server.subscribe((event) => {
      client.processServerEvent(event);
    });
  });

  afterEach(() => {
    server.stopProcessing();
    vi.useRealTimers();
  });

  it('should handle basic CRUD operations with server confirmation', async () => {
    // Create an item
    const createPromise = client.createItem({ name: 'New Item', value: 400 });

    // Fast-forward time to resolve the promise
    await vi.advanceTimersByTimeAsync(200); // Enough for max latency + buffer
    const newItem = await createPromise;

    // Verify item exists with server-assigned ID
    expect(newItem.id).toMatch(/^server_/);
    expect(arrayState.data).toHaveLength(4);
    expect(arrayState.data.find(item => item.name === 'New Item')).toBeTruthy();
    expect(arrayState.data.find(item => item.id === newItem.id)).toBeInstanceOf(TestItem);

    // Update the item
    const updatePromise = client.updateItem(newItem.id, { value: 450 });
    await vi.advanceTimersByTimeAsync(200);
    await updatePromise;

    // Verify update was applied
    const updatedItem = arrayState.data.find(item => item.id === newItem.id);
    expect(updatedItem.value).toBe(450);
    expect(updatedItem).toBeInstanceOf(TestItem);

    // Delete the item
    const deletePromise = client.deleteItem(newItem.id);
    await vi.advanceTimersByTimeAsync(200);
    await deletePromise;

    // Verify item was deleted
    expect(arrayState.data).toHaveLength(3);
    expect(arrayState.data.find(item => item.id === newItem.id)).toBeFalsy();
  });

  it('should handle high-frequency local operations', async () => {
    // Create multiple items in rapid succession
    const createPromises = [];
    for (let i = 0; i < 20; i++) {
      createPromises.push(client.createItem({ name: `Rapid Item ${i}`, value: i * 10 }));
    }

    // Initial optimistic state should have all items
    expect(arrayState.data).toHaveLength(initialData.length + 20);

    // Verify all optimistic operations are pending
    expect(client.pendingOperations.size).toBe(20);

    // Advance time enough for all operations to complete (20 * 150ms max + buffer)
    await vi.advanceTimersByTimeAsync(4000);
    await Promise.all(createPromises);

    // All operations should be confirmed
    expect(client.pendingOperations.size).toBe(0);
    expect(arrayState.optimisticOps.size).toBe(0);

    // Final state should reflect server-confirmed items
    expect(arrayState.data).toHaveLength(initialData.length + 20);

    // Check ground truth matches final state
    expect(arrayState.groundTruth).toHaveLength(initialData.length + 20);
    expect(arrayState.data.every(item => item instanceof TestItem)).toBe(true);
    expect(arrayState.groundTruth.every(item => item instanceof TestItem)).toBe(true);

  });

  it('should handle interleaved server and client operations', async () => {
    // Start server processing
    server.startProcessing();

    // Simulate other client making changes via server
    server.queueChange({
      type: 'create',
      data: { id: 'server_1001', name: 'Server Item 1', value: 1000 }
    });

    // Our client makes a local change
    const createPromise = client.createItem({ name: 'Client Item 1', value: 2000 });

    // Server sends another change
    server.queueChange({
      type: 'update',
      key: '1',
      data: { value: 150 }
    });

    // Advance time to process server events and client operation
    await vi.advanceTimersByTimeAsync(300); // Allow server + client op latency
    await createPromise;

    // Our client makes another local change
    const updatePromise = client.updateItem('2', { value: 250 });

    // Server sends a delete operation
    server.queueChange({
      type: 'delete',
      key: '3'
    });

    // Advance time again
    await vi.advanceTimersByTimeAsync(300);
    await updatePromise;

    // Advance just a bit more to ensure server processing catches up
    await vi.advanceTimersByTimeAsync(100);

    // Verify final state has correct items and values
    // Original 3 + 1 server create + 1 client create - 1 server delete = 4
    expect(arrayState.data).toHaveLength(4);

    const item1 = arrayState.data.find(item => item.id === '1');
    expect(item1).toBeInstanceOf(TestItem);
    expect(item1.value).toBe(150); // Updated by server

    const item2 = arrayState.data.find(item => item.id === '2');
    expect(item2).toBeInstanceOf(TestItem);
    expect(item2.value).toBe(250); // Updated by client

    const item3 = arrayState.data.find(item => item.id === '3');
    expect(item3).toBeFalsy(); // Deleted by server

    const serverItem = arrayState.data.find(item => item.id === 'server_1001');
    expect(serverItem).toBeInstanceOf(TestItem);
    expect(serverItem).toBeTruthy(); // Added by server

    const clientItem = arrayState.data.find(item => item.name === 'Client Item 1');
    expect(clientItem).toBeInstanceOf(TestItem);
    expect(clientItem).toBeTruthy(); // Added by client
    expect(clientItem.id).toMatch(/^server_/); // Should have server ID now
  });

  it('should handle concurrent updates to the same item', async () => {
    // Client starts updating item 1
    const clientUpdatePromise = client.updateItem('1', { value: 150, clientField: 'updated' });

    // Before client confirms, server sends update for same item
    server.queueChange({
      type: 'update',
      key: '1',
      data: { value: 160, serverField: 'updated' }
    });

    // Start server processing
    server.startProcessing();

    // Advance time to process both operations
    // Need time for server event AND client op confirmation
    await vi.advanceTimersByTimeAsync(400);
    const clientUpdateResult = await clientUpdatePromise;

    // Advance just a bit more to ensure server processing catches up
    await vi.advanceTimersByTimeAsync(100);

    // Get the final state of item 1
    const item1_gt = arrayState.groundTruth.find(item => item.id === '1');
    const item1_view = arrayState.data.find(item => item.id === '1');

    // Ground Truth: Server event processed first by direct update.
    // Then confirmOptimisticOp processed client's update, merging onto the GT state.
    expect(item1_gt).toBeInstanceOf(TestItem);
    expect(item1_gt.value).toBe(150); // Client's value from confirmOptimisticOp (overwrites server's)
    expect(item1_gt.clientField).toBe('updated'); // Added by client confirm
    expect(item1_gt.serverField).toBe('updated'); // Added by server direct update

    // View should reflect the final ground truth
    expect(item1_view).toEqual(item1_gt);

     // The result from client update should reflect the state *after* its confirmation
    expect(clientUpdateResult.value).toBe(150);
    expect(clientUpdateResult.clientField).toBe('updated');
    // serverField might or might not be present depending on exact timing of confirm vs GT update
    // So we check the final GT/view state above for certainty.
  });

  it('should handle server failures gracefully', async () => {
    // Enable random failures
    server.shouldFailRandomly = true;
    server.failureRate = 0.8; // High failure rate

    // Try to create multiple items knowing some will fail
    const createPromises = [];
    for (let i = 0; i < 10; i++) {
      createPromises.push(
        client.createItem({ name: `Test Item ${i}`, value: i * 10 })
          .catch(() => null) // Catch failures, return null
      );
    }

    // Advance time enough for all operations (10 * 150ms max + buffer)
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(createPromises);

    // Check stats
    const stats = client.getStats();
    expect(stats.pending).toBe(0); // All operations should be resolved (success or failure)

    // Some operations should have succeeded, some failed
    expect(stats.completed + stats.failed).toBe(10);

    // Final state should only include successful items (in view and GT)
    const testItemsView = arrayState.data.filter(item => item.name?.startsWith('Test Item'));
    expect(testItemsView.length).toBe(stats.completed);

    const testItemsGT = arrayState.groundTruth.filter(item => item.name?.startsWith('Test Item'));
    expect(testItemsGT.length).toBe(stats.completed);

    // No optimistic operations should remain
    expect(arrayState.optimisticOps.size).toBe(0);
  });

  it('should maintain consistency with very high frequency operations', async () => {
    // Reduce server latency for this test
    server.latencyRange = [10, 30];

    // Create 100 items in rapid succession
    const createPromises = [];
    for (let i = 0; i < 100; i++) {
      // No need to await timer inside loop - let promises run concurrently
      createPromises.push(
        client.createItem({ name: `Rapid Item ${i}`, value: i })
          .catch(() => null) // Handle potential rare failures if enabled
      );
    }

    // Advance time enough for all operations (100 * 30ms max + buffer)
    await vi.advanceTimersByTimeAsync(4000);
    await Promise.all(createPromises);

    const stats = client.getStats();
    expect(stats.pending).toBe(0); // All ops should be resolved

    // Expected length based on successful operations
    const expectedLength = initialData.length + stats.completed;

    // Ground truth and view should be consistent
    expect(arrayState.groundTruth).toHaveLength(expectedLength);
    expect(arrayState.data).toHaveLength(expectedLength);

    // No optimistic operations should remain
    expect(arrayState.optimisticOps.size).toBe(0);
  }, 10000); // Give this test more time

  it('should handle delayed server confirmations', async () => {
    // Set very high server latency
    server.latencyRange = [500, 1000];

    // Create items
    const createPromises = [];
    for (let i = 0; i < 5; i++) {
      createPromises.push(client.createItem({ name: `Delayed Item ${i}`, value: i * 10 }));
    }

    // After creating items but before server confirms
    expect(arrayState.data).toHaveLength(initialData.length + 5); // All optimistic updates visible
    expect(arrayState.groundTruth).toHaveLength(initialData.length); // Ground truth unchanged
    expect(arrayState.optimisticOps.size).toBe(5); // All operations pending

    // Advance time partially - some but not all operations should complete
    await vi.advanceTimersByTimeAsync(700); // Between min and max latency

    // Some operations should be confirmed, some still pending
    // Note: Due to randomness, we can't assert exact numbers, only bounds
    expect(arrayState.optimisticOps.size).toBeLessThan(5);
    // It's possible, though unlikely, all finished in <700ms if random latency was low
    // expect(arrayState.optimisticOps.size).toBeGreaterThan(0); // This might fail rarely

    // All items should still be visible in the view (optimistic + confirmed)
    expect(arrayState.data).toHaveLength(initialData.length + 5);

    // Complete remaining operations
    await vi.advanceTimersByTimeAsync(1000); // Ensure max latency is covered
    await Promise.all(createPromises);

    // All operations should be confirmed
    expect(arrayState.optimisticOps.size).toBe(0);
    expect(arrayState.groundTruth).toHaveLength(initialData.length + 5);
    expect(arrayState.data).toHaveLength(initialData.length + 5);
  });

  it('should handle primary key conflicts correctly during confirmation', async () => {
    // Create item optimistically with a specific ID that might already exist post-confirmation
    const conflictingId = 'server_1000'; // Assume server will assign this
    server.nextId = 1000; // Force next server ID

    // Client 1 creates an item (will get ID server_1000)
    const client1Promise = client.createItem({ name: 'First Item', value: 1 });

    // Client 2 *optimistically* creates an item using the *final* ID expected from client 1
    // This simulates a scenario where client 2 somehow knows the final ID,
    // or more realistically, confirms an op using server data that clashes.
    const opIdClient2 = `temp_${nanoid(8)}`;
    arrayState.createOptimistic({id: opIdClient2}, { id: conflictingId, name: 'Second Item Optimistic', value: 2 });

    // Advance time for Client 1's operation to complete
    await vi.advanceTimersByTimeAsync(200);
    await client1Promise; // Client 1 confirmed, GT now has 'server_1000'

    // Now, Client 2's operation gets "confirmed" (could be from server response or local logic)
    // We use serverData that matches the *optimistic* data, including the conflicting ID
    const confirmed = arrayState.confirmOptimisticOp(opIdClient2, { id: conflictingId, name: 'Second Item Confirmed', value: 3 });
    expect(confirmed).toBe(true); // Op was found and processed

    // Check final state
    const conflictingItems = arrayState.data.filter(item => item.id === conflictingId);
    expect(conflictingItems).toHaveLength(1); // Should only be one item with this ID

    // The _safeAddToArray inside confirmOptimisticOp should have updated the existing item
    expect(conflictingItems[0].name).toBe('Second Item Confirmed');
    expect(conflictingItems[0].value).toBe(3);
    expect(arrayState.groundTruth.find(item => item.id === conflictingId)?.name).toBe('Second Item Confirmed');
    expect(arrayState.optimisticOps.size).toBe(0); // Client 2's op was removed
  });

  it('should handle bulk operations correctly', async () => {
    // Prepare bulk create data
    const bulkItemsData = Array.from({ length: 10 }, (_, i) => ({
       name: `Bulk Item ${i}`, value: i * 10
    }));
    const bulkItemsOpts = bulkItemsData.map((data, i) => ({
        id: `temp_bulk_${i}`,
        position: undefined,
        data: data
    }));


    // Apply optimistic updates
    const opIds = arrayState.bulkCreateOptimistic(bulkItemsOpts);
    expect(opIds).toHaveLength(10);

    // Verify optimistic state
    expect(arrayState.data).toHaveLength(initialData.length + 10);
    expect(arrayState.optimisticOps.size).toBe(10);

    // Simulate server processing ALL items concurrently (promises)
    const serverProcessingPromises = bulkItemsOpts.map((itemOpt) =>
      server.processOperation({
        type: 'create',
        data: itemOpt.data // Send original data
      }).then(serverData => ({ id: itemOpt.id, serverData })) // Map result to expected confirm format
    );

    // Advance time enough for ALL server operations to potentially complete
    // Max latency 150ms * 10 = 1500ms. Add buffer.
    await vi.advanceTimersByTimeAsync(2000); // Increased time

    // Wait for all server operations to finish
    const serverResults = await Promise.all(serverProcessingPromises);
    expect(serverResults).toHaveLength(10); // Ensure all promises resolved

    // Bulk confirm all operations
    const confirmedCount = arrayState.bulkConfirmOptimisticOps(serverResults);
    expect(confirmedCount).toBe(10); // Ensure all were found and confirmed

    // Verify final state
    expect(arrayState.optimisticOps.size).toBe(0);
    expect(arrayState.groundTruth).toHaveLength(initialData.length + 10);
    expect(arrayState.data).toHaveLength(initialData.length + 10); // Check view too

    // All items should have server-assigned IDs and be TestItem instances
    let bulkItemCount = 0;
    for (const item of arrayState.data) {
      expect(item).toBeInstanceOf(TestItem);
      if (item.name?.startsWith('Bulk Item')) {
        expect(item.id).toMatch(/^server_/);
        bulkItemCount++;
      }
    }
    expect(bulkItemCount).toBe(10);
    expect(arrayState.groundTruth.every(item => item instanceof TestItem)).toBe(true);

  }, 10000); // Increased timeout for this test


  it('should handle create+update+delete sequence on same item', async () => {
    // Create a new item
    const createPromise = client.createItem({ name: 'Transient Item', value: 500 });
    // Advance time enough for server confirmation (max latency 150ms + buffer)
    await vi.advanceTimersByTimeAsync(300); // Increased advance time
    const newItem = await createPromise;
    expect(newItem.id).toMatch(/^server_/); // Verify server ID
    expect(arrayState.optimisticOps.size).toBe(0); // Verify confirmed


    // Immediately update it
    const updatePromise = client.updateItem(newItem.id, { value: 600 });
    // Advance time again
    await vi.advanceTimersByTimeAsync(300); // Increased advance time
    await updatePromise;
    expect(arrayState.optimisticOps.size).toBe(0); // Verify confirmed
    const updatedItem = arrayState.data.find(item => item.id === newItem.id);
    expect(updatedItem?.value).toBe(600);
    expect(updatedItem).toBeInstanceOf(TestItem);


    // Then delete it
    const deletePromise = client.deleteItem(newItem.id);
    // Advance time again
    await vi.advanceTimersByTimeAsync(300); // Increased advance time
    await deletePromise;
    expect(arrayState.optimisticOps.size).toBe(0); // Verify confirmed


    // Item should not exist in final state
    expect(arrayState.data.find(item => item.id === newItem.id)).toBeFalsy();

    // Ground truth should not contain the item
    expect(arrayState.groundTruth.find(item => item.id === newItem.id)).toBeFalsy();

    // No optimistic operations should remain
    expect(arrayState.optimisticOps.size).toBe(0);
  }, 10000); // Increased timeout for this test


  it('should maintain atomicity with overlapping operations', async () => {
    // Start with a race condition - multiple clients updating same items

    // Client 1 (our client) updates items 1, 2, 3
    const clientUpdatesPromises = [
      client.updateItem('1', { value: 110, updatedBy: 'client1' }),
      client.updateItem('2', { value: 210, updatedBy: 'client1' }),
      client.updateItem('3', { value: 310, updatedBy: 'client1' })
    ];

    // Client 2 (via server) updates same items with different values
    server.queueChange({ type: 'update', key: '1', data: { value: 120, updatedBy: 'client2' } });
    server.queueChange({ type: 'update', key: '2', data: { value: 220, updatedBy: 'client2' } });
    server.queueChange({ type: 'update', key: '3', data: { value: 320, updatedBy: 'client2' } });

    // Start server processing
    server.startProcessing();

    // Advance time to process all operations (3 client confirms + 3 server events)
    await vi.advanceTimersByTimeAsync(1000); // Generous time
    await Promise.all(clientUpdatesPromises);
    await vi.advanceTimersByTimeAsync(100); // Ensure server interval runs again

    // Each item should be updated atomically
    // The last writer wins in each case (depends on timing of direct vs confirm)
    const item1 = arrayState.data.find(item => item.id === '1');
    const item2 = arrayState.data.find(item => item.id === '2');
    const item3 = arrayState.data.find(item => item.id === '3');

    // All items should exist and be TestItem instances
    expect(item1).toBeInstanceOf(TestItem);
    expect(item2).toBeInstanceOf(TestItem);
    expect(item3).toBeInstanceOf(TestItem);

    // All items should have an 'updatedBy' field from one of the clients
    expect(item1.updatedBy).toMatch(/client[12]/);
    expect(item2.updatedBy).toMatch(/client[12]/);
    expect(item3.updatedBy).toMatch(/client[12]/);

    // The data should be consistent for each item.
    // We check that the value matches the source indicated by 'updatedBy'.
    if (item1.updatedBy === 'client1') expect(item1.value).toBe(110);
    else expect(item1.value).toBe(120);

    if (item2.updatedBy === 'client1') expect(item2.value).toBe(210);
    else expect(item2.value).toBe(220);

    if (item3.updatedBy === 'client1') expect(item3.value).toBe(310);
    else expect(item3.value).toBe(320);

    expect(arrayState.optimisticOps.size).toBe(0);
  });

  it('should maintain consistency with rapid server changes', async () => {
      // Helper to process all pending server changes synchronously
      const processAllServerChanges = () => {
          let processed = 0;
          while (server.pendingChanges.length > 0) {
              const change = server.pendingChanges.shift();
              // console.log("Processing server change:", change); // Debug
              client.processServerEvent(change);
              processed++;
          }
          // console.log(`Processed ${processed} server changes.`); // Optional debug log
      };

      // Stop interval-based processing if it was started
      server.stopProcessing();

      // Queue many server events rapidly
      for (let i = 0; i < 50; i++) {
          server.queueChange({
              type: 'create',
              // Ensure data is plain object for event, processServerEvent will handle ItemClass
              data: { id: `server_rapid_${i}`, name: `Server Rapid ${i}`, value: i }
          });
      }
      expect(server.pendingChanges.length).toBe(50); // Verify queueing

      // Advance time (simulates passage of time, not needed for processing here)
      await vi.advanceTimersByTimeAsync(1); // Minimal advance just to move time forward

      // Process ALL queued server events NOW
      processAllServerChanges();
      expect(server.pendingChanges.length).toBe(0); // Verify queue is empty

      // Verify all server items were created in ground truth and view IMMEDIATELY
      expect(arrayState.groundTruth.filter(item => item.id.startsWith('server_rapid_'))).toHaveLength(50);
      const serverItemsView = arrayState.data.filter(item => item.id.startsWith('server_rapid_'));
      expect(serverItemsView).toHaveLength(50); // <<<< THE CRITICAL CHECK
      // Ensure they are TestItem instances
      expect(serverItemsView.every(item => item instanceof TestItem)).toBe(true);


      // Apply some client operations concurrently
      const clientOpsPromises = [];
      for (let i = 0; i < 10; i++) {
          clientOpsPromises.push(
              client.createItem({ name: `Client Concurrent ${i}`, value: i })
                .catch(() => null) // Handle potential failures
          );
      }

      // Advance time to allow server confirmations for client operations
      await vi.advanceTimersByTimeAsync(500); // Enough time for 10 client ops (max 150ms each + buffer)
      await Promise.all(clientOpsPromises); // Wait for all client operations (including confirmation)

      // Process any final server changes (shouldn't be any here)
      processAllServerChanges();

      // Verify client items were created
      const clientItems = arrayState.data.filter(item => item.name?.startsWith('Client Concurrent'));
      const successfulClientOps = (await Promise.all(clientOpsPromises)).filter(r => r !== null).length;
      expect(clientItems).toHaveLength(successfulClientOps);
      // Ensure they have server IDs and are TestItem instances
      clientItems.forEach(item => {
          expect(item.id).toMatch(/^server_/);
          expect(item).toBeInstanceOf(TestItem);
      });


      // Verify server items still exist
      const finalServerItemsView = arrayState.data.filter(item => item.id.startsWith('server_rapid_'));
      expect(finalServerItemsView).toHaveLength(50);


      // Total items should be initial + server + successful client
      const expectedTotal = initialData.length + 50 + successfulClientOps;
      expect(arrayState.data).toHaveLength(expectedTotal);
      expect(arrayState.groundTruth).toHaveLength(expectedTotal);


      // No pending operations should remain
      expect(arrayState.optimisticOps.size).toBe(0);
      expect(client.pendingOperations.size).toBe(0);
  }, 10000); // Increase timeout just in case

  it('should handle server-side deletes of items with pending updates', async () => {
    // Start updating an item optimistically
    const opId = `temp_${nanoid(8)}`;
    arrayState.updateOptimistic({ id: opId, key: '1' }, { value: 150 });
    expect(arrayState.optimisticOps.has(opId)).toBe(true);
    expect(arrayState.data.find(item => item.id === '1')?.value).toBe(150); // Optimistic update applied

    // Simulate the server processing the *delete* for this item before the update confirmation arrives
    server.queueChange({ type: 'delete', key: '1' });

    // Start server processing
    server.startProcessing();
    await vi.advanceTimersByTimeAsync(100); // Allow server to process delete

    // Verify item is deleted from ground truth and view due to server event
    expect(arrayState.groundTruth.find(item => item.id === '1')).toBeFalsy();
    expect(arrayState.data.find(item => item.id === '1')).toBeFalsy(); // View reflects delete

    // Now, simulate the *confirmation* arriving for the (now obsolete) update operation
    // We use confirmOptimisticOp as it removes the op regardless of GT state
    const confirmed = arrayState.confirmOptimisticOp(opId, { value: 150 }); // Server data doesn't matter much here
    expect(confirmed).toBe(true); // Op was found and removed

    // The item should remain deleted
    expect(arrayState.data.find(item => item.id === '1')).toBeFalsy();
    expect(arrayState.groundTruth.find(item => item.id === '1')).toBeFalsy();

    // No optimistic operations should remain
    expect(arrayState.optimisticOps.size).toBe(0);
  });

  it('should maintain idempotency with duplicate optimistic create operations (same temp ID)', async () => {
    // Simulate applying the exact same optimistic create operation twice
    const opId = `temp_${nanoid(8)}`;
    const itemData = { name: 'Duplicate Op Item', value: 999 };

    // First optimistic create
    arrayState.createOptimistic({ id: opId, position: 0 }, itemData);
    expect(arrayState.data).toHaveLength(initialData.length + 1);
    expect(arrayState.optimisticOps.size).toBe(1);
    const item1 = arrayState.data.find(i => i.id === opId); // Use the temp ID for lookup here
    expect(item1).toBeTruthy();
    expect(item1?.name).toBe(itemData.name);
    expect(item1?.id).toBe(opId); // Should have temp ID

    // Second identical optimistic create (same opId)
    arrayState.createOptimistic({ id: opId, position: 0 }, { ...itemData, value: 1000 }); // Update data slightly
    expect(arrayState.data).toHaveLength(initialData.length + 1); // Length should NOT increase
    expect(arrayState.optimisticOps.size).toBe(1); // Still only one op in the map

     // The view should reflect the data from the *latest* optimistic op with that ID
    const item2 = arrayState.data.find(i => i.id === opId);
    expect(item2).toBeTruthy();
    expect(item2?.value).toBe(1000);


    // Now confirm the operation - start the server processing
    const serverDataPromise = server.processOperation({ type: 'create', data: itemData });

    // Advance timers enough for the server operation to complete
    await vi.advanceTimersByTimeAsync(300); // Use a safe margin over max latency

    // Explicitly wait for the server promise to resolve
    const serverData = await serverDataPromise;
    expect(serverData.id).toMatch(/^server_/); // Ensure server processing actually happened


    // Confirm using the server's response
    const confirmed = arrayState.confirmOptimisticOp(opId, serverData);
    expect(confirmed).toBe(true);

    // Final state should have one item with the server ID
    expect(arrayState.optimisticOps.size).toBe(0);
    expect(arrayState.data).toHaveLength(initialData.length + 1);
    const finalItem = arrayState.data.find(i => i.id === serverData.id);
    expect(finalItem).toBeTruthy();
    expect(finalItem).toBeInstanceOf(TestItem);
    expect(finalItem?.name).toBe(itemData.name);
    // Value should be from server data provided during confirmation
    expect(finalItem?.value).toBe(itemData.value); // Should match the data sent to server

    expect(arrayState.groundTruth).toHaveLength(initialData.length + 1);
    expect(arrayState.groundTruth.find(i => i.id === serverData.id)?.value).toBe(itemData.value);

}, 10000); // Increased timeout for this test

  it('should handle duplicate direct create operations safely', () => {
      const itemData = { id: 'direct_duplicate', name: 'Direct Dup', value: 1 };

      // First direct create
      const created1 = arrayState.createDirect({}, itemData);
      expect(created1).toBe(true); // New item added
      expect(arrayState.groundTruth).toHaveLength(initialData.length + 1);
      expect(arrayState.data).toHaveLength(initialData.length + 1);
      expect(arrayState.data.find(i => i.id === 'direct_duplicate')?.value).toBe(1);

      // Second direct create with same ID but different data
      const created2 = arrayState.createDirect({}, { ...itemData, value: 2 });
      expect(created2).toBe(false); // Existing item updated, not added
      expect(arrayState.groundTruth).toHaveLength(initialData.length + 1); // Length unchanged
      expect(arrayState.data).toHaveLength(initialData.length + 1); // Length unchanged

      // Verify the item was updated
      expect(arrayState.data.find(i => i.id === 'direct_duplicate')?.value).toBe(2);
      expect(arrayState.groundTruth.find(i => i.id === 'direct_duplicate')?.value).toBe(2);
  });


});