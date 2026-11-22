// Watching a folder: events mark relative paths dirty; every 500 ms the
// paths whose size and mtime held still for 2 s go to `onBatch` together.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { stat } from './holdings.js'

const SETTLE = 2000
const TICK = 500

// libuv watches a whole tree only on macOS and Windows; Node does it itself elsewhere, Bare does not
const NATIVE_RECURSIVE = !(/** @type {{ Bare?: unknown }} */ (globalThis).Bare) || ['darwin', 'win32'].includes(os.platform())

/**
 * @param {string} root
 * @param {object} opts
 * @param {boolean} [opts.recursive=true]
 * @param {boolean} [opts.perFolder] - recursive by one watcher per folder; default: where the platform can't watch a tree
 * @param {(rel: string) => boolean} [opts.filter] - false drops the event
 * @param {(rels: string[]) => unknown} opts.onBatch
 * @param {(err: unknown) => void} opts.onError - the watcher stopped (root gone, events lost)
 * @returns {{ close (): void }}
 */
export function watch (root, { recursive = true, perFolder = recursive && !NATIVE_RECURSIVE, filter = () => true, onBatch, onError }) {
  /** @type {Map<string, { sig: string | null, since: number }>} */
  const dirty = new Map()
  /** @type {Map<string, fs.FSWatcher>} relative folder ('' the root) → its watcher */
  const watchers = new Map()

  /** @param {string} dir */
  const open = (dir) => {
    const watcher = fs.watch(path.join(root, dir), { recursive: recursive && !perFolder }, (event, name) => {
      if (name == null) return onError(new Error('events lost'))
      const rel = path.join(dir, String(name))
      if (filter(rel)) dirty.set(rel, { sig: null, since: Date.now() })
      if (perFolder && event === 'rename') follow(rel)
    })
    watchers.set(dir, watcher)
    return watcher
  }

  // A folder appeared (made, moved in): watch it and every folder in it; its files reach sync as its scope.
  /** @param {string} dir */
  const watchTree = (dir) => {
    if (!watchers.has(dir)) {
      try {
        open(dir).on('error', () => unwatch(dir))
      } catch {
        return // shortcut: a folder past the system's watch limit goes unwatched until the next full pass, raise the limit if users hit it
      }
    }
    let items
    try { items = fs.readdirSync(path.join(root, dir), { withFileTypes: true }) } catch { return }
    for (const item of items) if (item.isDirectory()) watchTree(path.join(dir, item.name))
  }

  /** @param {string} dir */
  const unwatch = (dir) => {
    for (const [rel, w] of watchers) {
      if (rel !== dir && !rel.startsWith(dir + path.sep)) continue
      watchers.delete(rel)
      try { w.close() } catch {}
    }
  }

  /** @param {string} rel */
  const follow = (rel) => {
    let st = null
    try { st = fs.statSync(path.join(root, rel)) } catch {}
    if (st && st.isDirectory()) watchTree(rel)
    else unwatch(rel)
  }

  try {
    open('').on('error', (err) => onError(err))
    if (perFolder) for (const item of fs.readdirSync(root, { withFileTypes: true })) if (item.isDirectory()) watchTree(item.name)
  } catch (err) {
    for (const w of watchers.values()) try { w.close() } catch {}
    queueMicrotask(() => onError(err))
    return { close () {} }
  }

  let busy = false
  const timer = setInterval(async () => {
    if (busy || !dirty.size) return
    busy = true
    try {
      const ready = []
      const now = Date.now()
      for (const [rel, d] of dirty) {
        const st = await stat(path.join(root, rel)).catch(() => null)
        const sig = st ? `${st.size}:${st.mtime}` : 'gone'
        if (sig !== d.sig) Object.assign(d, { sig, since: now })
        else if (now - d.since >= SETTLE) ready.push(rel)
      }
      for (const rel of ready) dirty.delete(rel)
      if (ready.length) await onBatch(ready)
    } finally {
      busy = false
    }
  }, TICK)

  return {
    close () {
      clearInterval(timer)
      for (const w of watchers.values()) try { w.close() } catch {}
      watchers.clear()
    }
  }
}
