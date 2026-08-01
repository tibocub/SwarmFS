/**
 * Input validation for SwarmFS API boundaries
 */

/**
 * Validate merkle root hash format
 * @param {string} value - The merkle root to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateMerkleRoot(value) {
  if (!value || typeof value !== 'string') {
    return { valid: false, error: 'Missing merkle root' }
  }
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    return { valid: false, error: 'Invalid merkle root format (expected 64 hex characters)' }
  }
  return { valid: true }
}

/**
 * Validate chunk hash format
 * @param {string} value - The chunk hash to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateChunkHash(value) {
  if (!value || typeof value !== 'string') {
    return { valid: false, error: 'Missing chunk hash' }
  }
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    return { valid: false, error: 'Invalid chunk hash format (expected 64 hex characters)' }
  }
  return { valid: true }
}

/**
 * Validate topic name
 * @param {string} value - The topic name to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateTopicName(value) {
  if (!value || typeof value !== 'string') {
    return { valid: false, error: 'Missing topic name' }
  }
  if (value.length < 1 || value.length > 256) {
    return { valid: false, error: 'Topic name must be 1-256 characters' }
  }
  // Allow alphanumeric, dash, underscore, dot
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    return { valid: false, error: 'Topic name contains invalid characters' }
  }
  return { valid: true }
}

/**
 * Validate output path exists and is writable
 * @param {string} value - The output path to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateOutputPath(value) {
  if (!value || typeof value !== 'string') {
    return { valid: false, error: 'Missing output path' }
  }
  if (value.length === 0) {
    return { valid: false, error: 'Output path cannot be empty' }
  }
  // Check for obviously invalid paths
  if (value.includes('\0')) {
    return { valid: false, error: 'Output path contains null bytes' }
  }
  return { valid: true }
}

/**
 * Validate peer ID format
 * @param {string} value - The peer ID to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validatePeerId(value) {
  if (!value || typeof value !== 'string') {
    return { valid: false, error: 'Missing peer ID' }
  }
  if (!/^[0-9a-f]+$/i.test(value)) {
    return { valid: false, error: 'Invalid peer ID format (expected hex string)' }
  }
  return { valid: true }
}

/**
 * Validate chunk index is within bounds
 * @param {number} value - The chunk index to validate
 * @param {number} totalChunks - Total number of chunks
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateChunkIndex(value, totalChunks) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { valid: false, error: 'Chunk index must be an integer' }
  }
  if (value < 0) {
    return { valid: false, error: 'Chunk index cannot be negative' }
  }
  if (totalChunks !== undefined && value >= totalChunks) {
    return { valid: false, error: `Chunk index ${value} out of bounds (total: ${totalChunks})` }
  }
  return { valid: true }
}

/**
 * Validate file size is positive
 * @param {number} value - The file size to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateFileSize(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { valid: false, error: 'File size must be an integer' }
  }
  if (value < 0) {
    return { valid: false, error: 'File size cannot be negative' }
  }
  return { valid: true }
}

/**
 * Validate request ID format
 * @param {string} value - The request ID to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateRequestId(value) {
  if (!value || typeof value !== 'string') {
    return { valid: false, error: 'Missing request ID' }
  }
  if (!/^[0-9a-f]{32}$/i.test(value)) {
    return { valid: false, error: 'Invalid request ID format (expected 32 hex characters)' }
  }
  return { valid: true }
}
