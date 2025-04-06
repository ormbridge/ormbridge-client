/**
 * Represents a single metric's ground truth value that stays in sync
 * with a ModelStore's refresh cycle.
 *
 * It does NOT calculate optimistic values or notify subscribers directly.
 * Consumers should subscribe to the associated ModelStore and pull this
 * metric's value when needed for optimistic calculations.
 */
export class Metric {
    /**
     * @param {object} options
     * @param {ModelStore} options.modelStoreInstance - The ModelStore instance to monitor for sync triggers.
     * @param {Function} options.fetchMetricValue - Async function () => Promise<any> to get the ground truth value for THIS metric.
     * @param {any} [options.initialValue=null] - Optional initial value for the metric's ground truth.
     * @param {string} [options.name='UnnamedMetric'] - Optional name for logging/debugging.
     */
    constructor(options) {
        if (!options || !options.modelStoreInstance || !options.fetchMetricValue) {
            throw new Error("Metric requires options: modelStoreInstance, fetchMetricValue");
        }
        if (typeof options.modelStoreInstance.subscribe !== 'function') {
             throw new Error("Provided modelStoreInstance must have a 'subscribe' method.");
        }

        this.modelStore = options.modelStoreInstance;
        this.fetchMetricValue = options.fetchMetricValue;
        this.metricName = options.name || 'UnnamedMetric';

        // Only store the ground truth value
        this.value = options.initialValue !== undefined ? options.initialValue : null;

        this.isSyncing = false;
        this.lastSyncError = null;

        // Store the unsubscribe function from ModelStore
        this.modelStoreUnsubscriber = null;

        this._subscribeToModelStore();
    }

    _subscribeToModelStore() {
        // Only subscribe to sync_started to trigger our own fetch
        this.modelStoreUnsubscriber = this.modelStore.subscribe(
            (eventType) => {
                if (eventType === 'sync_started') {
                    // Don't await, let it run concurrently with ModelStore sync
                    this.sync();
                }
            },
            ['sync_started']
        );
    }

    /**
     * Fetches the ground truth value for this specific metric.
     * Triggered by ModelStore's sync cycle. Updates internal value.
     */
    async sync() {
        if (this.isSyncing) return;

        this.isSyncing = true;
        this.lastSyncError = null;

        try {
            const freshValue = await this.fetchMetricValue();

            // Update internal value if it changed. No notification needed from here.
            if (this.value !== freshValue) {
                this.value = freshValue;
            }
        } catch (error) {
            console.error(`Metric [${this.metricName}] sync failed:`, error);
            this.lastSyncError = error;
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Returns the current ground truth value of the metric.
     * Consumers call this when ModelStore indicates a change.
     * @returns {any}
     */
    getValue() {
        return this.value;
    }

    /**
     * Cleans up subscription to ModelStore.
     */
    destroy() {
        // Unsubscribe from ModelStore
        if (this.modelStoreUnsubscriber) {
            this.modelStoreUnsubscriber();
            this.modelStoreUnsubscriber = null;
        }
    }
}