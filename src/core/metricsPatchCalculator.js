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
    // Log detailed information about the inputs
    console.log('CountPatchCalculator called with:', {
      field,
      eventType,
      updatedDataLength: updatedData.length,
      updatedDataItems: updatedData.map(item => typeof item === 'object' ? item.id : item),
      originalDataLength: originalData.length,
      originalDataItems: originalData.map(item => typeof item === 'object' ? item.id : item),
      currentMetricValue: metricValue
    });
    
    // Existing logic
    console.log("patches", updatedData);
    if (eventType === 'create') {
      const newValue = metricValue + (updatedData.length - originalData.length);
      console.log(`Create event: ${metricValue} + (${updatedData.length} - ${originalData.length}) = ${newValue}`);
      return newValue;
    }
    
    if (eventType === 'delete') {
      const newValue = metricValue - (originalData.length - updatedData.length);
      console.log(`Delete event: ${metricValue} - (${originalData.length} - ${updatedData.length}) = ${newValue}`);
      return newValue;
    }
    
    // For updates, log and return unchanged
    console.log(`Update event: metric value remains ${metricValue}`);
    return metricValue;
  }
}

export default CountPatchCalculator;


  export const calculators = {
    "count": CountPatchCalculator
  }