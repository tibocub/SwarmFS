// Shared test helpers, on Node and Bare: tmp dirs, a local DHT per test,
// devices and paired devices. Pattern of hypergraph's test/next/helpers.js.

import fs from 'fs'
import path from 'path'
import os from 'os'
import createTestnet from 'hyperdht/testnet.js'
import { SwarmFS } from '../index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Polls `fn` until it returns something truthy, up to `ms`; that value, or null.
export async function eventually (fn, ms = 10000, every = 50) {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() >= until) return null
    await sleep(every)
  }
}

// The code of the error `promise` rejects with, or null if it resolves.
export async function codeOf (promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err.code || err.message
  }
}

let counter = 0

// A fresh temp dir, removed after the test (retries: Windows keeps files locked a moment).
export function tmpDir (t, label = 'sfs') {
  const dir = path.join(os.tmpdir(), `swarmfs-${label}-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  t.teardown(async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        return
      } catch {
        await sleep(200 * attempt)
      }
    }
  }, { order: 1000 })
  return dir
}

// Writes `files` ({ 'a.txt': 'bytes', 'sub/b.txt': '...' }) under `dir`.
export function writeTree (dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return dir
}

// One local DHT (3 nodes on loopback) per test.
const testnets = new WeakMap()

export async function bootstrap (t) {
  let testnet = testnets.get(t)
  if (!testnet) {
    testnet = createTestnet(3, t.teardown)
    testnets.set(t, testnet)
  }
  return (await testnet).bootstrap
}

// Opens a SwarmFS in a temp dir (or `opts.dir`) on the test's DHT; closed after the test.
export async function device (t, label = 'dev', opts = {}) {
  const dir = opts.dir || tmpDir(t, label)
  const sfs = await SwarmFS.open(dir, { deviceName: label, bootstrap: await bootstrap(t), readTimeout: 1000, ...opts })
  let closed = false
  const close = sfs.close.bind(sfs)
  sfs.close = () => { if (closed) return; closed = true; return close() }
  t.teardown(() => sfs.close(), { order: 0 })
  sfs.dir = dir
  return sfs
}

// A PC and a phone of one identity, paired by code.
export async function pair (t) {
  const pc = await device(t, 'pc')
  const { code, added } = await pc.addDevice()
  const phone = await device(t, 'phone', { joinCode: code })
  await added
  return { pc, phone }
}

// { name: [size, mtimeMs] } of every file under `dir`, to show nothing changed on disk.
export function snapshot (dir) {
  const out = {}
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else {
        const st = fs.statSync(full)
        out[path.relative(dir, full)] = [st.size, st.mtimeMs, fs.readFileSync(full).toString('hex')]
      }
    }
  }
  walk(dir)
  return out
}
