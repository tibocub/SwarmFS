import { EventEmitter } from 'events'

export class NodeRuntime extends EventEmitter {
  constructor(swarmfs) {
    super()
    this.swarmfs = swarmfs
    this.started = false
    this._networkHandlersInstalled = false
  }

  async start() {
    if (this.started) return
    this.swarmfs.open()

    const topics = this.swarmfs.db.getAutoJoinTopics()
    for (const t of topics) {
      try {
        await this.swarmfs.joinTopic(t.name)
      } catch (e) {
        this.emit('log', { level: 'error', message: `Auto-join failed for ${t.name}: ${e?.message || e}` })
      }
    }

    this._installNetworkHandlersIfNeeded()
    this.started = true
  }

  async stop() {
    if (!this.started) return
    await this.swarmfs.close()
    this.started = false
  }

  status() {
    const dbOpen = !!this.swarmfs?.db
    const networkRunning = !!this.swarmfs?.network
    const protocolRunning = !!this.swarmfs?.protocol

    let networkStats = null
    if (this.swarmfs?.network) {
      try {
        networkStats = this.swarmfs.network.getStats()
      } catch {
        networkStats = null
      }
    }

    return {
      dbOpen,
      networkRunning,
      protocolRunning,
      dataDir: this.swarmfs?.dataDir,
      networkStats
    }
  }

  networkOverview() {
    const topics = this.swarmfs?.db ? this.swarmfs.db.getAllTopics() : []
    const stats = this.status().networkStats

    const joined = new Set(Array.isArray(stats?.activeTopics) ? stats.activeTopics : [])
    const peersByTopic = new Map(
      Array.isArray(stats?.topicsDetails)
        ? stats.topicsDetails.map((t) => [t?.name, Number(t?.peers || 0)])
        : []
    )

    const topicsView = (Array.isArray(topics) ? topics : []).map((t) => {
      const name = t?.name
      return {
        id: t?.id,
        name,
        topicKey: t?.topic_key,
        autoJoin: t?.auto_join === 1,
        createdAt: t?.created_at,
        lastJoinedAt: t?.last_joined_at,

        joined: joined.has(name),
        peers: peersByTopic.get(name) || 0
      }
    })

    return {
      stats: stats || null,
      topics: topicsView
    }
  }

  async listTopics() {
    return this.swarmfs.listTopics()
  }

  async joinTopic(name) {
    await this.swarmfs.joinTopic(name)
    this._installNetworkHandlersIfNeeded()
  }

  async leaveTopic(name) {
    await this.swarmfs.leaveTopic(name)
  }

  _installNetworkHandlersIfNeeded() {
    if (this._networkHandlersInstalled) return
    if (!this.swarmfs?.network) return

    const net = this.swarmfs.network

    net.on('topic:joined', (topicName, topicKeyHex) => {
      this.emit('network', { type: 'topic_joined', topicName, topicKeyHex })
    })

    net.on('topic:left', (topicName, topicKeyHex) => {
      this.emit('network', { type: 'topic_left', topicName, topicKeyHex })
    })

    net.on('peer:connected', (payload) => {
      if (payload && typeof payload === 'object' && payload.peerId) {
        this.emit('network', { type: 'peer_connected', peerId: payload.peerId, topicKey: payload.topicKey ? payload.topicKey.toString('hex') : null })
        return
      }
      const peerId = arguments.length > 1 ? arguments[1] : null
      const topicKey = arguments.length > 2 && arguments[2] ? arguments[2].toString('hex') : null
      this.emit('network', { type: 'peer_connected', peerId, topicKey })
    })

    net.on('peer:disconnected', (payload) => {
      if (payload && typeof payload === 'object' && payload.peerId) {
        this.emit('network', { type: 'peer_disconnected', peerId: payload.peerId, topicKey: payload.topicKey ? payload.topicKey.toString('hex') : null })
        return
      }
      const peerId = arguments.length > 0 ? arguments[0] : null
      const topicKey = arguments.length > 1 && arguments[1] ? arguments[1].toString('hex') : null
      this.emit('network', { type: 'peer_disconnected', peerId, topicKey })
    })

    this._networkHandlersInstalled = true
  }
}
