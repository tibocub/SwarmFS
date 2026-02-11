/**
 * Merkle Tree implementation for SwarmFS
 * Builds binary Merkle trees for file verification and content addressing
 */

import { combineHashes, hashBuffers } from './hash.js'

/**
 * Build a Merkle tree from an array of leaf hashes
 * @param {string[]} leafHashes - Array of hex-encoded hashes (chunk hashes)
 * @returns {Object} Merkle tree with root and all levels
 */
export async function buildMerkleTree(leafHashes) {
  if (!Array.isArray(leafHashes) || leafHashes.length === 0) {
    throw new Error('leafHashes must be a non-empty array')
  }

  // Store all levels of the tree (bottom-up)
  const levels = [leafHashes]
  let currentLevel = leafHashes

  // Build tree bottom-up until we reach the root
  while (currentLevel.length > 1) {
    const nextLevel = []
    
    for (let i = 0; i < currentLevel.length; i += 2) {
      if (i + 1 < currentLevel.length) {
        // Pair exists: hash(left + right)
        const combined = await combineHashes(currentLevel[i], currentLevel[i + 1])
        nextLevel.push(combined)
      } else {
        // Odd node: duplicate it (standard Merkle tree approach)
        const combined = await combineHashes(currentLevel[i], currentLevel[i])
        nextLevel.push(combined)
      }
    }
    
    levels.push(nextLevel)
    currentLevel = nextLevel
  }

  return {
    root: currentLevel[0],
    levels: levels,
    leafCount: leafHashes.length
  };
}

/**
 * Get the root hash from a Merkle tree
 * @param {string[]} leafHashes - Array of leaf hashes
 * @returns {string} Root hash
 */
export async function getMerkleRoot(leafHashes) {
  const tree = await buildMerkleTree(leafHashes)
  return tree.root
}

/**
 * Generate a Merkle proof for a specific leaf
 * @param {string[]} leafHashes - All leaf hashes
 * @param {number} leafIndex - Index of the leaf to prove
 * @returns {Object} Proof object with siblings and directions
 */
export async function generateMerkleProof(leafHashes, leafIndex) {
  if (leafIndex < 0 || leafIndex >= leafHashes.length) {
    throw new RangeError('leafIndex out of bounds')
  }

  const tree = await buildMerkleTree(leafHashes)
  const proof = [];
  let index = leafIndex;

  // Walk up the tree, collecting sibling hashes
  for (let level = 0; level < tree.levels.length - 1; level++) {
    const currentLevel = tree.levels[level];
    const isRightNode = index % 2 === 1;
    const siblingIndex = isRightNode ? index - 1 : index + 1;

    if (siblingIndex < currentLevel.length) {
      proof.push({
        hash: currentLevel[siblingIndex],
        isLeft: isRightNode  // If we're on the right, sibling is on the left
      });
    } else {
      // Odd node - sibling is itself (duplicate)
      proof.push({
        hash: currentLevel[index],
        isLeft: false  // Duplicate goes on the right
      });
    }

    index = Math.floor(index / 2);
  }

  return {
    leaf: leafHashes[leafIndex],
    leafIndex: leafIndex,
    proof: proof,
    root: tree.root
  };
}

/**
 * Verify a Merkle proof
 * @param {string} leafHash - Hash to verify
 * @param {Object[]} proof - Proof array from generateMerkleProof
 * @param {string} expectedRoot - Expected root hash
 * @returns {boolean} True if proof is valid
 */
export async function verifyMerkleProof(leafHash, proof, expectedRoot) {
  let currentHash = leafHash;

  for (const step of proof) {
    if (step.isLeft) {
      currentHash = await combineHashes(step.hash, currentHash);
    } else {
      currentHash = await combineHashes(currentHash, step.hash);
    }
  }

  return currentHash === expectedRoot;
}

/**
 * Cover a contiguous leaf range [startIndex, endIndex] with a minimal set of
 * aligned power-of-two subtrees.
 *
 * Each returned block corresponds to a complete subtree spanning `size` leaves
 * starting at `start` (leaf-level index).
 */
export function coverRangeWithSubtrees(leafCount, startIndex, endIndex) {
  if (!Number.isInteger(leafCount) || leafCount <= 0) {
    throw new RangeError('leafCount must be a positive integer')
  }
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) {
    throw new RangeError('startIndex/endIndex must be integers')
  }
  if (startIndex < 0 || endIndex < 0 || startIndex >= leafCount || endIndex >= leafCount || startIndex > endIndex) {
    throw new RangeError('Invalid range')
  }

  const blocks = []
  let i = startIndex
  while (i <= endIndex) {
    let size = 1

    // Largest power-of-two aligned at i.
    while ((i % (size * 2)) === 0 && (size * 2) <= leafCount) {
      size *= 2
    }

    // Shrink to fit within [i..endIndex].
    while (i + size - 1 > endIndex) {
      size = Math.floor(size / 2)
    }

    blocks.push({ start: i, size })
    i += size
  }

  return blocks
}

/**
 * Generate a Merkle proof for an internal node (subtree root) given a prebuilt tree.
 *
 * The internal node is identified by:
 * - `level`: 0 for leaves, 1 for parents of leaves, ...
 * - `index`: node index at that level
 */
export function generateSubtreeProofFromTree(tree, level, index) {
  if (!tree || !Array.isArray(tree.levels) || tree.levels.length === 0) {
    throw new TypeError('Invalid tree')
  }
  if (!Number.isInteger(level) || level < 0 || level >= tree.levels.length) {
    throw new RangeError('level out of bounds')
  }
  const currentLevel = tree.levels[level]
  if (!Number.isInteger(index) || index < 0 || index >= currentLevel.length) {
    throw new RangeError('index out of bounds')
  }

  const proof = []
  let idx = index
  for (let l = level; l < tree.levels.length - 1; l++) {
    const nodes = tree.levels[l]
    const isRightNode = idx % 2 === 1
    const siblingIndex = isRightNode ? idx - 1 : idx + 1

    if (siblingIndex < nodes.length) {
      proof.push({ hash: nodes[siblingIndex], isLeft: isRightNode })
    } else {
      // Odd node duplication rule.
      proof.push({ hash: nodes[idx], isLeft: false })
    }

    idx = Math.floor(idx / 2)
  }

  return {
    node: currentLevel[index],
    level,
    index,
    proof,
    root: tree.root
  }
}

/**
 * Verify a proof for an internal node (subtree root) to the Merkle root.
 */
export async function verifySubtreeProof(nodeHash, proof, expectedRoot) {
  let currentHash = nodeHash
  for (const step of proof) {
    if (step.isLeft) {
      currentHash = await combineHashes(step.hash, currentHash)
    } else {
      currentHash = await combineHashes(currentHash, step.hash)
    }
  }
  return currentHash === expectedRoot
}

/**
 * Print a Merkle tree (for debugging)
 * @param {Object} tree - Merkle tree from buildMerkleTree
 * @returns {string} String representation
 */
export function printMerkleTree(tree) {
  let output = `Merkle Tree (${tree.leafCount} leaves)\n`;
  output += `Root: ${tree.root}\n\n`;

  for (let i = tree.levels.length - 1; i >= 0; i--) {
    const level = tree.levels[i];
    const indent = '  '.repeat(tree.levels.length - 1 - i);
    output += `Level ${i}: ${level.length} node(s)\n`;
    
    for (const hash of level) {
      output += `${indent}${hash.substring(0, 16)}...\n`;
    }
    output += '\n';
  }

  return output;
}

/**
 * Build a directory Merkle tree from files and subdirectories
 * Combines file hashes and subdirectory roots in sorted order
 * @param {object[]} items - Array of {name, hash, type} objects
 * @returns {string} Directory Merkle root
 */
export async function buildDirectoryMerkle(items) {
  if (!items || items.length === 0) {
    // Empty directory - hash empty string
    return await combineHashes('', '')
  }

  // Sort items by name for deterministic ordering
  const sortedItems = [...items].sort((a, b) => a.name.localeCompare(b.name))

  // Create leaf hashes: hash(name + hash)
  // This ensures same content with different names = different hash
  const leafHashes = await Promise.all(sortedItems.map(async item => {
    const nameBuffer = Buffer.from(item.name, 'utf8')
    const hashBuffer = Buffer.from(item.hash, 'hex')
    return await hashBuffers([nameBuffer, hashBuffer])
  }))

  // Build standard Merkle tree from leaves
  return await getMerkleRoot(leafHashes)
}

/**
 * Build directory Merkle tree recursively from a scanned directory tree
 * @param {object} tree - Directory tree from scanner
 * @param {function} getFileHash - Function to get hash for a file path
 * @returns {object} Enhanced tree with Merkle roots
 */
export async function buildDirectoryTreeMerkle(tree, getFileHash) {
  const items = [];

  // Add file hashes
  for (const file of tree.files) {
    const hash = getFileHash(file.path);
    if (hash) {
      items.push({
        name: file.name,
        hash: hash,
        type: 'file'
      });
    }
  }

  // Recursively process subdirectories
  const processedSubdirs = [];
  for (const subdir of tree.directories) {
    const processedSubdir = await buildDirectoryTreeMerkle(subdir, getFileHash);
    processedSubdirs.push(processedSubdir);
    
    items.push({
      name: subdir.name,
      hash: processedSubdir.merkleRoot,
      type: 'directory'
    });
  }

  // Build Merkle root for this directory
  const merkleRoot = await buildDirectoryMerkle(items);

  return {
    ...tree,
    merkleRoot,
    items,
    directories: processedSubdirs
  };
}
