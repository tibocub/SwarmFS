/**
 * SwarmFS Protocol Layer
 * Handles REQUEST/OFFER/DOWNLOAD/CHUNK_DATA messages over Hyperswarm connections
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';

// Protocol version
export const PROTOCOL_VERSION = 1;

// Message types
export const MSG_TYPE = {
  REQUEST: 0x01,      // Request a chunk by hash
  OFFER: 0x02,        // Offer to provide chunk (with Merkle proof)
  DOWNLOAD: 0x03,     // Accept offer and start download
  CHUNK_DATA: 0x04,   // Actual chunk bytes
  CANCEL: 0x05,       // Cancel request
  ERROR: 0x06         // Error response
};

export class Protocol extends EventEmitter {
  constructor(network, storage, database) {
    super();
    
    this.network = network;
    this.storage = storage;
    this.db = database;
    
    // Track active requests
    this.activeRequests = new Map(); // requestId -> { chunkHash, timeout, offers }
    this.activeDownloads = new Map(); // requestId -> { chunkHash, peerId, data }
    
    // Setup network event handlers
    this.network.on('peer:data', (conn, peerId, data) => {
      this.handleMessage(conn, peerId, data);
    });
    
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
  handleMessage(conn, peerId, data) {
    try {
      const { version, type, payload } = this.decodeMessage(data);
      
      if (version !== PROTOCOL_VERSION) {
        console.warn(`Protocol version mismatch: ${version} != ${PROTOCOL_VERSION}`);
        return;
      }
      
      switch (type) {
        case MSG_TYPE.REQUEST:
          this.handleRequest(conn, peerId, payload);
          break;
        case MSG_TYPE.OFFER:
          this.handleOffer(conn, peerId, payload);
          break;
        case MSG_TYPE.DOWNLOAD:
          this.handleDownload(conn, peerId, payload);
          break;
        case MSG_TYPE.CHUNK_DATA:
          this.handleChunkData(conn, peerId, payload);
          break;
        case MSG_TYPE.CANCEL:
          this.handleCancel(peerId, payload);
          break;
        case MSG_TYPE.ERROR:
          this.handleError(peerId, payload);
          break;
        default:
          console.warn(`Unknown message type: ${type}`);
      }
    } catch (error) {
      console.error(`Error handling message from ${peerId.substring(0, 8)}:`, error.message);
    }
  }

  /**
   * REQUEST: Peer needs a chunk
   */
  handleRequest(conn, peerId, payload) {
    const { requestId, chunkHash } = payload;
    
    console.log(`📥 REQUEST from ${peerId.substring(0, 8)}: chunk ${chunkHash.substring(0, 16)}...`);
    
    // Check if we have this chunk
    if (!this.storage.hasChunk(chunkHash)) {
      console.log(`   ⚠️  Don't have chunk`);
      return;
    }
    
    // Get chunk info from database
    const chunkInfo = this.db.getChunk(chunkHash);
    if (!chunkInfo) {
      console.log(`   ⚠️  Chunk not in database`);
      return;
    }
    
    console.log(`   ✓ Have chunk (${chunkInfo.size} bytes)`);
    
    // TODO: Generate Merkle proof (Phase 4.3.1)
    // For now, send offer without proof
    const merkleProof = [];
    
    // Send OFFER
    this.sendOffer(conn, requestId, chunkHash, chunkInfo.size, merkleProof);
  }

  /**
   * OFFER: Peer can provide chunk
   */
  handleOffer(conn, peerId, payload) {
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
    
    // TODO: Validate Merkle proof (Phase 4.3.1)
    // For now, accept all offers
    
    console.log(`   ✓ Valid offer (${chunkSize} bytes)`);
    
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
    
    // Verify we have the chunk
    if (!this.storage.hasChunk(chunkHash)) {
      this.sendError(conn, requestId, 'Chunk not found');
      return;
    }
    
    try {
      // Load chunk from storage
      const chunkData = this.storage.loadChunk(chunkHash);
      
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
    
    // Convert data back to Buffer (it comes as base64 in JSON)
    const chunkData = Buffer.from(data, 'base64');
    
    console.log(`📦 CHUNK_DATA from ${peerId.substring(0, 8)}: ${chunkData.length} bytes`);
    
    // Verify hash
    const actualHash = crypto.createHash('sha256').update(chunkData).digest('hex');
    
    if (actualHash !== chunkHash) {
      console.error(`   ❌ Hash mismatch! Expected ${chunkHash.substring(0, 16)}... got ${actualHash.substring(0, 16)}...`);
      this.emit('chunk:error', { requestId, chunkHash, error: 'Hash mismatch' });
      return;
    }
    
    console.log(`   ✓ Hash verified`);
    
    // Store chunk
    try {
      this.storage.storeChunk(chunkHash, chunkData);
      this.db.addChunk(chunkHash, chunkData.length);
      
      console.log(`   ✓ Chunk stored`);
      
      // Clean up request
      this.activeRequests.delete(requestId);
      this.activeDownloads.delete(requestId);
      
      // Emit success
      this.emit('chunk:downloaded', {
        requestId,
        chunkHash,
        size: chunkData.length,
        peerId
      });
      
    } catch (error) {
      console.error(`   ❌ Error storing chunk:`, error.message);
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
    
    // Track download
    this.activeDownloads.set(requestId, {
      chunkHash: request.chunkHash,
      peerId,
      startedAt: Date.now()
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
    
    this.activeRequests.clear();
    this.activeDownloads.clear();
  }
}
