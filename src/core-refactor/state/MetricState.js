/**
 * Represents a single metric's ground truth value that stays in sync
 * with a QueryState's refresh cycle.
 *
 * It does NOT calculate optimistic values or notify subscribers directly.
 * Consumers should subscribe to the associated QueryState and pull this
 * metric's value when needed for optimistic calculations.
 */
export class Metric {
    /**
     * @param {object} options
     * @param {QueryState} options.queryStateInstance - The QueryState instance to monitor for sync triggers.
     * @param {Function} options.fetchMetricValue - Async function () => Promise<any> to get the ground truth value for THIS metric.
     * @param {any} [options.initialValue=null] - Optional initial value for the metric's ground truth.
     * @param {string} [options.name='UnnamedMetric'] - Optional name for logging/debugging.
     */
    constructor(options) {
        if (!options || !options.queryStateInstance || !options.fetchMetricValue) {
            throw new Error("Metric requires options: queryStateInstance, fetchMetricValue");
        }
        if (typeof options.queryStateInstance.subscribe !== 'function') {
             throw new Error("Provided queryStateInstance must have a 'subscribe' method.");
        }

        this.queryState = options.queryStateInstance;
        this.fetchMetricValue = options.fetchMetricValue;
        this.metricName = options.name || 'UnnamedMetric';

        // Only store the ground truth value
        this.value = options.initialValue !== undefined ? options.initialValue : null;

        this.isSyncing = false;
        this.lastSyncError = null;

        // Store the unsubscribe function from QueryState
        this.queryStateUnsubscriber = null;

        this._subscribeToQueryState();
    }

    _subscribeToQueryState() {
        // Only subscribe to sync_started to trigger our own fetch
        this.queryStateUnsubscriber = this.queryState.subscribe(
            (eventType) => {
                if (eventType === 'sync_started') {
                    // Don't await, let it run concurrently with QueryState sync
                    this.sync();
                }
            },
            ['sync_started']
        );
    }

    /**
     * Fetches the ground truth value for this specific metric.
     * Triggered by QueryState's sync cycle. Updates internal value.
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
                 // console.log(`Metric [${this.metricName}] value updated to: ${this.value}`);
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
     * Consumers call this when QueryState indicates a change.
     * @returns {any}
     */
    getValue() {
        return this.value;
    }

    /**
     * Cleans up subscription to QueryState.
     */
    destroy() {
        // Unsubscribe from QueryState
        if (this.queryStateUnsubscriber) {
            this.queryStateUnsubscriber();
            this.queryStateUnsubscriber = null;
        }
    }
}