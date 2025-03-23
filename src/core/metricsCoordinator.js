/**
 * A simple coordinator that tracks refresh status and debounces refresh calls
 */
class MetricsCoordinator {
  constructor() {
    // Simple flag indicating if a refresh is in progress
    this.refreshInProgress = false;

    // Timer for debounced refreshes
    this.refreshTimer = null;

    // Default debounce time in ms
    this.debounceTime = 250;

    // Timestamp of last optimistic update
    this.lastUpdateTime = 0;
  }

  /**
   * Check if a refresh is currently in progress
   * @returns {boolean}
   */
  isRefreshing() {
    return this.refreshInProgress;
  }

  /**
   * Mark the beginning of a refresh
   */
  beginRefresh() {
    this.refreshInProgress = true;
  }

  /**
   * Mark the end of a refresh
   */
  endRefresh() {
    this.refreshInProgress = false;
  }

  /**
   * Record that an optimistic update happened
   */
  touch() {
    this.lastUpdateTime = Date.now();
  }

  /**
   * Schedule a refresh to happen after all optimistic updates
   * @param {Function} refreshFn - Function to call for refreshing
   * @returns {Promise<void>}
   */
  scheduleRefresh(refreshFn) {
    // Clear any existing timer
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    return new Promise((resolve) => {
      this.refreshTimer = setTimeout(async () => {
        // Only proceed if not already refreshing
        if (!this.refreshInProgress) {
          try {
            this.beginRefresh();
            await refreshFn();
          } catch (error) {
            console.error("Error during metrics refresh:", error);
          } finally {
            this.endRefresh();
            this.refreshTimer = null;
          }
        }
        resolve();
      }, this.debounceTime);
    });
  }
}

// Singleton instance for app-wide use
export const metricsCoordinator = new MetricsCoordinator();
