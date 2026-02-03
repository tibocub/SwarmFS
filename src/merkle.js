/**
 * Merkle Tree implementation for SwarmFS
 * Builds binary Merkle trees for file verification and content addressing
 */

import { combineHashes } from './hash.js';

/**
 * Build a Merkle tree from an array of leaf hashes
 * @param {string[]} leafHashes - Array of hex-encoded hashes (chunk hashes)
 * @returns {Object} Merkle tree with root and all levels
 */
export function buildMerkleTree(leafHashes) {
  if (!Array.isArray(leafHashes) || leafHashes.length === 0) {
    throw new Error('leafHashes must be a non-empty array');
  }

  // Store all levels of the tree (bottom-up)
  const levels = [leafHashes];
  let currentLevel = leafHashes;

  // Build tree bottom-up until we reach the root
  while (currentLevel.length > 1) {
    const nextLevel = [];
    
    for (let i = 0; i < currentLevel.length; i += 2) {
      if (i + 1 < currentLevel.length) {
        // Pair exists: hash(left + right)
        const combined = combineHashes(currentLevel[i], currentLevel[i + 1]);
        nextLevel.push(combined);
      } else {
        // Odd node: duplicate it (standard Merkle tree approach)
        const combined = combineHashes(currentLevel[i], currentLevel[i]);
        nextLevel.push(combined);
      }
    }
    
    levels.push(nextLevel);
    currentLevel = nextLevel;
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
export function getMerkleRoot(leafHashes) {
  return buildMerkleTree(leafHashes).root;
}

/**
 * Generate a Merkle proof for a specific leaf
 * @param {string[]} leafHashes - All leaf hashes
 * @param {number} leafIndex - Index of the leaf to prove
 * @returns {Object} Proof object with siblings and directions
 */
export function generateMerkleProof(leafHashes, leafIndex) {
  if (leafIndex < 0 || leafIndex >= leafHashes.length) {
    throw new RangeError('leafIndex out of bounds');
  }

  const tree = buildMerkleTree(leafHashes);
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
export function verifyMerkleProof(leafHash, proof, expectedRoot) {
  let currentHash = leafHash;

  for (const step of proof) {
    if (step.isLeft) {
      currentHash = combineHashes(step.hash, currentHash);
    } else {
      currentHash = combineHashes(currentHash, step.hash);
    }
  }

  return currentHash === expectedRoot;
}

/**
 * Pretty print a Merkle tree (for debugging)
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
