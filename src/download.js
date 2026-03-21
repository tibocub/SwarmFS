/**
 * DownloadSession - Manages parallel download of a single file
 */

import { EventEmitter } from 'events'
import fs from 'fs'
import blake3 from 'blake3-bao/blake3'
import { BitField } from './bitfield.js'
import { PeerManager } from './peer-manager.js'
import { ChunkScheduler } from './chunk-scheduler.js'
import { ChunkState, ChunkMeta } from './download/chunk-state.js'
import { SessionState } from './download/session-state.js'
import { DiskWriter } from './download/disk-writer.js'
import { getMerkleRoot, verifySubtreeProof } from './merkle.js'
import { hashBuffer } from './hash.js'
import { initLogger, getLogger } from './logger.js'

// Re-export for backward compatibility
export { ChunkState, ChunkMeta } from './download/chunk-state.js'
export { SessionState } from './download/session-state.js'
export { DiskWriter } from './download/disk-writer.js'

export class DownloadSession extends EventEmitter {
  constructor(topicKey, merkleRoot, outputPath, metadata, protocol, db) {
    super();
    
    this.topicKey = topicKey;
    this.merkleRoot = merkleRoot;
    this.outputPath = outputPath;
    this.metadata = metadata;
    this.protocol = protocol;
    this.db = db;
    
    this.totalChunks = metadata.chunkCount;
    this.chunkSize = metadata.chunkSize;
    this.fileSize = metadata.size;
    this.chunkHashes = metadata.chunks.map(c => c.hash);
    
    this.chunkStates = new Map();
    for (let i = 0; i < this.totalChunks; i++) {
      const chunkInfo = metadata.chunks[i];

      // Compute offset/size locally to avoid corruption if metadata offsets/sizes
      // are wrong/stale. The chunk hash is still authoritative.
      const offset = i * this.chunkSize;
      const size = Math.min(this.chunkSize, Math.max(0, this.fileSize - offset));

      this.chunkStates.set(i, new ChunkMeta(
        i,
        chunkInfo.hash,
        offset,
        size
      ));
    }
    
    this.ourBitfield = new BitField(this.totalChunks);
    
    this.peerManager = new PeerManager(this);
    this.scheduler = new ChunkScheduler(this);
    
    // Session state management (encapsulated)
    this._sessionState = new SessionState(this.totalChunks, this.fileSize);
    
    // Expose for backward compatibility (delegates to state)
    Object.defineProperty(this, 'chunksVerified', {
      get: () => this._sessionState.chunksVerified,
      set: (v) => { this._sessionState.chunksVerified = v }
    });
    Object.defineProperty(this, 'chunksInFlight', {
      get: () => this._sessionState.chunksInFlight,
      set: (v) => { this._sessionState.chunksInFlight = v }
    });
    Object.defineProperty(this, 'bytesDownloaded', {
      get: () => this._sessionState.bytesDownloaded,
      set: (v) => { this._sessionState.bytesDownloaded = v }
    });
    Object.defineProperty(this, 'maxConcurrentRequests', {
      get: () => this._sessionState.maxConcurrentRequests,
      set: (v) => { this._sessionState.maxConcurrentRequests = v }
    });
    
    // Disk writer (encapsulated)
    this._diskWriter = new DiskWriter(this.outputPath, this.fileSize, this.chunkSize, this.totalChunks);
    
    // Initialize logger for this download session
    const logDir = '/tmp/swarmfs-logs'
    const logFile = `${merkleRoot.substring(0, 8)}-${Date.now()}.log`
    this.logger = initLogger(`${logDir}/${logFile}`)
    this.requestTimeout = 30000;
    
    this.running = false;
    this.loopCount = 0;
    
    this.fileId = null;
    
    // Track if we need to update maxConcurrentRequests
    this._lastPeerCount = 0;

    this._protocolHandlers = null;

    // Prefer large subtree batches for throughput on good links.
    // When Protomux streaming is enabled, the subtree payload can exceed the 16MiB atomic write limit.
    // Keep a safe fallback for legacy peers by not exceeding what a single SUBTREE_DATA frame can carry.
    const TARGET_SUBTREE_BYTES = 64 * 1024 * 1024;

    const maxChunksByTarget = Math.max(1, Math.floor(TARGET_SUBTREE_BYTES / Math.max(1, this.chunkSize)));

    const MAX_ATOMIC_WRITE = 16777215;
    const SUBTREE_DATA_OVERHEAD = 6 + (1 + 16 + 32 + 4 + 2 + 4);
    const maxDataLegacy = Math.max(0, MAX_ATOMIC_WRITE - SUBTREE_DATA_OVERHEAD);
    const maxChunksLegacy = Math.max(1, Math.floor(maxDataLegacy / Math.max(1, this.chunkSize)));

    const cap = Math.max(1, Math.min(maxChunksByTarget, maxChunksLegacy));
    this.subtreeChunkCount = Math.max(1, 1 << Math.floor(Math.log2(cap)));
    
    // Expose session state maps for backward compatibility
    Object.defineProperty(this, '_activeRequestIds', {
      get: () => this._sessionState.activeRequestIds
    });
    Object.defineProperty(this, '_subtreeRequestMap', {
      get: () => this._sessionState.subtreeRequestMap
    });
    Object.defineProperty(this, '_subtreeTimeouts', {
      get: () => this._sessionState.subtreeTimeouts
    });
    Object.defineProperty(this, '_requestToChunkIndex', {
      get: () => this._sessionState.requestToChunkIndex
    });
    Object.defineProperty(this, '_pendingSubtreeProofs', {
      get: () => this._sessionState.pendingSubtreeProofs
    });
    Object.defineProperty(this, '_pendingSubtreeData', {
      get: () => this._sessionState.pendingSubtreeData
    });
    Object.defineProperty(this, '_partialChunks', {
      get: () => this._sessionState.partialChunks
    });
  }

  _clearAllChunkTimeouts() {
    for (const [, chunk] of this.chunkStates) {
      if (chunk.timeout) {
        clearTimeout(chunk.timeout);
        chunk.timeout = null;
      }
      if (chunk.endgameTimeouts && chunk.endgameTimeouts.size > 0) {
        for (const timeout of chunk.endgameTimeouts.values()) {
          clearTimeout(timeout);
        }
        chunk.endgameTimeouts.clear();
      }
    }
  }

  async start() {
    console.log(`\n🚀 Starting download session for ${this.metadata.name}`);
    console.log(`   Size: ${this._formatBytes(this.fileSize)}`);
    console.log(`   Chunks: ${this.totalChunks}`);
    console.log(`   Merkle Root: ${this.merkleRoot.substring(0, 16)}...`);
    
    await this.initializeFile();
    await this.openOutputFile();
    await this.loadExistingChunks();
    this.setupProtocolHandlers();

    // If the swarm already had connections before this session started,
    // we won't receive peer:connected events for them. Bootstrap from network state.
    this.bootstrapExistingPeers();
    
    this.running = true;
    this.downloadLoop();
  }

  async openOutputFile() {
    await this._diskWriter.open()
  }

  async closeOutputFile() {
    await this._diskWriter.close()
  }

  bootstrapExistingPeers() {
    const network = this.protocol?.network;
    if (!network || !network.topics) {
      return;
    }

    const topicKeyHex = this.topicKey.toString('hex');
    const topic = network.topics.get(topicKeyHex);
    if (!topic || !topic.connections) {
      return;
    }

    let added = 0;
    for (const [peerId, conn] of topic.connections) {
      this.peerManager.addPeer(peerId, conn);
      added++;
      
      // Request bitfield from this peer (same as onPeerConnected)
      console.log(`[BITFIELD] Requesting bitfield from bootstrapped peer ${peerId.substring(0, 8)} for ${this.merkleRoot.substring(0, 8)}`);
      this.protocol.requestBitfield(conn, peerId, this.merkleRoot);
    }

    if (added > 0) {
      console.log(`🔌 Bootstrapped ${added} existing peer(s) for download session`);
      this._updateMaxConcurrentRequests();
    }
  }

  getAnyConnectedPeer() {
    const peers = Array.from(this.peerManager.peers.values()).filter((p) => p && p.canRequest());
    if (peers.length > 0) {
      peers.sort((a, b) => b.getScore() - a.getScore());
      return peers[0];
    }

    const network = this.protocol?.network;
    if (!network || !network.topics) {
      return null;
    }

    const topicKeyHex = this.topicKey.toString('hex');
    const topic = network.topics.get(topicKeyHex);
    if (!topic || !topic.connections || topic.connections.size === 0) {
      return null;
    }

    const [peerId, conn] = topic.connections.entries().next().value;
    return this.peerManager.addPeer(peerId, conn);
  }

  async initializeFile() {
    const created = await this._diskWriter.initializeFile()
    if (!created) {
      console.log(`   ℹ️  File already exists, resuming...`)
    } else {
      console.log(`   ✓ Initialized file: ${this.outputPath}`)
    }
  }

  async loadExistingChunks() {
    const fileInfo = this.db.getFileByMerkleRoot(this.merkleRoot);
    if (!fileInfo) {
      console.log(`   ℹ️  New download, starting from scratch`);
      return;
    }
    
    console.log(`   🔍 Verifying existing chunks...`);
    
    const verified = await this._diskWriter.verifyExistingChunks(this.chunkStates, (index, size) => {
      const chunk = this.chunkStates.get(index)
      if (chunk) {
        chunk.state = ChunkState.VERIFIED
        this._sessionState.recordChunkVerified(size)
        this.ourBitfield.set(index)
      }
    })
    
    if (verified > 0) {
      console.log(`Resumed: ${verified}/${this.totalChunks} chunks already verified`);
    }
  }

  setupProtocolHandlers() {
    const onPeerConnected = (info) => this.onPeerConnected(info);
    const onPeerDisconnected = (info) => this.onPeerDisconnected(info);
    const onPeerBitfield = (info) => this.onPeerBitfield(info);
    const onChunkOffer = (info) => this.onChunkOffer(info);
    const onChunkReceived = (info) => this.onChunkReceived(info);
    const onSubtreePart = (info) => this.onSubtreePart(info);
    const onSubtreeProof = (info) => this.onSubtreeProof(info);
    const onSubtreeComplete = (info) => this.onSubtreeComplete(info);

    this._protocolHandlers = {
      onPeerConnected,
      onPeerDisconnected,
      onPeerBitfield,
      onChunkOffer,
      onChunkReceived,
      onSubtreePart,
      onSubtreeProof,
      onSubtreeComplete
    };

    this.protocol.on('peer:connected', onPeerConnected);
    this.protocol.on('peer:disconnected', onPeerDisconnected);
    this.protocol.on('peer:bitfield', onPeerBitfield);
    this.protocol.on('chunk:offer', onChunkOffer);
    this.protocol.on('chunk:downloaded', onChunkReceived);
    this.protocol.on('subtree:part', onSubtreePart);
    this.protocol.on('subtree:proof', onSubtreeProof);
    this.protocol.on('subtree:complete', onSubtreeComplete);
  }

  detachProtocolHandlers() {
    if (!this._protocolHandlers) {
      return;
    }
    const { onPeerConnected, onPeerDisconnected, onPeerBitfield, onChunkOffer, onChunkReceived, onSubtreePart, onSubtreeProof, onSubtreeComplete } = this._protocolHandlers;
    this.protocol.off('peer:connected', onPeerConnected);
    this.protocol.off('peer:disconnected', onPeerDisconnected);
    this.protocol.off('peer:bitfield', onPeerBitfield);
    this.protocol.off('chunk:offer', onChunkOffer);
    this.protocol.off('chunk:downloaded', onChunkReceived);
    this.protocol.off('subtree:part', onSubtreePart);
    this.protocol.off('subtree:proof', onSubtreeProof);
    this.protocol.off('subtree:complete', onSubtreeComplete);
    this._protocolHandlers = null;
  }

  async downloadLoop() {
    while (this.running) {
      try {
        if (this.chunksVerified === this.totalChunks) {
          await this.onComplete();
          break;
        }
        
        if (this.loopCount % 100 === 0 && this.loopCount > 0) {
          const stats = this.scheduler.getStats();
          console.log(`📊 Download progress: ${this.chunksVerified}/${this.totalChunks} verified`);
          console.log(`   Missing: ${stats.totalMissing} | Unavailable: ${stats.unavailable} | Critical: ${stats.critical}`);
        }
        this.loopCount++;
        
        const available = this.maxConcurrentRequests - this.chunksInFlight;
        if (available <= 0) {
          await this.waitForSlot();
          continue;
        }
        
        const toRequest = this.scheduler.getNextChunks(available);
        
        if (toRequest.length === 0) {
          const stats = this.scheduler.getStats();
          
          // Case 1: All missing chunks are unavailable (no peer has them)
          if (stats.totalMissing > 0 && stats.unavailable === stats.totalMissing) {
            console.warn(`⚠️  STUCK: ${stats.unavailable} chunks unavailable`);
            await this.sleep(5000);
            continue;
          }
          
          // Case 2: No missing chunks but verified < total = chunks stuck in REQUESTED
          // This happens when timeouts haven't fired yet or requests are orphaned
          if (stats.totalMissing === 0 && this.chunksVerified < this.totalChunks) {
            const stuckCount = this.totalChunks - this.chunksVerified;
            this.logger?.log('STUCK_STATE', {
              verified: this.chunksVerified,
              total: this.totalChunks,
              stuck: stuckCount,
              inFlight: this.chunksInFlight,
              activeRequests: this._activeRequestIds.size
            });
            
            // Force-check for stale REQUESTED chunks (requested > 60s ago)
            // Count unique stale subtrees, not individual chunks
            const staleThreshold = Date.now() - 60000;
            const staleSubtrees = new Set();
            for (const [idx, ch] of this.chunkStates) {
              if (ch.state === ChunkState.REQUESTED && ch.requestedAt && ch.requestedAt < staleThreshold) {
                // Find the requestId for this chunk
                for (const [reqId, indices] of this._subtreeRequestMap.entries()) {
                  if (indices.includes(idx)) {
                    staleSubtrees.add(reqId);
                    break;
                  }
                }
              }
            }
            
            // Force-timeout stale subtrees
            for (const reqId of staleSubtrees) {
              const indices = this._subtreeRequestMap.get(reqId) || [];
              if (indices.length > 0) {
                const ch = this.chunkStates.get(indices[0]);
                if (ch) {
                  this.onSubtreeTimeout(reqId, ch.requestedFrom);
                }
              }
            }
            
            if (staleSubtrees.size > 0) {
              console.warn(`🔧 Force-failed ${staleSubtrees.size} stale subtree requests`);
            }
            
            // Always sleep to prevent tight loop
            await this.sleep(1000);
            continue;
          }
          
          // Case 3: Normal wait for in-flight requests to complete
          await this.waitForSlot();
          continue;
        }
        
        for (const chunkIndex of toRequest) {
          await this.requestChunk(chunkIndex);
        }
        
        // Always yield to event loop
        await this.sleep(50);
        
      } catch (error) {
        console.error('Download loop error:', error);
        await this.sleep(1000);
      }
    }
  }

  // INVARIANT: chunksInFlight counts SUBTREE REQUESTS, not individual chunks
// Requesting an 8-chunk subtree increments chunksInFlight by 1, not 8
async requestChunk(chunkIndex) {
    const chunk = this.chunkStates.get(chunkIndex);
    
    if (chunk.state === ChunkState.REQUESTED && !this.scheduler.inEndgame) {
      return false;
    }
    
    let peer = this.peerManager.selectPeerForChunk(chunkIndex);
    if (!peer) {
      peer = this.getAnyConnectedPeer();
    }
    if (!peer) {
      console.log(`⚠️  No peers available to request chunk ${chunkIndex}`);
      return false;
    }
    
    if (this.scheduler.inEndgame) {
      if (!chunk.endgameRequests) {
        chunk.endgameRequests = new Map();
      }
      
      if (chunk.endgameRequests.has(peer.peerId)) {
        return false;
      }
    }
    
    // Subtree proofs require power-of-two chunkCount and alignment (startChunk % chunkCount === 0).
    // The simple power-of-two shrinking logic can accidentally skip the very last chunk(s).
    // For the tail of the file, request single-chunk subtrees to guarantee coverage.
    const remainingFromIndex = this.totalChunks - chunkIndex;
    let subtreeStart;
    let subtreeEnd;

    if (remainingFromIndex > 0 && remainingFromIndex < this.subtreeChunkCount) {
      subtreeStart = chunkIndex;
      subtreeEnd = chunkIndex;
    } else {
      subtreeStart = Math.floor(chunkIndex / this.subtreeChunkCount) * this.subtreeChunkCount;
      subtreeEnd = Math.min(this.totalChunks - 1, subtreeStart + this.subtreeChunkCount - 1);
    }
    const chunkIndices = [];
    for (let i = subtreeStart; i <= subtreeEnd; i++) {
      const ch = this.chunkStates.get(i);
      if (!ch) {
        continue;
      }
      if (ch.state === ChunkState.VERIFIED) {
        continue;
      }
      if (ch.state === ChunkState.REQUESTED && !this.scheduler.inEndgame) {
        continue;
      }
      chunkIndices.push(i);
    }
    if (chunkIndices.length === 0) {
      return false;
    }

    let requestId;
    requestId = this.protocol.requestSubtreeToPeer(this.topicKey, peer.peerId, this.merkleRoot, subtreeStart, subtreeEnd - subtreeStart + 1);
    this._activeRequestIds.add(requestId);
    this._subtreeRequestMap.set(requestId, chunkIndices);

    for (const i of chunkIndices) {
      const ch = this.chunkStates.get(i);
      if (!ch || ch.state === ChunkState.VERIFIED) {
        continue;
      }
      ch.state = ChunkState.REQUESTED;
      ch.requestedFrom = peer.peerId;
      ch.requestedAt = Date.now();
    }

    // Count this as ONE in-flight request (the subtree), not N chunks
    // This allows maxConcurrentRequests to control concurrent subtree requests
    this.chunksInFlight++;

    const timeout = setTimeout(() => {
      this.onSubtreeTimeout(requestId, peer.peerId);
    }, this.requestTimeout);
    this._subtreeTimeouts.set(requestId, timeout);

    peer.activeRequests.add(requestId);
    console.log(`⬇️  Requested subtree ${subtreeStart}-${subtreeEnd} req=${requestId.substring(0, 8)} peer=${peer.peerId.substring(0, 8)} chunks=${chunkIndices.length}`);
    
    this.logger?.log('SUBTREE_REQUEST', {
      requestId: requestId.substring(0, 8),
      start: subtreeStart,
      end: subtreeEnd,
      chunks: chunkIndices.length,
      peer: peer.peerId.substring(0, 8)
    });
    
    return true;
  }

  onSubtreeTimeout(requestId, peerId) {
    const t = this._subtreeTimeouts.get(requestId);
    if (t) {
      clearTimeout(t);
    }
    this._subtreeTimeouts.delete(requestId);

    this._pendingSubtreeProofs.delete(requestId);
    this._pendingSubtreeData.delete(requestId);

    const indices = this._subtreeRequestMap.get(requestId) || [];
    this._subtreeRequestMap.delete(requestId);
    this._activeRequestIds.delete(requestId);

    const peer = this.peerManager.getPeer(peerId);
    if (peer) {
      peer.activeRequests.delete(requestId);
      peer.timeouts++;
    }
    
    this.logger?.log('SUBTREE_TIMEOUT', {
      requestId: requestId.substring(0, 8),
      peer: peerId.substring(0, 8),
      chunks: indices.length
    });

    for (const idx of indices) {
      const ch = this.chunkStates.get(idx);
      if (!ch || ch.state === ChunkState.VERIFIED) {
        continue;
      }
      ch.state = ChunkState.FAILED;
      ch.retryCount++;
    }
    
    // Decrement chunksInFlight by 1 (we count per-subtree, not per-chunk)
    this.chunksInFlight = Math.max(0, this.chunksInFlight - 1);
  }

  // Streaming: write each part directly to disk as it arrives
  // Parts may span multiple chunks or be partial chunks
  async onSubtreePart(info) {
    const { requestId, startChunk, offset, data, peerId } = info;
    if (!this.running) {
      return;
    }

    // Calculate which chunk(s) this part belongs to
    // offset is the byte offset within the subtree (starting at startChunk)
    let partOffset = 0;
    let remaining = data.length;
    
    // Find the starting chunk by summing chunk sizes
    let chunkIndex = startChunk;
    let chunkByteOffset = 0;
    for (let i = startChunk; i < this.totalChunks; i++) {
      const ch = this.chunkStates.get(i);
      if (!ch) return;
      if (chunkByteOffset + ch.size > offset) {
        chunkIndex = i;
        break;
      }
      chunkByteOffset += ch.size;
    }
    
    // Write data to the appropriate chunk(s)
    while (remaining > 0 && chunkIndex < this.totalChunks) {
      const ch = this.chunkStates.get(chunkIndex);
      if (!ch) break;
      
      // Skip already verified chunks
      if (ch.state === ChunkState.VERIFIED) {
        remaining -= ch.size;
        chunkIndex++;
        continue;
      }
      
      // Calculate write position within this chunk
      const writeOffset = Math.max(0, offset - chunkByteOffset);
      const writeSize = Math.min(remaining, ch.size - writeOffset);
      
      if (writeSize <= 0) {
        chunkIndex++;
        continue;
      }
      
      // For now, we need to accumulate data per chunk to verify hash
      // This is a limitation - we can't verify partial chunk hashes
      // Store partial data and verify when complete
      // Note: _partialChunks is a getter to SessionState.partialChunks which is already initialized
      
      const chunkKey = `${requestId}:${chunkIndex}`;
      let partial = this._partialChunks.get(chunkKey);
      if (!partial) {
        partial = { data: Buffer.allocUnsafe(ch.size), written: 0, expectedSize: ch.size };
        this._partialChunks.set(chunkKey, partial);
      }
      
      // Copy data to partial buffer
      data.copy(partial.data, writeOffset, partOffset, partOffset + writeSize);
      partial.written += writeSize;
      
      // If chunk is complete, verify and write to disk
      if (partial.written >= ch.size) {
        try {
          const actualHash = await hashBuffer(partial.data);
          if (actualHash !== ch.hash) {
            throw new Error('Hash mismatch');
          }
          
          await this._diskWriter.writeChunk(partial.data, ch.offset);
          
          ch.state = ChunkState.VERIFIED;
          this._sessionState.recordChunkVerified(ch.size);
          this.ourBitfield.set(chunkIndex);
          this.peerManager.updatePeerStats(peerId, true, ch.size, Math.max(1, Date.now() - (ch.requestedAt || Date.now())));
          // Note: chunksInFlight is decremented in onSubtreeComplete, not per-chunk
          
          this.emit('progress', this._sessionState.getProgressInfo());
          
          this._partialChunks.delete(chunkKey);
        } catch (err) {
          ch.state = ChunkState.FAILED;
          ch.retryCount++;
          this.peerManager.updatePeerStats(peerId, false);
          // Note: chunksInFlight is decremented in onSubtreeComplete, not per-chunk
          this._partialChunks.delete(chunkKey);
        }
      }
      
      partOffset += writeSize;
      remaining -= writeSize;
      chunkIndex++;
    }
  }

  async onSubtreeProof(info) {
    const { requestId, merkleRoot, startChunk, chunkCount, node, proof, peerId } = info;
    if (!this.running) {
      return;
    }

    // Verify merkle proof
    const leafHashes = [];
    for (let i = startChunk; i < startChunk + chunkCount && i < this.totalChunks; i++) {
      const ch = this.chunkStates.get(i);
      if (ch) {
        leafHashes.push(ch.hash);
      }
    }

    if (leafHashes.length === chunkCount) {
      const computedNode = await getMerkleRoot(leafHashes);
      if (computedNode !== node) {
        console.error(`Subtree proof mismatch for ${requestId.substring(0, 8)}`);
        this.logger?.log('PROOF_MISMATCH', {
          requestId: requestId.substring(0, 8),
          startChunk,
          chunkCount,
          computedNode: computedNode?.substring(0, 16),
          receivedNode: node?.substring(0, 16)
        });
        return;
      }
      const ok = await verifySubtreeProof(node, proof, this.merkleRoot);
      if (!ok) {
        console.error(`Subtree proof verification failed for ${requestId.substring(0, 8)}`);
        return;
      }
    }
    
    // Clear timeout - proof received
    const t = this._subtreeTimeouts.get(requestId);
    if (t) {
      clearTimeout(t);
    }
    this._subtreeTimeouts.delete(requestId);
  }

  // INVARIANT: Decrement chunksInFlight by 1 (per-subtree, not per-chunk)
onSubtreeComplete(info) {
    const { requestId, peerId } = info;
    
    // Decrement chunksInFlight - we count one per subtree request
    this.chunksInFlight = Math.max(0, this.chunksInFlight - 1);
    
    // Cleanup request tracking
    this._subtreeRequestMap.delete(requestId);
    this._activeRequestIds.delete(requestId);
    
    const peer = this.peerManager.getPeer(peerId);
    if (peer) {
      peer.activeRequests.delete(requestId);
    }
  }

  onPeerConnected(info) {
    const { conn, peerId, topicKey } = info;
    
    if (topicKey.toString('hex') !== this.topicKey.toString('hex')) {
      return;
    }
    
    this.peerManager.addPeer(peerId, conn);
    this._updateMaxConcurrentRequests();
    
    // Request peer's bitfield to learn what chunks they have
    console.log(`[BITFIELD] Requesting bitfield from ${peerId.substring(0, 8)} for ${this.merkleRoot.substring(0, 8)}`);
    this.protocol.requestBitfield(conn, peerId, this.merkleRoot);
  }

  onPeerBitfield(info) {
    const { peerId, bitfield, merkleRoot } = info;
    
    console.log(`[BITFIELD] Received bitfield from ${peerId?.substring(0, 8)} merkleRoot=${merkleRoot?.substring(0, 8)} expected=${this.merkleRoot.substring(0, 8)}`);
    
    // Only process bitfield for our file
    if (merkleRoot !== this.merkleRoot) {
      console.log(`[BITFIELD] Ignoring bitfield - merkleRoot mismatch`);
      return;
    }
    
    this.peerManager.updatePeerBitfield(peerId, bitfield);
    this._updateMaxConcurrentRequests();
    console.log(`[BITFIELD] Updated peer availability for ${peerId.substring(0, 8)}`);
  }

  onPeerDisconnected(info) {
    const { peerId } = info;
    this.peerManager.removePeer(peerId);
    this._updateMaxConcurrentRequests();
    
    // Mark chunks as failed but don't decrement chunksInFlight here
    // onSubtreeTimeout will handle the decrement per-subtree
    for (const [requestId, indices] of this._subtreeRequestMap.entries()) {
      if (!Array.isArray(indices) || indices.length === 0) {
        continue
      }
      const first = this.chunkStates.get(indices[0])
      if (!first || first.requestedFrom !== peerId) {
        continue
      }
      this.onSubtreeTimeout(requestId, peerId)
    }
    
    // Handle any remaining chunks not in subtree requests (edge case)
    for (const [, ch] of this.chunkStates) {
      if (!ch || ch.state === ChunkState.VERIFIED) {
        continue
      }
      if (ch.requestedFrom !== peerId) {
        continue
      }

      if (ch.state === ChunkState.REQUESTED) {
        ch.state = ChunkState.FAILED
        ch.retryCount++
        // Don't decrement chunksInFlight here - handled by subtree timeout
      }
    }
  }

  onChunkOffer(info) {
    // Alpha optimization: serving peers stream CHUNK_DATA immediately after OFFER.
    // No need to respond with DOWNLOAD.
  }

  async onChunkReceived(info) {
    const { requestId, chunkHash, data, peerId } = info;

    // Ignore late deliveries after completion/stop.
    if (!this.running) {
      return;
    }
    
    const chunkIndex = this._requestToChunkIndex.get(requestId);
    if (typeof chunkIndex !== 'number') {
      // If we no longer know what this requestId was for (e.g. timed out/cancelled),
      // do NOT fall back to mapping by hash, since duplicate hashes can exist.
      this._activeRequestIds.delete(requestId);
      this._requestToChunkIndex.delete(requestId);
      return;
    }
    
    const chunk = this.chunkStates.get(chunkIndex);

    // Dedup: if we already verified this chunk, ignore late/duplicate deliveries.
    // This can happen in endgame mode or due to retries.
    if (chunk.state === ChunkState.VERIFIED) {
      this._activeRequestIds.delete(requestId);
      this._requestToChunkIndex.delete(requestId);
      return;
    }

    const startTime = chunk.requestedAt;

    // Track whether this chunk was actually counted as in-flight for this request.
    // We must only decrement chunksInFlight once.
    let matchedInFlight = false;
    if (!this.scheduler.inEndgame) {
      matchedInFlight = chunk.requestId === requestId;
    } else if (chunk.endgameRequests) {
      for (const [, otherRequestId] of chunk.endgameRequests) {
        if (otherRequestId === requestId) {
          matchedInFlight = true;
          break;
        }
      }
    }
    
    if (this.scheduler.inEndgame && chunk.endgameRequests) {
      for (const [otherPeerId, otherRequestId] of chunk.endgameRequests) {
        if (otherRequestId !== requestId) {
          this.protocol.cancelRequest(otherRequestId);

          this._activeRequestIds.delete(otherRequestId);
          this._requestToChunkIndex.delete(otherRequestId);
          
          const timeout = chunk.endgameTimeouts?.get(otherRequestId);
          if (timeout) {
            clearTimeout(timeout);
          }
        }
      }
      
      chunk.endgameRequests.clear();
      chunk.endgameTimeouts?.clear();
    }
    
    if (chunk.timeout) {
      clearTimeout(chunk.timeout);
    }
    
    chunk.state = ChunkState.RECEIVED;
    chunk.data = Buffer.isBuffer(data)
      ? data
      : (typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data));
    if (matchedInFlight) {
      this.chunksInFlight = Math.max(0, this.chunksInFlight - 1);
    }

    this._activeRequestIds.delete(requestId);
    this._requestToChunkIndex.delete(requestId);
    
    const peer = this.peerManager.getPeer(peerId);
    if (peer) {
      peer.activeRequests.delete(requestId);
    }
    
    await this.verifyAndWriteChunk(chunkIndex, chunk, peerId, startTime);
  }

  async verifyAndWriteChunk(chunkIndex, chunk, peerId, startTime) {
    try {
      // const actualHash = crypto.createHash('sha256').update(chunk.data).digest('hex');
      const actualHash = await hashBuffer(chunk.data)
      
      if (actualHash !== chunk.hash) {
        throw new Error('Hash mismatch');
      }

      // Another dedup guard: if we got here but a parallel delivery already verified it.
      if (chunk.state === ChunkState.VERIFIED) {
        chunk.data = null;
        return;
      }
      
      if (!this.outputFd) {
        await this.openOutputFile();
      }

      const receivedLen = chunk.data.length;
      if (receivedLen !== chunk.size) {
        console.warn(
          `⚠️  Chunk ${chunkIndex} size mismatch: expected=${chunk.size} received=${receivedLen} offset=${chunk.offset} fileSize=${this.fileSize}`
        );
      }

      // Write the full received chunk. Truncating here can corrupt the file even if the
      // received data hash verified against the expected chunk hash.
      const writeLen = receivedLen;
      if (chunk.offset + writeLen > this.fileSize) {
        throw new Error(`Write would exceed file bounds: offset=${chunk.offset} len=${writeLen} fileSize=${this.fileSize}`);
      }

      await this.outputFd.write(chunk.data, 0, writeLen, chunk.offset);
      
      chunk.state = ChunkState.VERIFIED;
      chunk.data = null;
      this.chunksVerified = Math.min(this.totalChunks, this.chunksVerified + 1);
      this.bytesDownloaded = Math.min(this.fileSize, this.bytesDownloaded + writeLen);
      this.ourBitfield.set(chunkIndex);
      
      const downloadTime = Date.now() - (startTime || Date.now());
      this.peerManager.updatePeerStats(peerId, true, writeLen, downloadTime);
      
      this.emit('progress', {
        verified: this.chunksVerified,
        total: this.totalChunks,
        bytes: this.bytesDownloaded,
        percentage: (this.chunksVerified / this.totalChunks) * 100
      });
      
    } catch (error) {
      console.error(`❌ Chunk ${chunkIndex} verification failed:`, error.message);
      
      this.peerManager.updatePeerStats(peerId, false);
      
      chunk.state = ChunkState.FAILED;
      chunk.data = null;
      chunk.retryCount++;
    }
  }

  onChunkTimeout(chunkIndex, requestId, peerId) {
    if (!this.running) {
      this._activeRequestIds.delete(requestId);
      this._requestToChunkIndex.delete(requestId);
      return;
    }

    try {
      this.protocol.cancelRequest(requestId);
    } catch {
      // ignore
    }

    const chunk = this.chunkStates.get(chunkIndex);
    const peer = this.peerManager.getPeer(peerId);
    
    console.warn(`⏱️  Chunk ${chunkIndex} timeout from ${peerId.substring(0, 8)}`);

    this._activeRequestIds.delete(requestId);
    this._requestToChunkIndex.delete(requestId);
    
    if (peer) {
      peer.timeouts++;
      peer.activeRequests.delete(requestId);
    }
    
    if (this.scheduler.inEndgame && chunk.endgameRequests) {
      chunk.endgameRequests.delete(peerId);
      
      if (chunk.endgameRequests.size === 0) {
        chunk.state = ChunkState.FAILED;
        chunk.retryCount++;
        this.chunksInFlight--;
      }
    } else {
      chunk.state = ChunkState.FAILED;
      chunk.retryCount++;
      chunk.requestedFrom = null;
      chunk.requestId = null;
      this.chunksInFlight--;
    }
  }

  async onComplete() {
    console.log(`\n🎉 Download complete!`);
    console.log(`   File: ${this.outputPath}`);
    console.log(`   Size: ${this._formatBytes(this.fileSize)}`);

    // Stop the loop and prevent any late writes/timeouts from mutating state.
    this.running = false;

    this._clearAllChunkTimeouts();
    
    // Close logger
    this.logger?.close();

    // Cancel all outstanding protocol requests to avoid post-success timeouts.
    for (const requestId of this._activeRequestIds) {
      try {
        this.protocol.cancelRequest(requestId);
      } catch {
        // ignore
      }
    }
    this._activeRequestIds.clear();
    this._requestToChunkIndex.clear();

    this.detachProtocolHandlers();

    await this.closeOutputFile();

    // Final verification: recompute Merkle root from the file bytes.
    try {
      const computed = await this.verifyFileMerkleRoot();
      if (computed !== this.merkleRoot) {
        const mismatch = await this.findFirstChunkMismatch();
        if (mismatch) {
          console.error(
            `❌ First mismatching chunk: index=${mismatch.index} expected=${mismatch.expected.substring(0, 16)}... actual=${mismatch.actual.substring(0, 16)}... offset=${mismatch.offset} len=${mismatch.len}`
          );
        }
        throw new Error(`Final verification failed: expected ${this.merkleRoot.substring(0, 16)}... got ${computed.substring(0, 16)}...`);
      }
    } catch (err) {
      console.error(`❌ ${err.message}`);
      this.emit('error', err);
      return;
    }
    
    if (this.fileId) {
      this.db.updateFileModifiedAt(this.fileId, Date.now());
    }
    
    this.emit('complete', {
      path: this.outputPath,
      size: this.fileSize,
      chunks: this.totalChunks
    });
  }

  async verifyFileMerkleRoot() {
    const fd = await fs.promises.open(this.outputPath, 'r')
    try {
      const leafHashes = []
      for (let i = 0; i < this.totalChunks; i++) {
        const offset = i * this.chunkSize
        const len = Math.min(this.chunkSize, Math.max(0, this.fileSize - offset))
        const buf = Buffer.allocUnsafe(len)
        const { bytesRead } = await fd.read(buf, 0, len, offset)
        const actualBuf = bytesRead < len ? buf.subarray(0, bytesRead) : buf
        const leafHash = await hashBuffer(actualBuf)
        leafHashes.push(leafHash)
      }
      return await getMerkleRoot(leafHashes);
    } finally {
      await fd.close();
    }
  }

  async findFirstChunkMismatch() {
    const fd = await fs.promises.open(this.outputPath, 'r');
    try {
      for (let i = 0; i < this.totalChunks; i++) {
        const expected = this.chunkStates.get(i)?.hash;
        if (!expected) {
          continue;
        }

        const offset = i * this.chunkSize;
        const len = Math.min(this.chunkSize, Math.max(0, this.fileSize - offset));
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fd.read(buf, 0, len, offset);
        const actualBuf = bytesRead < len ? buf.subarray(0, bytesRead) : buf;
        const actual = await hashBuffer(actualBuf);
        if (actual !== expected) {
          return { index: i, expected, actual, offset, len: actualBuf.length };
        }
      }
      return null;
    } finally {
      await fd.close();
    }
  }

  async waitForSlot() {
    // Poll for available slot instead of using event listeners.
    // The old approach added a new 'progress' listener every call, causing
    // EventEmitter memory leak warnings and memory accumulation.
    const maxPolls = 100; // 100 * 50ms = 5 seconds max wait
    for (let i = 0; i < maxPolls; i++) {
      if (this.chunksInFlight < this.maxConcurrentRequests) {
        return;
      }
      await this.sleep(50);
    }
  }

  _updateMaxConcurrentRequests() {
    const peerCount = this.peerManager.peers.size;
    if (peerCount === this._lastPeerCount) {
      return; // No change
    }
    this._lastPeerCount = peerCount;
    
    // Adaptive formula: min(50, max(4, peerCount * 8))
    const oldMax = this.maxConcurrentRequests;
    this.maxConcurrentRequests = Math.min(50, Math.max(4, peerCount * 8));
    
    if (oldMax !== this.maxConcurrentRequests) {
      console.log(`📊 Adaptive concurrency: ${this.maxConcurrentRequests} requests (${peerCount} peers)`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }
}
