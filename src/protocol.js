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
import { buildMerkleTree, generateSubtreeProofFromTree } from './merkle.js'
import Protomux from 'protomux'
import c from 'compact-encoding'
import { PROTOCOL_VERSION, MSG_TYPE, encodeMessage, decodeMessage } from './protocol/message-codec.js'
import { MerkleTreeCache } from './protocol/merkle-cache.js'
import { RequestTracker } from './protocol/request-tracker.js'
import { SubtreeServer } from './protocol/subtree-server.js'
import { debug } from './logger.js'

const VERBOSE = process.env.SWARMFS_VERBOSE === '1' || process.env.SWARMFS_VERBOSE === 'true'

// Re-export for backward compatibility
export { PROTOCOL_VERSION, MSG_TYPE } from './protocol/message-codec.js'
export { MerkleTreeCache } from './protocol/merkle-cache.js'
export { RequestTracker } from './protocol/request-tracker.js'
export { SubtreeServer } from './protocol/subtree-server.js'

export class Protocol extends EventEmitter {
  constructor(network, database) {
    super();
    
    debug('[PROTOCOL] Initializing Protocol...');
    debug('[PROTOCOL] Network:', network ? 'OK' : 'MISSING');
    debug('[PROTOCOL] Storage: REMOVED (direct file I/O)');
    debug('[PROTOCOL] Database:', database ? 'OK' : 'MISSING');
    
    this.network = network;
    this.db = database;
    
    // Request tracking (encapsulated)
    this._requestTracker = new RequestTracker();
    
    // Expose for backward compatibility (delegates to tracker)
    Object.defineProperty(this, 'activeRequests', {
      get: () => this._requestTracker.activeRequests
    });
    Object.defineProperty(this, 'activeDownloads', {
      get: () => this._requestTracker.activeDownloads
    });
    Object.defineProperty(this, 'activeFileListRequests', {
      get: () => this._requestTracker.activeFileListRequests
    });
    Object.defineProperty(this, 'activeMetadataRequests', {
      get: () => this._requestTracker.activeMetadataRequests
    });

    // Cache merkle trees for serving subtree proofs with LRU eviction.
    // Limit to 10 trees to bound memory usage (~10-15MB max for large files)
    this._merkleTreeCache = new MerkleTreeCache(10);

    // Subtree server with backpressure
    this._subtreeServer = new SubtreeServer(this.db, this._merkleTreeCache);

    // Protomux integration
    this._muxByConn = new WeakMap(); // conn -> mux
    this._controlMsgByConn = new WeakMap(); // conn -> protomux message (binary) that carries our framed protocol buffers
    this._subtreeBeginByConn = new WeakMap();
    this._subtreePartByConn = new WeakMap();
    this._subtreeRx = new Map(); // requestId(hex) -> { merkleRoot, startChunk, chunkCount, totalBytes, receivedBytes, parts: Buffer[], peerId }
    this._muxOpenByConn = new WeakMap(); // conn -> boolean
    this._muxReadyByConn = new WeakMap(); // conn -> boolean (safe to send via mux)
    
    // Backpressure state per connection (to avoid listener accumulation)
    this._backpressureByConn = new WeakMap(); // conn -> { pendingBytes, drainCallback }
    
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
      // New SwarmNetwork emits a single object: { conn, peerId, topicKey }
      if (peerId && typeof peerId === 'object' && peerId.peerId) {
        const { peerId: p, topicKey: t } = peerId;
        debug('[PROTOCOL] peer:disconnected (object payload)', p?.substring?.(0, 8));
        this.onPeerDisconnected(p, t);
        return;
      }

      debug('[PROTOCOL] peer:disconnected (positional payload)', peerId?.substring?.(0, 8));
      this.onPeerDisconnected(peerId, topicKey);
    });
    
    debug('[PROTOCOL] Protocol initialized successfully');
    
    // Cleanup old requests periodically
    this.cleanupInterval = setInterval(() => this.cleanup(), 30000);
  }

  _enqueueWrite(conn, data) {
    const control = this._controlMsgByConn.get(conn)
    const muxReady = this._muxReadyByConn.get(conn)
    
    console.log(`[MUX] _enqueueWrite: control=${!!control} muxReady=${muxReady} dataLen=${data.length}`)
    
    // Protomux required - use control channel
    if (!control) {
      console.error(`[MUX] No control channel - cannot send`)
      return Promise.reject(new Error('Protomux channel not set up'))
    }
    
    if (muxReady) {
      // Channel is ready - send immediately
      try {
        control.send(data)
        console.log(`[MUX] Sent ${data.length} bytes`)
        return Promise.resolve()
      } catch (err) {
        console.error('Protomux send error:', err)
        return Promise.reject(err)
      }
    }
    
    // Channel is opening - queue the message
    console.log(`[MUX] Channel not ready - queuing message`)
    return new Promise((resolve, reject) => {
      const queue = this._muxSendQueue?.get(conn) || []
      queue.push({ data, resolve, reject })
      if (!this._muxSendQueue) this._muxSendQueue = new Map()
      this._muxSendQueue.set(conn, queue)
    })
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

  async _readChunkBytes(chunkLocation) {
    let chunkData = Buffer.allocUnsafe(chunkLocation.chunk_size);
    const fh = await fs.promises.open(chunkLocation.path, 'r')
    try {
      const { bytesRead } = await fh.read(
        chunkData,
        0,
        chunkLocation.chunk_size,
        chunkLocation.chunk_offset
      )
      if (bytesRead !== chunkLocation.chunk_size) {
        chunkData = chunkData.subarray(0, bytesRead)
      }
    } finally {
      try {
        await fh.close()
      } catch {
        // Ignore close errors
      }
    }
    return chunkData
  }
  
  onPeerConnected(conn, peerId, topicKey) {
    console.log(`Peer connected: ${peerId.substring(0, 8)}`);

    // Setup Protomux for streaming (required for all peers)
    this._setupMux(conn, peerId);

    // Emit event
    this.emit('peer:connected', { conn, peerId, topicKey });
  }

  _setupMux(conn, peerId) {
    if (this._controlMsgByConn.get(conn)) {
      console.log(`[MUX] Channel already exists for ${peerId.substring(0, 8)}`)
      return
    }

    console.log(`[MUX] Setting up channel for ${peerId.substring(0, 8)}`)

    try {
      const mux = Protomux.from(conn)
      this._muxByConn.set(conn, mux)

      // Initialize backpressure state for this connection
      this._backpressureByConn.set(conn, { pendingBytes: 0, drainCallback: null })

      // Set up drain listener ONCE per connection (not per subtree request)
      const stream = mux.stream
      if (stream && typeof stream.on === 'function') {
        stream.on('drain', () => {
          const bp = this._backpressureByConn.get(conn)
          if (bp) {
            bp.pendingBytes = 0
            if (bp.drainCallback) {
              bp.drainCallback()
              bp.drainCallback = null
            }
          }
        })
      }

      // Mark as not open yet. We only switch send/receive routing once onopen fires.
      this._muxOpenByConn.set(conn, false)
      this._muxReadyByConn.set(conn, false)

      // Create channel first (messages added before open)
      const channel = mux.createChannel({
        protocol: 'swarmfs',
        id: Buffer.from([1]),
        onopen: () => {
          console.log(`[MUX] Channel OPEN for ${peerId.substring(0, 8)}`)
          this._muxOpenByConn.set(conn, true)
          // Protomux is required - channel open means ready
          this._muxReadyByConn.set(conn, true)
          // Drain any queued messages
          const queue = this._muxSendQueue?.get(conn) || []
          this._muxSendQueue?.delete(conn)
          console.log(`[MUX] Draining ${queue.length} queued messages`)
          for (const { data, resolve, reject } of queue) {
            try {
              control.send(data)
              resolve()
            } catch (err) {
              console.error(`[MUX] Failed to drain message:`, err)
              reject(err)
            }
          }
        },
        onclose: () => {
          console.log(`[MUX] Channel CLOSED for ${peerId.substring(0, 8)}`)
          this._muxOpenByConn.delete(conn)
          this._controlMsgByConn.delete(conn)
          this._subtreeBeginByConn.delete(conn)
          this._subtreePartByConn.delete(conn)
          this._muxReadyByConn.delete(conn)
          this._backpressureByConn.delete(conn)
        }
      })

      if (!channel) {
        console.error(`[MUX] Failed to create channel for ${peerId.substring(0, 8)}`)
        return
      }

    const control = channel.addMessage({
      encoding: c.binary,
      onmessage: async (buf) => {
        console.log(`[MUX] Received control message: ${buf.length} bytes from ${peerId.substring(0, 8)}`)
        try {
          await this.handleMessage(conn, peerId, buf)
        } catch (err) {
          console.error(`[MUX] Error handling message:`, err)
        }
      }
    })

    const subtreeBegin = channel.addMessage({
      encoding: c.string,
      onmessage: async (json) => {
        console.log(`[MUX] Received BEGIN message from ${peerId.substring(0, 8)}`)
        try {
          const msg = JSON.parse(json)
          const { requestId, merkleRoot, startChunk, chunkCount, totalBytes } = msg || {}
          if (typeof requestId !== 'string' || typeof merkleRoot !== 'string' || !Number.isInteger(startChunk) || !Number.isInteger(chunkCount) || !Number.isInteger(totalBytes)) {
            return
          }
          this._subtreeRx.set(requestId, {
            merkleRoot,
            startChunk,
            chunkCount,
            totalBytes,
            receivedBytes: 0,
            nextChunkIndex: startChunk,  // Track which chunk we're receiving
            chunkOffset: 0,              // Offset within current chunk
            peerId,
            createdAt: Date.now()
          })
          
          // Emit begin event so download session can prepare
          this.emit('subtree:begin', {
            requestId,
            merkleRoot,
            startChunk,
            chunkCount,
            totalBytes,
            peerId
          })
          
          // Note: No timeout here - download session handles timeouts via onSubtreeTimeout
          // which properly resets chunk states. Premature cleanup here would drop parts.
        } catch {
          // ignore
        }
      }
    })

    const subtreePart = channel.addMessage({
      encoding: c.binary,
      onmessage: async (buf) => {
        console.log(`[MUX] Received PART message: ${buf?.length || 0} bytes from ${peerId.substring(0, 8)}`)
        // part format: [16 bytes requestId][payload]
        if (!Buffer.isBuffer(buf) || buf.length < 16) {
          return
        }
        const requestId = buf.subarray(0, 16).toString('hex')
        const payload = buf.subarray(16)
        const rx = this._subtreeRx.get(requestId)
        if (!rx) {
          return
        }
        
        // Stream directly: emit each part with its offset
        // Download session will write to disk immediately
        const offset = rx.receivedBytes
        rx.receivedBytes += payload.length
        
        this.emit('subtree:part', {
          requestId,
          merkleRoot: rx.merkleRoot,
          startChunk: rx.startChunk,
          offset,  // Byte offset within the subtree
          data: payload,
          peerId: rx.peerId,
          isLast: rx.receivedBytes >= rx.totalBytes
        })
        
        if (rx.receivedBytes >= rx.totalBytes) {
          this._subtreeRx.delete(requestId)
          // Emit complete event
          this.emit('subtree:complete', {
            requestId,
            merkleRoot: rx.merkleRoot,
            startChunk: rx.startChunk,
            chunkCount: rx.chunkCount,
            peerId: rx.peerId
          })
        }
      }
    })

      this._controlMsgByConn.set(conn, control)
      this._subtreeBeginByConn.set(conn, subtreeBegin)
      this._subtreePartByConn.set(conn, subtreePart)

      channel.open()
    } catch {
      // If mux setup fails, keep using the legacy framing on this connection.
      return
    }
  }

  onPeerDisconnected(peerId, topicKey) {
    console.log(`Peer disconnected: ${peerId.substring(0, 8)}`);
    
    // Notify download sessions
    this.emit('peer:disconnected', { peerId, topicKey });
  }
  
  /**
   * Request bitfield from peer (learn what chunks they have)
   */
  requestBitfield(conn, peerId, merkleRoot = null) {
    const message = encodeMessage(MSG_TYPE.BITFIELD_REQUEST, {
      requestId: crypto.randomBytes(16).toString('hex'),
      merkleRoot
    });

    void this._enqueueWrite(conn, message);
  }
  
  /**
   * Send our bitfield to peer
   */
  sendBitfield(conn, session) {
    const bitfield = session.ourBitfield;
    
    const message = encodeMessage(MSG_TYPE.BITFIELD, {
      merkleRoot: session.merkleRoot,
      bitfield: bitfield.buffer
    });

    void this._enqueueWrite(conn, message);
  }

  /**
   * Handle incoming message
   */
  async handleMessage(conn, peerId, data) {
    try {
      // Debug: Log that we received data
      debug(`[DEBUG] handleMessage called, data length: ${data.length}`);
      
      const { version, type, payload } = decodeMessage(data);

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
        case MSG_TYPE.SUBTREE_PROOF:
          this.handleSubtreeProof(conn, peerId, payload);
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
    const context = {
      mux: this._muxByConn.get(conn),
      beginMsg: this._subtreeBeginByConn.get(conn),
      partMsg: this._subtreePartByConn.get(conn),
      backpressureState: this._backpressureByConn.get(conn),
      stream: this._muxByConn.get(conn)?.stream,
      enqueueWrite: (c, data) => this._enqueueWrite(c, data),
      sendError: (c, requestId, error) => this.sendError(c, requestId, error)
    }
    console.log(`[SUBTREE] handleSubtreeRequest: beginMsg=${!!context.beginMsg} partMsg=${!!context.partMsg} mux=${!!context.mux}`)
    await this._subtreeServer.handleRequest(conn, peerId, payload, context)
  }

  handleSubtreeProof(conn, peerId, payload) {
    const { requestId, merkleRoot, startChunk, chunkCount, level, index, node, proof } = payload || {}
    this.emit('subtree:proof', {
      requestId,
      merkleRoot,
      startChunk,
      chunkCount,
      level,
      index,
      node,
      proof,
      peerId
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
    
    // Cancel in-progress subtree serving
    this._subtreeServer.cancel(requestId);
  }

  /**
   * ERROR: Error response
   */
  handleError(peerId, payload) {
    const { requestId, message } = payload;
    console.error(`ERROR from ${peerId.substring(0, 8)}: ${message}`);

    const req = requestId ? this.activeRequests.get(requestId) : null
    if (req && req.chunkHash == null) {
      this.emit('subtree:error', { requestId, error: message })
      return
    }

    this.emit('chunk:error', { requestId, error: message });
  }

  /**
   * FILE_LIST_REQUEST: Peer requests list of shared files and vdirs in topic
   */
  async handleFileListRequest(conn, peerId, payload) {
    const { requestId, topicKey } = payload;

    console.log(`FILE_LIST_REQUEST from ${peerId.substring(0, 8)}...`);

    // topicKey is a buffer from compact-encoding, convert to hex for DB lookup
    const topicKeyHex = topicKey ? topicKey.toString('hex') : null;
    const topic = this.db.getTopicByKey(topicKeyHex);
    if (!topic) {
      console.log(`Unknown topic key`);
      return;
    }

    const shares = this.db.getTopicShares(topic.id);
    const items = [];

    for (const share of shares) {
      if (share.share_type === 'file') {
        const file = this.db.getFile(share.share_path);
        if (file && file.file_modified_at > 0) {
          items.push({
            name: path.basename(share.share_path),
            path: share.share_path,
            merkleRoot: share.merkle_root,
            type: 'file',
            size: file.size,
            chunkCount: file.chunk_count
          });
        }
      } else if (share.share_type === 'vdir') {
        const vdir = this.db.getVdirById(share.share_path);
        if (vdir && vdir.merkle_root) {
          const children = this.db.getVdirChildren(vdir.id);
          items.push({
            name: vdir.name,
            path: share.share_path,
            merkleRoot: vdir.merkle_root,
            type: 'vdir',
            childCount: children.length
          });
        }
      } else if (share.share_type === 'directory') {
        const dir = this.db.getDirectory(share.share_path);
        if (dir && dir.merkle_root) {
          items.push({
            name: path.basename(share.share_path),
            path: share.share_path,
            merkleRoot: share.merkle_root,
            type: 'directory',
            size: dir.size
          });
        }
      }
    }

    this.sendFileListResponse(conn, requestId, topicKey, items);
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
   * METADATA_REQUEST: Peer requests metadata for a file or vdir
   */
  async handleMetadataRequest(conn, peerId, payload) {
    const { requestId, merkleRoot, topicKey } = payload;

    console.log(`METADATA_REQUEST from ${peerId.substring(0, 8)}: ${merkleRoot.substring(0, 16)}...`);

    // topicKey is a buffer from compact-encoding, convert to hex for DB lookup
    const topicKeyHex = topicKey ? topicKey.toString('hex') : null;
    const topic = this.db.getTopicByKey(topicKeyHex);
    if (!topic) {
      this.sendError(conn, requestId, 'Unknown topic');
      return;
    }

    // First, check if this is a vdir
    const vdir = this.db.getVdirByMerkleRoot(merkleRoot);
    if (vdir) {
      // Return vdir metadata
      const children = this.db.getVdirChildren(vdir.id);
      const metadata = {
        merkleRoot,
        type: 'vdir',
        suggestedName: vdir.name,
        children
      };
      this.sendMetadataResponse(conn, requestId, metadata);
      return;
    }

    // Fall back to file handling
    const share = this.db.getTopicShareByMerkleRoot(topic.id, merkleRoot);
    if (!share) {
      this.sendError(conn, requestId, 'Content not found in topic');
      return;
    }

    const file = this.db.getFile(share.share_path);
    if (!file || file.file_modified_at <= 0) {
      this.sendError(conn, requestId, 'File metadata unavailable');
      return;
    }

    const chunkList = this.db.getFileChunks(file.id);
    const metadata = {
      merkleRoot,
      type: 'file',
      suggestedName: path.basename(share.share_path),
      size: file.size,
      chunkCount: file.chunk_count,
      chunkSize: file.chunk_size,
      chunkHashes: chunkList.map((chunk) => chunk.chunk_hash)
    };

    this.sendMetadataResponse(conn, requestId, metadata);
  }

  handleMetadataResponse(conn, peerId, payload) {
    // Codec returns: requestId, merkleRoot, type, suggestedName, ...
    // For files: size, chunkCount, chunkSize, chunkHashes[]
    const { requestId, merkleRoot, type, suggestedName, children, size, chunkCount, chunkSize, chunkHashes } = payload;

    const request = this.activeMetadataRequests.get(requestId);
    if (!request) {
      return;
    }

    if (merkleRoot !== request.merkleRoot) {
      return;
    }

    if (request.timeout) {
      clearTimeout(request.timeout);
    }
    this.activeMetadataRequests.delete(requestId);

    // Build metadata object for event (matches DownloadSession constructor expectations)
    const metadata = { merkleRoot, type, suggestedName };
    if (type === 'vdir') {
      metadata.children = children;
    } else {
      metadata.size = size;
      metadata.chunkCount = chunkCount;
      metadata.chunkSize = chunkSize;
      // Build chunks array with computed offsets/sizes from chunkHashes
      // (offset/size can be derived from index * chunkSize, hash is authoritative)
      metadata.chunks = (chunkHashes || []).map((hash, i) => {
        const offset = i * chunkSize;
        const chunkBytes = Math.min(chunkSize, Math.max(0, size - offset));
        return { hash, offset, size: chunkBytes };
      });
    }

    // Handle both file and vdir responses
    if (type === 'vdir') {
      console.log(`METADATA_RESPONSE from ${peerId.substring(0, 8)} (vdir: ${children?.length || 0} children)`);
      this.emit('vdir:metadata', { requestId, peerId, metadata });
    } else {
      console.log(`METADATA_RESPONSE from ${peerId.substring(0, 8)} (${chunkCount} chunks)`);
      this.emit('metadata:response', { requestId, peerId, metadata });
    }
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
    const { merkleRoot, bitfield } = payload;
    
    console.log(`BITFIELD from ${peerId.substring(0, 8)}: ${bitfield.length * 8} chunks`);
    
    // Import BitField
    import('./bitfield.js').then(({ BitField }) => {
      const peerBitfield = BitField.fromBuffer(bitfield);
      
      // Emit event for download sessions
      this.emit('peer:bitfield', { peerId, bitfield: peerBitfield, merkleRoot });
    });
  }
  
  /**
   * BITFIELD_REQUEST: Peer requests our bitfield
   */
  // INVARIANT: Content-addressed - find ANY file with matching merkle root that exists on disk
// Sharing status is irrelevant, only merkle root + disk access matters
async handleBitfieldRequest(conn, peerId, payload) {
    const { requestId, merkleRoot } = payload;
    
    console.log(`BITFIELD_REQUEST from ${peerId.substring(0, 8)} merkleRoot=${merkleRoot?.substring(0, 8)}`);
    
    // If we have the file, respond with a full bitfield (all chunks available)
    if (merkleRoot) {
      // Find any available file with this merkle root (content-addressed)
      const candidates = this.db.getFilesByMerkleRoot(merkleRoot);
      let file = null;
      for (const candidate of candidates || []) {
        try {
          fs.accessSync(candidate.path, fs.constants.R_OK);
          file = candidate;
          break;
        } catch {
          // File not accessible, try next
        }
      }
      
      if (file && file.chunk_count > 0) {
        // Create a bitfield with all chunks set (we have the complete file)
        const { BitField } = await import('./bitfield.js');
        const bitfield = new BitField(file.chunk_count);
        for (let i = 0; i < file.chunk_count; i++) {
          bitfield.set(i);
        }
        
        const message = encodeMessage(MSG_TYPE.BITFIELD, {
          merkleRoot,
          bitfield: bitfield.buffer
        });
        
        void this._enqueueWrite(conn, message);
        console.log(`BITFIELD sent to ${peerId.substring(0, 8)}: ${file.chunk_count} chunks from ${file.path}`);
        return;
      }
    }
    
    // Emit event so download sessions can respond (for partial bitfields)
    this.emit('bitfield:request', { conn, peerId, requestId, merkleRoot });
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
    const message = encodeMessage(MSG_TYPE.REQUEST, {
      requestId,
      chunkHash
    });
    
    const sent = this.network.broadcast(topicKey, message, (conn, data) => this._enqueueWrite(conn, data));
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

    const message = encodeMessage(MSG_TYPE.REQUEST, {
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

    const message = encodeMessage(MSG_TYPE.SUBTREE_REQUEST, {
      requestId,
      merkleRoot,
      startChunk,
      chunkCount,
      topicKey
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

    const message = encodeMessage(MSG_TYPE.FILE_LIST_REQUEST, {
      requestId,
      topicKey
    });

    this.network.broadcast(topicKey, message, (conn, data) => this._enqueueWrite(conn, data));
    return requestId;
  }

  /**
   * Send OFFER
   */
  sendOffer(conn, requestId, chunkHash, chunkSize) {
    const message = encodeMessage(MSG_TYPE.OFFER, {
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
    const message = encodeMessage(MSG_TYPE.FILE_LIST_RESPONSE, {
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

    const message = encodeMessage(MSG_TYPE.METADATA_REQUEST, {
      requestId,
      merkleRoot,
      topicKey // Pass as Buffer, not hex string
    });

    this.network.broadcast(topicKey, message, (conn, data) => this._enqueueWrite(conn, data));
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
    const message = encodeMessage(MSG_TYPE.DOWNLOAD, {
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
    const message = encodeMessage(MSG_TYPE.CHUNK_DATA, {
      requestId,
      chunkHash,
      chunkData
    });

    await this._enqueueWrite(conn, message);
  }

  sendMetadataResponse(conn, requestId, metadata) {
    const message = encodeMessage(MSG_TYPE.METADATA_RESPONSE, {
      requestId,
      ...metadata
    });

    void this._enqueueWrite(conn, message);
  }

  /**
   * Send error
   */
  sendError(conn, requestId, error) {
    const message = encodeMessage(MSG_TYPE.ERROR, {
      requestId,
      message: error
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
    const message = encodeMessage(MSG_TYPE.CANCEL, { requestId });
    this.network.broadcast(request.topicKey, message, (conn, data) => this._enqueueWrite(conn, data));
    
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

    // CRITICAL: Cleanup stale subtree reassembly buffers to prevent memory leaks
    // Use longer timeout (5 min) to avoid interfering with active downloads
    // Download session handles its own timeouts (30s) and properly resets chunk states
    const subtreeMaxAge = 5 * 60 * 1000; // 5 minutes
    let subtreeCleanupCount = 0;
    for (const [requestId, rx] of this._subtreeRx) {
      if (now - (rx.createdAt || rx.timestamp || 0) > subtreeMaxAge) {
        console.warn(`🧹 Cleaning up stale subtree ${requestId.substring(0, 8)} (${rx.receivedBytes}/${rx.totalBytes} bytes)`);
        this._subtreeRx.delete(requestId);
        subtreeCleanupCount++;
      }
    }
    
    if (subtreeCleanupCount > 0) {
      console.log(`🧹 Cleaned up ${subtreeCleanupCount} stale subtree buffers`);
    }
  }

  /**
   * Get stats including memory usage
   */
  getStats() {
    const mem = process.memoryUsage()
    return {
      activeRequests: this.activeRequests.size,
      activeDownloads: this.activeDownloads.size,
      subtreeRxBuffers: this._subtreeRx.size,
      merkleTreeCache: this._merkleTreeCache.size,
      subtreeServeQueue: this._subtreeServer.getStats().queueLength,
      memory: {
        heapUsed: this._formatBytes(mem.heapUsed),
        heapTotal: this._formatBytes(mem.heapTotal),
        external: this._formatBytes(mem.external),
        rss: this._formatBytes(mem.rss)
      }
    };
  }

  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
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
