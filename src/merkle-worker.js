/**
 * Worker thread for parallel chunk hashing
 * Each worker processes a batch of file chunks and returns their hashes
 */

import { parentPort } from 'worker_threads';
import { hashBuffer } from './hash.js';

parentPort.on('message', async (message) => {
  const { chunks } = message;
  
  try {
    // Validate input
    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
      throw new Error(`Invalid chunks array`);
    }
    
    // Hash each chunk buffer
    const results = await Promise.all(chunks.map(async (chunk) => {
      if (!chunk.data) {
        throw new Error(`Chunk ${chunk.index} missing data`);
      }
      
      // Convert Uint8Array back to Buffer if needed
      const buffer = Buffer.isBuffer(chunk.data) 
        ? chunk.data 
        : Buffer.from(chunk.data);
      
      if (!buffer || buffer.length === 0) {
        throw new Error(`Chunk ${chunk.index} has invalid or empty buffer`);
      }
      
      const hash = await hashBuffer(buffer);
      
      if (!hash || typeof hash !== 'string') {
        throw new Error(`Invalid hash generated for chunk ${chunk.index}`);
      }
      
      return {
        index: chunk.index,
        hash: hash
      };
    }));
    
    parentPort.postMessage({ success: true, results });
    
  } catch (error) {
    parentPort.postMessage({ 
      success: false, 
      error: error.message,
      stack: error.stack
    });
  }
});
