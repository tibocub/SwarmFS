/**
 * Hashing utilities for SwarmFS
 * Provides BLAKE3 hashing for chunks and content addressing
 */
import blake3 from "blake3-bao/blake3"

// Initialize SIMD once at module load
let initPromise = null

async function ensureSimd() {
  if (initPromise) {
    return initPromise
  }

  const isBun = typeof process !== 'undefined' && !!process.versions?.bun
  const enableSimd = process?.env?.SWARMFS_BLAKE3_SIMD === '1'

  if (!enableSimd) {
    initPromise = Promise.resolve(false)
    return initPromise
  }

  initPromise = blake3.initSimd()
  return initPromise
}

function bufferToAlignedUint8Array(buffer) {
  const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  const isBun = typeof process !== 'undefined' && !!process.versions?.bun
  const enableSimd = process?.env?.SWARMFS_BLAKE3_SIMD === '1'

  if (!enableSimd) {
    return view
  }

  const len = view.byteLength
  const pad = (4 - (len % 4)) % 4
  if (pad === 0) {
    return view
  }

  const backing = new ArrayBuffer(len + pad)
  const out = new Uint8Array(backing, 0, len)
  out.set(view)
  return out
}

/**
 * Hash a buffer using BLAKE3
 * @param {Buffer} buffer - Data to hash
 * @returns {Promise<string>} Hex-encoded BLAKE3 hash
 */
export async function hashBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('Input must be a Buffer')
  }
  await ensureSimd()
  const uint8 = bufferToAlignedUint8Array(buffer)
  return blake3.hashHex(uint8)
}

/**
 * Hash multiple buffers in sequence (useful for Merkle tree nodes)
 * @param {Buffer[]} buffers - Array of buffers to hash together
 * @returns {Promise<string>} Hex-encoded BLAKE3 hash
 */
export async function hashBuffers(buffers) {
  await ensureSimd()
  const hasher = new blake3.Hasher()
  
  for (const buffer of buffers) {
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('All inputs must be Buffers')
    }
    hasher.update(bufferToAlignedUint8Array(buffer))
  }
  
  const digest = hasher.finalize(32)
  return Buffer.from(digest).toString('hex')
}

/**
 * Hash two hex strings together (for Merkle tree construction)
 * @param {string} hash1 - First hex hash
 * @param {string} hash2 - Second hex hash
 * @returns {Promise<string>} Combined hash
 */
export async function combineHashes(hash1, hash2) {
  const buffer1 = Buffer.from(hash1, 'hex')
  const buffer2 = Buffer.from(hash2, 'hex')
  return await hashBuffers([buffer1, buffer2])}
