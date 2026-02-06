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
    this.topics = new Map(); // topicKey -> { discovery, name }
    this.connections = new Map(); // peerId -> { conn, topics: Set }
    
    // Setup connection handler
    this.swarm.on('connection', (conn, info) => {
      this.handleConnection(conn, info);
    });
    
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
      key: topicKey
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
    for (const [peerId, peerInfo] of this.connections) {
      peerInfo.topics.delete(topicKeyHex);
      if (peerInfo.topics.size === 0) {
        peerInfo.conn.destroy();
      }
    }

    this.emit('topic:left', topicName, topicKeyHex);
    debug(`[NETWORK] ✓ Left topic: ${topicName}`);
  }

  /**
   * Handle new peer connection
   */
  handleConnection(conn, info) {
    const peerId = conn.remotePublicKey.toString('hex');
    
    debug(`\n[NETWORK] 🔗 Peer connected: ${peerId.substring(0, 16)}...`);

    // Find which topic this connection belongs to
    const topicKey = info.topics[0]?.toString('hex');
    const topic = this.topics.get(topicKey);

    if (topic) {
      debug(`[NETWORK]    Topic: ${topic.name}`);
    }

    // Store connection info
    const peerInfo = this.connections.get(peerId) || {
      conn,
      topics: new Set()
    };

    if (topicKey) {
      peerInfo.topics.add(topicKey);
    }

    this.connections.set(peerId, peerInfo);

    // Emit event for protocol layer (Phase 4.3)
    this.emit('peer:connect', conn, {
      peerId,
      topics: Array.from(peerInfo.topics)
    });

    // Handle disconnection
    conn.on('close', () => {
      debug(`\n[NETWORK] ❌ Peer disconnected: ${peerId.substring(0, 16)}...`);
      this.connections.delete(peerId);
      this.emit('peer:disconnect', peerId);
    });

    // Handle data - CRITICAL for protocol
    conn.on('data', (data) => {
      debug(`[NETWORK] 📨 Data from ${peerId.substring(0, 8)}: ${data.length} bytes`);
      this.emit('peer:data', conn, peerId, data);
    });

    conn.on('error', (err) => {
      console.error(`[NETWORK] ⚠️  Connection error with ${peerId.substring(0, 8)}:`, err.message);
    });
  }

  /**
   * Get connection statistics
   */
  getStats() {
    return {
      topics: this.topics.size,
      connections: this.connections.size,
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

    for (const [peerId, peerInfo] of this.connections) {
      if (peerInfo.topics.has(topicKeyHex)) {
        debug(`[NETWORK]   -> Sending to peer ${peerId.substring(0, 8)}`);
        peerInfo.conn.write(data);
        sent++;
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
    for (const [peerId, peerInfo] of this.connections) {
      peerInfo.conn.destroy();
    }

    // Destroy swarm
    await this.swarm.destroy();

    this.topics.clear();
    this.connections.clear();

    debug('[NETWORK] ✓ Network closed');
  }
}
