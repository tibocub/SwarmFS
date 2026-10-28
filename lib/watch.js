// Watching a folder (research R7): events mark relative paths dirty; every 500 ms the
// paths whose size and mtime held still for 2 s go to `onBatch` together.

import fs from 'fs'
import path from 'path'
import { stat } from './holdings.js'

const SETTLE = 2000
const TICK = 500

// `filter(rel)`: false drops the event. `onError`: the watcher stopped (root gone, events lost).
export function watch (root, { recursive = true, filter = () => true, onBatch, onError }) {
  const dirty = new Map() // rel -> { sig, since }
  let watcher
  try {
    watcher = fs.watch(root, { recursive }, (event, name) => {
      if (name == null) return onError(new Error('events lost'))
      const rel = String(name)
      if (filter(rel)) dirty.set(rel, { sig: null, since: Date.now() })
    })
    watcher.on('error', (err) => onError(err))
  } catch (err) {
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
      try { watcher.close() } catch {}
    }
  }
}
