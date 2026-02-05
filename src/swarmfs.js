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
import { SwarmNetwork } from './network.js';

export class SwarmFS {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'swarmfs.db');
    this.chunksDir = path.join(dataDir, 'chunks');
    
    this.db = null;
    this.storage = null;
    this.network = null;
    this.protocol = null;
  }


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


  open() {
    if (!fs.existsSync(this.dataDir)) {
      throw new Error(`SwarmFS not initialized at ${this.dataDir}. Run 'swarmfs init' first.`);
    }

    this.db = new SwarmDB(this.dbPath);
    this.storage = new ChunkStorage(this.chunksDir);
  }


  isInitialized() {
    return fs.existsSync(this.dataDir) && fs.existsSync(this.dbPath);
  }


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


  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }


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


  listFiles() {
    return this.db.getAllFiles();
  }


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


  removeFile(filePath) {
    const absolutePath = path.resolve(filePath);
    return this.db.removeFile(absolutePath);
  }


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


  setupProtocolHandlers() {
    // When we receive an offer, auto-accept the first one
    this.protocol.on('chunk:offer', (info) => {
      console.log(`\nReceived offer ${info.offerCount} for chunk ${info.chunkHash.substring(0, 16)}...`);

      // Auto-accept first offer (TODO: make this smarter - pick fastest peer, etc.)
      if (info.offerCount === 1) {
        console.log(`   Auto-accepting from ${info.peerId.substring(0, 8)}...`);
        this.protocol.acceptOffer(info.requestId, info.peerId);
      }
    });

    // When chunk downloaded successfully
    this.protocol.on('chunk:downloaded', (info) => {
      console.log(`\nChunk downloaded successfully!`);
      console.log(`   Hash: ${info.chunkHash.substring(0, 16)}...`);
      console.log(`   Size: ${info.size} bytes`);
      console.log(`   From: ${info.peerId.substring(0, 8)}...`);
    });

    // When request times out
    this.protocol.on('chunk:timeout', (info) => {
      console.log(`\nRequest timeout for chunk ${info.chunkHash.substring(0, 16)}...`);
      console.log(`   No peers responded`);
    });

    // When error occurs
    this.protocol.on('chunk:error', (info) => {
      console.error(`\nChunk error: ${info.error}`);
      console.error(`   Chunk: ${info.chunkHash?.substring(0, 16)}...`);
    });
  }


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


  close() {
    if (this.network) {
      this.network.close();
    }
    if (this.protocol) {
      this.protocol.close();
    }
    if (this.db) {
      this.db.close();
    }
  }


  // ============================================================================
  // TOPIC MANAGEMENT
  // ============================================================================

  async createTopic(name, autoJoin = true) {
    const crypto = await import('crypto');

    const existing = this.db.getTopic(name);
    if (existing) {
      throw new Error(`Topic "${name}" already exists`);
    }

    const topicKey = crypto.createHash('sha256')
      .update(name)
      .digest('hex');

    const topicId = this.db.addTopic(name, topicKey, autoJoin);

    return {
      id: topicId,
      name,
      topicKey,
      autoJoin
    };
  }


  async listTopics() {
    return this.db.getAllTopics();
  }


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


  async deleteTopic(name) {
    return this.db.deleteTopic(name);
  }


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

    this.db.addTopicShare(topic.id, shareType, absolutePath, merkleRoot);

    return {
      path: absolutePath,
      type: shareType,
      merkleRoot
    };
  }


  async unsharePath(topicName, sharePath) {
    const absolutePath = path.resolve(sharePath);
    const topic = this.db.getTopic(topicName);

    if (!topic) {
      throw new Error(`Topic "${topicName}" not found`);
    }

    this.db.removeTopicShare(topic.id, absolutePath);
  }


  async joinTopic(name) {
    const topic = this.db.getTopic(name);
    if (!topic) {
      throw new Error(`Topic "${name}" not found. Create it first with: swarmfs topic create ${name}`);
    }

    if (!this.network) {
      const { loadConfig } = await import('./config.js');
      const { SwarmNetwork } = await import('./network.js');
      this.network = new SwarmNetwork(loadConfig().network || {});
    }

    if (!this.protocol) {
      const { Protocol } = await import('./protocol.js');
      this.protocol = new Protocol(this.network, this.storage, this.db);

      this.setupProtocolHandlers();
    }

    const topicKey = Buffer.from(topic.topic_key, 'hex');
    await this.network.joinTopic(name, topicKey);
    this.db.updateTopicJoinTime(topic.id);
  }


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
}
