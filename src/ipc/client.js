import net from 'net'

function writeLine(sock, obj) {
  sock.write(`${JSON.stringify(obj)}\n`)
}

export async function connectIpc(endpoint) {
  return await new Promise((resolve, reject) => {
    const sock = net.createConnection(endpoint)
    sock.once('connect', () => resolve(sock))
    sock.once('error', (e) => reject(e))
  })
}

export function createRpcClient(sock) {
  let nextId = 1
  const pending = new Map()

  let buf = ''
  sock.on('data', (data) => {
    buf += data.toString('utf8')
    while (true) {
      const idx = buf.indexOf('\n')
      if (idx === -1) break
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue

      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }

      if (msg && msg.type === 'res' && msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.ok) resolve(msg.result)
        else reject(new Error(msg?.error?.message || 'RPC error'))
        continue
      }

      if (msg && msg.type === 'evt') {
        const handler = pending.get('__evt__')
        if (handler && typeof handler.onEvent === 'function') {
          handler.onEvent(msg)
        }
      }
    }
  })

  function rpc(method, params = {}) {
    const id = String(nextId++)
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      writeLine(sock, { id, type: 'req', method, params })
    })
  }

  function onEvent(onEvent) {
    pending.set('__evt__', { onEvent })
  }

  return { rpc, onEvent }
}
