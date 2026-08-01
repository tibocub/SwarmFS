/**
 * LRU cache for Merkle trees used in subtree proof generation
 * Bounds memory usage by limiting cached tree count
 */

const DEFAULT_MAX_SIZE = 10

/**
 * MerkleTreeCache - LRU cache for merkle trees
 * Each entry: { root, levels, leafCount, timestamp }
 */
export class MerkleTreeCache {
  constructor(maxSize = DEFAULT_MAX_SIZE) {
    this._cache = new Map()
    this._maxSize = maxSize
  }

  /**
   * Get a cached tree by merkle root
   * @param {string} merkleRoot - Hex-encoded merkle root
   * @returns {object|null} Tree object or null if not found
   */
  get(merkleRoot) {
    const tree = this._cache.get(merkleRoot)
    if (tree) {
      // Update timestamp for LRU on access
      tree.timestamp = Date.now()
      return tree
    }
    return null
  }

  /**
   * Set a tree in the cache with LRU eviction
   * @param {string} merkleRoot - Hex-encoded merkle root
   * @param {object} tree - Tree object { root, levels, leafCount, ... }
   */
  set(merkleRoot, tree) {
    // If already exists, just update timestamp
    if (this._cache.has(merkleRoot)) {
      const existing = this._cache.get(merkleRoot)
      existing.timestamp = Date.now()
      // Merge in new tree data
      Object.assign(existing, tree)
      return
    }

    // LRU eviction: remove oldest entry if cache is full
    if (this._cache.size >= this._maxSize) {
      let oldestKey = null
      let oldestTime = Infinity
      for (const [key, value] of this._cache) {
        if (value.timestamp < oldestTime) {
          oldestTime = value.timestamp
          oldestKey = key
        }
      }
      if (oldestKey) {
        this._cache.delete(oldestKey)
      }
    }

    // Add timestamp if not present
    tree.timestamp = tree.timestamp || Date.now()
    this._cache.set(merkleRoot, tree)
  }

  /**
   * Check if cache has a tree
   * @param {string} merkleRoot - Hex-encoded merkle root
   * @returns {boolean}
   */
  has(merkleRoot) {
    return this._cache.has(merkleRoot)
  }

  /**
   * Delete a tree from cache
   * @param {string} merkleRoot - Hex-encoded merkle root
   * @returns {boolean} True if deleted
   */
  delete(merkleRoot) {
    return this._cache.delete(merkleRoot)
  }

  /**
   * Get cache size
   * @returns {number}
   */
  get size() {
    return this._cache.size
  }

  /**
   * Get max size
   * @returns {number}
   */
  get maxSize() {
    return this._maxSize
  }

  /**
   * Clear the cache
   */
  clear() {
    this._cache.clear()
  }

  /**
   * Get all entries (for debugging)
   * @returns {IterableIterator}
   */
  entries() {
    return this._cache.entries()
  }
}
