/**
 * Network layer for SwarmFS
 * Handles P2P connections via Hyperswarm
 */

import Hyperswarm from 'hyperswarm';
import { EventEmitter } from 'events';

const VERBOSE = process.env.SWARMFS_VERBOSE === '1' || process.env.SWARMFS_VERBOSE === 'true';
const debug = (...args) => {
  if (VERBOSE) {
    console.log(...args);
  }
};

export class SwarmNetwork extends EventEmitter {
  constructor(config = {}) {
    super();
    
    debug('[NETWORK] Initializing SwarmNetwork...');
    
    this.config = {
      maxConnections: config.maxConnections || 50,
      ...config
    };
    
    // Initialize Hyperswarm
    debug('[NETWORK] Creating Hyperswarm instance...');

    this.swarm = new Hyperswarm({
      maxPeers: this.config.maxConnections
    });
    
    // Track active topics and connections
    // topics: topicKeyHex -> { discovery, name, key, connections: Map<peerId, conn> }
    this.topics = new Map();
    // peerConnections: peerId -> { conn, topics: Set<topicKeyHex> }
    this.peerConnections = new Map();

    this.setupSwarmHandlers();
    
    debug('[NETWORK] SwarmNetwork initialized');
  }

  /**
   * Join a topic
   * @param {string} topicName - Human-readable topic name
   * @param {Buffer} topicKey - 32-byte topic key
   */
  async joinTopic(topicName, topicKey) {
    // Check if already joined
    const topicKeyHex = topicKey.toString('hex');
    if (this.topics.has(topicKeyHex)) {
      debug(`[NETWORK] Already joined topic: ${topicName}`);
      return;
    }

    debug(`[NETWORK] Joining topic: ${topicName}`);
    debug(`[NETWORK] Topic key: ${topicKeyHex}`);

    // Join the swarm
    const discovery = this.swarm.join(topicKey, {
      server: true,  // Accept connections
      client: true   // Make connections
    });

    // Wait for topic to be fully announced
    await discovery.flushed();

    // Store topic info
    this.topics.set(topicKeyHex, {
      discovery,
      name: topicName,
      key: topicKey,
      connections: new Map()
    });

    this.emit('topic:joined', topicName, topicKeyHex);
    debug(`[NETWORK] ✓ Joined topic: ${topicName}`);
    debug(`[NETWORK]   Discovering peers...`);
  }

  /**
   * Leave a topic
   */
  async leaveTopic(topicName, topicKey) {
    const topicKeyHex = topicKey.toString('hex');
    const topic = this.topics.get(topicKeyHex);

    if (!topic) {
      debug(`[NETWORK] Not joined to topic: ${topicName}`);
      return;
    }

    debug(`[NETWORK] Leaving topic: ${topicName}`);

    // Destroy the discovery
    await topic.discovery.destroy();
    this.topics.delete(topicKeyHex);

    // Close connections that only belonged to this topic
    for (const [peerId, peerInfo] of this.peerConnections) {
      peerInfo.topics.delete(topicKeyHex);
      if (peerInfo.topics.size === 0) {
        try {
          peerInfo.conn.destroy();
        } catch {
          // ignore
        }
        this.peerConnections.delete(peerId);
      }
    }

    this.emit('topic:left', topicName, topicKeyHex);
    debug(`[NETWORK] ✓ Left topic: ${topicName}`);
  }

  /**
   * Handle new peer connection
   */
  setupSwarmHandlers() {
    this.swarm.on('connection', (conn, info) => {
      const peerId = (conn.remotePublicKey || info.publicKey).toString('hex');

      conn.on('error', (err) => {
        console.error(`[NETWORK] ⚠️  Connection error with ${peerId.substring(0, 8)}:`, err.message);
      });

      // Hyperswarm can report multiple topics. Sometimes info.topics is empty.
      // We only track connections under topics we joined.
      const joinedTopicKeys = (info.topics || []).filter((t) => this.topics.has(t.toString('hex')));
      const inferredTopicKeys = joinedTopicKeys.length > 0
        ? joinedTopicKeys
        : Array.from(this.topics.keys()).map((hex) => Buffer.from(hex, 'hex'));

      debug(`\n[NETWORK] 🔗 Peer connected: ${peerId.substring(0, 16)}...`);
      if (inferredTopicKeys.length === 0) {
        debug('[NETWORK]    No joined topics yet; connection will not be attributed to a topic');
      }

      if (!this.peerConnections.has(peerId)) {
        this.peerConnections.set(peerId, { conn, topics: new Set() });
      }

      const peerConn = this.peerConnections.get(peerId);
      // Hyperswarm can establish multiple connections to the same peer.
      // Always treat the latest conn as authoritative for this peer to avoid stale conn references.
      peerConn.conn = conn;

      for (const t of inferredTopicKeys) {
        const topicKeyHex = t.toString('hex');
        const topic = this.topics.get(topicKeyHex);
        if (!topic) {
          continue;
        }

        peerConn.topics.add(topicKeyHex);
        topic.connections.set(peerId, conn);

        debug(`[NETWORK]    Topic: ${topic.name}`);

        // Emit both event styles for compatibility across older/newer layers.
        this.emit('peer:connected', { conn, peerId, topicKey: t });
        this.emit('peer:connect', { conn, peerId, topicKey: t });
      }

      this.setupConnectionHandlers(conn, peerId);
    });
  }

  setupConnectionHandlers(conn, peerId) {
    conn.on('data', (data) => {
      const peerConn = this.peerConnections.get(peerId);
      const topics = peerConn ? Array.from(peerConn.topics) : [];

      // If we know the topic(s), emit one event per topic for deterministic routing.
      if (topics.length > 0) {
        for (const topicKeyHex of topics) {
          this.emit('peer:data', { conn, peerId, topicKey: Buffer.from(topicKeyHex, 'hex'), data });
        }
        return;
      }

      // Fallback: positional payload (older callers)
      this.emit('peer:data', conn, peerId, data);
    });

    conn.on('close', () => {
      debug(`\n[NETWORK] ❌ Peer disconnected: ${peerId.substring(0, 16)}...`);

      const peerConn = this.peerConnections.get(peerId);
      const topics = peerConn ? Array.from(peerConn.topics) : [];

      for (const topicKeyHex of topics) {
        const topic = this.topics.get(topicKeyHex);
        if (topic) {
          topic.connections.delete(peerId);
        }

        const topicKey = Buffer.from(topicKeyHex, 'hex');
        this.emit('peer:disconnected', { peerId, topicKey });
        this.emit('peer:disconnect', { peerId, topicKey });
      }

      // Only delete if this is the currently tracked connection for the peer.
      // Otherwise another active conn exists and should keep topic attribution.
      if (peerConn && peerConn.conn === conn) {
        this.peerConnections.delete(peerId);
      }
    });
  }

  /**
   * Get connection statistics
   */
  getStats() {
    return {
      topics: this.topics.size,
      connections: Array.from(this.topics.values()).reduce((acc, t) => acc + (t.connections?.size || 0), 0),
      activeTopics: Array.from(this.topics.values()).map(t => t.name)
    };
  }

  /**
   * Broadcast data to all connections in a topic
   */
  broadcast(topicKey, data) {
    const topicKeyHex = topicKey.toString('hex');
    let sent = 0;

    debug(`[NETWORK] Broadcasting ${data.length} bytes to topic ${topicKeyHex.substring(0, 16)}...`);

    const topic = this.topics.get(topicKeyHex);
    if (!topic || !topic.connections) {
      debug('[NETWORK] Broadcast: topic not joined');
      return 0;
    }

    for (const [peerId, conn] of topic.connections) {
      try {
        debug(`[NETWORK]   -> Sending to peer ${peerId.substring(0, 8)}`);
        conn.write(data);
        sent++;
      } catch (err) {
        console.error(`[NETWORK] ⚠️  Broadcast error to ${peerId.substring(0, 8)}:`, err.message);
      }
    }

    debug(`[NETWORK] Broadcast complete: sent to ${sent} peer(s)`);
    return sent;
  }

  /**
   * Close network and cleanup
   */
  async close() {
    debug('[NETWORK] Closing network...');

    // Leave all topics
    for (const [topicKeyHex, topic] of this.topics) {
      await topic.discovery.destroy();
    }

    // Close all connections
    for (const [peerId, peerInfo] of this.peerConnections) {
      try {
        peerInfo.conn.destroy();
      } catch {
        // ignore
      }
      this.peerConnections.delete(peerId);
    }

    // Destroy swarm
    await this.swarm.destroy();

    this.topics.clear();
    this.peerConnections.clear();

    debug('[NETWORK] ✓ Network closed');
  }
}
