/**
 * SwarmFS Protocol Layer
 * Handles REQUEST/OFFER/DOWNLOAD/CHUNK_DATA messages over Hyperswarm connections
 */

import { EventEmitter } from 'events'
import crypto from 'crypto'
import blake3 from 'blake3-bao/blake3'
import fs from 'fs'
import path from 'path'
import { hashBuffer } from './hash.js'

const VERBOSE = process.env.SWARMFS_VERBOSE === '1' || process.env.SWARMFS_VERBOSE === 'true'
const debug = (...args) => {
  if (VERBOSE) {
    console.log(...args)
  }
};

// Protocol version
export const PROTOCOL_VERSION = 1

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
  METADATA_RESPONSE: 0x0a,  // Response with file metadata
  HAVE: 0x0b,               // Announce single chunk
  BITFIELD: 0x0c,           // Send complete bitfield
  BITFIELD_REQUEST: 0x0d,   // Request peer's bitfield
  SUBTREE_REQUEST: 0x0e,
  SUBTREE_DATA: 0x0f
}

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

    // Stream reassembly buffers per peer (Hyperswarm delivers arbitrary-sized data chunks)
    this._peerBuffers = new Map(); // peerId -> Buffer

    // Per-connection send queues for backpressure-safe writes without stalling message handling.
    // conn -> Promise chain
    this._sendQueues = new Map();
    
    // Setup network event handlers
    debug('[PROTOCOL] Setting up peer handler...');

		this.network.on('peer:connected', (conn, peerId, topicKey) => {
      // Backward-compat: older SwarmNetwork versions may have emitted positional args
      // New SwarmNetwork emits a single object: { conn, peerId, topicKey }
      if (conn && typeof conn === 'object' && conn.conn && conn.peerId) {
        const { conn: c, peerId: p, topicKey: t } = conn;
        debug('[PROTOCOL] peer:connected (object payload)', p?.substring?.(0, 8));
        this.onPeerConnected(c, p, t);
        return;
      }
      debug('[PROTOCOL] peer:connected (positional payload)', peerId?.substring?.(0, 8));
      this.onPeerConnected(conn, peerId, topicKey);
    });
    
    this.network.on('peer:disconnected', (peerId, topicKey) => {
      // New SwarmNetwork emits a single object: { peerId, topicKey }
      if (peerId && typeof peerId === 'object' && peerId.peerId) {
        const { peerId: p, topicKey: t } = peerId;
        debug('[PROTOCOL] peer:disconnected (object payload)', p?.substring?.(0, 8));
        this.onPeerDisconnected(p, t);
        return;
      }

      debug('[PROTOCOL] peer:disconnected (positional payload)', peerId?.substring?.(0, 8));
      this.onPeerDisconnected(peerId, topicKey);
    });
    
    this.network.on('peer:data', async (conn, peerId, data) => {
      // New SwarmNetwork emits a single object: { conn, peerId, topicKey, data }
      if (conn && typeof conn === 'object' && conn.data && conn.conn && conn.peerId) {
        const { conn: c, peerId: p, data: d } = conn;
        debug('[PROTOCOL] peer:data (object payload)', p?.substring?.(0, 8), 'len=', d?.length);
        await this.handleData(c, p, d);
        return;
      }

      debug('[PROTOCOL] peer:data (positional payload)', peerId?.substring?.(0, 8), 'len=', data?.length);
      await this.handleData(conn, peerId, data);
    });
    
    debug('[PROTOCOL] Protocol initialized successfully');
    
    // Cleanup old requests periodically
    this.cleanupInterval = setInterval(() => this.cleanup(), 30000);
  }

  _enqueueWrite(conn, data) {
    const prev = this._sendQueues.get(conn) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => {
        const ok = conn.write(data);
        if (ok) {
          return;
        }
        return new Promise((resolve) => conn.once('drain', resolve));
      });

    this._sendQueues.set(conn, next);
    return next;
  }

  async _findValidChunkSource(chunkHash, limit = 10) {
    const locations = typeof this.db.getChunkLocations === 'function'
      ? this.db.getChunkLocations(chunkHash, limit)
      : (this.db.getChunkLocation(chunkHash) ? [this.db.getChunkLocation(chunkHash)] : []);

    for (const loc of locations) {
      if (!loc) {
        continue;
      }
      try {
        let requireRehash = true

        try {
          const st = fs.statSync(loc.path)
          if (st && st.isFile() && typeof loc.file_modified_at === 'number') {
            requireRehash = Math.floor(st.mtimeMs) !== loc.file_modified_at
          }
        } catch {
          // If stat fails, fall back to rehashing (will also fail if unreadable)
          requireRehash = true
        }

        const chunkData = this._readChunkBytes(loc);
        if (!requireRehash) {
          return { location: loc, chunkData }
        }

        const actualHash = await hashBuffer(chunkData)
        if (actualHash === chunkHash) {
          return { location: loc, chunkData }
        }

        console.warn(
          `   ⚠️  Stale chunk mapping candidate: ${actualHash.substring(0, 16)}... not ${chunkHash.substring(0, 16)}... (${loc.path})`
        )
      } catch (err) {
        console.warn(`   ⚠️  Failed to read chunk candidate (${loc.path}): ${err.message}`);
      }
    }

    return null;
  }

  _readChunkBytes(chunkLocation) {
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
    return chunkData;
  }
  
  onPeerConnected(conn, peerId, topicKey) {
    console.log(`Peer connected: ${peerId.substring(0, 8)}`);
    
    // Notify download sessions about new peer
    this.emit('peer:connected', { conn, peerId, topicKey });
    
    // Request bitfield from peer (to learn what chunks they have)
    // this.requestBitfield(conn, peerId);
  }
  
  onPeerDisconnected(peerId, topicKey) {
    console.log(`Peer disconnected: ${peerId.substring(0, 8)}`);
    
    // Notify download sessions
    this.emit('peer:disconnected', { peerId, topicKey });
  }
  
  /**
   * Request bitfield from peer (learn what chunks they have)
   */
  requestBitfield(conn, peerId) {
    const message = this.encodeMessage(MSG_TYPE.BITFIELD_REQUEST, {
      requestId: crypto.randomBytes(16).toString('hex')
    });

    void this._enqueueWrite(conn, message);
  }
  
  /**
   * Send our bitfield to peer
   */
  sendBitfield(conn, session) {
    const bitfield = session.ourBitfield;
    
    const message = this.encodeMessage(MSG_TYPE.BITFIELD, {
      merkleRoot: session.merkleRoot,
      bitfield: bitfield.buffer.toString('base64'),
      chunkCount: session.totalChunks
    });

    void this._enqueueWrite(conn, message);
  }

  /**
   * Encode a message to binary
   */
  encodeMessage(type, payload) {
    if (type === MSG_TYPE.CHUNK_DATA) {
      const { requestId, chunkHash, chunkData } = payload || {}
      if (typeof requestId !== 'string' || typeof chunkHash !== 'string' || !Buffer.isBuffer(chunkData)) {
        throw new TypeError('CHUNK_DATA payload must be { requestId: string, chunkHash: string, chunkData: Buffer }')
      }

      const requestIdBytes = Buffer.from(requestId, 'hex')
      const chunkHashBytes = Buffer.from(chunkHash, 'hex')
      if (requestIdBytes.length !== 16) {
        throw new Error(`Invalid requestId hex length: expected 16 bytes, got ${requestIdBytes.length}`)
      }
      if (chunkHashBytes.length !== 32) {
        throw new Error(`Invalid chunkHash hex length: expected 32 bytes, got ${chunkHashBytes.length}`)
      }

      const payloadLen = 1 + 16 + 32 + 4 + chunkData.length
      const message = Buffer.allocUnsafe(6 + payloadLen)
      message.writeUInt8(PROTOCOL_VERSION, 0)
      message.writeUInt8(type, 1)
      message.writeUInt32BE(payloadLen, 2)

      let off = 6
      message.writeUInt8(0x01, off)
      off += 1
      requestIdBytes.copy(message, off)
      off += 16
      chunkHashBytes.copy(message, off)
      off += 32
      message.writeUInt32BE(chunkData.length, off)
      off += 4
      chunkData.copy(message, off)
      return message
    }

    if (type === MSG_TYPE.SUBTREE_DATA) {
      const { requestId, merkleRoot, startChunk, chunkCount, data } = payload || {}
      if (typeof requestId !== 'string' || typeof merkleRoot !== 'string' || !Number.isInteger(startChunk) || !Number.isInteger(chunkCount) || !Buffer.isBuffer(data)) {
        throw new TypeError('SUBTREE_DATA payload must be { requestId: string, merkleRoot: string, startChunk: number, chunkCount: number, data: Buffer }')
      }

      const requestIdBytes = Buffer.from(requestId, 'hex')
      const merkleRootBytes = Buffer.from(merkleRoot, 'hex')
      if (requestIdBytes.length !== 16) {
        throw new Error(`Invalid requestId hex length: expected 16 bytes, got ${requestIdBytes.length}`)
      }
      if (merkleRootBytes.length !== 32) {
        throw new Error(`Invalid merkleRoot hex length: expected 32 bytes, got ${merkleRootBytes.length}`)
      }

      const payloadLen = 1 + 16 + 32 + 4 + 2 + 4 + data.length
      const message = Buffer.allocUnsafe(6 + payloadLen)
      message.writeUInt8(PROTOCOL_VERSION, 0)
      message.writeUInt8(type, 1)
      message.writeUInt32BE(payloadLen, 2)

      let off = 6
      message.writeUInt8(0x01, off)
      off += 1
      requestIdBytes.copy(message, off)
      off += 16
      merkleRootBytes.copy(message, off)
      off += 32
      message.writeUInt32BE(startChunk >>> 0, off)
      off += 4
      message.writeUInt16BE(chunkCount & 0xffff, off)
      off += 2
      message.writeUInt32BE(data.length >>> 0, off)
      off += 4
      data.copy(message, off)
      return message
    }

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

    if (type === MSG_TYPE.CHUNK_DATA) {
      // Alpha: CHUNK_DATA is always binary with a magic byte 0x01.
      if (payloadBuffer.length < 1 + 16 + 32 + 4) {
        throw new Error('Invalid CHUNK_DATA payload (too short)')
      }
      if (payloadBuffer[0] !== 0x01) {
        throw new Error('Invalid CHUNK_DATA payload (missing magic byte)')
      }

      const requestId = payloadBuffer.subarray(1, 17).toString('hex')
      const chunkHash = payloadBuffer.subarray(17, 49).toString('hex')
      const dataLen = payloadBuffer.readUInt32BE(49)
      const expected = 1 + 16 + 32 + 4 + dataLen
      if (payloadBuffer.length !== expected) {
        throw new Error(`Invalid CHUNK_DATA payload length: expected ${expected}, got ${payloadBuffer.length}`)
      }
      const chunkData = payloadBuffer.subarray(53, 53 + dataLen)

      return {
        version,
        type,
        payload: {
          requestId,
          chunkHash,
          chunkData
        }
      }
    }

    if (type === MSG_TYPE.SUBTREE_DATA) {
      if (payloadBuffer.length < 1 + 16 + 32 + 4 + 2 + 4) {
        throw new Error('Invalid SUBTREE_DATA payload (too short)')
      }
      if (payloadBuffer[0] !== 0x01) {
        throw new Error('Invalid SUBTREE_DATA payload (missing magic byte)')
      }

      const requestId = payloadBuffer.subarray(1, 17).toString('hex')
      const merkleRoot = payloadBuffer.subarray(17, 49).toString('hex')
      const startChunk = payloadBuffer.readUInt32BE(49)
      const chunkCount = payloadBuffer.readUInt16BE(53)
      const dataLen = payloadBuffer.readUInt32BE(55)
      const expected = 1 + 16 + 32 + 4 + 2 + 4 + dataLen
      if (payloadBuffer.length !== expected) {
        throw new Error(`Invalid SUBTREE_DATA payload length: expected ${expected}, got ${payloadBuffer.length}`)
      }
      const data = payloadBuffer.subarray(59, 59 + dataLen)

      return {
        version,
        type,
        payload: {
          requestId,
          merkleRoot,
          startChunk,
          chunkCount,
          data
        }
      }
    }

    const payload = JSON.parse(payloadBuffer.toString('utf8'));
    
    return { version, type, payload };
  }

  _tryDecodeFrames(peerId) {
    let buf = this._peerBuffers.get(peerId);
    if (!buf || buf.length === 0) {
      return [];
    }

    const frames = [];
    while (buf.length >= 6) {
      const length = buf.readUInt32BE(2);
      const total = 6 + length;
      if (buf.length < total) {
        break;
      }

      const frame = buf.subarray(0, total);
      frames.push(frame);
      buf = buf.subarray(total);
    }

    this._peerBuffers.set(peerId, buf);
    return frames;
  }

  async handleData(conn, peerId, data) {
    try {
      const prev = this._peerBuffers.get(peerId);
      const next = prev && prev.length > 0 ? Buffer.concat([prev, data]) : data;
      this._peerBuffers.set(peerId, next);

      const frames = this._tryDecodeFrames(peerId);
      for (const frame of frames) {
        await this.handleMessage(conn, peerId, frame);
      }
    } catch (error) {
      console.error(`Error handling data stream from ${peerId.substring(0, 8)}:`, error.message);
      console.error(error.stack);
    }
  }

  /**
   * Handle incoming message
   */
  async handleMessage(conn, peerId, data) {
    try {
      // Debug: Log that we received data
      debug(`[DEBUG] handleMessage called, data length: ${data.length}`);
      
      const { version, type, payload } = this.decodeMessage(data);

      if (VERBOSE) {
        console.log(`[DEBUG] Decoded message - version: ${version}, type: ${type}`);
      }
      
      if (version !== PROTOCOL_VERSION) {
        console.warn(`Protocol version mismatch: ${version} != ${PROTOCOL_VERSION}`);
        return;
      }
      
      switch (type) {
        case MSG_TYPE.REQUEST:
          if (VERBOSE) {
            console.log(`[DEBUG] Calling handleRequest`);
          }
          await this.handleRequest(conn, peerId, payload);
          break;
        case MSG_TYPE.OFFER:
          if (VERBOSE) {
            console.log(`[DEBUG] Calling handleOffer`);
          }
          await this.handleOffer(conn, peerId, payload);
          break;
        case MSG_TYPE.DOWNLOAD:
          if (VERBOSE) {
            console.log(`[DEBUG] Calling handleDownload`);
          }
          await this.handleDownload(conn, peerId, payload);
          break;
        case MSG_TYPE.CHUNK_DATA:
          if (VERBOSE) {
            console.log(`[DEBUG] Calling handleChunkData`);
          }
          await this.handleChunkData(conn, peerId, payload);
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
        case MSG_TYPE.HAVE:
          this.handleHave(conn, peerId, payload);
          break;
        case MSG_TYPE.BITFIELD:
          this.handleBitfield(conn, peerId, payload);
          break;
        case MSG_TYPE.BITFIELD_REQUEST:
          this.handleBitfieldRequest(conn, peerId, payload);
          break;
        case MSG_TYPE.SUBTREE_REQUEST:
          await this.handleSubtreeRequest(conn, peerId, payload);
          break;
        case MSG_TYPE.SUBTREE_DATA:
          await this.handleSubtreeData(conn, peerId, payload);
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

    if (VERBOSE) {
      console.log(`REQUEST from ${peerId.substring(0, 8)}: chunk ${chunkHash.substring(0, 16)}...`);
    }

    const found = await this._findValidChunkSource(chunkHash, 20);
    if (!found) {
      console.log(`   ⚠️  Don't have chunk (or all local candidates invalid/unreadable)`);
      this.sendError(conn, requestId, 'Chunk not found');
      return;
    }

    const { location: chunkLocation, chunkData } = found;
    if (VERBOSE) {
      console.log(`Have chunk (${chunkLocation.chunk_size} bytes)`);
    }

    // Alpha optimization: do not send per-chunk Merkle proofs.
    // Chunk integrity is verified by chunkHash; file integrity is verified by final Merkle root.
    this.sendOffer(conn, requestId, chunkHash, chunkLocation.chunk_size);

    // Alpha optimization: skip the extra DOWNLOAD round-trip.
    // Once the requester sees the OFFER, we immediately stream the chunk.
    // Do not await backpressure here; enqueue to avoid stalling the request handler.
    void this.sendChunkData(conn, requestId, chunkHash, chunkData);
  }


  /**
   * OFFER: Peer can provide chunk
   */
  async handleOffer(conn, peerId, payload) {
    const { requestId, chunkHash, chunkSize } = payload;
    
    if (VERBOSE) {
      console.log(`OFFER from ${peerId.substring(0, 8)}: chunk ${chunkHash.substring(0, 16)}...`);
    }
    
    // Check if we're still waiting for this
    const request = this.activeRequests.get(requestId);
    if (!request) {
      console.log(`Request expired or completed`);
      return;
    }

    if (request.chunkHash !== chunkHash) {
      console.log(`Chunk hash mismatch`);
      return;
    }

    if (VERBOSE) {
      console.log(`Valid offer (${chunkSize} bytes)`);
    }
    
    // Store offer
    request.offers.push({
      peerId,
      conn,
      chunkSize,
      timestamp: Date.now()
    });

    // Alpha optimization: we may receive CHUNK_DATA immediately after OFFER.
    // Create the active download entry now so progress accounting has expectedSize.
    if (!this.activeDownloads.has(requestId)) {
      this.activeDownloads.set(requestId, {
        chunkHash: request.chunkHash,
        peerId,
        expectedSize: chunkSize,
        receivedSize: 0,
        startedAt: Date.now()
      });
    }
    
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
  async handleDownload(conn, peerId, payload) {
    const { requestId, chunkHash } = payload;
    
    if (VERBOSE) {
      console.log(`DOWNLOAD request from ${peerId.substring(0, 8)}: ${chunkHash.substring(0, 16)}...`);
    }
    
    const found = await this._findValidChunkSource(chunkHash, 20);
    if (!found) {
      this.sendError(conn, requestId, 'Chunk not found');
      return;
    }

    const { location: chunkLocation, chunkData } = found;
    if (VERBOSE) {
      console.log(`Sending chunk (${chunkData.length} bytes)`);
    }

    void this.sendChunkData(conn, requestId, chunkHash, chunkData);
  }

  /**
   * CHUNK_DATA: Received chunk data
   */
  async handleChunkData(conn, peerId, payload) {
    const { requestId, chunkHash } = payload;
    const chunkData = Buffer.from(payload.chunkData)

    if (VERBOSE) {
      console.log(`CHUNK_DATA from ${peerId.substring(0, 8)}: ${chunkData.length} bytes`);
    }

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

    const actualHash = await hashBuffer(chunkData)
    if (actualHash !== chunkHash) {
      console.error(`Hash mismatch! Expected ${chunkHash.substring(0, 16)}... got ${actualHash.substring(0, 16)}...`);

      const request = this.activeRequests.get(requestId);
      if (request && request.timeout) {
        clearTimeout(request.timeout);
      }

      this.activeRequests.delete(requestId);
      this.activeDownloads.delete(requestId);

      this.emit('chunk:error', { requestId, chunkHash, error: 'Hash mismatch' });
      return;
    }

    if (VERBOSE) {
      console.log(`Hash verified`);
    }

    const request = this.activeRequests.get(requestId);
    if (request && request.timeout) {
      clearTimeout(request.timeout);
    }

    this.activeRequests.delete(requestId);
    this.activeDownloads.delete(requestId);

    // IMPORTANT: Protocol does not know the caller's intended output file.
    // It only verifies integrity and forwards the chunk bytes to the download session.
    this.emit('chunk:downloaded', {
      requestId,
      chunkHash,
      size: chunkData.length,
      peerId,
      data: chunkData
    });
  }

  async handleSubtreeRequest(conn, peerId, payload) {
    const { requestId, merkleRoot, startChunk, chunkCount, topicKey } = payload || {}
    if (typeof requestId !== 'string' || typeof merkleRoot !== 'string' || !Number.isInteger(startChunk) || !Number.isInteger(chunkCount)) {
      this.sendError(conn, requestId || '00000000000000000000000000000000', 'Invalid subtree request')
      return
    }

    let file = null
    if (typeof topicKey === 'string' && topicKey.length > 0) {
      const topic = this.db.getTopicByKey(topicKey)
      if (topic) {
        const share = this.db.getTopicShareByMerkleRoot(topic.id, merkleRoot)
        if (share && share.share_type === 'file' && typeof share.share_path === 'string') {
          const byPath = this.db.getFile(share.share_path)
          if (byPath && byPath.file_modified_at > 0) {
            file = byPath
          }
        }
      }
    }

    if (!file) {
      const byRoot = this.db.getFileByMerkleRoot(merkleRoot)
      if (byRoot && byRoot.file_modified_at > 0) {
        file = byRoot
      }
    }

    if (!file) {
      this.sendError(conn, requestId, 'File not found')
      return
    }

    const endChunk = Math.min(file.chunk_count - 1, startChunk + chunkCount - 1)
    if (startChunk < 0 || startChunk >= file.chunk_count || endChunk < startChunk) {
      this.sendError(conn, requestId, 'Invalid subtree range')
      return
    }

    const chunks = this.db.getFileChunks(file.id)
    const slice = chunks.slice(startChunk, endChunk + 1)

    // Guard against Hyperswarm/secret-stream atomic write limit.
    // If we try to write a single frame larger than this, the connection is reset.
    const MAX_ATOMIC_WRITE = 16777215
    const SUBTREE_DATA_OVERHEAD = 6 + (1 + 16 + 32 + 4 + 2 + 4)
    let total = 0
    for (const ch of slice) {
      total += ch.chunk_size
    }
    const projected = SUBTREE_DATA_OVERHEAD + total
    if (projected > MAX_ATOMIC_WRITE) {
      this.sendError(conn, requestId, `Subtree too large (${projected} bytes); reduce chunkCount`)
      return
    }

    const fd = fs.openSync(file.path, 'r')
    try {
      const out = Buffer.allocUnsafe(total)
      let off = 0
      for (const ch of slice) {
        const bytesRead = fs.readSync(fd, out, off, ch.chunk_size, ch.chunk_offset)
        off += bytesRead
      }
      const dataBuf = off === out.length ? out : out.subarray(0, off)
      const msg = this.encodeMessage(MSG_TYPE.SUBTREE_DATA, {
        requestId,
        merkleRoot,
        startChunk,
        chunkCount: slice.length,
        data: dataBuf
      })
      void this._enqueueWrite(conn, msg)
    } finally {
      fs.closeSync(fd)
    }
  }

  async handleSubtreeData(conn, peerId, payload) {
    const { requestId, merkleRoot, startChunk, chunkCount } = payload
    const data = Buffer.from(payload.data)

    this.emit('subtree:downloaded', {
      requestId,
      merkleRoot,
      startChunk,
      chunkCount,
      peerId,
      data
    })
  }


  /**
   * CANCEL: Request cancelled
   */
  handleCancel(peerId, payload) {
    const { requestId } = payload;
    console.log(`CANCEL from ${peerId.substring(0, 8)}: ${requestId}`);
    
    this.activeRequests.delete(requestId);
    this.activeDownloads.delete(requestId);
  }

  /**
   * ERROR: Error response
   */
  handleError(peerId, payload) {
    const { requestId, error } = payload;
    console.error(`ERROR from ${peerId.substring(0, 8)}: ${error}`);

    const req = requestId ? this.activeRequests.get(requestId) : null
    if (req && req.chunkHash == null) {
      this.emit('subtree:error', { requestId, error })
      return
    }

    this.emit('chunk:error', { requestId, error });
  }

  /**
   * FILE_LIST_REQUEST: Peer requests list of shared files in topic
   */
  async handleFileListRequest(conn, peerId, payload) {
    const { requestId, topicKey } = payload;

    console.log(`FILE_LIST_REQUEST from ${peerId.substring(0, 8)}...`);

    const topic = this.db.getTopicByKey(topicKey);
    if (!topic) {
      console.log(`Unknown topic key`);
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

    console.log(`FILE_LIST_RESPONSE from ${peerId.substring(0, 8)} (${files.length} files)`);
    this.emit('file:list', { requestId, peerId, files });
  }

  /**
   * METADATA_REQUEST: Peer requests metadata for a file
   */
  async handleMetadataRequest(conn, peerId, payload) {
    const { requestId, merkleRoot, topicKey } = payload;

    console.log(`METADATA_REQUEST from ${peerId.substring(0, 8)}: ${merkleRoot.substring(0, 16)}...`);

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

    console.log(`METADATA_RESPONSE from ${peerId.substring(0, 8)} (${metadata.chunkCount} chunks)`);
    this.emit('metadata:response', { requestId, peerId, metadata });
  }

 /**
  * HAVE: Peer announces they have a chunk
  */
  handleHave(conn, peerId, payload) {
    const { chunkIndex, chunkHash, merkleRoot } = payload;
    
    console.log(`HAVE from ${peerId.substring(0, 8)}: chunk ${chunkIndex}`);
    
    // Emit event for download sessions to handle
    this.emit('peer:have', { peerId, chunkIndex, chunkHash, merkleRoot });
  }
  
  /**
   * BITFIELD: Peer sends their complete bitfield
   */
  handleBitfield(conn, peerId, payload) {
    const { merkleRoot, bitfield, chunkCount } = payload;
    
    console.log(`BITFIELD from ${peerId.substring(0, 8)}: ${chunkCount} chunks`);
    
    // Import BitField
    import('./bitfield.js').then(({ BitField }) => {
      const peerBitfield = BitField.fromBase64(bitfield, chunkCount);
      
      // Emit event for download sessions
      this.emit('peer:bitfield', { peerId, bitfield: peerBitfield, merkleRoot });
    });
  }
  
  /**
   * BITFIELD_REQUEST: Peer requests our bitfield
   */
  handleBitfieldRequest(conn, peerId, payload) {
    const { requestId } = payload;
    
    console.log(`BITFIELD_REQUEST from ${peerId.substring(0, 8)}`);
    
    // For now, we don't have a global bitfield to send
    // This would be implemented when we have active download sessions
    // that track which chunks we have
    
    // Emit event so download sessions can respond
    this.emit('bitfield:request', { conn, peerId, requestId });
  }

  // ============================================================================
  // SEND METHODS
  // ============================================================================

  /**
   * Request a chunk from the network
   */
  requestChunk(topicKey, chunkHash, timeout = 30000) {
    const requestId = crypto.randomBytes(16).toString('hex');
    
    if (VERBOSE) {
      console.log(`\nRequesting chunk: ${chunkHash.substring(0, 16)}...`);
      console.log(`   Request ID: ${requestId.substring(0, 16)}...`);
    }
    
    // Track request
    this.activeRequests.set(requestId, {
      chunkHash,
      topicKey,
      offers: [],
      timestamp: Date.now(),
      timeout: setTimeout(() => {
        console.log(`Request timeout for ${chunkHash.substring(0, 16)}...`);
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
    if (VERBOSE) {
      console.log(`Broadcast to ${sent} peer(s)`);
    }
    
    return requestId;
  }

  requestChunkToPeer(topicKey, peerId, chunkHash, timeout = 30000) {
    const requestId = crypto.randomBytes(16).toString('hex');

    if (VERBOSE) {
      console.log(`\nRequesting chunk (unicast): ${chunkHash.substring(0, 16)}...`);
      console.log(`   Request ID: ${requestId.substring(0, 16)}... peer=${peerId.substring(0, 8)}`);
    }

    this.activeRequests.set(requestId, {
      chunkHash,
      topicKey,
      offers: [],
      timestamp: Date.now(),
      timeout: setTimeout(() => {
        if (VERBOSE) {
          console.log(`Request timeout for ${chunkHash.substring(0, 16)}...`);
        }
        this.activeRequests.delete(requestId);
        this.emit('chunk:timeout', { requestId, chunkHash });
      }, timeout)
    });

    const topicKeyHex = topicKey.toString('hex');
    const topic = this.network?.topics?.get(topicKeyHex);
    const conn = topic?.connections?.get(peerId);
    if (!conn) {
      const req = this.activeRequests.get(requestId);
      if (req?.timeout) {
        clearTimeout(req.timeout);
      }
      this.activeRequests.delete(requestId);
      throw new Error(`Peer not connected in topic: ${peerId.substring(0, 8)}`);
    }

    const message = this.encodeMessage(MSG_TYPE.REQUEST, {
      requestId,
      chunkHash
    });

    void this._enqueueWrite(conn, message);
    return requestId;
  }

  requestSubtreeToPeer(topicKey, peerId, merkleRoot, startChunk, chunkCount, timeout = 30000) {
    const requestId = crypto.randomBytes(16).toString('hex');

    this.activeRequests.set(requestId, {
      chunkHash: null,
      topicKey,
      offers: [],
      timestamp: Date.now(),
      timeout: setTimeout(() => {
        this.activeRequests.delete(requestId);
        this.emit('subtree:timeout', { requestId, merkleRoot, startChunk, chunkCount });
      }, timeout)
    });

    const topicKeyHex = topicKey.toString('hex');
    const topic = this.network?.topics?.get(topicKeyHex);
    const conn = topic?.connections?.get(peerId);
    if (!conn) {
      const req = this.activeRequests.get(requestId);
      if (req?.timeout) {
        clearTimeout(req.timeout);
      }
      this.activeRequests.delete(requestId);
      throw new Error(`Peer not connected in topic: ${peerId.substring(0, 8)}`);
    }

    const message = this.encodeMessage(MSG_TYPE.SUBTREE_REQUEST, {
      requestId,
      merkleRoot,
      startChunk,
      chunkCount,
      topicKey: topicKey.toString('hex')
    });

    void this._enqueueWrite(conn, message);
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
  sendOffer(conn, requestId, chunkHash, chunkSize) {
    const message = this.encodeMessage(MSG_TYPE.OFFER, {
      requestId,
      chunkHash,
      chunkSize
    });

    void this._enqueueWrite(conn, message);
    if (VERBOSE) {
      console.log(`Sent OFFER`);
    }
  }

  sendFileListResponse(conn, requestId, topicKey, files) {
    const message = this.encodeMessage(MSG_TYPE.FILE_LIST_RESPONSE, {
      requestId,
      topicKey,
      files
    });

    void this._enqueueWrite(conn, message);
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
    
    if (VERBOSE) {
      console.log(`\nAccepting offer from ${peerId.substring(0, 8)}...`);
    }
    
    // Send DOWNLOAD message
    const message = this.encodeMessage(MSG_TYPE.DOWNLOAD, {
      requestId,
      chunkHash: request.chunkHash
    });
    
    void this._enqueueWrite(offer.conn, message);
    
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
  async sendChunkData(conn, requestId, chunkHash, chunkData) {
    const message = this.encodeMessage(MSG_TYPE.CHUNK_DATA, {
      requestId,
      chunkHash,
      chunkData
    });

    await this._enqueueWrite(conn, message);
  }

  sendMetadataResponse(conn, requestId, metadata) {
    const message = this.encodeMessage(MSG_TYPE.METADATA_RESPONSE, {
      requestId,
      metadata
    });

    void this._enqueueWrite(conn, message);
  }

  /**
   * Send error
   */
  sendError(conn, requestId, error) {
    const message = this.encodeMessage(MSG_TYPE.ERROR, {
      requestId,
      error
    });

    void this._enqueueWrite(conn, message);
  }

  /**
   * Cancel a request
   */
  cancelRequest(requestId) {
    const request = this.activeRequests.get(requestId);
    if (!request) {
      return;
    }
    
    console.log(`Cancelling request: ${requestId.substring(0, 16)}...`);
    
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
        console.log(`Cleaning up old request: ${requestId.substring(0, 16)}...`);
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
  async generateMerkleProof(chunkHash, preferredFileId = null) {
    if (VERBOSE) {
      console.log(`[DEBUG] generateMerkleProof called for ${chunkHash.substring(0, 16)}...`);
    }

    let file = null;
    if (preferredFileId) {
      file = this.db.getFileById(preferredFileId);
    }

    if (!file) {
      const locs = typeof this.db.getChunkLocations === 'function' ? this.db.getChunkLocations(chunkHash, 20) : [];
      if (locs.length > 0) {
        file = this.db.getFileById(locs[0].file_id);
      }
    }

    if (!file) {
      const files = this.db.getFilesWithChunk(chunkHash);
      if (VERBOSE) {
        console.log(`[DEBUG] Found ${files.length} files with this chunk`);
      }
      file = files[0] || null;
    }

    if (!file) {
      if (VERBOSE) {
        console.log(`[DEBUG] No files found, returning empty proof`);
      }
      return [];
    }

    if (VERBOSE) {
      console.log(`[DEBUG] Using file: ${file.path}`);
    }
    
    // Get all chunks for this file
    const fileChunks = this.db.getFileChunks(file.id);
    if (VERBOSE) {
      console.log(`[DEBUG] File has ${fileChunks.length} chunks`);
    }
    
    // Find the index of our chunk
    const chunkIndex = fileChunks.findIndex(fc => fc.chunk_hash === chunkHash);
    if (VERBOSE) {
      console.log(`[DEBUG] Chunk index: ${chunkIndex}`);
    }
    
    if (chunkIndex === -1) {
      if (VERBOSE) {
        console.log(`[DEBUG] Chunk not found in file chunks, returning empty proof`);
      }
      return [];
    }
    
    // Get all chunk hashes in order
    const chunkHashes = fileChunks.map(fc => fc.chunk_hash);
    
    // Import merkle module
    if (VERBOSE) {
      console.log(`[DEBUG] Importing merkle module...`);
    }
    const { generateMerkleProof } = await import('./merkle.js');
    if (VERBOSE) {
      console.log(`[DEBUG] Merkle module imported`);
    }
    
    try {
      const proof = await generateMerkleProof(chunkHashes, chunkIndex)
      const siblings = Array.isArray(proof?.proof) ? proof.proof : []
      if (VERBOSE) {
        console.log(`[DEBUG] Merkle proof generated, siblings: ${siblings.length}`);
      }
      
      // Return simplified proof for network transmission
      const simplifiedProof = {
        fileRoot: file.merkle_root,
        chunkIndex: chunkIndex,
        siblings: siblings.map(p => ({
          hash: p.hash,
          isLeft: p.isLeft
        }))
      };
      
      if (VERBOSE) {
        console.log(`[DEBUG] Returning simplified proof`);
      }
      return simplifiedProof;
    } catch (error) {
      if (VERBOSE) {
        console.error('[DEBUG] Error generating merkle proof:', error.message);
        console.error('[DEBUG] Stack:', error.stack);
      }
      return null;
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
      const isValid = await verifyMerkleProof(
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
