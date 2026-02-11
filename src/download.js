/**
 * DownloadSession - Manages parallel download of a single file
 */

import { EventEmitter } from 'events'
import fs from 'fs'
// import crypto from 'crypto'
import blake3 from 'blake3-bao/blake3'
import { BitField } from './bitfield.js'
import { PeerManager } from './peer-manager.js'
import { ChunkScheduler, ChunkState } from './chunk-scheduler.js'
import { getMerkleRoot } from './merkle.js'
import { hashBuffer } from './hash.js'

export class ChunkMeta {
  constructor(index, hash, offset, size) {
    this.index = index;
    this.hash = hash;
    this.offset = offset;
    this.size = size;
    
    this.state = ChunkState.MISSING;
    this.requestedFrom = null;
    this.requestedAt = null;
    this.requestId = null;
    this.retryCount = 0;
    this.data = null;
    this.timeout = null;
    
    this.endgameRequests = null;
    this.endgameTimeouts = null;
  }
}

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
    
    this.chunksVerified = 0;
    this.chunksInFlight = 0;
    this.bytesDownloaded = 0;
    
    this.maxConcurrentRequests = 50;
    this.requestTimeout = 30000;
    
    this.running = false;
    this.loopCount = 0;
    
    this.fileId = null;

    this.outputFd = null;

    this._activeRequestIds = new Set();
    this._protocolHandlers = null;

    this._requestToChunkIndex = new Map();
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
    if (this.outputFd) {
      return;
    }
    this.outputFd = await fs.promises.open(this.outputPath, 'r+');
  }

  async closeOutputFile() {
    if (!this.outputFd) {
      return;
    }
    try {
      await this.outputFd.datasync();
    } catch {
      // ignore
    }
    try {
      await this.outputFd.close();
    } finally {
      this.outputFd = null;
    }
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
    }

    if (added > 0) {
      console.log(`🔌 Bootstrapped ${added} existing peer(s) for download session`);
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
    if (fs.existsSync(this.outputPath)) {
      const stats = fs.statSync(this.outputPath);
      if (stats.size === this.fileSize) {
        console.log(`   ℹ️  File already exists, resuming...`);
        return;
      }
    }
    
    const fd = fs.openSync(this.outputPath, 'w');
    try {
      fs.ftruncateSync(fd, this.fileSize);
    } finally {
      fs.closeSync(fd);
    }
    
    console.log(`   ✓ Initialized file: ${this.outputPath}`);
  }

  async loadExistingChunks() {
    const fileInfo = this.db.getFileByMerkleRoot(this.merkleRoot);
    if (!fileInfo) {
      console.log(`   ℹ️  New download, starting from scratch`);
      return;
    }
    
    console.log(`   🔍 Verifying existing chunks...`);
    
    const fd = await fs.promises.open(this.outputPath, 'r');

    try {
      for (const [index, chunk] of this.chunkStates) {
        try {
          const buffer = Buffer.allocUnsafe(chunk.size);
          await fd.read(buffer, 0, chunk.size, chunk.offset);
          
          // const hash = crypto.createHash('sha256').update(buffer).digest('hex');
          const hash = await hashBuffer(buffer)
          
          if (hash === chunk.hash) {
            chunk.state = ChunkState.VERIFIED;
            this.chunksVerified++;
            this.bytesDownloaded += chunk.size;
            this.ourBitfield.set(index);
          }
        } catch (err) {
          console.error('Chunk verification failed: ', err)
        }
      }
    } finally {
      await fd.close();
    }
    
    if (this.chunksVerified > 0) {
      console.log(`Resumed: ${this.chunksVerified}/${this.totalChunks} chunks already verified`);
    }
  }

  setupProtocolHandlers() {
    const onPeerConnected = (info) => this.onPeerConnected(info);
    const onPeerDisconnected = (info) => this.onPeerDisconnected(info);
    const onChunkOffer = (info) => this.onChunkOffer(info);
    const onChunkReceived = (info) => this.onChunkReceived(info);

    this._protocolHandlers = {
      onPeerConnected,
      onPeerDisconnected,
      onChunkOffer,
      onChunkReceived
    };

    this.protocol.on('peer:connected', onPeerConnected);
    this.protocol.on('peer:disconnected', onPeerDisconnected);
    this.protocol.on('chunk:offer', onChunkOffer);
    this.protocol.on('chunk:downloaded', onChunkReceived);
  }

  detachProtocolHandlers() {
    if (!this._protocolHandlers) {
      return;
    }
    const { onPeerConnected, onPeerDisconnected, onChunkOffer, onChunkReceived } = this._protocolHandlers;
    this.protocol.off('peer:connected', onPeerConnected);
    this.protocol.off('peer:disconnected', onPeerDisconnected);
    this.protocol.off('chunk:offer', onChunkOffer);
    this.protocol.off('chunk:downloaded', onChunkReceived);
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
          if (stats.totalMissing > 0 && stats.unavailable === stats.totalMissing) {
            console.warn(`⚠️  STUCK: ${stats.unavailable} chunks unavailable`);
            await this.sleep(5000);
            continue;
          }
          
          await this.waitForSlot();
          continue;
        }
        
        for (const chunkIndex of toRequest) {
          await this.requestChunk(chunkIndex);
        }
        
        await this.sleep(10);
        
      } catch (error) {
        console.error('Download loop error:', error);
        await this.sleep(1000);
      }
    }
  }

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
    
    const requestId = this.protocol.requestChunk(this.topicKey, chunk.hash);
    this._activeRequestIds.add(requestId);
    this._requestToChunkIndex.set(requestId, chunkIndex);
    console.log(`⬇️  Requested chunk ${chunkIndex} (${chunk.hash.substring(0, 16)}...) req=${requestId.substring(0, 8)} peer=${peer.peerId.substring(0, 8)}`);
    
    if (!this.scheduler.inEndgame) {
      chunk.state = ChunkState.REQUESTED;
      chunk.requestedFrom = peer.peerId;
      chunk.requestedAt = Date.now();
      chunk.requestId = requestId;
      this.chunksInFlight++;
    } else {
      chunk.endgameRequests.set(peer.peerId, requestId);
      if (chunk.state === ChunkState.MISSING) {
        chunk.state = ChunkState.REQUESTED;
        this.chunksInFlight++;
      }
    }
    
    peer.activeRequests.add(requestId);
    
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
    
    return true;
  }

  onPeerConnected(info) {
    const { conn, peerId, topicKey } = info;
    
    if (topicKey.toString('hex') !== this.topicKey.toString('hex')) {
      return;
    }
    
    this.peerManager.addPeer(peerId, conn);
  }

  onPeerDisconnected(info) {
    const { peerId } = info;
    this.peerManager.removePeer(peerId);
  }

  onChunkOffer(info) {
    if (info.offerCount === 1) {
      this.protocol.acceptOffer(info.requestId, info.peerId);
    }
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
    chunk.data = Buffer.from(data, 'base64');
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
    return new Promise(resolve => {
      const handler = () => {
        this.removeListener('progress', handler);
        resolve();
      };
      this.once('progress', handler);
      setTimeout(resolve, 5000);
    });
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
