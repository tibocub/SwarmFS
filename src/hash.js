/**
 * Hashing utilities for SwarmFS
 * Provides SHA-256 hashing for chunks and content addressing
 */

import crypto from 'crypto';

/**
 * Hash a buffer using SHA-256
 * @param {Buffer} buffer - Data to hash
 * @returns {string} Hex-encoded SHA-256 hash
 */
export function hashBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('Input must be a Buffer');
  }
  
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Hash multiple buffers in sequence (useful for Merkle tree nodes)
 * @param {Buffer[]} buffers - Array of buffers to hash together
 * @returns {string} Hex-encoded SHA-256 hash
 */
export function hashBuffers(buffers) {
  const hash = crypto.createHash('sha256');
  
  for (const buffer of buffers) {
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('All inputs must be Buffers');
    }
    hash.update(buffer);
  }
  
  return hash.digest('hex');
}

/**
 * Hash two hex strings together (for Merkle tree construction)
 * @param {string} hash1 - First hex hash
 * @param {string} hash2 - Second hex hash
 * @returns {string} Combined hash
 */
export function combineHashes(hash1, hash2) {
  const buffer1 = Buffer.from(hash1, 'hex');
  const buffer2 = Buffer.from(hash2, 'hex');
  return hashBuffers([buffer1, buffer2]);
}
