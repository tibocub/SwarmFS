/**
 * SwarmFS Protocol Layer
 * Handles REQUEST/OFFER/DOWNLOAD/CHUNK_DATA messages over Hyperswarm connections
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const VERBOSE = process.env.SWARMFS_VERBOSE === '1' || process.env.SWARMFS_VERBOSE === 'true';
const debug = (...args) => {
  if (VERBOSE) {
    console.log(...args);
  }
};

// Protocol version
export const PROTOCOL_VERSION = 1;

// Message types
export const MSG_TYPE = {
  REQUEST: 0x01,            // Request a chunk by hash
  OFFER: 0x02,              // Offer to provide chunk (with Merkle proof)
  DOWNLOAD: 0x03,           // Accept offer and start download
  CHUNK_DATA: 0x04,         // Actual chunk bytes
  CANCEL: 0x05,             // Cancel request
  ERROR: 0x06,              // Error response
  FILE_LIST_REQUEST: 0x07,  // Request list of shared files in topic
  FILE_LIST_RESPONSE: 0x08, // Response with shared files
  METADATA_REQUEST: 0x09,   // Request file metadata by merkle root
  METADATA_RESPONSE: 0x0a   // Response with file metadata
};

export class Protocol extends EventEmitter {
  constructor(network, database) {
    super();
    
    debug('[PROTOCOL] Initializing Protocol...');
    debug('[PROTOCOL] Network:', network ? 'OK' : 'MISSING');
    debug('[PROTOCOL] Storage: REMOVED (direct file I/O)');
    debug('[PROTOCOL] Database:', database ? 'OK' : 'MISSING');
    
    this.network = network;
    this.db = database;
    
    // Track active requests
    this.activeRequests = new Map(); // requestId -> { chunkHash, timeout, offers }
    this.activeDownloads = new Map(); // requestId -> { chunkHash, peerId, data }
    this.activeFileListRequests = new Map(); // requestId -> { topicKey, timeout }
    this.activeMetadataRequests = new Map(); // requestId -> { merkleRoot, topicKey, timeout }
    
    // Setup network event handlers
    debug('[PROTOCOL] Setting up peer:data handler...');
    this.network.on('peer:data', async (conn, peerId, data) => {
      debug(`[PROTOCOL] peer:data event fired: ${data.length} bytes from ${peerId.substring(0, 8)}`);
      await this.handleMessage(conn, peerId, data);
    });
    
    debug('[PROTOCOL] Protocol initialized successfully');
    
    // Cleanup old requests periodically
    this.cleanupInterval = setInterval(() => this.cleanup(), 30000);
  }

  /**
   * Encode a message to binary
   */
  encodeMessage(type, payload) {
    const payloadJson = JSON.stringify(payload);
    const payloadBuffer = Buffer.from(payloadJson, 'utf8');
    
    // Message format: [version:1][type:1][length:4][payload:n]
    const message = Buffer.allocUnsafe(6 + payloadBuffer.length);
    message.writeUInt8(PROTOCOL_VERSION, 0);
    message.writeUInt8(type, 1);
    message.writeUInt32BE(payloadBuffer.length, 2);
    payloadBuffer.copy(message, 6);
    
    return message;
  }

  /**
   * Decode a message from binary
   */
  decodeMessage(buffer) {
    if (buffer.length < 6) {
      throw new Error('Message too short');
    }
    
    const version = buffer.readUInt8(0);
    const type = buffer.readUInt8(1);
    const length = buffer.readUInt32BE(2);
    
    if (buffer.length < 6 + length) {
      throw new Error('Incomplete message');
    }
    
    const payloadBuffer = buffer.subarray(6, 6 + length);
    const payload = JSON.parse(payloadBuffer.toString('utf8'));
    
    return { version, type, payload };
  }

  /**
   * Handle incoming message
   */
  async handleMessage(conn, peerId, data) {
    try {
      // Debug: Log that we received data
      debug(`[DEBUG] handleMessage called, data length: ${data.length}`);
      
      const { version, type, payload } = this.decodeMessage(data);
      
      console.log(`[DEBUG] Decoded message - version: ${version}, type: ${type}`);
      
      if (version !== PROTOCOL_VERSION) {
        console.warn(`Protocol version mismatch: ${version} != ${PROTOCOL_VERSION}`);
        return;
      }
      
      switch (type) {
        case MSG_TYPE.REQUEST:
          console.log(`[DEBUG] Calling handleRequest`);
          await this.handleRequest(conn, peerId, payload);
          break;
        case MSG_TYPE.OFFER:
          console.log(`[DEBUG] Calling handleOffer`);
          await this.handleOffer(conn, peerId, payload);
          break;
        case MSG_TYPE.DOWNLOAD:
          console.log(`[DEBUG] Calling handleDownload`);
          this.handleDownload(conn, peerId, payload);
          break;
        case MSG_TYPE.CHUNK_DATA:
          console.log(`[DEBUG] Calling handleChunkData`);
          this.handleChunkData(conn, peerId, payload);
          break;
        case MSG_TYPE.CANCEL:
          this.handleCancel(peerId, payload);
          break;
        case MSG_TYPE.ERROR:
          this.handleError(peerId, payload);
          break;
        case MSG_TYPE.FILE_LIST_REQUEST:
          await this.handleFileListRequest(conn, peerId, payload);
          break;
        case MSG_TYPE.FILE_LIST_RESPONSE:
          this.handleFileListResponse(conn, peerId, payload);
          break;
        case MSG_TYPE.METADATA_REQUEST:
          await this.handleMetadataRequest(conn, peerId, payload);
          break;
        case MSG_TYPE.METADATA_RESPONSE:
          this.handleMetadataResponse(conn, peerId, payload);
          break;
        default:
          console.warn(`Unknown message type: ${type}`);
      }
    } catch (error) {
      console.error(`Error handling message from ${peerId.substring(0, 8)}:`, error.message);
      console.error(error.stack);
    }
  }

  /**
   * REQUEST: Peer needs a chunk
   */
  async handleRequest(conn, peerId, payload) {
    const { requestId, chunkHash } = payload;

    console.log(`📥 REQUEST from ${peerId.substring(0, 8)}: chunk ${chunkHash.substring(0, 16)}...`);

    const chunkLocation = this.db.getChunkLocation(chunkHash);
    if (!chunkLocation) {
      console.log(`   ⚠️  Don't have chunk`);
      return;
    }

    console.log(`   ✓ Have chunk (${chunkLocation.chunk_size} bytes)`);

    const merkleProof = await this.generateMerkleProof(chunkHash);
    this.sendOffer(conn, requestId, chunkHash, chunkLocation.chunk_size, merkleProof);
  }


  /**
   * OFFER: Peer can provide chunk
   */
  async handleOffer(conn, peerId, payload) {
    const { requestId, chunkHash, chunkSize, merkleProof } = payload;
    
    console.log(`📨 OFFER from ${peerId.substring(0, 8)}: chunk ${chunkHash.substring(0, 16)}...`);
    
    // Check if we're still waiting for this
    const request = this.activeRequests.get(requestId);
    if (!request) {
      console.log(`   ⚠️  Request expired or completed`);
      return;
    }
    
    if (request.chunkHash !== chunkHash) {
      console.log(`   ⚠️  Chunk hash mismatch`);
      return;
    }
    
    // Validate Merkle proof
    const isValidProof = await this.validateMerkleProof(chunkHash, merkleProof);
    if (!isValidProof) {
      console.log(`   ⚠️  Invalid Merkle proof - rejecting offer`);
      return;
    }
    
    console.log(`   ✓ Valid offer (${chunkSize} bytes)${merkleProof && merkleProof.fileRoot ? ' [proof verified]' : ''}`);
    
    // Store offer
    request.offers.push({
      peerId,
      conn,
      chunkSize,
      merkleProof,
      timestamp: Date.now()
    });
    
    // Emit event so caller can decide which offer to accept
    this.emit('chunk:offer', {
      requestId,
      chunkHash,
      peerId,
      chunkSize,
      offerCount: request.offers.length
    });
  }

  /**
   * DOWNLOAD: Accept an offer and start download
   */
  handleDownload(conn, peerId, payload) {
    const { requestId, chunkHash } = payload;
    
    console.log(`📤 DOWNLOAD request from ${peerId.substring(0, 8)}: ${chunkHash.substring(0, 16)}...`);
    
    const chunkLocation = this.db.getChunkLocation(chunkHash);
    if (!chunkLocation) {
      this.sendError(conn, requestId, 'Chunk not found');
      return;
    }
    
    try {
      let chunkData = Buffer.allocUnsafe(chunkLocation.chunk_size);
      const fd = fs.openSync(chunkLocation.path, 'r');
      try {
        const bytesRead = fs.readSync(
          fd,
          chunkData,
          0,
          chunkLocation.chunk_size,
          chunkLocation.chunk_offset
        );
        if (bytesRead !== chunkLocation.chunk_size) {
          chunkData = chunkData.subarray(0, bytesRead);
        }
      } finally {
        fs.closeSync(fd);
      }
      
      console.log(`   📦 Sending chunk (${chunkData.length} bytes)`);
      
      // Send chunk data
      this.sendChunkData(conn, requestId, chunkHash, chunkData);
      
    } catch (error) {
      console.error(`   ❌ Error loading chunk:`, error.message);
      this.sendError(conn, requestId, error.message);
    }
  }

  /**
   * CHUNK_DATA: Received chunk data
   */
  handleChunkData(conn, peerId, payload) {
    const { requestId, chunkHash, data } = payload;
    const chunkData = Buffer.from(data, 'base64');

    console.log(`📦 CHUNK_DATA from ${peerId.substring(0, 8)}: ${chunkData.length} bytes`);

    const download = this.activeDownloads.get(requestId);
    if (download) {
      download.receivedSize = chunkData.length;
      this.emit('chunk:progress', {
        requestId,
        chunkHash,
        current: chunkData.length,
        total: download.expectedSize,
        percentage: (chunkData.length / download.expectedSize) * 100
      });
    }

    const actualHash = crypto.createHash('sha256').update(chunkData).digest('hex');
    if (actualHash !== chunkHash) {
      console.error(`   ❌ Hash mismatch! Expected ${chunkHash.substring(0, 16)}... got ${actualHash.substring(0, 16)}...`);

      const request = this.activeRequests.get(requestId);
      if (request && request.timeout) {
        clearTimeout(request.timeout);
      }

      this.activeRequests.delete(requestId);
      this.activeDownloads.delete(requestId);

      this.emit('chunk:error', { requestId, chunkHash, error: 'Hash mismatch' });
      return;
    }

    console.log(`   ✓ Hash verified`);

    try {
      const chunkLocation = this.db.getChunkWriteLocation(chunkHash);
      if (!chunkLocation) {
        throw new Error('Chunk metadata missing for output file');
      }

      const fd = fs.openSync(chunkLocation.path, 'r+');
      try {
        fs.writeSync(fd, chunkData, 0, chunkData.length, chunkLocation.chunk_offset);
      } finally {
        fs.closeSync(fd);
      }

      console.log(`   ✓ Chunk written`);

      const request = this.activeRequests.get(requestId);
      if (request && request.timeout) {
        clearTimeout(request.timeout);
      }

      this.activeRequests.delete(requestId);
      this.activeDownloads.delete(requestId);

      this.emit('chunk:downloaded', {
        requestId,
        chunkHash,
        size: chunkData.length,
        peerId
      });
    } catch (error) {
      console.error(`   ❌ Error writing chunk:`, error.message);

      const request = this.activeRequests.get(requestId);
      if (request && request.timeout) {
        clearTimeout(request.timeout);
      }

      this.activeRequests.delete(requestId);
      this.activeDownloads.delete(requestId);

      this.emit('chunk:error', { requestId, chunkHash, error: error.message });
    }
  }


  /**
   * CANCEL: Request cancelled
   */
  handleCancel(peerId, payload) {
    const { requestId } = payload;
    console.log(`🚫 CANCEL from ${peerId.substring(0, 8)}: ${requestId}`);
    
    this.activeRequests.delete(requestId);
    this.activeDownloads.delete(requestId);
  }

  /**
   * ERROR: Error response
   */
  handleError(peerId, payload) {
    const { requestId, error } = payload;
    console.error(`❌ ERROR from ${peerId.substring(0, 8)}: ${error}`);
    
    this.emit('chunk:error', { requestId, error });
  }

  /**
   * FILE_LIST_REQUEST: Peer requests list of shared files in topic
   */
  async handleFileListRequest(conn, peerId, payload) {
    const { requestId, topicKey } = payload;

    console.log(`📄 FILE_LIST_REQUEST from ${peerId.substring(0, 8)}...`);

    const topic = this.db.getTopicByKey(topicKey);
    if (!topic) {
      console.log(`   ⚠️  Unknown topic key`);
      return;
    }

    const shares = this.db.getTopicShares(topic.id);
    const files = shares
      .filter((share) => share.share_type === 'file')
      .map((share) => {
        const file = this.db.getFile(share.share_path);
        if (!file || file.file_modified_at <= 0) {
          return null;
        }

        return {
          name: path.basename(share.share_path),
          path: share.share_path,
          merkleRoot: share.merkle_root,
          size: file.size,
          chunkSize: file.chunk_size,
          chunkCount: file.chunk_count
        };
      })
      .filter(Boolean);

    this.sendFileListResponse(conn, requestId, topicKey, files);
  }

  handleFileListResponse(conn, peerId, payload) {
    const { requestId, files } = payload;

    const request = this.activeFileListRequests.get(requestId);
    if (!request) {
      return;
    }

    console.log(`📄 FILE_LIST_RESPONSE from ${peerId.substring(0, 8)} (${files.length} files)`);
    this.emit('file:list', { requestId, peerId, files });
  }

  /**
   * METADATA_REQUEST: Peer requests metadata for a file
   */
  async handleMetadataRequest(conn, peerId, payload) {
    const { requestId, merkleRoot, topicKey } = payload;

    console.log(`📑 METADATA_REQUEST from ${peerId.substring(0, 8)}: ${merkleRoot.substring(0, 16)}...`);

    const topic = this.db.getTopicByKey(topicKey);
    if (!topic) {
      this.sendError(conn, requestId, 'Unknown topic');
      return;
    }

    const share = this.db.getTopicShareByMerkleRoot(topic.id, merkleRoot);
    if (!share) {
      this.sendError(conn, requestId, 'File not shared in topic');
      return;
    }

    const file = this.db.getFile(share.share_path);
    if (!file || file.file_modified_at <= 0) {
      this.sendError(conn, requestId, 'File metadata unavailable');
      return;
    }

    const chunks = this.db.getFileChunks(file.id);
    const metadata = {
      merkleRoot,
      name: path.basename(share.share_path),
      path: share.share_path,
      size: file.size,
      chunkSize: file.chunk_size,
      chunkCount: file.chunk_count,
      chunks: chunks.map((chunk) => ({
        hash: chunk.chunk_hash,
        offset: chunk.chunk_offset,
        size: chunk.chunk_size
      }))
    };

    this.sendMetadataResponse(conn, requestId, metadata);
  }

  handleMetadataResponse(conn, peerId, payload) {
    const { requestId, metadata } = payload;

    const request = this.activeMetadataRequests.get(requestId);
    if (!request) {
      return;
    }

    if (metadata.merkleRoot !== request.merkleRoot) {
      return;
    }

    if (request.timeout) {
      clearTimeout(request.timeout);
    }
    this.activeMetadataRequests.delete(requestId);

    console.log(`📑 METADATA_RESPONSE from ${peerId.substring(0, 8)} (${metadata.chunkCount} chunks)`);
    this.emit('metadata:response', { requestId, peerId, metadata });
  }

  // ============================================================================
  // SEND METHODS
  // ============================================================================

  /**
   * Request a chunk from the network
   */
  requestChunk(topicKey, chunkHash, timeout = 30000) {
    const requestId = crypto.randomBytes(16).toString('hex');
    
    console.log(`\n📤 Requesting chunk: ${chunkHash.substring(0, 16)}...`);
    console.log(`   Request ID: ${requestId.substring(0, 16)}...`);
    
    // Track request
    this.activeRequests.set(requestId, {
      chunkHash,
      topicKey,
      offers: [],
      timestamp: Date.now(),
      timeout: setTimeout(() => {
        console.log(`   ⏱️  Request timeout for ${chunkHash.substring(0, 16)}...`);
        this.activeRequests.delete(requestId);
        this.emit('chunk:timeout', { requestId, chunkHash });
      }, timeout)
    });
    
    // Broadcast REQUEST to topic
    const message = this.encodeMessage(MSG_TYPE.REQUEST, {
      requestId,
      chunkHash
    });
    
    const sent = this.network.broadcast(topicKey, message);
    console.log(`   📡 Broadcast to ${sent} peer(s)`);
    
    return requestId;
  }

  /**
   * Request shared file list from topic
   */
  requestFileList(topicKey, timeout = 5000) {
    const requestId = crypto.randomBytes(16).toString('hex');
    const topicKeyHex = topicKey.toString('hex');

    this.activeFileListRequests.set(requestId, {
      topicKey,
      timestamp: Date.now(),
      timeout: setTimeout(() => {
        this.activeFileListRequests.delete(requestId);
        this.emit('file:list:timeout', { requestId });
      }, timeout)
    });

    const message = this.encodeMessage(MSG_TYPE.FILE_LIST_REQUEST, {
      requestId,
      topicKey: topicKeyHex
    });

    this.network.broadcast(topicKey, message);
    return requestId;
  }

  /**
   * Send OFFER
   */
  sendOffer(conn, requestId, chunkHash, chunkSize, merkleProof) {
    const message = this.encodeMessage(MSG_TYPE.OFFER, {
      requestId,
      chunkHash,
      chunkSize,
      merkleProof
    });
    
    conn.write(message);
    console.log(`   📨 Sent OFFER`);
  }

  sendFileListResponse(conn, requestId, topicKey, files) {
    const message = this.encodeMessage(MSG_TYPE.FILE_LIST_RESPONSE, {
      requestId,
      topicKey,
      files
    });

    conn.write(message);
  }

  /**
   * Request file metadata by merkle root
   */
  requestMetadata(topicKey, merkleRoot, timeout = 10000) {
    const requestId = crypto.randomBytes(16).toString('hex');
    const topicKeyHex = topicKey.toString('hex');

    this.activeMetadataRequests.set(requestId, {
      merkleRoot,
      topicKey,
      timestamp: Date.now(),
      timeout: setTimeout(() => {
        this.activeMetadataRequests.delete(requestId);
        this.emit('metadata:timeout', { requestId, merkleRoot });
      }, timeout)
    });

    const message = this.encodeMessage(MSG_TYPE.METADATA_REQUEST, {
      requestId,
      merkleRoot,
      topicKey: topicKeyHex
    });

    this.network.broadcast(topicKey, message);
    return requestId;
  }

  /**
   * Accept an offer and download
   */
  acceptOffer(requestId, peerId) {
    const request = this.activeRequests.get(requestId);
    if (!request) {
      throw new Error('Request not found');
    }
    
    const offer = request.offers.find(o => o.peerId === peerId);
    if (!offer) {
      throw new Error('Offer not found');
    }
    
    console.log(`\n✓ Accepting offer from ${peerId.substring(0, 8)}...`);
    
    // Send DOWNLOAD message
    const message = this.encodeMessage(MSG_TYPE.DOWNLOAD, {
      requestId,
      chunkHash: request.chunkHash
    });
    
    offer.conn.write(message);
    
    // Track download with progress info
    this.activeDownloads.set(requestId, {
      chunkHash: request.chunkHash,
      peerId,
      expectedSize: offer.chunkSize,
      receivedSize: 0,
      startedAt: Date.now()
    });
    
    // Emit download started
    this.emit('chunk:download-started', {
      requestId,
      chunkHash: request.chunkHash,
      peerId,
      size: offer.chunkSize
    });
  }

  /**
   * Send chunk data
   */
  sendChunkData(conn, requestId, chunkHash, chunkData) {
    const message = this.encodeMessage(MSG_TYPE.CHUNK_DATA, {
      requestId,
      chunkHash,
      data: chunkData.toString('base64') // JSON-safe encoding
    });
    
    conn.write(message);
  }

  sendMetadataResponse(conn, requestId, metadata) {
    const message = this.encodeMessage(MSG_TYPE.METADATA_RESPONSE, {
      requestId,
      metadata
    });

    conn.write(message);
  }

  /**
   * Send error
   */
  sendError(conn, requestId, error) {
    const message = this.encodeMessage(MSG_TYPE.ERROR, {
      requestId,
      error
    });
    
    conn.write(message);
  }

  /**
   * Cancel a request
   */
  cancelRequest(requestId) {
    const request = this.activeRequests.get(requestId);
    if (!request) {
      return;
    }
    
    console.log(`🚫 Cancelling request: ${requestId.substring(0, 16)}...`);
    
    // Broadcast CANCEL
    const message = this.encodeMessage(MSG_TYPE.CANCEL, { requestId });
    this.network.broadcast(request.topicKey, message);
    
    // Cleanup
    clearTimeout(request.timeout);
    this.activeRequests.delete(requestId);
    this.activeDownloads.delete(requestId);
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  /**
   * Cleanup expired requests
   */
  cleanup() {
    const now = Date.now();
    const maxAge = 60000; // 1 minute
    
    for (const [requestId, request] of this.activeRequests) {
      if (now - request.timestamp > maxAge) {
        console.log(`🧹 Cleaning up old request: ${requestId.substring(0, 16)}...`);
        clearTimeout(request.timeout);
        this.activeRequests.delete(requestId);
      }
    }

    for (const [requestId, request] of this.activeFileListRequests) {
      if (now - request.timestamp > maxAge) {
        clearTimeout(request.timeout);
        this.activeFileListRequests.delete(requestId);
      }
    }

    for (const [requestId, request] of this.activeMetadataRequests) {
      if (now - request.timestamp > maxAge) {
        clearTimeout(request.timeout);
        this.activeMetadataRequests.delete(requestId);
      }
    }
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      activeRequests: this.activeRequests.size,
      activeDownloads: this.activeDownloads.size
    };
  }

  /**
   * Close protocol
   */
  close() {
    clearInterval(this.cleanupInterval);
    
    // Clear all timeouts
    for (const [requestId, request] of this.activeRequests) {
      clearTimeout(request.timeout);
    }

    for (const [requestId, request] of this.activeFileListRequests) {
      clearTimeout(request.timeout);
    }

    for (const [requestId, request] of this.activeMetadataRequests) {
      clearTimeout(request.timeout);
    }
    
    this.activeRequests.clear();
    this.activeDownloads.clear();
    this.activeFileListRequests.clear();
    this.activeMetadataRequests.clear();
  }

  // ============================================================================
  // MERKLE PROOF GENERATION & VALIDATION
  // ============================================================================

  /**
   * Generate Merkle proof for a chunk
   */
  async generateMerkleProof(chunkHash) {
    console.log(`[DEBUG] generateMerkleProof called for ${chunkHash.substring(0, 16)}...`);
    
    // Find all files that contain this chunk
    const files = this.db.getFilesWithChunk(chunkHash);
    console.log(`[DEBUG] Found ${files.length} files with this chunk`);
    
    if (files.length === 0) {
      console.log(`[DEBUG] No files found, returning empty proof`);
      return [];
    }
    
    // Use the first file (could be smarter - pick smallest file, etc.)
    const file = files[0];
    console.log(`[DEBUG] Using file: ${file.path}`);
    
    // Get all chunks for this file
    const fileChunks = this.db.getFileChunks(file.id);
    console.log(`[DEBUG] File has ${fileChunks.length} chunks`);
    
    // Find the index of our chunk
    const chunkIndex = fileChunks.findIndex(fc => fc.chunk_hash === chunkHash);
    console.log(`[DEBUG] Chunk index: ${chunkIndex}`);
    
    if (chunkIndex === -1) {
      console.log(`[DEBUG] Chunk not found in file chunks, returning empty proof`);
      return [];
    }
    
    // Get all chunk hashes in order
    const chunkHashes = fileChunks.map(fc => fc.chunk_hash);
    
    // Import merkle module
    console.log(`[DEBUG] Importing merkle module...`);
    const { generateMerkleProof } = await import('./merkle.js');
    console.log(`[DEBUG] Merkle module imported`);
    
    try {
      const proof = generateMerkleProof(chunkHashes, chunkIndex);
      console.log(`[DEBUG] Merkle proof generated, siblings: ${proof.proof.length}`);
      
      // Return simplified proof for network transmission
      const simplifiedProof = {
        fileRoot: file.merkle_root,
        chunkIndex: chunkIndex,
        siblings: proof.proof.map(p => ({
          hash: p.hash,
          isLeft: p.isLeft
        }))
      };
      
      console.log(`[DEBUG] Returning simplified proof`);
      return simplifiedProof;
    } catch (error) {
      console.error('[DEBUG] Error generating merkle proof:', error.message);
      console.error('[DEBUG] Stack:', error.stack);
      return [];
    }
  }

  /**
   * Validate Merkle proof
   */
  async validateMerkleProof(chunkHash, merkleProof) {
    // If no proof provided, skip validation (backward compatibility)
    if (!merkleProof || merkleProof.length === 0 || !merkleProof.fileRoot) {
      return true; // Accept for now
    }
    
    // Import merkle module
    const { verifyMerkleProof } = await import('./merkle.js');
    
    try {
      const isValid = verifyMerkleProof(
        chunkHash,
        merkleProof.siblings,
        merkleProof.fileRoot
      );
      
      return isValid;
    } catch (error) {
      console.error('Error validating merkle proof:', error.message);
      return false;
    }
  }
}
