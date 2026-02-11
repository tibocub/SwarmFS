/**
 * SwarmFS - Main class with Parallel Merkle Tree Support
 * Coordinates database, storage, and file operations
 */

import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import blake3 from 'blake3-bao/blake3'
import { SwarmDB } from './database.js'
import { DEFAULT_CHUNK_SIZE } from './chunk.js'
import { hashBuffer } from './hash.js'
import { getMerkleRoot, buildMerkleTree, printMerkleTree } from './merkle.js'
import { buildFileMerkleTreeParallel, buildMultipleFileMerkleTrees } from './merkle-tree-parallel.js'

export class SwarmFS {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'swarmfs.db');
    this.db = null;
    this.network = null;
    this.protocol = null;
  }

  async *_readFileChunksStream(filePath, chunkSize) {
    const stream = fs.createReadStream(filePath, { highWaterMark: Math.max(64 * 1024, chunkSize) })
    let carry = Buffer.alloc(0)

    for await (const chunk of stream) {
      carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
      while (carry.length >= chunkSize) {
        yield carry.subarray(0, chunkSize)
        carry = carry.subarray(chunkSize)
      }
    }

    if (carry.length > 0) {
      yield carry
    }
  }

  _chooseChunkSizeForFile(fileSize) {
    if (typeof fileSize !== 'number' || !Number.isFinite(fileSize) || fileSize < 0) {
      return DEFAULT_CHUNK_SIZE;
    }

    // Prefer larger chunks for large files (fewer hashes/proofs, fewer DB rows).
    // Keep within [1MiB, 64MiB] by default.
    if (fileSize >= 256 * 1024 * 1024 * 1024) {
      return 64 * 1024 * 1024;
    }

    if (fileSize >= 64 * 1024 * 1024 * 1024) {
      return 32 * 1024 * 1024;
    }

    if (fileSize >= 16 * 1024 * 1024 * 1024) {
      return 16 * 1024 * 1024;
    }

    if (fileSize >= 4 * 1024 * 1024 * 1024) {
      return 8 * 1024 * 1024;
    }

    if (fileSize >= 1024 * 1024 * 1024) {
      return 4 * 1024 * 1024;
    }

    if (fileSize >= 256 * 1024 * 1024) {
      return 2 * 1024 * 1024;
    }

    return DEFAULT_CHUNK_SIZE;
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
   * Add a file to SwarmFS using parallel merkle tree building
   * @param {string} filePath - Path to file
   * @param {number} chunkSize - Chunk size in bytes
   * @param {object} options - Options { useParallel, workerCount, onProgress }
   */
  async addFile(filePath, chunkSize = null, options = {}) {
    const {
      useParallel = false, //    <-- Not efficent enought (worst than single-threaded)
      workerCount = null,
      onProgress = null
    } = options;

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

    if (chunkSize === null || chunkSize === undefined) {
      chunkSize = this._chooseChunkSizeForFile(fileSize);
    }

    // Decide whether to use parallel or single-threaded approach
    const shouldUseParallel = useParallel && (fileSize > 1024 * 1024); // Use parallel for files > 1MB

    let chunkHashes;
    let chunkEntries;
    let merkleRoot;

    if (shouldUseParallel) {
      // Use parallel merkle tree builder
      try {
        const tree = await buildFileMerkleTreeParallel(
          absolutePath,
          chunkSize,
          {
            workerCount,
            debug: true, // Enable debug logging
            onProgress: (status) => {
              if (onProgress && status.phase === 'hashing') {
                const percent = (status.completed / status.total * 100).toFixed(1);
                onProgress(`Hashing chunks: ${percent}%`);
              }
            }
          }
        );

        // Verify tree structure
        if (!tree || !tree.levels || !Array.isArray(tree.levels[0]) || tree.levels[0].length === 0) {
          throw new Error('Invalid merkle tree structure returned');
        }

        // Extract chunk hashes from tree levels (level 0 = leaf hashes)
        chunkHashes = tree.levels[0];
        merkleRoot = tree.root;

        // Build chunk entries with offset and size info
        chunkEntries = chunkHashes.map((hash, index) => {
          const offset = index * chunkSize;
          const size = Math.min(chunkSize, fileSize - offset);
          return { hash, offset, size };
        });

      } catch (parallelError) {
        // Fallback to single-threaded if parallel fails
        if (onProgress) {
          onProgress('Parallel processing failed, falling back to single-threaded...');
        }
        console.warn(`Parallel processing failed: ${parallelError.message}, using fallback`);
        
        // Force single-threaded processing
        chunkHashes = [];
        chunkEntries = [];
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

            const hash = await hashBuffer(buffer);
            chunkHashes.push(hash);
            chunkEntries.push({ hash, offset, size: buffer.length });
            offset += buffer.length;

            if (onProgress && chunkEntries.length % 100 === 0) {
              const percent = (offset / fileSize * 100).toFixed(1);
              onProgress(`Hashing chunks: ${percent}%`);
            }
          }
        } finally {
          fs.closeSync(fd);
        }

        merkleRoot = await getMerkleRoot(chunkHashes);
      }

    } else {
      // Use single-threaded approach (original implementation)
      chunkHashes = [];
      chunkEntries = [];
      let offset = 0

      for await (const buffer of this._readFileChunksStream(absolutePath, chunkSize)) {
        const hash = await hashBuffer(buffer)
        chunkHashes.push(hash)
        chunkEntries.push({ hash, offset, size: buffer.length })
        offset += buffer.length

        if (onProgress && chunkEntries.length % 100 === 0) {
          const percent = (offset / fileSize * 100).toFixed(1)
          onProgress(`Hashing chunks: ${percent}%`)
        }
      }

      // Build Merkle tree
      merkleRoot = await getMerkleRoot(chunkHashes);
    }

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
   * Add a directory to SwarmFS recursively with parallel processing
   * @param {string} dirPath - Directory path
   * @param {number} chunkSize - Chunk size
   * @param {object} options - Options { useParallel, workerCount, batchSize, onProgress }
   */
  async addDirectory(dirPath, chunkSize = null, options = {}) {
    const {
      useParallel = false, //  <-- still slower than single threaded merkle tree builder
      workerCount = null,
      batchSize = 8,
      onProgress = null
    } = options;

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
    const results = [];
    const fileHashes = new Map();

    if (useParallel && allFiles.length > 1) {
      // Process files in batches using parallel merkle tree building
      console.log(`Processing files in parallel (batch size: ${batchSize})...`);

      for (let i = 0; i < allFiles.length; i += batchSize) {
        const batch = allFiles.slice(i, Math.min(i + batchSize, allFiles.length));
        
        // Process batch in parallel
        const batchPromises = batch.map(async (filePath, batchIndex) => {
          const globalIndex = i + batchIndex;
          const fileName = path.basename(filePath);
          console.log(`  [${globalIndex + 1}/${allFiles.length}] Adding ${fileName}...`);
          
          try {
            const result = await this.addFile(filePath, chunkSize, {
              useParallel: true,
              workerCount,
              onProgress: (msg) => {
                if (onProgress) {
                  onProgress(`[${globalIndex + 1}/${allFiles.length}] ${msg}`);
                }
              }
            });
            
            return { success: true, result, filePath };
          } catch (error) {
            console.error(`    ✗ Error adding ${fileName}: ${error.message}`);
            return { success: false, error: error.message, filePath };
          }
        });

        const batchResults = await Promise.all(batchPromises);
        
        // Collect successful results
        for (const item of batchResults) {
          if (item.success) {
            results.push(item.result);
            fileHashes.set(item.result.path, item.result.merkleRoot);
          }
        }
      }

    } else {
      // Single-threaded processing (original implementation)
      for (let i = 0; i < allFiles.length; i++) {
        const filePath = allFiles[i];
        console.log(`  [${i + 1}/${allFiles.length}] Adding ${path.basename(filePath)}...`);
        
        try {
          const result = await this.addFile(filePath, chunkSize, {
            useParallel: false,
            onProgress: (msg) => {
              if (onProgress) {
                onProgress(`[${i + 1}/${allFiles.length}] ${msg}`);
              }
            }
          });
          
          results.push(result);
          fileHashes.set(result.path, result.merkleRoot);
        } catch (error) {
          console.error(`    Error: ${error.message}`);
        }
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
   * Verify a file's integrity using parallel merkle tree building
   */
  async verifyFile(filePath, options = {}) {
    const { useParallel = true, workerCount = null } = options;
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

    const stats = fs.statSync(absolutePath);

    // Check size
    if (stats.size !== fileInfo.size) {
      return {
        valid: false,
        error: `Size mismatch: expected ${fileInfo.size}, got ${stats.size}`
      };
    }

    // Rebuild merkle tree and compare
    let currentRoot;
    let currentHashes;

    if (useParallel && stats.size > 1024 * 1024) {
      // Use parallel verification
      const tree = await buildFileMerkleTreeParallel(
        absolutePath,
        fileInfo.chunk_size,
        { workerCount }
      );
      currentRoot = tree.root;
      currentHashes = tree.levels[0];
    } else {
      // Use single-threaded verification
      const currentData = fs.readFileSync(absolutePath);
      const { chunkBuffer } = await import('./chunk.js');
      const chunks = chunkBuffer(currentData, fileInfo.chunk_size);
      currentHashes = chunks.map( async chunk => await hashBuffer(chunk));
      currentRoot = await getMerkleRoot(currentHashes);
    }

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
      chunks: currentHashes.length,
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
  async close() {
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
  // TOPIC MANAGEMENT
  // ============================================================================

  /**
   * Create a new topic
   */
  async createTopic(name, autoJoin = true) {
    // Check if topic already exists
    const existing = this.db.getTopic(name);
    if (existing) {
      throw new Error(`Topic "${name}" already exists`);
    }

    // Generate topic key from name (deterministic)
    const topicKey = blake3.hashHex(name)

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
    
    console.log(`[DEBUG] Requesting file list...`);
    console.log(`[DEBUG] Topic: ${topicName}`);
    console.log(`[DEBUG] Topic key: ${topicKey.toString('hex').substring(0, 16)}...`);
    console.log(`[DEBUG] Timeout: ${timeout}ms`);
    
    const requestId = this.protocol.requestFileList(topicKey, timeout);
    console.log(`[DEBUG] Request ID: ${requestId.substring(0, 16)}...`);
  
    return new Promise((resolve, reject) => {
      const filesByRoot = new Map();
      let responseCount = 0;
  
      const onList = (info) => {
        console.log(`[DEBUG] Received file list response`);
        console.log(`[DEBUG] Request ID match: ${info.requestId === requestId}`);
        
        if (info.requestId !== requestId) {
          return;
        }
  
        responseCount++;
        console.log(`[DEBUG] Response ${responseCount}: ${info.files.length} files from ${info.peerId?.substring(0, 8)}`);
  
        info.files.forEach((file) => {
          if (!filesByRoot.has(file.merkleRoot)) {
            filesByRoot.set(file.merkleRoot, file);
          }
        });
      };
  
      const onTimeout = (info) => {
        console.log(`[DEBUG] File list request timeout`);
        console.log(`[DEBUG] Request ID match: ${info.requestId === requestId}`);
        
        if (info.requestId !== requestId) {
          return;
        }
        cleanup();
        console.log(`[DEBUG] Total responses: ${responseCount}`);
        console.log(`[DEBUG] Total unique files: ${filesByRoot.size}`);
        resolve(Array.from(filesByRoot.values()));
      };
  
      const cleanup = () => {
        this.protocol.removeListener('file:list', onList);
        this.protocol.removeListener('file:list:timeout', onTimeout);
      };
  
      this.protocol.on('file:list', onList);
      this.protocol.on('file:list:timeout', onTimeout);
      
      console.log(`[DEBUG] Waiting for responses...`);
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

  // Get metadata
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
    const ordered = Array.isArray(metadata.chunks)
      ? [...metadata.chunks].sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0))
      : [];

    chunks = ordered.map((chunk) => ({
      chunk_hash: chunk.hash,
      chunk_offset: chunk.offset,
      chunk_size: chunk.size
    }));
  } else {
    chunks = this.db.getFileChunks(fileInfo.id);
  }

  // Prepare metadata for DownloadSession
  const sessionMetadata = {
    name: fileInfo.path,
    size: fileInfo.size,
    chunkSize: fileInfo.chunk_size,
    chunkCount: fileInfo.chunk_count,
    merkleRoot: merkleRoot,
    chunks: chunks.map(c => ({
      hash: c.chunk_hash,
      offset: c.chunk_offset,
      size: c.chunk_size
    }))
  };

  const absoluteOutputPath = path.resolve(outputPath);

  // Add file to database
  const outputFileId = this.db.addFile(
    absoluteOutputPath,
    merkleRoot,
    fileInfo.size,
    fileInfo.chunk_size,
    fileInfo.chunk_count,
    0 // file_modified_at = 0 (incomplete)
  );

  const outputChunks = chunks.map((chunk) => ({
    hash: chunk.chunk_hash,
    offset: chunk.chunk_offset,
    size: chunk.chunk_size
  }));

  this.db.addFileChunks(outputFileId, outputChunks);

  // Create download session
  const { DownloadSession } = await import('./download.js');
  const topicKey = Buffer.from(this.db.getTopic(topicName).topic_key, 'hex');
  
  const session = new DownloadSession(
    topicKey,
    merkleRoot,
    absoluteOutputPath,
    sessionMetadata,
    this.protocol,
    this.db
  );

  session.fileId = outputFileId;

  // Forward progress events
  if (typeof options.onProgress === 'function') {
    session.on('progress', (info) => {
      options.onProgress({
        totalChunks: info.total,
        downloadedChunks: info.verified
      });
    });
  }

  // Start download
  await session.start();

  // Wait for completion
  return new Promise((resolve, reject) => {
    session.on('complete', (info) => {
      resolve({
        path: info.path,
        size: info.size,
        totalChunks: info.chunks,
        chunksDownloaded: info.chunks,
        chunksAlreadyHad: 0
      });
    });

    session.on('error', (error) => {
      reject(error);
    });
  });
}
}




/**
 * Download Session Manager
 */

export class DownloadSession extends EventEmitter {
  async downloadLoop() {
    while (this.running) {
      try {
        // Check completion
        if (this.chunksVerified === this.totalChunks) {
          await this.onComplete();
          break;
        }

        // Log scheduler stats periodically
        if (this.loopCount % 100 === 0) {
          const stats = this.scheduler.getStats();
          console.log(`Download stats:
            Missing: ${stats.totalMissing}
            Unavailable: ${stats.unavailable} (no peers)
            Critical: ${stats.critical} (1 peer only!)
            Rare: ${stats.rare} (2 peers)
            Common: ${stats.common} (3+ peers)
            Endgame: ${stats.inEndgame}`);
        }
        this.loopCount++;

        // Calculate available request slots
        const available = this.maxConcurrentRequests - this.chunksInFlight;
        if (available <= 0) {
          await this.waitForSlot();
          continue;
        }

        // Get chunks using rarest-first strategy
        const toRequest = this.scheduler.getNextChunks(available);

        if (toRequest.length === 0) {
          // Check if we're stuck (no chunks available from any peer)
          const stats = this.scheduler.getStats();
          if (stats.totalMissing > 0 && stats.unavailable === stats.totalMissing) {
            console.warn(`STUCK: ${stats.unavailable} chunks unavailable (no peers have them)`);
            console.warn(`    Waiting for new peers to join...`);
            await this.sleep(5000); // Wait 5s for new peers
            continue;
          }

          // All chunks in-flight, wait for completion
          await this.waitForSlot();
          continue;
        }

        // Request chunks in rarest-first order
        for (const chunkIndex of toRequest) {
          const success = await this.requestChunk(chunkIndex);
          
          // If rarity is 1, log critical download
          const rarity = this.scheduler.getRarity(chunkIndex);
          if (rarity === 1 && success) {
            console.log(`CRITICAL PRIORITY: Downloading chunk ${chunkIndex} (only 1 peer has it and can go offline any moment!)`);
          }
        }

        // Brief sleep to avoid tight loop
        await this.sleep(10);

      } catch (error) {
        console.error('Download loop error:', error);
        await this.sleep(1000);
      }
    }
  }

  async requestChunk(chunkIndex) {
    const chunk = this.chunkStates.get(chunkIndex);
    
    // Check if already requested (in endgame mode, we may request same chunk multiple times)
    if (chunk.state === ChunkState.REQUESTED && !this.scheduler.inEndgame) {
      return false;
    }

    // Select best peer for this chunk
    const peer = this.peerManager.selectPeerForChunk(chunkIndex);
    if (!peer) {
      // No peer available with this chunk
      return false;
    }

    // In endgame mode, we may request same chunk from multiple peers
    // Track multiple requests per chunk
    if (this.scheduler.inEndgame) {
      if (!chunk.endgameRequests) {
        chunk.endgameRequests = new Map(); // peerId -> requestId
      }

      // Don't request from same peer twice
      if (chunk.endgameRequests.has(peer.peerId)) {
        return false;
      }
    }

    // Create request
    const requestId = await this.protocol.requestChunk(
      this.topicKey,
      chunk.hash
    );

    // Update state
    if (!this.scheduler.inEndgame) {
      chunk.state = ChunkState.REQUESTED;
      chunk.requestedFrom = peer.peerId;
      chunk.requestedAt = Date.now();
      chunk.requestId = requestId;
      this.chunksInFlight++;
    } else {
      // Endgame: track multiple requests
      chunk.endgameRequests.set(peer.peerId, requestId);
      if (chunk.state === ChunkState.MISSING) {
        chunk.state = ChunkState.REQUESTED;
        this.chunksInFlight++;
      }
    }

    // Track in peer
    peer.activeRequests.add(requestId);

    // Set timeout
    const timeout = setTimeout(() => {
      this.onChunkTimeout(chunkIndex, requestId, peer.peerId);
    }, this.requestTimeout);

    if (!this.scheduler.inEndgame) {
      chunk.timeout = timeout;
    } else {
      if (!chunk.endgameTimeouts) {
        chunk.endgameTimeouts = new Map();
      }
      chunk.endgameTimeouts.set(requestId, timeout);
    }

    this.emit('chunk:requested', { 
      chunkIndex, 
      peerId: peer.peerId,
      rarity: this.scheduler.getRarity(chunkIndex)
    });

    return true;
  }

  /**
   * Handle chunk timeout - updated for endgame mode
   */
  onChunkTimeout(chunkIndex, requestId, peerId) {
    const chunk = this.chunkStates.get(chunkIndex);
    const peer = this.peerManager.peers.get(peerId);

    console.warn(`Chunk ${chunkIndex} timeout from ${peerId.substring(0, 8)}`);

    // Update peer health
    if (peer) {
      peer.timeouts++;
      peer.activeRequests.delete(requestId);

      // Ban peer if too many timeouts
      if (peer.timeouts > 5) {
        console.warn(`Banning peer ${peerId.substring(0, 8)} (too many timeouts)`);
        this.peerManager.removePeer(peerId);
      }
    }

    // Handle endgame vs normal mode
    if (this.scheduler.inEndgame && chunk.endgameRequests) {
      // Remove this specific request
      chunk.endgameRequests.delete(peerId);
      
      // If no more endgame requests, mark as failed
      if (chunk.endgameRequests.size === 0) {
        chunk.state = ChunkState.FAILED;
        chunk.retryCount++;
        this.chunksInFlight--;
      }
    } else {
      // Normal mode: mark for retry
      chunk.state = ChunkState.FAILED;
      chunk.retryCount++;
      chunk.requestedFrom = null;
      chunk.requestId = null;
      this.chunksInFlight--;
    }

    this.emit('chunk:failed', { chunkIndex, reason: 'timeout' });
  }

  /**
   * Handle chunk receipt - updated for endgame mode
   */
  async onChunkReceived(info) {
    const { requestId, chunkHash, data, peerId } = info;

    // Find chunk by hash (in endgame, we can't rely on requestId alone)
    let chunkIndex = null;
    for (const [index, chunk] of this.chunkStates) {
      if (chunk.hash === chunkHash) {
        chunkIndex = index;
        break;
      }
    }

    if (chunkIndex === null) {
      console.warn('Received unknown chunk');
      return;
    }

    const chunk = this.chunkStates.get(chunkIndex);

    // ENDGAME: Cancel all other requests for this chunk
    if (this.scheduler.inEndgame && chunk.endgameRequests) {
      for (const [otherPeerId, otherRequestId] of chunk.endgameRequests) {
        if (otherRequestId !== requestId) {
          // Send CANCEL message
          this.protocol.cancelRequest(otherRequestId);
          
          // Clear timeout
          const timeout = chunk.endgameTimeouts?.get(otherRequestId);
          if (timeout) {
            clearTimeout(timeout);
          }
        }
      }
      
      // Clear endgame tracking
      chunk.endgameRequests.clear();
      chunk.endgameTimeouts?.clear();
    }

    // Clear timeout(s)
    if (chunk.timeout) {
      clearTimeout(chunk.timeout);
    }
    if (chunk.endgameTimeouts) {
      for (const timeout of chunk.endgameTimeouts.values()) {
        clearTimeout(timeout);
      }
    }

    // Update state
    chunk.state = ChunkState.RECEIVED;
    chunk.data = data;
    this.chunksInFlight--;

    // Update peer
    const peer = this.peerManager.peers.get(peerId);
    if (peer) {
      peer.activeRequests.delete(requestId);
    }

    // Queue for verification
    this.verifier.enqueue(chunkIndex, chunk);
  }
}


/*
 * Chunk Scheduler
 */

class ChunkScheduler {
  constructor(session) {
    this.session = session;
    this.inEndgame = false;
    this.endgameThreshold = 20; // Start endgame with last 20 chunks
  }

  /**
   * Get next chunks to request using rarest-first strategy
   */
  getNextChunks(limit) {
    const progress = this.session.chunksVerified / this.session.totalChunks;
    
    // Enter endgame mode when close to completion
    if (progress >= 0.95 || this.getRemainingCount() <= this.endgameThreshold) {
      if (!this.inEndgame) {
        this.enterEndgame();
      }
      return this.getEndgameChunks(limit);
    }
    
    // Main strategy: STRICT rarest-first
    return this.getRarestChunks(limit);
  }

  /**
   * Rarest-first selection with critical optimizations for peer volatility
   */
  getRarestChunks(limit) {
    const missing = this.getMissingChunks();
    if (missing.length === 0) {
      return [];
    }

    // Build rarity map: chunkIndex -> peer count
    const rarityMap = new Map();
    for (const chunkIndex of missing) {
      rarityMap.set(chunkIndex, this.getRarity(chunkIndex));
    }

    // Group chunks by rarity level
    const rarityGroups = new Map(); // rarity -> [chunkIndex, ...]
    for (const [chunkIndex, rarity] of rarityMap) {
      if (!rarityGroups.has(rarity)) {
        rarityGroups.set(rarity, []);
      }
      rarityGroups.get(rarity).push(chunkIndex);
    }

    // Sort rarity levels (ascending - rarest first)
    const sortedRarities = Array.from(rarityGroups.keys()).sort((a, b) => a - b);

    // Select chunks, prioritizing rarest
    const selected = [];
    for (const rarity of sortedRarities) {
      const chunks = rarityGroups.get(rarity);
      
      // CRITICAL: If rarity is 0, skip (no peers have it)
      if (rarity === 0) {
        continue;
      }

      // CRITICAL: If rarity is 1, take ALL of them immediately (high priority)
      if (rarity === 1) {
        selected.push(...chunks);
        continue;
      }

      // For rarity > 1, shuffle to avoid thundering herd
      // (all downloaders requesting same chunks from same peers)
      const shuffled = this.shuffle(chunks);
      selected.push(...shuffled);

      if (selected.length >= limit) {
        break;
      }
    }

    return selected.slice(0, limit);
  }

  /**
   * Get rarity (peer count) for a chunk
   * Returns 0 if no peers have it, N if N peers have it
   */
  getRarity(chunkIndex) {
    const peers = this.session.peerManager.availabilityIndex.get(chunkIndex);
    return peers ? peers.size : 0;
  }

  /**
   * Get chunks that are missing or failed
   */
  getMissingChunks() {
    const missing = [];
    for (const [index, chunk] of this.session.chunkStates) {
      if (chunk.state === ChunkState.MISSING || 
          chunk.state === ChunkState.FAILED) {
        missing.push(index);
      }
    }
    return missing;
  }

  /**
   * Get count of remaining chunks (not verified)
   */
  getRemainingCount() {
    return this.session.totalChunks - this.session.chunksVerified;
  }

  /**
   * Endgame mode: request remaining chunks from ALL available peers
   * Cancel duplicates when first copy arrives
   */
  getEndgameChunks(limit) {
    const missing = this.getMissingChunks();
    
    // In endgame, we want to request ALL remaining chunks
    // from multiple peers, not just `limit` chunks
    return missing;
  }

  enterEndgame() {
    console.log('📍 ENDGAME MODE: Requesting remaining chunks from all peers');
    this.inEndgame = true;
  }

  /**
   * Fisher-Yates shuffle for randomization
   */
  shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Get statistics for monitoring
   */
  getStats() {
    const missing = this.getMissingChunks();
    const rarityMap = new Map();

    for (const chunkIndex of missing) {
      const rarity = this.getRarity(chunkIndex);
      if (!rarityMap.has(rarity)) {
        rarityMap.set(rarity, 0);
      }
      rarityMap.set(rarity, rarityMap.get(rarity) + 1);
    }

    return {
      totalMissing: missing.length,
      unavailable: rarityMap.get(0) || 0,  // Rarity 0 = no peers have it
      critical: rarityMap.get(1) || 0,      // Rarity 1 = only 1 peer
      rare: rarityMap.get(2) || 0,          // Rarity 2 = 2 peers
      common: missing.length - (rarityMap.get(0) || 0) - (rarityMap.get(1) || 0) - (rarityMap.get(2) || 0),
      inEndgame: this.inEndgame
    };
  }
}
