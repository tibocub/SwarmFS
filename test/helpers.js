// Shared test helpers, on Node and Bare: tmp dirs, a local DHT per test,
// devices and paired devices. Pattern of hypergraph's test/next/helpers.js.

import fs from 'fs'
import b4a from 'b4a'
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
  const sfs = await SwarmFS.open(dir, { deviceName: label, bootstrap: await bootstrap(t), ...opts })
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

// Every `sync` event of `sfs`, in order; `events.wait(pred, ms)` → the first matching one (or null).
export function syncEvents (sfs) {
  const events = []
  sfs.on('sync', (e) => events.push(e))
  events.wait = (pred, ms = 15000) => eventually(() => events.find(pred), ms)
  return events
}

// A PC with folder `docs/` (from `files`) added in a space, and a laptop paired after, the
// folder linked on it; both syncing (minFree 0: tests never meet the disk's floor).
// `opts.laptopFiles`: written in the laptop's folder before it is linked (already copied by hand).
export async function linkedPair (t, files = { 'docs/a.txt': 'aaaa' }, { laptopFiles, ...opts } = {}) {
  // paired before the files are added: a device paired after a private space got big never gets
  // access (hypergraph H17)
  const pc = await device(t, 'pc', { minFree: 0, ...opts })
  const disk = writeTree(tmpDir(t, 'pc-disk'), files)
  const drive = await pc.createSpace('My files')
  const { code, added } = await pc.addDevice()
  const laptop = await device(t, 'laptop', { joinCode: code, minFree: 0, ...opts })
  await added
  const ld = await eventually(() => laptop.spaces().find((s) => s.key === drive.key) && laptop.space(drive.key), 15000)
  const docs = await drive.add(path.join(disk, 'docs'))
  const pcEvents = syncEvents(pc)
  const laptopEvents = syncEvents(laptop)
  await pc.sync()
  await laptop.sync()
  const there = path.join(tmpDir(t, 'laptop-disk'), 'docs')
  const seen = await eventually(async () => (await ld.get(docs.id).catch(() => null)) && (await ld.list(docs.id, { timeout: 500 })).complete, 90000)
  if (!seen) throw new Error('the laptop never saw docs/')
  if (laptopFiles) writeTree(there, laptopFiles)
  await ld.link(docs.id, there)
  return { pc, laptop, drive, ld, docs, pcDocs: path.join(disk, 'docs'), laptopDocs: there, pcEvents, laptopEvents }
}

// BLAKE3-free fingerprint of every file under `dirs` (path -> hex bytes), for SC-006.
export function contents (dir) {
  const out = new Map()
  if (!fs.existsSync(dir)) return out
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else out.set(full, fs.readFileSync(full).toString('hex'))
    }
  }
  walk(dir)
  return out
}

// SC-006: every file seen in `before` (contents()) is still somewhere under `dir`, byte for
// byte: at a place, or in its trash. Nothing destroyed.
export function assertNothingLost (t, before, dir) {
  const now = new Set(contents(dir).values())
  const lost = [...before].filter(([, hex]) => !now.has(hex)).map(([p]) => path.relative(dir, p))
  t.alike(lost, [], 'nothing lost: every earlier version is at a place or in the trash')
}

// Bytes that don't repeat by group (a filled buffer would hash the same everywhere).
export function bytes (n, seed = 1) {
  const b = b4a.alloc(n)
  let x = seed
  for (let i = 0; i < n; i++) b[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24
  return b
}

// The PC makes a space and adds `files` (written to a disk dir) first; the phone is paired
// after (hypergraph H5) and sees them with the PC online. `byName`: the phone's entries.
export async function filesOnPC (t, files, phoneOpts = {}) {
  const pc = await device(t, 'pc')
  const disk = writeTree(tmpDir(t, 'disk'), files)
  const drive = await pc.createSpace('My files')
  for (const name of Object.keys(files)) await drive.add(path.join(disk, name))
  const { code, added } = await pc.addDevice()
  const phone = await device(t, 'phone', { joinCode: code, ...phoneOpts })
  await added
  const pd = await eventually(() => phone.spaces().find((s) => s.key === drive.key) && phone.space(drive.key))
  const online = await eventually(async () => {
    const { items } = await pd.list(undefined, { timeout: 1000 })
    return items.length === Object.keys(files).length && items.every((i) => i.holders.some((h) => h.online)) && items
  }, 15000)
  const byName = Object.fromEntries((online || []).map((i) => [i.name, i]))
  return { pc, phone, drive, pd, disk, byName, out: tmpDir(t, 'out') }
}
