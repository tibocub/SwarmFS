/**
 * Chunk Storage - Content-Addressable Storage (CAS)
 * Stores chunks in a Git-like directory structure
 */

import fs from 'fs';
import path from 'path';

export class ChunkStorage {
  constructor(storageRoot) {
    this.storageRoot = storageRoot;
    this._ensureStorageExists();
  }

  _ensureStorageExists() {
    if (!fs.existsSync(this.storageRoot)) {
      fs.mkdirSync(this.storageRoot, { recursive: true });
    }
  }

  /**
   * Get the filesystem path for a chunk hash
   * Uses first 2 characters as subdirectory (like Git)
   */
  _getChunkPath(hash) {
    const prefix = hash.substring(0, 2);
    const filename = hash.substring(2);
    return path.join(this.storageRoot, prefix, filename);
  }

  /**
   * Store a chunk
   */
  storeChunk(hash, data) {
    const chunkPath = this._getChunkPath(hash);
    const dir = path.dirname(chunkPath);

    // Create subdirectory if it doesn't exist
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write chunk data
    fs.writeFileSync(chunkPath, data);
  }

  /**
   * Check if a chunk exists
   */
  hasChunk(hash) {
    const chunkPath = this._getChunkPath(hash);
    return fs.existsSync(chunkPath);
  }

  /**
   * Load a chunk
   */
  loadChunk(hash) {
    const chunkPath = this._getChunkPath(hash);
    
    if (!fs.existsSync(chunkPath)) {
      throw new Error(`Chunk not found: ${hash}`);
    }

    return fs.readFileSync(chunkPath);
  }

  /**
   * Delete a chunk
   */
  deleteChunk(hash) {
    const chunkPath = this._getChunkPath(hash);
    
    if (fs.existsSync(chunkPath)) {
      fs.unlinkSync(chunkPath);
    }
  }

  /**
   * Get storage statistics
   */
  getStats() {
    let chunkCount = 0;
    let totalSize = 0;

    const countChunks = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          countChunks(fullPath);
        } else {
          chunkCount++;
          totalSize += fs.statSync(fullPath).size;
        }
      }
    };

    if (fs.existsSync(this.storageRoot)) {
      countChunks(this.storageRoot);
    }

    return { chunkCount, totalSize };
  }

  /**
   * List all chunk hashes (for debugging)
   */
  listChunks() {
    const chunks = [];

    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else {
          // Reconstruct hash from path
          const prefix = path.basename(path.dirname(fullPath));
          const hash = prefix + entry.name;
          chunks.push(hash);
        }
      }
    };

    scanDir(this.storageRoot);
    return chunks;
  }
}
