/**
 * Network layer for SwarmFS
 * Handles P2P connections via Hyperswarm
 */

import Hyperswarm from 'hyperswarm';
import crypto from 'hypercore-crypto';
import { EventEmitter } from 'events';

const debug = (...args) => {
  const verbose = process.env.SWARMFS_VERBOSE === '1' || process.env.SWARMFS_VERBOSE === 'true';
  if (verbose) console.log(...args);
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
    
    // Initialize Hyperswarm (workshop pattern: single swarm)
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

    // Join the swarm (workshop pattern: single swarm)
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
   * 
   * Protocol flow:
   * 1. Discovery topic: non-indexer requests key, indexer sends autobase.key
   * 2. After key exchange: non-indexer sends writer-request, indexer adds writer
   * 3. Then: start replication
   */
  setupSwarmHandlers() {
    this.swarm.on('connection', (conn, info) => {
      const peerId = (conn.remotePublicKey || info.publicKey).toString('hex');

      console.log(`\n[NETWORK] 🔗 Peer connected: ${peerId.substring(0, 16)}...`);

      conn.on('error', (err) => {
        console.error(`[NETWORK] ⚠️  Connection error with ${peerId.substring(0, 8)}:`, err.message);
      });

      // Track topics for this connection
      const attributedTopicKeys = (info.topics || []).filter((t) => this.topics.has(t.toString('hex')));
      
      // Debug: show what topics are being attributed
      console.log(`[NETWORK] DEBUG info.topics count: ${(info.topics || []).length}`);
      console.log(`[NETWORK] DEBUG this.topics count: ${this.topics.size}`);
      console.log(`[NETWORK] DEBUG attributed topics: ${attributedTopicKeys.length}`);
      
      if ((info.topics || []).length > 0) {
        for (const t of info.topics) {
          const hex = t.toString('hex');
          const hasIt = this.topics.has(hex);
          console.log(`[NETWORK] DEBUG topic ${hex.slice(0, 16)}... tracked: ${hasIt}`);
        }
      }

      if (!this.peerConnections.has(peerId)) {
        this.peerConnections.set(peerId, { conn, topics: new Set() });
      }
      const peerConn = this.peerConnections.get(peerId);
      peerConn.conn = conn;

      for (const t of attributedTopicKeys) {
        const topicKeyHex = t.toString('hex');
        const topic = this.topics.get(topicKeyHex);
        if (!topic) continue;

        peerConn.topics.add(topicKeyHex);
        topic.connections.set(peerId, conn);

        console.log(`[NETWORK]    Topic: ${topic.name}`);
        this.emit('peer:connected', { conn, peerId, topicKey: t });
        this.emit('peer:connect', { conn, peerId, topicKey: t });
      }

      // Setup close handler
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

      // Handle discovery topic protocol (key exchange + writer handshake)
      if (this.userDatabase) {
        this._handleDiscoveryProtocol(conn, peerId);
      } else {
        // Queue the connection - will be processed when joinUserTopic is called
        console.log(`[NETWORK] Connection before userDatabase set, queuing...`)
        if (!this._pendingConnections) {
          this._pendingConnections = []
        }
        this._pendingConnections.push({ conn, peerId })
      }
    });
  }

  /**
   * Process any pending connections (called by joinUserTopic)
   */
  _processPendingConnections() {
    if (!this._pendingConnections) return
    
    for (const { conn, peerId } of this._pendingConnections) {
      if (!conn.destroyed) {
        this._handleDiscoveryProtocol(conn, peerId)
      }
    }
    this._pendingConnections = []
  }

  /**
   * Handle discovery topic protocol: key exchange + writer handshake
   * 
   * Indexer flow:
   *   - Receive get-key request → send autobase.key
   *   - Receive writer-request → add writer, send writer-added
   *   - Start replication
   * 
   * Non-indexer flow:
   *   - Send get-key request → receive autobase.key
   *   - (userdb creates autobase with received key)
   *   - Send writer-request → receive writer-added
   *   - Start replication
   */
  _handleDiscoveryProtocol(conn, peerId) {
    // Use options.isIndexer (set at creation) not autobase.isIndexer
    // Non-indexers don't have autobase yet when they first connect
    const isIndexer = this.userDatabase.options?.isIndexer === true
    const autobase = this.userDatabase.autobase
    const hasAutobase = !!autobase
    
    console.log(`[NETWORK] Connection from ${peerId.slice(0, 16)}...`)
    console.log(`[NETWORK]   Role: ${isIndexer ? 'INDEXER' : 'NON-INDEXER'}`)
    console.log(`[NETWORK]   Has autobase: ${hasAutobase}`)
    
    let buffer = ''
    const replicationStarted = { started: false }
    
    const onData = (data) => {
      if (replicationStarted.started) return
      
      buffer += data.toString()
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        
        if (!line) continue
        
        try {
          const msg = JSON.parse(line)
          console.log(`[NETWORK] Received: ${msg.type} from ${peerId.slice(0, 16)}...`)
          
          // === INDEXER HANDLERS ===
          if (isIndexer) {
            // Key request from non-indexer
            if (msg.type === 'get-key' && autobase) {
              const keyMsg = JSON.stringify({
                type: 'autobase-key',
                key: autobase.key.toString('hex')
              }) + '\n'
              conn.write(keyMsg)
              console.log(`[NETWORK] INDEXER: Sent autobase key: ${autobase.key.toString('hex').slice(0, 16)}...`)
            }
            
            // Writer request from non-indexer
            if (msg.type === 'writer-request' && msg.key) {
              console.log(`[NETWORK] INDEXER: Writer request from: ${msg.key.slice(0, 16)}...`)
              this._handleWriterRequest(conn, msg.key)
            }
          }
          
          // === NON-INDEXER HANDLERS ===
          if (!isIndexer) {
            // Receive autobase key from indexer
            if (msg.type === 'autobase-key' && msg.key) {
              console.log(`[NETWORK] NON-INDEXER: Received autobase key: ${msg.key.slice(0, 16)}...`)
              this.emit('autobase-key-received', { key: Buffer.from(msg.key, 'hex'), peerId })
              
              // Send writer request immediately after receiving key
              // We need to wait for the autobase to be created by the event handler
              setTimeout(async () => {
                if (this.userDatabase.autobase && this.userDatabase.autobase.local) {
                  const writerKey = this.userDatabase.autobase.local.key.toString('hex')
                  conn.write(JSON.stringify({
                    type: 'writer-request',
                    key: writerKey
                  }) + '\n')
                  console.log(`[NETWORK] NON-INDEXER: Sent writer request: ${writerKey.slice(0, 16)}...`)
                }
              }, 500) // Small delay to let autobase be created
            }
            
            // Writer added confirmation
            if (msg.type === 'writer-added') {
              console.log(`[NETWORK] NON-INDEXER: Writer-added confirmation received`)
              this._startReplication(conn, onData, replicationStarted)
            }
          }
        } catch {
          // Not JSON, ignore
        }
      }
    }
    
    conn.on('data', onData)
    
    // NON-INDEXER: send get-key request
    if (!isIndexer) {
      conn.write(JSON.stringify({ type: 'get-key' }) + '\n')
      console.log(`[NETWORK] NON-INDEXER: Sent get-key request`)
    }
    
    // NON-INDEXER with autobase: send writer request (after key received and autobase created)
    if (!isIndexer && hasAutobase && autobase.local) {
      conn.write(JSON.stringify({
        type: 'writer-request',
        key: autobase.local.key.toString('hex')
      }) + '\n')
      console.log(`[NETWORK] NON-INDEXER: Sent writer request: ${autobase.local.key.toString('hex').slice(0, 16)}...`)
    }
    
    // Timeout: start replication anyway after 10s
    setTimeout(() => {
      if (!replicationStarted.started && hasAutobase) {
        console.log('[NETWORK] Handshake timeout, starting replication')
        this._startReplication(conn, onData, replicationStarted)
      }
    }, 10000)
  }
  
  /**
   * Handle writer request (indexer only)
   */
  async _handleWriterRequest(conn, keyHex) {
    try {
      await this.userDatabase.addWriter(Buffer.from(keyHex, 'hex'))
      console.log(`[NETWORK] Added writer: ${keyHex.slice(0, 16)}...`)
      
      conn.write(JSON.stringify({ type: 'writer-added' }) + '\n')
      console.log('[NETWORK] Sent writer-added confirmation')
      
      // Start replication after adding writer
      // Note: The connection is still in discovery protocol mode
      // Replication will be started when writer-added is processed
    } catch (err) {
      console.log(`[NETWORK] Failed to add writer: ${err.message}`)
    }
  }
  
  /**
   * Start replication after handshake complete
   */
  _startReplication(conn, dataHandler, state) {
    if (state.started) return
    state.started = true
    
    conn.removeListener('data', dataHandler)
    this.userDatabase.store.replicate(conn)
    console.log('[NETWORK] Corestore replication active')
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
   * Join the user discovery topic for key exchange
   * Uses a topic derived from the user's mnemonic (same for all devices)
   * NOT the autobase.discoveryKey (which is unknown to non-indexers initially)
   * @param {Object} identity - IdentityManager instance
   * @param {Object} userDatabase - UserDatabase instance
   */
  async joinUserTopic(identity, userDatabase) {
    this.userDatabase = userDatabase;
    this.identity = identity;

    // Derive discovery topic from mnemonic (same for all devices with same mnemonic)
    const mnemonic = identity.mnemonic
    if (!mnemonic) {
      console.log('[NETWORK] ERROR: No mnemonic available for discovery topic');
      console.log('[NETWORK] identity.mnemonic:', identity.mnemonic);
      console.log('[NETWORK] identity has mnemonic:', !!identity.mnemonic);
      return null;
    }
    
    // Debug: show full mnemonic to verify they match
    console.log(`[NETWORK] DEBUG Full mnemonic: "${mnemonic}"`);
    console.log(`[NETWORK] DEBUG mnemonic length: ${mnemonic.length}`);
    
    const crypto = await import('hypercore-crypto')
    const namespace = Buffer.from('swarmfs-user-discovery-v1')
    const combined = Buffer.concat([namespace, Buffer.from(mnemonic)])
    const discoveryTopic = crypto.hash(combined)
    
    console.log(`[NETWORK] DEBUG namespace hex: ${namespace.toString('hex')}`);
    console.log(`[NETWORK] DEBUG combined length: ${combined.length}`);
    console.log(`[NETWORK] DEBUG discovery topic hex: ${discoveryTopic.toString('hex')}`);
    
    console.log(`[NETWORK] Joining discovery topic: ${discoveryTopic.toString('hex').substring(0, 16)}...`);
    
    await this.joinTopic('user-discovery', discoveryTopic);
    this.autobaseTopic = discoveryTopic.toString('hex');
    this.emit('user:topic:joined', this.autobaseTopic);

    console.log('[NETWORK] Joined discovery topic - key exchange will happen here');
    
    // Process any connections that arrived before we were ready
    this._processPendingConnections();
    
    return discoveryTopic;
  }
  
  /**
   * Leave the user topic
   */
  async leaveUserTopic() {
    if (!this.autobaseTopic) {
      return;
    }

    const topicKey = Buffer.from(this.autobaseTopic, 'hex');
    await this.leaveTopic('autobase-replication', topicKey);

    this.autobaseTopic = null;
    this.userDatabase = null;
    this.emit('user:topic:left');
  }

  /**
   * Get user topic key if joined
   * @returns {Buffer|null}
   */
  getUserTopicKey() {
    return this.autobaseTopic ? Buffer.from(this.autobaseTopic, 'hex') : null;
  }

  /**
   * Check if connected to user topic
   * @returns {boolean}
   */
  isUserTopicJoined() {
    return this.autobaseTopic !== null;
  }
}
