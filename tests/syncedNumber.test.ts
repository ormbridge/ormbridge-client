import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncedNumber } from '../src/core/syncedNumber'; // Adjust path as needed
import { nanoid } from 'nanoid';

// Utility for creating delays that simulate network latency
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Mock server that simulates network latency and responses for counter operations
class MockServer {
  constructor(initialValue = 0, latencyRange = [50, 150]) {
    this.value = initialValue;
    this.latencyRange = latencyRange;
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
      case 'update': {
        // Apply delta to server value
        this.value += operation.delta;
        return operation.delta; // Return the delta that was applied
      }
      case 'set': {
        // Set absolute value
        const oldValue = this.value;
        this.value = operation.value;
        return oldValue; // Return previous value
      }
      default:
        throw new Error(`Unknown operation type: ${operation.type}`);
    }
  }
}

// Simulates client-side operations and server confirmations
class ClientSimulator {
  constructor(counter, server) {
    this.counter = counter;
    this.server = server;
    this.completedOperations = 0;
    this.failedOperations = 0;
    this.pendingOperations = new Map();
  }

  async updateValue(delta) {
    const opId = `temp_${nanoid(8)}`;

    try {
      // Apply optimistic update locally
      this.counter.updateOptimistic(opId, delta);
      this.pendingOperations.set(opId, { type: 'update', delta });

      // Send to server
      const serverDelta = await this.server.processOperation({
        type: 'update',
        delta
      });

      // Confirm optimistic update with server result
      this.counter.confirmOptimisticOp(opId, serverDelta);
      this.pendingOperations.delete(opId);
      this.completedOperations++;

      return this.counter.value;
    } catch (error) {
      // Handle server failure - remove optimistic operation
      this.counter.removeOptimisticOp(opId);
      this.pendingOperations.delete(opId);
      this.failedOperations++;
      throw error;
    }
  }

  async setValue(newValue) {
    try {
      // Send to server - no optimistic update for setValue
      await this.server.processOperation({
        type: 'set',
        value: newValue
      });

      // Update local value directly
      this.counter.setDirect(newValue);
      this.completedOperations++;

      return this.counter.value;
    } catch (error) {
      this.failedOperations++;
      throw error;
    }
  }

  // Process a server event
  processServerEvent(event) {
    switch (event.type) {
      case 'update':
        this.counter.updateDirect(event.delta);
        break;
      case 'set':
        this.counter.setDirect(event.value);
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

describe('SyncedNumber Tests', () => {
  let counter;
  let server;
  let client;
  let initialValue;
  let onChangeHandler;

  beforeEach(() => {
    vi.useFakeTimers();

    initialValue = 100;
    onChangeHandler = vi.fn();

    // Create new counter and server instances for each test
    counter = new SyncedNumber({
      initialValue,
      onChange: onChangeHandler
    });

    server = new MockServer(initialValue);
    client = new ClientSimulator(counter, server);

    // Set up server subscription
    server.subscribe((event) => {
      client.processServerEvent(event);
    });
  });

  afterEach(() => {
    server.stopProcessing();
    vi.useRealTimers();
  });

  it('should initialize with correct value', () => {
    expect(counter.value).toBe(initialValue);
    expect(counter.getGroundTruth()).toBe(initialValue);
    expect(counter.getOptimisticOps().size).toBe(0);
  });

  it('should apply optimistic updates correctly', () => {
    // Apply single optimistic update
    const opId = counter.updateOptimistic('op1', 5);
    
    // Check state after optimistic update
    expect(counter.value).toBe(initialValue + 5);
    expect(counter.getGroundTruth()).toBe(initialValue);
    expect(counter.getOptimisticOps().size).toBe(1);
    expect(counter.getOptimisticOps().has(opId)).toBe(true);
    
    // Apply another optimistic update
    counter.updateOptimistic('op2', -3);
    
    // Check cumulative effect
    expect(counter.value).toBe(initialValue + 5 - 3);
    expect(counter.getGroundTruth()).toBe(initialValue);
    expect(counter.getOptimisticOps().size).toBe(2);
  });

  it('should call onChange when value changes', () => {
    // Initial state shouldn't trigger onChange
    expect(onChangeHandler).not.toHaveBeenCalled();
    
    // Apply optimistic update should trigger onChange
    counter.updateOptimistic('op1', 5);
    expect(onChangeHandler).toHaveBeenCalledTimes(1);
    expect(onChangeHandler).toHaveBeenCalledWith(initialValue + 5, initialValue);
    
    // Another update should trigger onChange again
    counter.updateOptimistic('op2', 10);
    expect(onChangeHandler).toHaveBeenCalledTimes(2);
    expect(onChangeHandler).toHaveBeenCalledWith(initialValue + 5 + 10, initialValue + 5);
  });

  it('should handle direct updates correctly', () => {
    // Apply direct update
    const oldValue = counter.updateDirect(15);
    
    // Check state after direct update
    expect(oldValue).toBe(initialValue); // Returns previous value
    expect(counter.value).toBe(initialValue + 15);
    expect(counter.getGroundTruth()).toBe(initialValue + 15);
    expect(counter.getOptimisticOps().size).toBe(0);
    
    // Apply another direct update
    counter.updateDirect(-8);
    
    // Check cumulative effect
    expect(counter.value).toBe(initialValue + 15 - 8);
    expect(counter.getGroundTruth()).toBe(initialValue + 15 - 8);
  });

  it('should handle setDirect correctly', () => {
    // Set direct value
    const oldValue = counter.setDirect(50);
    
    // Check state after direct set
    expect(oldValue).toBe(initialValue); // Returns previous value
    expect(counter.value).toBe(50);
    expect(counter.getGroundTruth()).toBe(50);
    expect(counter.getOptimisticOps().size).toBe(0);
  });

  it('should remove optimistic operations', () => {
    // Apply optimistic update
    const opId = counter.updateOptimistic('op1', 5);
    
    // Verify update was applied
    expect(counter.value).toBe(initialValue + 5);
    
    // Remove the optimistic operation
    const result = counter.removeOptimisticOp(opId);
    
    // Check operation was removed
    expect(result).toBe(true);
    expect(counter.value).toBe(initialValue);
    expect(counter.getOptimisticOps().size).toBe(0);
    
    // Try removing non-existent operation
    const notFoundResult = counter.removeOptimisticOp('non-existent');
    expect(notFoundResult).toBe(false);
  });

  it('should confirm optimistic operations', () => {
    // Apply optimistic update
    const opId = counter.updateOptimistic('op1', 5);
    
    // Verify update was applied optimistically
    expect(counter.value).toBe(initialValue + 5);
    expect(counter.getGroundTruth()).toBe(initialValue);
    
    // Confirm the operation
    const confirmed = counter.confirmOptimisticOp(opId);
    
    // Check operation was confirmed
    expect(confirmed).toBe(true);
    expect(counter.value).toBe(initialValue + 5);
    expect(counter.getGroundTruth()).toBe(initialValue + 5);
    expect(counter.getOptimisticOps().size).toBe(0);
  });

  it('should confirm with server delta', () => {
    // Apply optimistic update
    const opId = counter.updateOptimistic('op1', 5);
    
    // Verify optimistic update
    expect(counter.value).toBe(initialValue + 5);
    
    // Confirm with different server delta
    const confirmed = counter.confirmOptimisticOp(opId, 3);
    
    // Check correct server value was applied
    expect(confirmed).toBe(true);
    expect(counter.value).toBe(initialValue + 3);
    expect(counter.getGroundTruth()).toBe(initialValue + 3);
    expect(counter.getOptimisticOps().size).toBe(0);
  });

  it('should clear all optimistic operations', () => {
    // Apply multiple optimistic updates
    counter.updateOptimistic('op1', 5);
    counter.updateOptimistic('op2', 10);
    counter.updateOptimistic('op3', -3);
    
    // Verify combined effect
    expect(counter.value).toBe(initialValue + 5 + 10 - 3);
    expect(counter.getOptimisticOps().size).toBe(3);
    
    // Clear all operations
    const cleared = counter.clearOptimisticOps();
    
    // Check operations were cleared
    expect(cleared).toBe(3);
    expect(counter.value).toBe(initialValue);
    expect(counter.getOptimisticOps().size).toBe(0);
  });

  it('should handle basic operations with server confirmation', async () => {
    // Apply optimistic update
    const updatePromise = client.updateValue(10);
    
    // Fast-forward time to resolve the promise
    await vi.advanceTimersByTimeAsync(200);
    const newValue = await updatePromise;
    
    // Verify update was applied and confirmed
    expect(newValue).toBe(initialValue + 10);
    expect(counter.value).toBe(initialValue + 10);
    expect(counter.getGroundTruth()).toBe(initialValue + 10);
    expect(counter.getOptimisticOps().size).toBe(0);
    
    // Apply another update
    const updatePromise2 = client.updateValue(-5);
    await vi.advanceTimersByTimeAsync(200);
    const newerValue = await updatePromise2;
    
    // Verify second update
    expect(newerValue).toBe(initialValue + 10 - 5);
    expect(counter.value).toBe(initialValue + 10 - 5);
    expect(counter.getGroundTruth()).toBe(initialValue + 10 - 5);
  });

  it('should handle high-frequency operations', async () => {
    // Apply many updates in rapid succession
    const updatePromises = [];
    for (let i = 0; i < 20; i++) {
      updatePromises.push(
        client.updateValue(1)
          .catch(() => null) // Handle potential failures
      );
    }
    
    // Initial state should reflect all optimistic updates
    expect(counter.value).toBe(initialValue + 20);
    expect(counter.getGroundTruth()).toBe(initialValue);
    expect(client.pendingOperations.size).toBe(20);
    
    // Advance time enough for all operations to complete
    await vi.advanceTimersByTimeAsync(4000);
    await Promise.all(updatePromises);
    
    // All operations should be confirmed
    expect(client.pendingOperations.size).toBe(0);
    expect(counter.getOptimisticOps().size).toBe(0);
    
    // Final state should reflect all updates
    expect(counter.value).toBe(initialValue + 20);
    expect(counter.getGroundTruth()).toBe(initialValue + 20);
  });

  it('should handle interleaved server and client operations', async () => {
    // Start server processing
    server.startProcessing();
    
    // Server applies an update
    server.queueChange({
      type: 'update',
      delta: 5
    });
    
    // Client applies a different update
    const clientPromise = client.updateValue(10);
    
    // Server applies another update
    server.queueChange({
      type: 'update',
      delta: -3
    });
    
    // Advance time to process operations
    await vi.advanceTimersByTimeAsync(300);
    await clientPromise;
    await vi.advanceTimersByTimeAsync(100);
    
    // Final value should include all updates
    // Initial 100 + server 5 + client 10 + server -3 = 112
    expect(counter.value).toBe(112);
    expect(counter.getGroundTruth()).toBe(112);
    expect(counter.getOptimisticOps().size).toBe(0);
  });

  it('should handle server failures gracefully', async () => {
    // Enable random failures
    server.shouldFailRandomly = true;
    server.failureRate = 0.8; // High failure rate
    
    // Try multiple updates knowing some will fail
    const updatePromises = [];
    for (let i = 0; i < 10; i++) {
      updatePromises.push(
        client.updateValue(1)
          .catch(() => null) // Catch failures
      );
    }
    
    // Advance time for operations to complete
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(updatePromises);
    
    // Check stats
    const stats = client.getStats();
    expect(stats.pending).toBe(0);
    
    // Some operations should have succeeded, some failed
    expect(stats.completed + stats.failed).toBe(10);
    
    // Final value should reflect only successful operations
    expect(counter.value).toBe(initialValue + stats.completed);
    expect(counter.getGroundTruth()).toBe(initialValue + stats.completed);
    expect(counter.getOptimisticOps().size).toBe(0);
  });

  it('should handle delayed server confirmations', async () => {
    // Set very high server latency
    server.latencyRange = [500, 1000];
    
    // Apply updates
    const updatePromises = [];
    for (let i = 0; i < 5; i++) {
      updatePromises.push(client.updateValue(1));
    }
    
    // After updates but before confirmation
    expect(counter.value).toBe(initialValue + 5);
    expect(counter.getGroundTruth()).toBe(initialValue);
    expect(counter.getOptimisticOps().size).toBe(5);
    
    // Advance time enough for at least one operation to complete
    // Since minimum latency is 500ms, we need at least 550ms to be sure
    await vi.advanceTimersByTimeAsync(550);
    
    // Check if any operations completed
    // We won't assert on this because the operations complete at random times
    // and it's possible none have completed yet due to random latency
    const pendingAfterPartialTime = counter.getOptimisticOps().size;
    console.log(`Pending operations after partial time advance: ${pendingAfterPartialTime}`);
    
    // Complete remaining operations - advance well beyond max latency
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(updatePromises);
    
    // All operations should be confirmed
    expect(counter.getOptimisticOps().size).toBe(0);
    expect(counter.value).toBe(initialValue + 5);
    expect(counter.getGroundTruth()).toBe(initialValue + 5);
  });

  it('should handle concurrent updates with the same operation ID', async () => {
    // Apply same operation ID twice
    const opId = 'concurrent';
    counter.updateOptimistic(opId, 5);
    
    // Value should reflect first update
    expect(counter.value).toBe(initialValue + 5);
    
    // Apply second update with same ID
    counter.updateOptimistic(opId, 3);
    
    // Value should reflect only the second update (not cumulative)
    expect(counter.value).toBe(initialValue + 3);
    expect(counter.getOptimisticOps().size).toBe(1);
    
    // Confirm the operation
    counter.confirmOptimisticOp(opId);
    
    // Check final state
    expect(counter.value).toBe(initialValue + 3);
    expect(counter.getGroundTruth()).toBe(initialValue + 3);
    expect(counter.getOptimisticOps().size).toBe(0);
  });

  it('should handle very high frequency operations', async () => {
    // Reduce server latency
    server.latencyRange = [10, 30];
    
    // Apply many updates rapidly
    const updatePromises = [];
    for (let i = 0; i < 100; i++) {
      updatePromises.push(
        client.updateValue(1)
          .catch(() => null)
      );
    }
    
    // Advance time for operations
    await vi.advanceTimersByTimeAsync(4000);
    await Promise.all(updatePromises);
    
    // Check stats
    const stats = client.getStats();
    expect(stats.pending).toBe(0);
    
    // Final state should reflect successful operations
    expect(counter.value).toBe(initialValue + stats.completed);
    expect(counter.getGroundTruth()).toBe(initialValue + stats.completed);
    expect(counter.getOptimisticOps().size).toBe(0);
  }, 10000);

  it('should handle operations with non-numeric deltas', () => {
    // Test with string that converts to number
    counter.updateOptimistic('op1', '5');
    expect(counter.value).toBe(initialValue + 5);
    
    // Test with invalid input - should throw error
    expect(() => counter.updateOptimistic('op2', 'abc')).toThrow();
    
    // Counter should still have only the valid operation
    expect(counter.getOptimisticOps().size).toBe(1);
    expect(counter.value).toBe(initialValue + 5);
  });

  it('should handle rapid server changes', async () => {
    // Helper to process server changes synchronously
    const processAllServerChanges = () => {
      let processed = 0;
      while (server.pendingChanges.length > 0) {
        const change = server.pendingChanges.shift();
        client.processServerEvent(change);
        processed++;
      }
      return processed;
    };
    
    // Stop interval-based processing
    server.stopProcessing();
    
    // Queue many server events
    for (let i = 0; i < 50; i++) {
      server.queueChange({
        type: 'update',
        delta: 1
      });
    }
    
    // Verify queueing
    expect(server.pendingChanges.length).toBe(50);
    
    // Process all events
    const processed = processAllServerChanges();
    expect(processed).toBe(50);
    expect(server.pendingChanges.length).toBe(0);
    
    // Verify all updates were applied
    expect(counter.value).toBe(initialValue + 50);
    expect(counter.getGroundTruth()).toBe(initialValue + 50);
    
    // Apply client operations concurrently
    const clientPromises = [];
    for (let i = 0; i < 10; i++) {
      clientPromises.push(
        client.updateValue(1)
          .catch(() => null)
      );
    }
    
    // Advance time for client operations
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all(clientPromises);
    
    // Process any final server changes
    processAllServerChanges();
    
    // Verify final state
    const successfulClientOps = client.getStats().completed;
    expect(counter.value).toBe(initialValue + 50 + successfulClientOps);
    expect(counter.getGroundTruth()).toBe(initialValue + 50 + successfulClientOps);
    expect(counter.getOptimisticOps().size).toBe(0);
  }, 10000);

  it('should handle server set operations', async () => {
    // Apply some updates to change initial value
    await client.updateValue(25);
    expect(counter.value).toBe(initialValue + 25);
    
    // Server sets absolute value
    server.queueChange({
      type: 'set',
      value: 50
    });
    
    // Start server processing
    server.startProcessing();
    await vi.advanceTimersByTimeAsync(100);
    
    // Value should be set by server
    expect(counter.value).toBe(50);
    expect(counter.getGroundTruth()).toBe(50);
    
    // Client applies optimistic update
    const opId = counter.updateOptimistic('op1', 10);
    expect(counter.value).toBe(60);
    
    // Confirm the update
    counter.confirmOptimisticOp(opId);
    expect(counter.value).toBe(60);
    expect(counter.getGroundTruth()).toBe(60);
  });

  it('should maintain atomicity with overlapping operations', async () => {
    // Client applies update
    const clientPromise = client.updateValue(10);
    
    // Server applies update to same counter
    server.queueChange({
      type: 'update',
      delta: 5
    });
    
    // Start server processing
    server.startProcessing();
    
    // Advance time for operations
    await vi.advanceTimersByTimeAsync(300);
    await clientPromise;
    await vi.advanceTimersByTimeAsync(100);
    
    // Final value should include both updates
    // Initial 100 + client 10 + server 5 = 115
    expect(counter.value).toBe(115);
    expect(counter.getGroundTruth()).toBe(115);
    expect(counter.getOptimisticOps().size).toBe(0);
  });

  it('should handle set operations after optimistic updates', async () => {
    // Apply optimistic update
    counter.updateOptimistic('op1', 10);
    
    // Set direct value
    counter.setDirect(50);
    
    // Value should be set directly, ignoring optimistic update
    expect(counter.value).toBe(50 + 10); // Ground truth + optimistic
    expect(counter.getGroundTruth()).toBe(50);
    expect(counter.getOptimisticOps().size).toBe(1);
    
    // Confirm optimistic operation
    counter.confirmOptimisticOp('op1');
    
    // Final value includes confirmed update
    expect(counter.value).toBe(60);
    expect(counter.getGroundTruth()).toBe(60);
    expect(counter.getOptimisticOps().size).toBe(0);
  });

  it('should validate inputs properly', () => {
    // Invalid operation ID
    expect(() => counter.updateOptimistic('', 5)).toThrow();
    expect(() => counter.updateOptimistic(null, 5)).toThrow();
    
    // Invalid delta values
    expect(() => counter.updateOptimistic('op1', 'abc')).toThrow();
    expect(() => counter.updateOptimistic('op1', NaN)).toThrow();
    
    // Invalid direct values
    expect(() => counter.setDirect('abc')).toThrow();
    expect(() => counter.setDirect(NaN)).toThrow();
    
    // Counter state should be unchanged
    expect(counter.value).toBe(initialValue);
    expect(counter.getGroundTruth()).toBe(initialValue);
    expect(counter.getOptimisticOps().size).toBe(0);
  });
});