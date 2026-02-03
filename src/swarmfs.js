/**
 * SwarmFS - Main class
 * Coordinates database, storage, and file operations
 */

import fs from 'fs';
import path from 'path';
import { SwarmDB } from './database.js';
import { ChunkStorage } from './storage.js';
import { chunkBuffer, DEFAULT_CHUNK_SIZE } from './chunk.js';
import { hashBuffer } from './hash.js';
import { getMerkleRoot } from './merkle.js';

export class SwarmFS {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'swarmfs.db');
    this.chunksDir = path.join(dataDir, 'chunks');
    
    this.db = null;
    this.storage = null;
  }

  /**
   * Initialize SwarmFS (create data directory, database, etc.)
   */
  init() {
    // Create data directory
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    // Initialize database
    this.db = new SwarmDB(this.dbPath);
    
    // Initialize chunk storage
    this.storage = new ChunkStorage(this.chunksDir);

    return {
      dataDir: this.dataDir,
      dbPath: this.dbPath,
      chunksDir: this.chunksDir
    };
  }

  /**
   * Open an existing SwarmFS instance
   */
  open() {
    if (!fs.existsSync(this.dataDir)) {
      throw new Error(`SwarmFS not initialized at ${this.dataDir}. Run 'swarmfs init' first.`);
    }

    this.db = new SwarmDB(this.dbPath);
    this.storage = new ChunkStorage(this.chunksDir);
  }

  /**
   * Check if SwarmFS is initialized
   */
  isInitialized() {
    return fs.existsSync(this.dataDir) && fs.existsSync(this.dbPath);
  }

  /**
   * Add a file to SwarmFS
   */
  async addFile(filePath, chunkSize = DEFAULT_CHUNK_SIZE) {
    // Resolve to absolute path
    const absolutePath = path.resolve(filePath);

    // Check if file exists
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`File not found: ${absolutePath}`);
    }

    const stats = fs.statSync(absolutePath);
    
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${absolutePath}`);
    }

    // Read file
    const fileData = fs.readFileSync(absolutePath);
    
    // Chunk the file
    const chunks = chunkBuffer(fileData, chunkSize);
    
    // Hash each chunk and store
    const chunkHashes = [];
    for (const chunk of chunks) {
      const hash = hashBuffer(chunk);
      chunkHashes.push(hash);
      
      // Store chunk if not already stored
      if (!this.storage.hasChunk(hash)) {
        this.storage.storeChunk(hash, chunk);
      }
      
      // Add to database
      this.db.addChunk(hash, chunk.length);
    }

    // Build Merkle tree
    const merkleRoot = getMerkleRoot(chunkHashes);

    // Add file to database
    const fileId = this.db.addFile(
      absolutePath,
      merkleRoot,
      fileData.length,
      chunkSize,
      chunks.length,
      Math.floor(stats.mtimeMs)
    );

    // Add file chunks mapping
    this.db.addFileChunks(fileId, chunkHashes);

    return {
      fileId,
      path: absolutePath,
      size: fileData.length,
      chunks: chunks.length,
      merkleRoot,
      chunkHashes
    };
  }

  /**
   * Get file information
   */
  getFileInfo(filePath) {
    const absolutePath = path.resolve(filePath);
    const file = this.db.getFile(absolutePath);
    
    if (!file) {
      return null;
    }

    const chunks = this.db.getFileChunks(file.id);
    
    return {
      ...file,
      chunks
    };
  }

  /**
   * List all tracked files
   */
  listFiles() {
    return this.db.getAllFiles();
  }

  /**
   * Verify a file's integrity
   */
  async verifyFile(filePath) {
    const absolutePath = path.resolve(filePath);
    const fileInfo = this.getFileInfo(absolutePath);

    if (!fileInfo) {
      throw new Error(`File not tracked: ${absolutePath}`);
    }

    // Check if file still exists
    if (!fs.existsSync(absolutePath)) {
      return {
        valid: false,
        error: 'File not found on filesystem'
      };
    }

    // Read current file
    const currentData = fs.readFileSync(absolutePath);
    
    // Check size
    if (currentData.length !== fileInfo.size) {
      return {
        valid: false,
        error: `Size mismatch: expected ${fileInfo.size}, got ${currentData.length}`
      };
    }

    // Chunk and verify
    const chunks = chunkBuffer(currentData, fileInfo.chunk_size);
    const currentHashes = chunks.map(chunk => hashBuffer(chunk));
    const currentRoot = getMerkleRoot(currentHashes);

    // Compare Merkle roots
    if (currentRoot !== fileInfo.merkle_root) {
      // Find corrupted chunks
      const corruptedChunks = [];
      fileInfo.chunks.forEach((storedChunk, index) => {
        if (currentHashes[index] !== storedChunk.chunk_hash) {
          corruptedChunks.push({
            index,
            expected: storedChunk.chunk_hash,
            actual: currentHashes[index]
          });
        }
      });

      return {
        valid: false,
        error: 'Merkle root mismatch',
        corruptedChunks
      };
    }

    return {
      valid: true,
      chunks: chunks.length,
      merkleRoot: currentRoot
    };
  }

  /**
   * Remove a file from tracking
   */
  removeFile(filePath) {
    const absolutePath = path.resolve(filePath);
    return this.db.removeFile(absolutePath);
  }

  /**
   * Get statistics
   */
  getStats() {
    const dbStats = this.db.getStats();
    const storageStats = this.storage.getStats();

    return {
      files: dbStats.files,
      chunks: dbStats.chunks,
      totalFileSize: dbStats.totalFileSize,
      storageSize: storageStats.totalSize,
      dataDir: this.dataDir
    };
  }

  /**
   * Close SwarmFS
   */
  close() {
    if (this.db) {
      this.db.close();
    }
  }
}
