import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'

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

  async createTopic(name, autoJoin = true, password = null) {
    this.swarmfs.open()
    const n = String(name || '')
    if (!n) throw new Error('name required')
    const aj = autoJoin !== false
    const pw = password ? String(password) : null
    return await this.swarmfs.createTopic(n, aj, pw)
  }

  async deleteTopic(name) {
    this.swarmfs.open()
    const n = String(name || '')
    if (!n) throw new Error('name required')
    return await this.swarmfs.deleteTopic(n)
  }

  filesList() {
    this.swarmfs.open()
    const files = this.swarmfs.listFiles()
    const dirs = this.swarmfs.db.getAllDirectories()
    return { files, dirs }
  }

  filesInfo(path) {
    this.swarmfs.open()
    return this.swarmfs.getFileInfo(path)
  }

  async filesVerify(path) {
    this.swarmfs.open()
    return await this.swarmfs.verifyFile(path)
  }

  async filesAdd(paths) {
    this.swarmfs.open()
    const ps = Array.isArray(paths) ? paths : []
    if (ps.length === 0) throw new Error('paths required')

    const results = []
    for (const p0 of ps) {
      const p = String(p0 || '')
      if (!p) continue
      const abs = path.resolve(p)
      if (!fs.existsSync(abs)) {
        results.push({ ok: false, path: abs, error: 'not_found' })
        continue
      }

      const st = fs.statSync(abs)
      try {
        if (st.isDirectory()) {
          const r = await this.swarmfs.addDirectory(abs)
          results.push({ ok: true, type: 'directory', path: abs, merkleRoot: r?.merkleRoot || null })
        } else if (st.isFile()) {
          const r = await this.swarmfs.addFile(abs)
          results.push({ ok: true, type: 'file', path: abs, merkleRoot: r?.merkleRoot || null })
        } else {
          results.push({ ok: false, path: abs, error: 'not_file_or_directory' })
        }
      } catch (e) {
        results.push({ ok: false, path: abs, error: e?.message || String(e) })
      }
    }

    return { ok: true, results }
  }

  filesRemove(filePath) {
    this.swarmfs.open()
    const p = String(filePath || '')
    if (!p) throw new Error('path required')

    const abs = path.resolve(p)
    const file = this.swarmfs.db.getFile(abs)
    const dir = this.swarmfs.db.getDirectory(abs)

    if (!file && !dir) {
      return { removed: false, reason: 'not_tracked' }
    }

    this.swarmfs.db.removeTopicSharesByPath(abs)
    if (file) {
      this.swarmfs.removeFile(abs)
      return { removed: true, type: 'file' }
    }
    this.swarmfs.removeDirectory(abs)
    return { removed: true, type: 'directory' }
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
