class CountPatchCalculator {
    /**
     * Calculates the new metric value for count
     * 
     * @param {string|undefined} field - Field to count (not used for count)
     * @param {string} eventType - Type of event ('create', 'update', or 'delete')
     * @param {Array} updatedData - The updatedData array
     * @param {Array} originalData - The original data (not used for count)
     * @param {number} metricValue - Current metric value
     * @returns {number} The new metric value
     */
    static calculate(field, eventType, updatedData, originalData, metricValue) {
      console.log("patches", updatedData)
      if (eventType === 'create') {
        return metricValue + (updatedData.length - originalData.length);
      }
      
      if (eventType === 'delete') {
        return metricValue - (updatedData.length - originalData.length);
      }
      
      // For updates, return unchanged
      return metricValue;
    }
  }
  
  export default CountPatchCalculator;


  export const calculators = {
    "count": CountPatchCalculator
  }