import net from 'net'
import fs from 'fs'
import os from 'os'
import { EventEmitter } from 'events'

function safeJsonParse(line) {
  try {
    return { ok: true, value: JSON.parse(line) }
  } catch (e) {
    return { ok: false, error: e }
  }
}

function writeLine(sock, obj) {
  try {
    sock.write(`${JSON.stringify(obj)}\n`)
  } catch {
    // ignore
  }
}

async function canConnect(endpoint) {
  return await new Promise((resolve) => {
    const s = net.createConnection(endpoint)
    const done = (ok) => {
      try { s.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

async function cleanupStaleEndpoint(endpoint) {
  if (os.platform() === 'win32') {
    return
  }

  if (!fs.existsSync(endpoint)) {
    return
  }

  const ok = await canConnect(endpoint)
  if (!ok) {
    try {
      fs.unlinkSync(endpoint)
    } catch {
      // ignore
    }
  }
}

export class IpcServer extends EventEmitter {
  constructor({ endpoint, nodeRuntime, version = '0.1' }) {
    super()
    this.endpoint = endpoint
    this.node = nodeRuntime
    this.version = version

    this._server = null
    this._clients = new Set()
    this._subs = new Map() // sock -> Set(channel)

    this._logRing = []
    this._logRingMax = 2000

    this._statsTimer = null
  }

  pushLog(line, level = 'info') {
    const msg = String(line ?? '')
    const entry = { ts: Date.now(), level, message: msg }
    this._logRing.push(entry)
    if (this._logRing.length > this._logRingMax) {
      this._logRing.splice(0, this._logRing.length - this._logRingMax)
    }
    this._broadcast('log', { event: 'log', data: entry })
  }

  start() {
    const endpoint = this.endpoint

    const server = net.createServer((sock) => this._onClient(sock))
    this._server = server

    server.on('error', (err) => {
      this.emit('error', err)
    })

    this.node.on('network', (evt) => {
      this._broadcast('network', { event: `network.${evt.type}`, data: evt })
    })

    this._statsTimer = setInterval(() => {
      try {
        const status = this.node.status()
        const stats = status.networkStats
        if (stats) {
          this._broadcast('network', { event: 'network.stats', data: stats })
        }
      } catch {
        // ignore
      }
    }, 1000)

    server.listen(endpoint)
    this.emit('listening', { endpoint })
    return this
  }

  async close() {
    if (this._statsTimer) {
      clearInterval(this._statsTimer)
      this._statsTimer = null
    }

    for (const c of this._clients) {
      try { c.destroy() } catch { /* ignore */ }
    }
    this._clients.clear()

    if (!this._server) return

    await new Promise((resolve) => {
      try {
        this._server.close(() => resolve())
      } catch {
        resolve()
      }
    })

    this._server = null
  }

  async bind() {
    await cleanupStaleEndpoint(this.endpoint)
    return this.start()
  }

  _onClient(sock) {
    this._clients.add(sock)
    this._subs.set(sock, new Set())

    let buf = ''

    sock.on('data', (data) => {
      buf += data.toString('utf8')
      while (true) {
        const idx = buf.indexOf('\n')
        if (idx === -1) break
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        this._handleLine(sock, line)
      }
    })

    sock.on('close', () => {
      this._clients.delete(sock)
      this._subs.delete(sock)
    })

    sock.on('error', () => {
      // ignore
    })
  }

  async _handleLine(sock, line) {
    const parsed = safeJsonParse(line)
    if (!parsed.ok) {
      writeLine(sock, { type: 'res', ok: false, error: { code: 'bad_json', message: 'Invalid JSON' } })
      return
    }

    const msg = parsed.value
    if (!msg || msg.type !== 'req' || typeof msg.method !== 'string') {
      writeLine(sock, { id: msg?.id, type: 'res', ok: false, error: { code: 'bad_request', message: 'Invalid request' } })
      return
    }

    const id = msg.id
    try {
      const result = await this._dispatch(msg.method, msg.params || {}, sock)
      writeLine(sock, { id, type: 'res', ok: true, result })
    } catch (e) {
      writeLine(sock, { id, type: 'res', ok: false, error: { code: 'error', message: e?.message || String(e) } })
    }
  }

  async _dispatch(method, params, sock) {
    switch (method) {
      case 'daemon.ping':
        return { version: this.version, pid: process.pid, endpoint: this.endpoint }

      case 'daemon.shutdown':
        setTimeout(() => {
          this.emit('shutdown')
        }, 0)
        return { ok: true }

      case 'node.status':
        return this.node.status()

      case 'network.stats':
        return this.node.status().networkStats

      case 'topic.list':
        return await this.node.listTopics()

      case 'topic.join':
        await this.node.joinTopic(params?.name)
        return { ok: true }

      case 'topic.leave':
        await this.node.leaveTopic(params?.name)
        return { ok: true }

      case 'logs.tail': {
        const n = Number.isFinite(params?.lines) ? Math.max(1, Math.min(5000, params.lines)) : 200
        return this._logRing.slice(-n)
      }

      case 'events.subscribe': {
        const channels = Array.isArray(params?.channels) ? params.channels : []
        const s = this._subs.get(sock)
        if (s) {
          for (const ch of channels) {
            if (ch === 'log' || ch === 'network') {
              s.add(ch)
            }
          }
        }
        return { ok: true, channels: Array.from(s || []) }
      }

      default:
        throw new Error(`Unknown method: ${method}`)
    }
  }

  _broadcast(channel, payload) {
    for (const sock of this._clients) {
      const subs = this._subs.get(sock)
      if (!subs || !subs.has(channel)) continue
      writeLine(sock, { type: 'evt', event: payload.event, data: payload.data })
    }
  }
}
