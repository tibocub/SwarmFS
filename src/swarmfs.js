/**
 * SwarmFS - Main class
 * Coordinates database, storage, and file operations
 */

import fs from 'fs';
import path from 'path';
import { SwarmDB } from './database.js';
import { chunkBuffer, DEFAULT_CHUNK_SIZE } from './chunk.js';
import { hashBuffer } from './hash.js';
import { getMerkleRoot } from './merkle.js';

export class SwarmFS {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'swarmfs.db');
    this.db = null;
    this.network = null;
    this.protocol = null;
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
    
    return {
      dataDir: this.dataDir,
      dbPath: this.dbPath
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
  }

  /**
   * Check if SwarmFS is initialized
   */
  isInitialized() {
    return fs.existsSync(this.dataDir) && fs.existsSync(this.dbPath);
  }

  /**
   * Add a file to SwarmFS
   * Also used internally by addDirectory
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

    const fileSize = stats.size;

    // Hash each chunk without copying the file
    const chunkHashes = [];
    const chunkEntries = [];
    let offset = 0;
    const fd = fs.openSync(absolutePath, 'r');

    try {
      while (offset < fileSize) {
        const length = Math.min(chunkSize, fileSize - offset);
        let buffer = Buffer.allocUnsafe(length);
        const bytesRead = fs.readSync(fd, buffer, 0, length, offset);

        if (bytesRead !== length) {
          buffer = buffer.subarray(0, bytesRead);
        }

        const hash = hashBuffer(buffer);
        chunkHashes.push(hash);
        chunkEntries.push({ hash, offset, size: buffer.length });
        offset += buffer.length;
      }
    } finally {
      fs.closeSync(fd);
    }

    // Build Merkle tree
    const merkleRoot = getMerkleRoot(chunkHashes);

    // Add file to database
    const fileId = this.db.addFile(
      absolutePath,
      merkleRoot,
      fileSize,
      chunkSize,
      chunkEntries.length,
      Math.floor(stats.mtimeMs)
    );

    // Add file chunks mapping
    this.db.addFileChunks(fileId, chunkEntries);

    return {
      fileId,
      path: absolutePath,
      size: fileSize,
      chunks: chunkEntries.length,
      merkleRoot,
      chunkHashes
    };
  }

  /**
   * Add a directory to SwarmFS recursively
   */
  async addDirectory(dirPath, chunkSize = DEFAULT_CHUNK_SIZE) {
    const absolutePath = path.resolve(dirPath);

    // Import scanner here to avoid circular deps
    const { scanDirectory, getAllFiles, countItems, calculateTotalSize } = await import('./scanner.js');
    const { buildDirectoryTreeMerkle } = await import('./merkle.js');

    // Scan directory
    console.log(`Scanning directory: ${absolutePath}`);
    const tree = scanDirectory(absolutePath);
    const counts = countItems(tree);
    const totalSize = calculateTotalSize(tree);

    console.log(`Found ${counts.files} files in ${counts.directories} directories (${this._formatBytes(totalSize)})`);

    // Get all files
    const allFiles = getAllFiles(tree);

    // Add each file
    const results = [];
    const fileHashes = new Map();

    for (let i = 0; i < allFiles.length; i++) {
      const filePath = allFiles[i];
      console.log(`  [${i + 1}/${allFiles.length}] Adding ${path.basename(filePath)}...`);
      
      try {
        const result = await this.addFile(filePath, chunkSize);
        results.push(result);
        fileHashes.set(result.path, result.merkleRoot);
      } catch (error) {
        console.error(`    Error: ${error.message}`);
      }
    }

    // Build directory Merkle tree
    const getFileHash = (filePath) => fileHashes.get(filePath);
    const dirTreeWithMerkle = buildDirectoryTreeMerkle(tree, getFileHash);

    // Store directory in database
    this.db.addDirectory(
      absolutePath,
      dirTreeWithMerkle.merkleRoot
    );

    return {
      path: absolutePath,
      filesAdded: results.length,
      totalFiles: counts.files,
      directories: counts.directories,
      totalSize: totalSize,
      merkleRoot: dirTreeWithMerkle.merkleRoot,
      tree: dirTreeWithMerkle
    };
  }

  /**
   * Helper to format bytes
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
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

    return {
      files: dbStats.files,
      chunks: dbStats.chunks,
      totalFileSize: dbStats.totalFileSize,
      storageSize: dbStats.totalChunkSize,
      dataDir: this.dataDir
    };
  }

  /**
   * Close SwarmFS
   */
  close() {
    if (this.protocol) {
      this.protocol.close();
    }
    if (this.network) {
      this.network.close();
    }
    if (this.db) {
      this.db.close();
    }
  }

  // ============================================================================
  // TOPIC MANAGEMENT (Phase 4)
  // ============================================================================

  /**
   * Create a new topic
   */
  async createTopic(name, autoJoin = true) {
    const crypto = await import('crypto');
    
    // Check if topic already exists
    const existing = this.db.getTopic(name);
    if (existing) {
      throw new Error(`Topic "${name}" already exists`);
    }

    // Generate topic key from name (deterministic)
    const topicKey = crypto.createHash('sha256')
      .update(name)
      .digest('hex');

    // Add to database
    const topicId = this.db.addTopic(name, topicKey, autoJoin);

    return {
      id: topicId,
      name,
      topicKey,
      autoJoin
    };
  }

  /**
   * List all topics
   */
  async listTopics() {
    return this.db.getAllTopics();
  }

  /**
   * Get topic info with shares
   */
  async getTopicInfo(name) {
    const topic = this.db.getTopic(name);
    if (!topic) {
      return null;
    }

    const shares = this.db.getTopicShares(topic.id);

    return {
      ...topic,
      shares
    };
  }

  /**
   * Delete a topic
   */
  async deleteTopic(name) {
    return this.db.deleteTopic(name);
  }

  /**
   * Share a path in a topic
   */
  async sharePath(topicName, sharePath) {
    const absolutePath = path.resolve(sharePath);

    // Check if topic exists
    const topic = this.db.getTopic(topicName);
    if (!topic) {
      throw new Error(`Topic "${topicName}" not found`);
    }

    // Check if path is tracked
    const file = this.db.getFile(absolutePath);
    const directory = this.db.getDirectory(absolutePath);

    if (!file && !directory) {
      throw new Error(`Path not tracked: ${absolutePath}\nUse "swarmfs add ${sharePath}" first`);
    }

    // Determine type and merkle root
    const shareType = file ? 'file' : 'directory';
    const merkleRoot = file ? file.merkle_root : directory.merkle_root;

    // Add share
    this.db.addTopicShare(topic.id, shareType, absolutePath, merkleRoot);

    return {
      path: absolutePath,
      type: shareType,
      merkleRoot
    };
  }

  /**
   * Stop sharing a path in a topic
   */
  async unsharePath(topicName, sharePath) {
    const absolutePath = path.resolve(sharePath);

    // Check if topic exists
    const topic = this.db.getTopic(topicName);
    if (!topic) {
      throw new Error(`Topic "${topicName}" not found`);
    }

    this.db.removeTopicShare(topic.id, absolutePath);
  }

  /**
   * Join a topic (network operation)
   */
  async joinTopic(name) {
    const topic = this.db.getTopic(name);
    if (!topic) {
      throw new Error(`Topic "${name}" not found. Create it first with: swarmfs topic create ${name}`);
    }

    // Initialize network if not already done
    if (!this.network) {
      const { loadConfig } = await import('./config.js');
      const { SwarmNetwork } = await import('./network.js');
      this.network = new SwarmNetwork(loadConfig().network || {});
    }

    // Initialize protocol if not already done
    if (!this.protocol) {
      const { Protocol } = await import('./protocol.js');
      this.protocol = new Protocol(this.network, this.db);
      
      // Setup protocol event handlers
      this.setupProtocolHandlers();
    }

    // Convert hex string to Buffer
    const topicKey = Buffer.from(topic.topic_key, 'hex');

    // Join the network
    await this.network.joinTopic(name, topicKey);

    // Update database
    this.db.updateTopicJoinTime(topic.id);
  }

  /**
   * Setup protocol event handlers
   */
  setupProtocolHandlers() {
    // When we receive an offer, auto-accept the first one
    this.protocol.on('chunk:offer', (info) => {
      console.log(`\n💡 Received offer ${info.offerCount} for chunk ${info.chunkHash.substring(0, 16)}...`);
      
      // Auto-accept first offer
      if (info.offerCount === 1) {
        console.log(`   ⚡ Auto-accepting from ${info.peerId.substring(0, 8)}...`);
        this.protocol.acceptOffer(info.requestId, info.peerId);
      }
    });

    // When chunk downloaded successfully
    this.protocol.on('chunk:downloaded', (info) => {
      console.log(`\n✅ Chunk downloaded successfully!`);
      console.log(`   Hash: ${info.chunkHash.substring(0, 16)}...`);
      console.log(`   Size: ${this._formatBytes(info.size)}`);
      console.log(`   From: ${info.peerId.substring(0, 8)}...`);
    });

    // When request times out
    this.protocol.on('chunk:timeout', (info) => {
      console.log(`\n⏱️  Request timeout for chunk ${info.chunkHash.substring(0, 16)}...`);
      console.log(`   No peers responded`);
    });

    // When error occurs
    this.protocol.on('chunk:error', (info) => {
      console.error(`\n❌ Chunk error: ${info.error}`);
      console.error(`   Chunk: ${info.chunkHash?.substring(0, 16)}...`);
    });
  }

  /**
   * Leave a topic (network operation)
   */
  async leaveTopic(name) {
    const topic = this.db.getTopic(name);
    if (!topic) {
      throw new Error(`Topic "${name}" not found`);
    }

    if (!this.network) {
      console.log('Network not running');
      return;
    }

    const topicKey = Buffer.from(topic.topic_key, 'hex');
    await this.network.leaveTopic(name, topicKey);
  }

  /**
   * Request a chunk from a topic
   */
  async requestChunk(topicName, chunkHash) {
    const topic = this.db.getTopic(topicName);
    if (!topic) {
      throw new Error(`Topic "${topicName}" not found`);
    }

    if (!this.protocol) {
      throw new Error('Not connected to network. Join a topic first.');
    }

    const topicKey = Buffer.from(topic.topic_key, 'hex');
    return this.protocol.requestChunk(topicKey, chunkHash);
  }

  /**
   * Request list of shared files in a topic
   */
  async browseTopic(topicName, timeout = 5000) {
    const topic = this.db.getTopic(topicName);
    if (!topic) {
      throw new Error(`Topic "${topicName}" not found`);
    }

    if (!this.protocol) {
      throw new Error('Not connected to network. Join a topic first.');
    }

    const topicKey = Buffer.from(topic.topic_key, 'hex');
    const requestId = this.protocol.requestFileList(topicKey, timeout);

    return new Promise((resolve, reject) => {
      const filesByRoot = new Map();

      const onList = (info) => {
        if (info.requestId !== requestId) {
          return;
        }

        info.files.forEach((file) => {
          if (!filesByRoot.has(file.merkleRoot)) {
            filesByRoot.set(file.merkleRoot, file);
          }
        });
      };

      const onTimeout = (info) => {
        if (info.requestId !== requestId) {
          return;
        }
        cleanup();
        resolve(Array.from(filesByRoot.values()));
      };

      const cleanup = () => {
        this.protocol.removeListener('file:list', onList);
        this.protocol.removeListener('file:list:timeout', onTimeout);
      };

      this.protocol.on('file:list', onList);
      this.protocol.on('file:list:timeout', onTimeout);
    });
  }

  /**
   * Request metadata for a file by merkle root
   */
  async requestMetadata(topicName, merkleRoot, timeout = 10000) {
    const topic = this.db.getTopic(topicName);
    if (!topic) {
      throw new Error(`Topic "${topicName}" not found`);
    }

    if (!this.protocol) {
      throw new Error('Not connected to network. Join a topic first.');
    }

    const topicKey = Buffer.from(topic.topic_key, 'hex');
    const requestId = this.protocol.requestMetadata(topicKey, merkleRoot, timeout);

    return new Promise((resolve, reject) => {
      const onMetadata = (info) => {
        if (info.requestId !== requestId) {
          return;
        }
        cleanup();
        resolve(info.metadata);
      };

      const onTimeout = (info) => {
        if (info.requestId !== requestId) {
          return;
        }
        cleanup();
        reject(new Error('Metadata request timed out'));
      };

      const cleanup = () => {
        this.protocol.removeListener('metadata:response', onMetadata);
        this.protocol.removeListener('metadata:timeout', onTimeout);
      };

      this.protocol.on('metadata:response', onMetadata);
      this.protocol.on('metadata:timeout', onTimeout);
    });
  }

  /**
   * Download a complete file by requesting all missing chunks
   */
  async downloadFile(topicName, merkleRoot, outputPath, options = {}) {
    if (!this.protocol) {
      throw new Error('Not connected to network. Join a topic first.');
    }

    // First, check if we have file info for this merkle root
    // This would happen if we've seen it shared in the topic
    let fileInfo = this.db.getFileByMerkleRoot(merkleRoot);
    let chunks = [];

    if (!fileInfo || fileInfo.file_modified_at <= 0) {
      const metadata = await this.requestMetadata(topicName, merkleRoot);
      fileInfo = {
        path: metadata.path || metadata.name,
        size: metadata.size,
        chunk_size: metadata.chunkSize,
        chunk_count: metadata.chunkCount,
        merkle_root: metadata.merkleRoot
      };
      chunks = metadata.chunks.map((chunk) => ({
        chunk_hash: chunk.hash,
        chunk_offset: chunk.offset,
        chunk_size: chunk.size
      }));
    } else {
      chunks = this.db.getFileChunks(fileInfo.id);
    }

    console.log(`Found file info: ${fileInfo.path}`);
    console.log(`  Size: ${this._formatBytes(fileInfo.size)}`);
    console.log(`  Chunks: ${fileInfo.chunk_count}`);
    console.log('');

    const absoluteOutputPath = path.resolve(outputPath);
    const outputFileId = this.db.addFile(
      absoluteOutputPath,
      merkleRoot,
      fileInfo.size,
      fileInfo.chunk_size,
      fileInfo.chunk_count,
      0
    );

    const outputChunks = chunks.map((chunk) => ({
      hash: chunk.chunk_hash,
      offset: chunk.chunk_offset,
      size: chunk.chunk_size
    }));

    this.db.addFileChunks(outputFileId, outputChunks);

    console.log(`Preparing output file...`);
    const outputFd = fs.openSync(absoluteOutputPath, 'w');
    try {
      fs.ftruncateSync(outputFd, fileInfo.size);
    } finally {
      fs.closeSync(outputFd);
    }

    console.log(`Downloading ${chunks.length} chunks...`);
    const missingChunks = [...chunks];

    if (typeof options.onProgress === 'function') {
      options.onProgress({ totalChunks: missingChunks.length, downloadedChunks: 0 });
    }

    // Download missing chunks
    let downloaded = 0;
    for (const chunk of missingChunks) {
      console.log(`Downloading chunk ${downloaded + 1}/${missingChunks.length}...`);
      
      const requestId = await this.requestChunk(topicName, chunk.chunk_hash);
      
      // Wait for download to complete
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Chunk download timeout'));
        }, 60000); // 60 second timeout per chunk

        const onDownloaded = (info) => {
          if (info.requestId === requestId) {
            clearTimeout(timeout);
            this.protocol.removeListener('chunk:downloaded', onDownloaded);
            this.protocol.removeListener('chunk:timeout', onTimeout);
            this.protocol.removeListener('chunk:error', onError);
            resolve();
          }
        };

        const onTimeout = (info) => {
          if (info.requestId === requestId) {
            clearTimeout(timeout);
            this.protocol.removeListener('chunk:downloaded', onDownloaded);
            this.protocol.removeListener('chunk:timeout', onTimeout);
            this.protocol.removeListener('chunk:error', onError);
            reject(new Error('No peers responded'));
          }
        };

        const onError = (info) => {
          if (info.requestId === requestId) {
            clearTimeout(timeout);
            this.protocol.removeListener('chunk:downloaded', onDownloaded);
            this.protocol.removeListener('chunk:timeout', onTimeout);
            this.protocol.removeListener('chunk:error', onError);
            reject(new Error(info.error));
          }
        };

        this.protocol.on('chunk:downloaded', onDownloaded);
        this.protocol.on('chunk:timeout', onTimeout);
        this.protocol.on('chunk:error', onError);
      });

      downloaded++;

      if (typeof options.onProgress === 'function') {
        options.onProgress({ totalChunks: missingChunks.length, downloadedChunks: downloaded });
      }
    }

    this.db.updateFileModifiedAt(outputFileId, Date.now());
    console.log(`✓ File written to: ${absoluteOutputPath}`);

    return {
      path: absoluteOutputPath,
      size: fileInfo.size,
      totalChunks: chunks.length,
      chunksDownloaded: missingChunks.length,
      chunksAlreadyHad: 0
    };
  }
}
