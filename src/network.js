/**
 * Network layer for SwarmFS
 * Handles P2P connections via Hyperswarm
 */

import Hyperswarm from 'hyperswarm';
import crypto from 'hypercore-crypto';
import { EventEmitter } from 'events';

const VERBOSE = process.env.SWARMFS_VERBOSE === '1' || process.env.SWARMFS_VERBOSE === 'true';
const debug = (...args) => {
  if (VERBOSE) {
    console.log(...args);
  }
};

// Namespace for user topic derivation
const USER_TOPIC_NAMESPACE = Buffer.from('swarmfs-user-v1');

export class SwarmNetwork extends EventEmitter {
  constructor(config = {}) {
    super();
    
    debug('[NETWORK] Initializing SwarmNetwork...');
    
    this.config = {
      maxConnections: config.maxConnections || 50,
      flushTimeoutMs: config.flushTimeoutMs || 30000,
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
    
    // User topic for identity/database sync
    this.userTopic = null;
    this.userDatabase = null;

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

    // Store topic info immediately to avoid races where Hyperswarm emits
    // incoming connections before we've registered this topic.
    // Without this, early connections can end up unattributed, leading to
    // asymmetric peer visibility and one-way request capability.
    this.topics.set(topicKeyHex, {
      discovery,
      name: topicName,
      key: topicKey,
      connections: new Map()
    });

    // Wait for topic to be fully announced
    await discovery.flushed();

    // Accelerate peer convergence. flush() is heavyweight but ensures Hyperswarm
    // processes pending DHT operations + queued peer connections.
    const flushTimeoutMs = this.config.flushTimeoutMs;
    if (Number.isFinite(flushTimeoutMs) && flushTimeoutMs > 0) {
      await Promise.race([
        this.swarm.flush(),
        new Promise((resolve) => setTimeout(resolve, flushTimeoutMs))
      ]);
    } else {
      await this.swarm.flush();
    }

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

      // Hyperswarm v3: In client mode, peerInfo.topics is set.
      // In server mode (incoming connections), peerInfo.topics can be empty.
      // For our protocol, we still need to be able to broadcast per-topic requests
      // to incoming peers, so we conservatively attribute server-mode connections
      // to all currently joined topics.
      const joinedTopicKeys = (info.topics || []).filter((t) => this.topics.has(t.toString('hex')));
      const attributedTopicKeys = joinedTopicKeys.length > 0
        ? joinedTopicKeys
        : Array.from(this.topics.keys()).map((hex) => Buffer.from(hex, 'hex'));

      debug(`\n[NETWORK] 🔗 Peer connected: ${peerId.substring(0, 16)}...`);

      if (attributedTopicKeys.length === 0) {
        debug('[NETWORK]    No joined topics yet; connection will not be attributed to a topic');
      }

      // Check if this is a user topic connection for key exchange
      const isUserTopic = this.userTopic && attributedTopicKeys.some(t => t.toString('hex') === this.userTopic);
      
      // Check if this is an autobase replication connection
      const isAutobaseTopic = this.autobaseTopic && attributedTopicKeys.some(t => t.toString('hex') === this.autobaseTopic);
      
      if (isUserTopic && this.userDatabase) {
        debug(`[NETWORK]    Setting up key exchange for user topic`);
        // Use workshop pattern: key exchange + store.replicate
        const isIndexer = this.userDatabase.autobase.isIndexer;
        this._handleUserTopicConnection(conn, peerId, isIndexer);
      }
      
      if (isAutobaseTopic && this.userDatabase) {
        debug(`[NETWORK]    Setting up replication for autobase topic`);
        // Just set up store replication for data sync
        this.userDatabase.store.replicate(conn);
      }

      if (!this.peerConnections.has(peerId)) {
        this.peerConnections.set(peerId, { conn, topics: new Set() });
      }

      const peerConn = this.peerConnections.get(peerId);
      peerConn.conn = conn;

      for (const t of attributedTopicKeys) {
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

      if (attributedTopicKeys.length === 0) {
        this.emit('peer:connected', { conn, peerId, topicKey: null });
        this.emit('peer:connect', { conn, peerId, topicKey: null });
      }

      // Only set up data handlers for non-replication connections
      // User topic and autobase topic replication is handled by corestore
      if (!isUserTopic && !isAutobaseTopic) {
        this.setupConnectionHandlers(conn, peerId);
      }
    });
  }

  setupConnectionHandlers(conn, peerId) {
    conn.on('data', (data) => {
      const peerConn = this.peerConnections.get(peerId);
      const topics = peerConn ? Array.from(peerConn.topics) : [];

      // Emit only once per chunk. If topics are known, include them as metadata.
      // Protocol currently ignores topicKey on peer:data anyway, and duplicating
      // peer:data breaks message reassembly/decoding.
      if (topics.length > 0) {
        this.emit('peer:data', { conn, peerId, topicKeys: topics, data });
        return;
      }

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

      if (peerConn && peerConn.conn === conn) {
        this.peerConnections.delete(peerId);
      }
    });
  }

  /**
   * Get connection statistics
   */
  getStats() {
    const topicsDetails = Array.from(this.topics.values()).map((t) => ({
      name: t.name,
      peers: t.connections?.size || 0
    }));

    return {
      topics: this.topics.size,
      peerCount: this.peerConnections.size,
      connections: Array.from(this.topics.values()).reduce((acc, t) => acc + (t.connections?.size || 0), 0),
      activeTopics: topicsDetails.map((t) => t.name),
      topicsDetails
    };
  }

  /**
   * Broadcast data to all connections in a topic
   * @param {Buffer} topicKey - Topic key
   * @param {Buffer} data - Data to broadcast
   * @param {Function} sendFn - Optional send function (conn, data) => Promise - used by Protocol for Protomux
   */
  broadcast(topicKey, data, sendFn) {
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
        if (sendFn) {
          // Use Protocol's send function (routes through Protomux)
          sendFn(conn, data);
        } else {
          // Direct write (legacy, should not happen with Protomux)
          conn.write(data);
        }
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

  /**
   * Derive a deterministic topic from user identity
   * All devices of the same user will use the same topic
   * @param {Buffer} identityPublicKey - User's identity public key
   * @returns {Buffer} Topic key
   */
  deriveUserTopic(identityPublicKey) {
    const combined = Buffer.concat([USER_TOPIC_NAMESPACE, identityPublicKey]);
    return crypto.hash(combined);
  }

  /**
   * Join the user topic for database replication
   * Uses identity-derived discovery topic so all devices with same mnemonic find each other
   * Implements workshop pattern for key exchange and replication
   * @param {Object} identity - IdentityManager instance
   * @param {Object} userDatabase - UserDatabase instance to replicate
   */
  async joinUserTopic(identity, userDatabase) {
    // Use identity-derived topic for discovery (same for all devices with same mnemonic)
    const discoveryTopic = identity.deriveUserSwarmTopic();
    
    debug(`[NETWORK] Joining user discovery topic: ${discoveryTopic.toString('hex').substring(0, 16)}...`);

    this.userDatabase = userDatabase;
    this.identity = identity;

    // Join the discovery topic for key exchange
    await this.joinTopic('user-swarm', discoveryTopic);

    this.userTopic = discoveryTopic.toString('hex');
    this.emit('user:topic:joined', this.userTopic);
    
    // Only join autobase.discoveryKey if autobase already exists
    // New devices will join this topic after receiving the key
    const autobaseDiscoveryKey = userDatabase.autobase?.discoveryKey;
    if (autobaseDiscoveryKey) {
      debug(`[NETWORK] Joining autobase discovery key: ${autobaseDiscoveryKey.toString('hex').substring(0, 16)}...`);
      await this.joinTopic('autobase-replication', autobaseDiscoveryKey);
      this.autobaseTopic = autobaseDiscoveryKey.toString('hex');
    }

    return discoveryTopic;
  }
  
  /**
   * Handle user topic connection - key exchange and replication
   * Workshop pattern: indexer sends key, new devices request to be added as writer
   */
  _handleUserTopicConnection(conn, peerId, isIndexer) {
    const autobase = this.userDatabase.autobase;
    
    // Set up corestore replication (workshop pattern)
    this.userDatabase.store.replicate(conn);
    
    // Key exchange protocol
    conn.on('data', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // New device receives autobase key from indexer
        if (msg.type === 'autobase-key' && !isIndexer) {
          console.log(`[NETWORK] Received autobase key: ${msg.key.slice(0, 16)}...`);
          this.emit('user:autobase-key-received', { key: Buffer.from(msg.key, 'hex'), peerId });
          
          // Send writer request immediately
          const writerMsg = JSON.stringify({ 
            type: 'writer-key', 
            key: autobase.local.key.toString('hex') 
          });
          conn.write(writerMsg);
          console.log(`[NETWORK] Sent writer request: ${autobase.local.key.toString('hex').slice(0, 16)}...`);
        }
        
        // Indexer receives writer key request from new device
        if (msg.type === 'writer-key' && isIndexer) {
          console.log(`[NETWORK] Writer request: ${msg.key.slice(0, 16)}...`);
          this.emit('user:writer-request', { key: Buffer.from(msg.key, 'hex'), peerId });
        }
      } catch {
        // Not JSON, ignore (replication data)
      }
    });
    
    // If we're an indexer, send our autobase key
    if (isIndexer) {
      const keyMsg = JSON.stringify({ 
        type: 'autobase-key', 
        key: autobase.key.toString('hex') 
      });
      conn.write(keyMsg);
      console.log(`[NETWORK] Sent autobase key to peer`);
    }
  }

  /**
   * Leave the user topic
   */
  async leaveUserTopic() {
    if (!this.userTopic) {
      return;
    }

    const topicKey = Buffer.from(this.userTopic, 'hex');
    await this.leaveTopic('user-sync', topicKey);

    this.userTopic = null;
    this.userDatabase = null;
    this.emit('user:topic:left');
  }

  /**
   * Set up connection for user topic - handles key exchange and replication
   * Pattern: indexers broadcast their autobase key, new devices receive and rejoin
   */
  _setupUserTopicConnection(conn, peerId) {
    const autobase = this.userDatabase.autobase;
    const isIndexer = autobase.isIndexer;
    
    // Set up replication first
    autobase.replicate(conn);
    
    // Key exchange protocol
    conn.on('data', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // New device receives autobase key from indexer
        if (msg.type === 'autobase-key' && !isIndexer) {
          console.log(`[NETWORK] Received autobase key from indexer: ${msg.key.slice(0, 16)}...`);
          
          // Check if we need to rejoin with this key
          const currentKey = autobase.key?.toString('hex');
          if (currentKey !== msg.key) {
            console.log(`[NETWORK] Different autobase key, need to rejoin`);
            // Emit event so UserDatabase can handle rejoin
            this.emit('user:autobase-key-received', { key: Buffer.from(msg.key, 'hex'), peerId });
          }
        }
        
        // Indexer receives writer key request from new device
        if (msg.type === 'writer-key' && isIndexer) {
          console.log(`[NETWORK] New device wants to join: ${msg.key.slice(0, 16)}...`);
          // Emit event so we can add them as writer
          this.emit('user:writer-request', { key: Buffer.from(msg.key, 'hex'), peerId });
        }
      } catch {
        // Not JSON, ignore (replication data)
      }
    });
    
    // If we're an indexer, broadcast our key
    if (isIndexer) {
      // Send our autobase key to the peer
      const keyMsg = JSON.stringify({ 
        type: 'autobase-key', 
        key: autobase.key.toString('hex') 
      });
      conn.write(keyMsg);
      console.log(`[NETWORK] Sent autobase key to peer`);
    } else {
      // We're not an indexer, send our local key to request being added
      const writerMsg = JSON.stringify({ 
        type: 'writer-key', 
        key: autobase.local.key.toString('hex') 
      });
      conn.write(writerMsg);
      console.log(`[NETWORK] Sent writer key request to indexer`);
    }
  }

  /**
   * Get user topic key if joined
   * @returns {Buffer|null}
   */
  getUserTopicKey() {
    return this.userTopic ? Buffer.from(this.userTopic, 'hex') : null;
  }

  /**
   * Check if connected to user topic
   * @returns {boolean}
   */
  isUserTopicJoined() {
    return this.userTopic !== null;
  }
}
