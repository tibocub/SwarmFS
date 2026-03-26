/* tslint:disable */
/* eslint-disable */
/* prettier-ignore */

/* SwarmFS Native - JavaScript wrapper with fallback to JS implementations */

import { createRequire } from 'module';
import { Buffer } from 'buffer';
import { platform, arch } from 'os';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

let nativeBinding = null;
let loadError = null;

function isMusl() {
  if (!process.report || typeof process.report.getReport !== 'function') {
    try {
      const lddPath = require('child_process').execSync('which ldd').toString().trim();
      return require('fs').readFileSync(lddPath, 'utf8').includes('musl');
    } catch (e) {
      return true;
    }
  } else {
    const { glibcVersionRuntime } = process.report.getReport().header;
    return !glibcVersionRuntime;
  }
}

// Try to load native binding, but don't throw if not found
try {
  switch (platform()) {
    case 'win32':
      switch (arch()) {
        case 'x64':
          if (existsSync(join(__dirname, 'swarmfs_native.win32-x64-msvc.node'))) {
            nativeBinding = require('./swarmfs_native.win32-x64-msvc.node');
          }
          break;
      }
      break;
    case 'linux':
      switch (arch()) {
        case 'x64':
          if (isMusl()) {
            if (existsSync(join(__dirname, 'swarmfs_native.linux-x64-musl.node'))) {
              nativeBinding = require('./swarmfs_native.linux-x64-musl.node');
            }
          } else {
            if (existsSync(join(__dirname, 'swarmfs_native.linux-x64-gnu.node'))) {
              nativeBinding = require('./swarmfs_native.linux-x64-gnu.node');
            }
          }
          break;
      }
      break;
  }
} catch (e) {
  loadError = e;
}

// ============================================================================
// Hash functions with fallback
// ============================================================================

export async function hashBuffer(buffer) {
  if (nativeBinding) {
    return nativeBinding.hashBuffer(buffer);
  }
  // Fallback to JS implementation
  const blake3 = await import('blake3-bao/blake3');
  return Buffer.from(blake3.hashHex(new Uint8Array(buffer)), 'hex');
}

export async function hashBuffers(buffers) {
  if (nativeBinding) {
    return nativeBinding.hashBuffers(buffers);
  }
  // Fallback
  const blake3 = await import('blake3-bao/blake3');
  const hasher = new blake3.Hasher();
  for (const buf of buffers) {
    hasher.update(new Uint8Array(buf));
  }
  return Buffer.from(hasher.finalize(32));
}

export async function combineHashes(hash1, hash2) {
  if (nativeBinding) {
    const buf1 = Buffer.isBuffer(hash1) ? hash1 : Buffer.from(hash1, 'hex');
    const buf2 = Buffer.isBuffer(hash2) ? hash2 : Buffer.from(hash2, 'hex');
    return nativeBinding.combineHashes(buf1, buf2);
  }
  // Fallback
  const blake3 = await import('blake3-bao/blake3');
  const hasher = new blake3.Hasher();
  hasher.update(Buffer.from(hash1, 'hex'));
  hasher.update(Buffer.from(hash2, 'hex'));
  return Buffer.from(hasher.finalize(32));
}

export async function hashFileChunks(path, chunkSize) {
  if (nativeBinding) {
    return nativeBinding.hashFileChunks(path, chunkSize);
  }
  // Fallback - not implemented, throw error
  throw new Error('hashFileChunks requires native addon');
}

// ============================================================================
// Merkle tree functions with fallback
// ============================================================================

export async function buildMerkleTree(leafHashes) {
  if (nativeBinding) {
    const buffers = leafHashes.map(h => Buffer.isBuffer(h) ? h : Buffer.from(h, 'hex'));
    return nativeBinding.buildMerkleTree(buffers);
  }
  // Fallback
  const { buildMerkleTree: jsBuild } = await import('../src/merkle.js');
  return jsBuild(leafHashes);
}

export async function getMerkleRoot(leafHashes) {
  if (nativeBinding) {
    const buffers = leafHashes.map(h => Buffer.isBuffer(h) ? h : Buffer.from(h, 'hex'));
    return nativeBinding.getMerkleRoot(buffers);
  }
  // Fallback
  const { getMerkleRoot: jsGet } = await import('../src/merkle.js');
  return jsGet(leafHashes);
}

export async function generateSubtreeProof(leafHashes, level, index) {
  if (nativeBinding) {
    const buffers = leafHashes.map(h => Buffer.isBuffer(h) ? h : Buffer.from(h, 'hex'));
    return nativeBinding.generateSubtreeProof(buffers, level, index);
  }
  // Fallback
  const { generateSubtreeProofFromTree, buildMerkleTree: jsBuild } = await import('../src/merkle.js');
  const tree = await jsBuild(leafHashes);
  return generateSubtreeProofFromTree(tree, level, index);
}

export async function verifySubtreeProof(node, proof, expectedRoot) {
  if (nativeBinding) {
    const nodeBuf = Buffer.isBuffer(node) ? node : Buffer.from(node, 'hex');
    const rootBuf = Buffer.isBuffer(expectedRoot) ? expectedRoot : Buffer.from(expectedRoot, 'hex');
    const proofSteps = proof.map(p => ({
      hash: Buffer.isBuffer(p.hash) ? p.hash : Buffer.from(p.hash, 'hex'),
      isLeft: p.isLeft
    }));
    return nativeBinding.verifySubtreeProof(nodeBuf, proofSteps, rootBuf);
  }
  // Fallback
  const { verifySubtreeProof: jsVerify } = await import('../src/merkle.js');
  return jsVerify(node, proof, expectedRoot);
}

export async function buildFileMerkleTree(path, chunkSize = 256 * 1024) {
  if (nativeBinding) {
    return nativeBinding.buildFileMerkleTree(path, chunkSize);
  }
  // Fallback
  const { buildFileMerkleTreeParallel } = await import('../src/merkle-tree-parallel.js');
  return buildFileMerkleTreeParallel(path, chunkSize);
}

// ============================================================================
// BitField functions with fallback
// ============================================================================

export function bitfieldCount(buffer) {
  if (nativeBinding) {
    return nativeBinding.bitfieldCount(buffer);
  }
  // Fallback - popcount in JS
  let count = 0;
  for (const byte of buffer) {
    count += byte.toString(2).split('1').length - 1;
  }
  return count;
}

export function bitfieldGetSetIndices(buffer) {
  if (nativeBinding) {
    return nativeBinding.bitfieldGetSetIndices(buffer);
  }
  // Fallback
  const indices = [];
  for (let i = 0; i < buffer.length * 8; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = i % 8;
    if (buffer[byteIdx] & (1 << bitIdx)) {
      indices.push(i);
    }
  }
  return indices;
}

export function bitfieldGet(buffer, index) {
  if (nativeBinding) {
    return nativeBinding.bitfieldGet(buffer, index);
  }
  // Fallback
  const byteIdx = Math.floor(index / 8);
  const bitIdx = index % 8;
  return byteIdx < buffer.length && (buffer[byteIdx] & (1 << bitIdx)) !== 0;
}

export function bitfieldSet(buffer, index) {
  if (nativeBinding) {
    return nativeBinding.bitfieldSet(buffer, index);
  }
  // Fallback
  const result = Buffer.from(buffer);
  const byteIdx = Math.floor(index / 8);
  const bitIdx = index % 8;
  if (byteIdx < result.length) {
    result[byteIdx] |= 1 << bitIdx;
  }
  return result;
}

export function bitfieldClear(buffer, index) {
  if (nativeBinding) {
    return nativeBinding.bitfieldClear(buffer, index);
  }
  // Fallback
  const result = Buffer.from(buffer);
  const byteIdx = Math.floor(index / 8);
  const bitIdx = index % 8;
  if (byteIdx < result.length) {
    result[byteIdx] &= ~(1 << bitIdx);
  }
  return result;
}

export function bitfieldNew(size) {
  if (nativeBinding) {
    return nativeBinding.bitfieldNew(size);
  }
  // Fallback
  return Buffer.alloc(Math.ceil(size / 8));
}

export function bitfieldIsFull(buffer, size) {
  return bitfieldCount(buffer) === size;
}

export function bitfieldIsEmpty(buffer) {
  if (nativeBinding) {
    return nativeBinding.bitfieldIsEmpty(buffer);
  }
  return buffer.every(b => b === 0);
}

// ============================================================================
// Chunk verification with fallback
// ============================================================================

export async function verifyChunk(data, expectedHash) {
  if (nativeBinding) {
    const hashBuf = Buffer.isBuffer(expectedHash) ? expectedHash : Buffer.from(expectedHash, 'hex');
    return nativeBinding.verifyChunk(data, hashBuf);
  }
  // Fallback
  const hash = await hashBuffer(data);
  return hash.toString('hex') === expectedHash.toString('hex');
}

export async function verifyChunksBatch(chunks, hashes) {
  if (nativeBinding) {
    const hashBuffers = hashes.map(h => Buffer.isBuffer(h) ? h : Buffer.from(h, 'hex'));
    return nativeBinding.verifyChunksBatch(chunks, hashBuffers);
  }
  // Fallback
  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    results.push(await verifyChunk(chunks[i], hashes[i]));
  }
  return results;
}

/**
 * Batch verify subtree proof AND all chunk data in one optimized call.
 * This eliminates JS↔Rust boundary overhead by doing everything in one call:
 * 1. Hash all chunks in parallel
 * 2. Compare computed hashes to expected hashes
 * 3. Verify the subtree proof
 * 
 * @param {Buffer[]} chunkData - Array of chunk data buffers
 * @param {Buffer[]} expectedHashes - Expected chunk hashes from metadata
 * @param {Object[]} proof - Merkle proof steps [{hash, isLeft}, ...]
 * @param {Buffer|string} expectedRoot - File's Merkle root
 * @param {Buffer|string} subtreeNode - The subtree node hash from proof
 * @returns {Object} {proofValid: boolean, chunkResults: boolean[], computedHashes: Buffer[]}
 */
export async function verifySubtreeChunks(chunkData, expectedHashes, proof, expectedRoot, subtreeNode) {
  if (nativeBinding) {
    const hashBuffers = expectedHashes.map(h => Buffer.isBuffer(h) ? h : Buffer.from(h, 'hex'));
    const rootBuf = Buffer.isBuffer(expectedRoot) ? expectedRoot : Buffer.from(expectedRoot, 'hex');
    const nodeBuf = Buffer.isBuffer(subtreeNode) ? subtreeNode : Buffer.from(subtreeNode, 'hex');
    const proofSteps = proof.map(p => ({
      hash: Buffer.isBuffer(p.hash) ? p.hash : Buffer.from(p.hash, 'hex'),
      isLeft: p.isLeft
    }));
    return nativeBinding.verifySubtreeChunks(chunkData, hashBuffers, proofSteps, rootBuf, nodeBuf);
  }
  
  // Fallback: sequential verification
  const chunkResults = [];
  const computedHashes = [];
  
  for (let i = 0; i < chunkData.length; i++) {
    const hash = await hashBuffer(chunkData[i]);
    computedHashes.push(hash);
    const expected = Buffer.isBuffer(expectedHashes[i]) 
      ? expectedHashes[i].toString('hex') 
      : expectedHashes[i];
    chunkResults.push(hash.toString('hex') === expected);
  }
  
  // Verify proof
  const proofValid = await verifySubtreeProof(subtreeNode, proof, expectedRoot);
  
  return {
    proofValid,
    chunkResults,
    computedHashes
  };
}

// ============================================================================
// Utility
// ============================================================================

export function isNativeAvailable() {
  return !!nativeBinding;
}
