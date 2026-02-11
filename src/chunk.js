/**
 * Chunking utilities for SwarmFS
 * Splits data into fixed-size chunks for content-addressed storage
 */

export const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1MiB


/**
 * Split a buffer into fixed-size chunks
 * @param {Buffer} buffer - The data to chunk
 * @param {number} chunkSize - Size of each chunk in bytes (default: 256KB)
 * @returns {Buffer[]} Array of chunk buffers
 */
export function chunkBuffer(buffer, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('Input must be a Buffer');
  }
  
  if (chunkSize <= 0) {
    throw new RangeError('Chunk size must be positive');
  }

  const chunks = [];
  let offset = 0;

  while (offset < buffer.length) {
    const end = Math.min(offset + chunkSize, buffer.length);
    chunks.push(buffer.subarray(offset, end));
    offset = end;
  }

  // Handle empty buffer
  if (chunks.length === 0) {
    chunks.push(Buffer.alloc(0));
  }

  return chunks;
}

/**
 * Calculate the number of chunks a file will produce
 * @param {number} fileSize - Size of file in bytes
 * @param {number} chunkSize - Size of each chunk in bytes
 * @returns {number} Number of chunks
 */
export function calculateChunkCount(fileSize, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (fileSize === 0) return 1;
  return Math.ceil(fileSize / chunkSize);
}
