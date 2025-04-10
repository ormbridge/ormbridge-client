
/**
 * Guarantees an array of operations, is an array of operations. Handles
 * the basic failure case of a single operation.
 */
export function validateOperationsArray(operationsArray){
    // verify the operations list
    if (Array.isArray(operationsArray)){
        if (operationsArray.length > 0){
            if (!(operationsArray[0] instanceof Operation)){
                throw new Error(`operationsArray must be Operations not ${typeof(operationsArray[0])}`)
            }
        }
    } else if (!isNil(operationsArray)) {
        if (!(operationsArray instanceof Operation)){
            throw new Error(`operationsArray must be Operations not ${typeof(operationsArray)}`)
        }
        operationsArray = [operationsArray] // coerce it to be an array
    }
    return operationsArray
}

