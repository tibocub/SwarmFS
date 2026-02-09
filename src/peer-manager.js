/**
 * PeerManager - Tracks peer health and chunk availability
 */

import { BitField } from './bitfield.js';

export class PeerInfo {
  constructor(peerId, conn, totalChunks) {
    this.peerId = peerId;
    this.conn = conn;
    this.bitfield = new BitField(totalChunks);
    
    this.successfulChunks = 0;
    this.failedChunks = 0;
    this.timeouts = 0;
    this.avgDownloadSpeed = 0;
    this.lastActiveAt = Date.now();
    
    this.activeRequests = new Set();
    this.maxConcurrent = 5;
  }
  
  getScore() {
    const totalRequests = this.successfulChunks + this.failedChunks;
    if (totalRequests === 0) {
      return 1.0;
    }
    
    const successRate = this.successfulChunks / totalRequests;
    const speedFactor = Math.min(this.avgDownloadSpeed / 1048576, 10);
    const timeoutPenalty = Math.max(0, 1 - (this.timeouts * 0.1));
    
    return successRate * (1 + speedFactor) * timeoutPenalty;
  }
  
  canRequest() {
    return this.activeRequests.size < this.maxConcurrent;
  }
  
  updateSpeed(bytes, milliseconds) {
    const bytesPerSec = (bytes / milliseconds) * 1000;
    
    if (this.avgDownloadSpeed === 0) {
      this.avgDownloadSpeed = bytesPerSec;
    } else {
      this.avgDownloadSpeed = (0.3 * bytesPerSec) + (0.7 * this.avgDownloadSpeed);
    }
  }
}

export class PeerManager {
  constructor(session) {
    this.session = session;
    this.peers = new Map();
    this.availabilityIndex = new Map();
  }

  addPeer(peerId, conn) {
    if (this.peers.has(peerId)) {
      return this.peers.get(peerId);
    }
    
    const peer = new PeerInfo(peerId, conn, this.session.totalChunks);
    this.peers.set(peerId, peer);
    
    console.log(`👋 Added peer: ${peerId.substring(0, 8)}`);
    
    return peer;
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    console.log(`👋 Removed peer: ${peerId.substring(0, 8)}`);
    
    for (const requestId of peer.activeRequests) {
      for (const [index, chunk] of this.session.chunkStates) {
        if (chunk.requestId === requestId) {
          this.session.onChunkTimeout(index, requestId, peerId);
          break;
        }
      }
    }
    
    for (let i = 0; i < this.session.totalChunks; i++) {
      if (peer.bitfield.has(i)) {
        const peers = this.availabilityIndex.get(i);
        if (peers) {
          peers.delete(peerId);
          if (peers.size === 0) {
            this.availabilityIndex.delete(i);
          }
        }
      }
    }
    
    this.peers.delete(peerId);
  }

  updatePeerBitfield(peerId, bitfield) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      console.warn(`Cannot update bitfield for unknown peer: ${peerId.substring(0, 8)}`);
      return;
    }
    
    peer.bitfield = bitfield;
    
    for (let i = 0; i < this.session.totalChunks; i++) {
      if (bitfield.has(i)) {
        if (!this.availabilityIndex.has(i)) {
          this.availabilityIndex.set(i, new Set());
        }
        this.availabilityIndex.get(i).add(peerId);
      } else {
        const peers = this.availabilityIndex.get(i);
        if (peers) {
          peers.delete(peerId);
          if (peers.size === 0) {
            this.availabilityIndex.delete(i);
          }
        }
      }
    }
    
    const chunkCount = bitfield.count();
    console.log(`📊 Peer ${peerId.substring(0, 8)} has ${chunkCount}/${this.session.totalChunks} chunks`);
  }

  announcePeerChunk(peerId, chunkIndex) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    peer.bitfield.set(chunkIndex);
    
    if (!this.availabilityIndex.has(chunkIndex)) {
      this.availabilityIndex.set(chunkIndex, new Set());
    }
    this.availabilityIndex.get(chunkIndex).add(peerId);
  }

  selectPeerForChunk(chunkIndex) {
    const candidates = this.availabilityIndex.get(chunkIndex);
    if (!candidates || candidates.size === 0) {
      const any = Array.from(this.peers.values()).filter((peer) => peer && peer.canRequest());
      if (any.length === 0) {
        return null;
      }
      any.sort((a, b) => b.getScore() - a.getScore());
      const topN = Math.min(3, any.length);
      const index = Math.floor(Math.random() * topN);
      return any[index];
    }
    
    const available = Array.from(candidates)
      .map(peerId => this.peers.get(peerId))
      .filter(peer => peer && peer.canRequest());
    
    if (available.length === 0) {
      return null;
    }
    
    available.sort((a, b) => b.getScore() - a.getScore());
    
    const topN = Math.min(3, available.length);
    const index = Math.floor(Math.random() * topN);
    return available[index];
  }

  updatePeerStats(peerId, success, bytes = 0, milliseconds = 0) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    if (success) {
      peer.successfulChunks++;
      peer.lastActiveAt = Date.now();
      
      if (bytes > 0 && milliseconds > 0) {
        peer.updateSpeed(bytes, milliseconds);
      }
    } else {
      peer.failedChunks++;
    }
    
    this.checkPeerHealth(peer);
  }

  checkPeerHealth(peer) {
    const totalRequests = peer.successfulChunks + peer.failedChunks;
    
    if (totalRequests < 10) {
      return;
    }
    
    const successRate = peer.successfulChunks / totalRequests;
    
    if (successRate < 0.5 || peer.timeouts > 5) {
      console.warn(`🚫 Banning peer ${peer.peerId.substring(0, 8)} (success rate: ${(successRate * 100).toFixed(1)}%, timeouts: ${peer.timeouts})`);
      this.removePeer(peer.peerId);
    }
  }

  getStats() {
    return {
      totalPeers: this.peers.size,
      activePeers: Array.from(this.peers.values()).filter(p => p.activeRequests.size > 0).length,
      totalRequests: Array.from(this.peers.values()).reduce((sum, p) => sum + p.activeRequests.size, 0)
    };
  }

  getPeer(peerId) {
    return this.peers.get(peerId);
  }
}
