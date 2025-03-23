class CountPatchCalculator {
  /**
   * Calculates the new metric value for count
   *
   * @param {string|undefined} field - Field to count (not used for count)
   * @param {string} eventType - Type of event ('create', 'update', or 'delete')
   * @param {Array} updatedData - The updated data array
   * @param {Array} originalData - The original data
   * @param {number} metricValue - Current metric value
   * @returns {number} The new metric value
   */
  static calculate(field, eventType, updatedData, originalData, metricValue) {
    if (eventType === "create") {
      const newValue = metricValue + (updatedData.length - originalData.length);
      return newValue;
    }
    if (eventType === "delete") {
      const newValue = metricValue - (originalData.length - updatedData.length);
      return newValue;
    }
    return metricValue;
  }
}

export default CountPatchCalculator;

export const calculators = {
  count: CountPatchCalculator,
};
