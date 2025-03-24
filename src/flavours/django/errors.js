/**
 * @typedef {Object} IErrorResponse
 * @property {number} status - The HTTP status code.
 * @property {string} type - The error type.
 * @property {*} detail - The error details.
 */

/**
 * @typedef {Object} IErrorDetail
 * @property {string} message - The error message.
 * @property {string} code - The error code.
 */

/**
 * Base error class for ORMBridge errors.
 */
export class ORMBridgeError extends Error {
  /**
   * Creates a new ORMBridgeError.
   *
   * @param {string} message - The error message.
   * @param {string} code - The error code.
   * @param {IErrorDetail|Object|string} detail - The error details.
   * @param {number} status - The HTTP status code.
   */
  constructor(message, code, detail, status) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.detail = detail;
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Returns a full error message including the detail.
   * 
   * @returns {string} The full error message with details
   */
  getFullMessage() {
    if (typeof this.detail === 'string') {
      return `${this.message}: ${this.detail}`;
    } else if (this.detail && typeof this.detail === 'object') {
      if (this.detail.message) {
        return `${this.message}: ${this.detail.message}`;
      } else {
        try {
          return `${this.message}: ${JSON.stringify(this.detail)}`;
        } catch (e) {
          return `${this.message}: [Complex detail object]`;
        }
      }
    }
    return this.message;
  }
}

/**
 * Error class for validation errors.
 */
export class ValidationError extends ORMBridgeError {
  /**
   * Creates a new ValidationError.
   *
   * @param {IErrorDetail|Object|string} detail - The error details.
   * @param {number} [status=400] - The HTTP status code.
   */
  constructor(detail, status = 400) {
    super("Validation error", "validation_error", detail, status);
  }
}

/**
 * Error class for "Does Not Exist" errors (renamed from NotFound).
 */
export class DoesNotExist extends ORMBridgeError {
  /**
   * Creates a new DoesNotExist error.
   *
   * @param {IErrorDetail|Object|string} [detail="Does not exist"] - The error details.
   * @param {number} [status=404] - The HTTP status code.
   */
  constructor(detail = "Does not exist", status = 404) {
    super("DoesNotExist", "does_not_exist", detail, status);
  }
}

/**
 * Error class for permission denied errors.
 */
export class PermissionDenied extends ORMBridgeError {
  /**
   * Creates a new PermissionDenied error.
   *
   * @param {IErrorDetail|Object|string} [detail="Permission denied"] - The error details.
   * @param {number} [status=403] - The HTTP status code.
   */
  constructor(detail = "Permission denied", status = 403) {
    super("Permission denied", "permission_denied", detail, status);
  }
}

/**
 * Error class for multiple objects returned errors.
 */
export class MultipleObjectsReturned extends ORMBridgeError {
  /**
   * Creates a new MultipleObjectsReturned error.
   *
   * @param {IErrorDetail|Object|string} [detail="Multiple objects returned"] - The error details.
   * @param {number} [status=500] - The HTTP status code.
   */
  constructor(detail = "Multiple objects returned", status = 500) {
    super("Multiple objects returned", "multiple_objects_returned", detail, status);
  }
}

/**
 * Error class for AST validation errors.
 */
export class ASTValidationError extends ORMBridgeError {
  /**
   * Creates a new ASTValidationError.
   *
   * @param {IErrorDetail|Object|string} detail - The error details.
   * @param {number} [status=400] - The HTTP status code.
   */
  constructor(detail, status = 400) {
    super("Query syntax error", "ast_validation_error", detail, status);
  }
}

/**
 * Error class for configuration errors.
 */
export class ConfigError extends ORMBridgeError {
  /**
   * Creates a new ConfigError.
   *
   * @param {IErrorDetail|Object|string} detail - The error details.
   * @param {number} [status=500] - The HTTP status code.
   */
  constructor(detail, status = 500) {
    super("Configuration error", "config_error", detail, status);
  }
}

/**
 * Parses a JSON error response from the backend and returns an instance
 * of the corresponding custom error.
 *
 * @param {IErrorResponse} errorResponse - The error response JSON.
 * @returns {ORMBridgeError} An instance of a ORMBridgeError subclass.
 */
export function parseORMBridgeError(errorResponse) {
  const { status, type, detail } = errorResponse;
  
  // Handle undefined type/status case (like in permission denied)
  if (type === undefined && detail === 'Invalid token.') {
    return new PermissionDenied(detail, 403);
  }

  switch (type) {
    // Direct mappings
    case "ValidationError":
      return new ValidationError(detail, status);
    case "NotFound":
      return new DoesNotExist(detail, status);
    case "MultipleObjectsReturned":
      return new MultipleObjectsReturned(detail, status);
    case "PermissionDenied":
      return new PermissionDenied(detail, status);
    case "ASTValidationError":
      return new ASTValidationError(detail, status);
    case "ConfigError":
      return new ConfigError(detail, status);

    // Django error types that map to our error classes
    case "FieldError":
      return new ValidationError(detail, status);
    case "ValueError":
      return new ValidationError(detail, status);
    
    default:
      // Fallback to status code based mapping
      if (status === 400) {
        return new ValidationError(detail, status);
      } else if (status === 403) {
        return new PermissionDenied(detail, status);
      } else if (status === 404) {
        return new DoesNotExist(detail, status);
      }
      return new ORMBridgeError("Unknown error", "unknown", detail, status);
  }
}
