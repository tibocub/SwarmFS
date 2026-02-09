/**
 * ChunkScheduler - Implements rarest-first chunk scheduling
 */

export const ChunkState = {
  MISSING: 'missing',
  REQUESTED: 'requested',
  RECEIVED: 'received',
  VERIFIED: 'verified',
  FAILED: 'failed'
};

export class ChunkScheduler {
  constructor(session) {
    this.session = session;
    this.inEndgame = false;
    this.endgameThreshold = 20;
  }

  getNextChunks(limit) {
    const progress = this.session.chunksVerified / this.session.totalChunks;
    
    if (progress >= 0.95 || this.getRemainingCount() <= this.endgameThreshold) {
      if (!this.inEndgame) {
        this.enterEndgame();
      }
      return this.getEndgameChunks(limit);
    }
    
    return this.getRarestChunks(limit);
  }

  getRarestChunks(limit) {
    const missing = this.getMissingChunks();
    if (missing.length === 0) {
      return [];
    }

    // If we have no availability information yet (or it hasn't arrived),
    // strict rarest-first will see rarity=0 for everything and request nothing.
    // Probe by requesting a few missing chunks so peers can respond with offers.
    let knownAvailability = 0;
    for (const chunkIndex of missing) {
      if (this.getRarity(chunkIndex) > 0) {
        knownAvailability++;
      }
    }
    if (knownAvailability === 0) {
      return this.shuffle(missing).slice(0, limit);
    }

    const rarityMap = new Map();
    for (const chunkIndex of missing) {
      rarityMap.set(chunkIndex, this.getRarity(chunkIndex));
    }

    const rarityGroups = new Map();
    for (const [chunkIndex, rarity] of rarityMap) {
      if (!rarityGroups.has(rarity)) {
        rarityGroups.set(rarity, []);
      }
      rarityGroups.get(rarity).push(chunkIndex);
    }

    const sortedRarities = Array.from(rarityGroups.keys()).sort((a, b) => a - b);

    const selected = [];
    for (const rarity of sortedRarities) {
      const chunks = rarityGroups.get(rarity);
      
      if (rarity === 0) {
        continue;
      }

      if (rarity === 1) {
        selected.push(...chunks);
        continue;
      }

      const shuffled = this.shuffle(chunks);
      selected.push(...shuffled);

      if (selected.length >= limit) {
        break;
      }
    }

    return selected.slice(0, limit);
  }

  getRarity(chunkIndex) {
    const peers = this.session.peerManager.availabilityIndex.get(chunkIndex);
    return peers ? peers.size : 0;
  }

  getMissingChunks() {
    const missing = [];
    for (const [index, chunk] of this.session.chunkStates) {
      if (chunk.state === ChunkState.MISSING || 
          chunk.state === ChunkState.FAILED) {
        missing.push(index);
      }
    }
    return missing;
  }

  getRemainingCount() {
    return this.session.totalChunks - this.session.chunksVerified;
  }

  getEndgameChunks(limit) {
    const missing = this.getMissingChunks();
    return missing;
  }

  enterEndgame() {
    console.log('📍 ENDGAME MODE: Requesting remaining chunks from all peers');
    this.inEndgame = true;
  }

  shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  getStats() {
    const missing = this.getMissingChunks();
    const rarityMap = new Map();

    for (const chunkIndex of missing) {
      const rarity = this.getRarity(chunkIndex);
      if (!rarityMap.has(rarity)) {
        rarityMap.set(rarity, 0);
      }
      rarityMap.set(rarity, rarityMap.get(rarity) + 1);
    }

    return {
      totalMissing: missing.length,
      unavailable: rarityMap.get(0) || 0,
      critical: rarityMap.get(1) || 0,
      rare: rarityMap.get(2) || 0,
      common: missing.length - (rarityMap.get(0) || 0) - (rarityMap.get(1) || 0) - (rarityMap.get(2) || 0),
      inEndgame: this.inEndgame
    };
  }
}
