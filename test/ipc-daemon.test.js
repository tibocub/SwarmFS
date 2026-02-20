import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'

import { getDataDir } from '../src/config.js'
import { getIpcEndpoint } from '../src/ipc/endpoint.js'
import { connectIpc, createRpcClient } from '../src/ipc/client.js'

const REPO_ROOT = path.resolve(process.cwd())

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function waitForDaemon(endpoint, timeoutMs = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const sock = await connectIpc(endpoint)
      const client = createRpcClient(sock)
      await client.rpc('daemon.ping', {})
      sock.destroy()
      return
    } catch {
      await sleep(150)
    }
  }
  throw new Error('Timed out waiting for daemon IPC')
}

let daemonProc = null
let endpoint = null

before(async () => {
  const dataDir = getDataDir()
  endpoint = getIpcEndpoint(dataDir)

  daemonProc = spawn(process.execPath, ['cli.js', 'daemon', 'start'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  await waitForDaemon(endpoint, 15000)
})

after(async () => {
  if (!endpoint) return
  try {
    const sock = await connectIpc(endpoint)
    const client = createRpcClient(sock)
    await client.rpc('daemon.shutdown', {})
    sock.destroy()
  } catch {
    // ignore
  }

  if (daemonProc) {
    daemonProc.kill('SIGTERM')
  }
})

test('daemon.ping returns pid/version/endpoint', async () => {
  const sock = await connectIpc(endpoint)
  const client = createRpcClient(sock)
  const res = await client.rpc('daemon.ping', {})
  sock.destroy()

  assert.ok(res)
  assert.equal(typeof res.pid, 'number')
  assert.ok(typeof res.version === 'string' || typeof res.version === 'number')
  assert.equal(res.endpoint, endpoint)
})

test('multi-client status works', async () => {
  const s1 = await connectIpc(endpoint)
  const c1 = createRpcClient(s1)
  const s2 = await connectIpc(endpoint)
  const c2 = createRpcClient(s2)

  const [a, b] = await Promise.all([
    c1.rpc('node.status', {}),
    c2.rpc('node.status', {})
  ])

  s1.destroy()
  s2.destroy()

  assert.equal(typeof a.dbOpen, 'boolean')
  assert.equal(typeof b.dbOpen, 'boolean')
})

test('event subscription yields network.stats events (may be null if no topics joined)', async () => {
  const sock = await connectIpc(endpoint)
  const client = createRpcClient(sock)

  const events = []
  client.onEvent((evt) => {
    events.push(evt)
  })

  await client.rpc('events.subscribe', { channels: ['network'] })

  await sleep(1250)

  sock.destroy()

  // We should see at least one stats tick, unless the daemon crashed.
  assert.ok(events.some((e) => e && e.event === 'network.stats'))
})
