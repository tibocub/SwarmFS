/**
 * Parallel Merkle Tree Builder for SwarmFS
 * Uses worker threads to parallelize chunk hashing for large files
 */

import { Worker } from 'worker_threads';
import fs from 'fs';
import { cpus } from 'os';
import { stat } from 'fs/promises';
import { buildMerkleTree, getMerkleRoot } from './merkle.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { hashBuffer } from './hash.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Worker pool for managing reusable worker threads
 */
class WorkerPool {
  constructor(workerPath, poolSize = cpus().length) {
    this.workerPath = workerPath;
    this.poolSize = poolSize;
    this.workers = [];
    this.available = [];
    this.queue = [];
  }

  async initialize() {
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const worker = new Worker(this.workerPath, {
          // Ensure proper ES module support
          type: 'module'
        });
        
        // Add error handler for worker initialization errors
        worker.on('error', (error) => {
          console.error(`Worker ${i} error:`, error);
        });
        
        worker.on('exit', (code) => {
          if (code !== 0) {
            console.error(`Worker ${i} exited with code ${code}`);
          }
        });
        
        this.workers.push(worker);
        this.available.push(worker);
      } catch (error) {
        throw new Error(`Failed to create worker ${i}: ${error.message}`);
      }
    }
  }

  async execute(message) {
    return new Promise((resolve, reject) => {
      const task = { message, resolve, reject };

      if (this.available.length > 0) {
        this._runTask(task);
      } else {
        this.queue.push(task);
      }
    });
  }

  _runTask(task) {
    const worker = this.available.pop();
    
    const onMessage = (result) => {
      cleanup();
      this.available.push(worker);
      
      // Process next queued task
      if (this.queue.length > 0) {
        this._runTask(this.queue.shift());
      }
      
      if (result.success) {
        task.resolve(result.results);
      } else {
        const error = new Error(result.error || 'Worker failed');
        error.workerStack = result.stack;
        task.reject(error);
      }
    };

    const onError = (error) => {
      cleanup();
      this.available.push(worker);
      const enhancedError = new Error(`Worker error: ${error.message}`);
      enhancedError.originalError = error;
      task.reject(enhancedError);
    };

    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
    };

    worker.once('message', onMessage);
    worker.once('error', onError);
    
    try {
      worker.postMessage(task.message);
    } catch (error) {
      cleanup();
      this.available.push(worker);
      task.reject(new Error(`Failed to post message to worker: ${error.message}`));
    }
  }

  async terminate() {
    await Promise.all(this.workers.map(worker => worker.terminate()));
    this.workers = [];
    this.available = [];
    this.queue = [];
  }
}

/**
 * Build Merkle tree for a file using parallel chunk hashing
 * @param {string} filePath - Path to file
 * @param {number} chunkSize - Size of each chunk in bytes (default 256KB)
 * @param {object} options - Options { workerCount, onProgress }
 * @returns {Promise<Object>} Merkle tree object
 */
export async function buildFileMerkleTreeParallel(filePath, chunkSize = 256 * 1024, options = {}) {
  const {
    workerCount: userWorkerCount = null,
    onProgress = null,
    debug = false
  } = options;

  // Use actual CPU count if not specified
  const workerCount = userWorkerCount || cpus().length;

  if (debug) console.log(`[DEBUG] Starting parallel merkle tree for: ${filePath}`);
  if (debug) console.log(`[DEBUG] Worker count: ${workerCount}`);

  // Get file size
  const stats = await stat(filePath);
  const fileSize = stats.size;
  const totalChunks = Math.ceil(fileSize / chunkSize);

  if (debug) console.log(`[DEBUG] File size: ${fileSize}, Total chunks: ${totalChunks}`);

  // If file is small, use single-threaded approach
  if (totalChunks <= 4 || fileSize < 1024 * 1024) {
    if (debug) console.log(`[DEBUG] File too small, using single-threaded approach`);
    return buildFileMerkleTreeSingleThreaded(filePath, chunkSize, onProgress);
  }

  // Create worker pool
  const workerPath = new URL('./merkle-worker.js', import.meta.url);
  
  if (debug) console.log(`[DEBUG] Worker path: ${workerPath.href}`);
  
  const pool = new WorkerPool(workerPath, workerCount);
  
  try {
    if (debug) console.log(`[DEBUG] Initializing worker pool...`);
    await pool.initialize();
    if (debug) console.log(`[DEBUG] Worker pool initialized successfully`);
  } catch (error) {
    if (debug) console.error(`[DEBUG] Failed to initialize workers:`, error);
    throw new Error(`Failed to initialize worker pool: ${error.message}`);
  }

  try {
    // Read file sequentially and distribute chunks to workers
    if (debug) console.log(`[DEBUG] Reading file and distributing to ${workerCount} workers...`);
    
    const fd = fs.openSync(filePath, 'r');
    
    try {
      const allChunks = [];
      
      // Read all chunks sequentially
      for (let i = 0; i < totalChunks; i++) {
        const offset = i * chunkSize;
        const length = Math.min(chunkSize, fileSize - offset);
        const buffer = Buffer.allocUnsafe(length);
        
        const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
        const actualBuffer = bytesRead < length ? buffer.subarray(0, bytesRead) : buffer;
        
        allChunks.push({
          index: i,
          data: actualBuffer
        });
        
        if (onProgress && i % 100 === 0) {
          onProgress({ phase: 'reading', completed: i + 1, total: totalChunks });
        }
      }
      
      if (onProgress) {
        onProgress({ phase: 'reading', completed: totalChunks, total: totalChunks });
      }
      
      if (debug) console.log(`[DEBUG] File read complete. Distributing ${allChunks.length} chunks to workers...`);
      
      // Distribute chunks to workers in round-robin fashion
      const chunksPerWorker = Math.ceil(totalChunks / workerCount);
      const tasks = [];
      
      for (let w = 0; w < workerCount; w++) {
        const startIdx = w * chunksPerWorker;
        const endIdx = Math.min(startIdx + chunksPerWorker, totalChunks);
        
        if (startIdx >= totalChunks) break;
        
        const workerChunks = allChunks.slice(startIdx, endIdx).map(chunk => ({
          index: chunk.index,
          // Convert Buffer to Uint8Array for proper serialization
          data: new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength)
        }));
        
        if (debug) console.log(`[DEBUG] Worker ${w}: hashing chunks ${startIdx}-${endIdx-1} (${workerChunks.length} chunks)`);
        
        tasks.push(pool.execute({ chunks: workerChunks }));
      }
      
      if (debug) console.log(`[DEBUG] Waiting for ${tasks.length} workers to hash...`);
      
      // Wait for all workers to complete hashing
      const results = await Promise.all(tasks);
      
      if (debug) {
        console.log(`[DEBUG] Received ${results.length} results from workers`);
      }
      
      // Flatten and sort results by chunk index
      const allHashes = results
        .flat()
        .sort((a, b) => a.index - b.index)
        .map(r => r.hash);
      
      if (debug) console.log(`[DEBUG] Total hashes: ${allHashes.length}`);
      
      // Validate results
      if (!allHashes || allHashes.length === 0) {
        throw new Error(`No chunk hashes generated. Expected ${totalChunks} chunks but got 0`);
      }
      
      if (allHashes.length !== totalChunks) {
        throw new Error(`Chunk count mismatch. Expected ${totalChunks} but got ${allHashes.length}`);
      }
      
      // Report progress
      if (onProgress) {
        onProgress({ phase: 'hashing', completed: totalChunks, total: totalChunks });
      }
      
      // Build Merkle tree from hashes
      if (onProgress) {
        onProgress({ phase: 'building', completed: 0, total: 1 });
      }
      
      const tree = buildMerkleTree(allHashes);
      
      if (onProgress) {
        onProgress({ phase: 'building', completed: 1, total: 1 });
      }
      
      return {
        ...tree,
        chunkSize,
        fileSize,
        chunkCount: totalChunks
      };
      
    } finally {
      fs.closeSync(fd);
    }

  } finally {
    await pool.terminate();
  }
}

/**
 * Single-threaded fallback for small files
 */
async function buildFileMerkleTreeSingleThreaded(filePath, chunkSize, onProgress) {
  
  const stats = await fs.promises.stat(filePath);
  const fileSize = stats.size;
  const totalChunks = Math.ceil(fileSize / chunkSize);
  
  const leafHashes = [];
  
  // Use synchronous file operations to avoid loading entire file into memory
  const fd = fs.openSync(filePath, 'r');
  
  try {
    for (let i = 0; i < totalChunks; i++) {
      const offset = i * chunkSize;
      const length = Math.min(chunkSize, fileSize - offset);
      const buffer = Buffer.allocUnsafe(length);
      
      const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
      const actualBuffer = bytesRead < length ? buffer.subarray(0, bytesRead) : buffer;
      
      leafHashes.push(hashBuffer(actualBuffer));
      
      if (onProgress && i % 100 === 0) {
        onProgress({ phase: 'hashing', completed: i + 1, total: totalChunks });
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  
  if (onProgress) {
    onProgress({ phase: 'hashing', completed: totalChunks, total: totalChunks });
  }
  
  const tree = buildMerkleTree(leafHashes);
  
  return {
    ...tree,
    chunkSize,
    fileSize,
    chunkCount: totalChunks
  };
}

/**
 * Get just the Merkle root hash (parallel)
 * @param {string} filePath - Path to file
 * @param {number} chunkSize - Chunk size in bytes
 * @param {object} options - Options
 * @returns {Promise<string>} Root hash
 */
export async function getFileMerkleRootParallel(filePath, chunkSize = 256 * 1024, options = {}) {
  const tree = await buildFileMerkleTreeParallel(filePath, chunkSize, options);
  return tree.root;
}

/**
 * Build Merkle trees for multiple files in parallel
 * Useful for batch processing during initial file scanning
 * @param {Array<{path: string, chunkSize?: number}>} files - Files to process
 * @param {object} options - Options
 * @returns {Promise<Map>} Map of filePath -> merkleRoot
 */
export async function buildMultipleFileMerkleTrees(files, options = {}) {
  const { concurrency = cpus().length } = options;
  const results = new Map();
  
  // Process files in batches
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, Math.min(i + concurrency, files.length));
    
    const promises = batch.map(async (file) => {
      const tree = await buildFileMerkleTreeParallel(
        file.path,
        file.chunkSize || 256 * 1024,
        options
      );
      return { path: file.path, root: tree.root };
    });
    
    const batchResults = await Promise.all(promises);
    batchResults.forEach(({ path, root }) => results.set(path, root));
  }
  
  return results;
}
