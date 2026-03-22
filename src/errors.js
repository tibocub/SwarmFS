/**
 * Typed errors for SwarmFS
 */

/**
 * Base error class for all SwarmFS errors
 */
export class SwarmFSError extends Error {
  constructor(message, code, cause) {
    super(message)
    this.name = 'SwarmFSError'
    this.code = code
    this.cause = cause
  }
}

/**
 * Validation error - invalid input at API boundary
 */
export class ValidationError extends SwarmFSError {
  constructor(message, cause) {
    super(message, 'VALIDATION_ERROR', cause)
    this.name = 'ValidationError'
  }
}

/**
 * Network error - connection or transport issues
 */
export class NetworkError extends SwarmFSError {
  constructor(message, cause) {
    super(message, 'NETWORK_ERROR', cause)
    this.name = 'NetworkError'
  }
}

/**
 * Protocol error - message format or protocol violation
 */
export class ProtocolError extends SwarmFSError {
  constructor(message, cause) {
    super(message, 'PROTOCOL_ERROR', cause)
    this.name = 'ProtocolError'
  }
}

/**
 * Not found error - resource does not exist
 */
export class NotFoundError extends SwarmFSError {
  constructor(message, cause) {
    super(message, 'NOT_FOUND', cause)
    this.name = 'NotFoundError'
  }
}

/**
 * Timeout error - operation timed out
 */
export class TimeoutError extends SwarmFSError {
  constructor(message, cause) {
    super(message, 'TIMEOUT_ERROR', cause)
    this.name = 'TimeoutError'
  }
}

/**
 * Disk error - file I/O issues
 */
export class DiskError extends SwarmFSError {
  constructor(message, cause) {
    super(message, 'DISK_ERROR', cause)
    this.name = 'DiskError'
  }
}

/**
 * Verification error - hash mismatch or integrity check failed
 */
export class VerificationError extends SwarmFSError {
  constructor(message, cause) {
    super(message, 'VERIFICATION_ERROR', cause)
    this.name = 'VerificationError'
  }
}

/**
 * Create appropriate error from validation result
 * @param {{ valid: boolean, error?: string }} result - Validation result
 * @returns {ValidationError}
 */
export function validationError(result) {
  return new ValidationError(result.error || 'Validation failed')
}

/**
 * Wrap an unknown error into a SwarmFSError
 * @param {unknown} err - The error to wrap
 * @param {string} defaultMessage - Default message if err has no message
 * @returns {SwarmFSError}
 */
export function wrapError(err, defaultMessage = 'An unexpected error occurred') {
  if (err instanceof SwarmFSError) {
    return err
  }
  const message = err instanceof Error ? err.message : defaultMessage
  return new SwarmFSError(message, 'UNKNOWN_ERROR', err)
}
