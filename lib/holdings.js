// What this device holds: `held` and `added` records in the personal space, hashing in
// place, and the rescan of files added on their own (data-model.md). Linked folders: sync.js.

import fs from 'fs'
import path from 'path'
import { hashFile } from 'swarmwire-lib'
import { contentRef, rootOf, nextBase } from './types.js'

// Root, size and mtime of one unchanged read: a file written while hashed is hashed again.
// Still changing after 3 tries: the last values; they won't match it, so it isn't served until a rescan.
export async function hash (file) {
  for (let tries = 1; ; tries++) {
    const before = await stat(file)
    const root = await hashFile(file)
    const { size, mtime } = await stat(file)
    if ((before.size === size && before.mtime === mtime) || tries === 3) return { root, size, mtime }
  }
}

export async function stat (file) {
  try {
    const st = await fs.promises.stat(file, ...EXACT)
    return { size: Number(st.size), mtime: Math.floor(Number(st.mtimeMs)), directory: st.isDirectory(), file: st.isFile(), ino: fileId(st.ino) }
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

const EXACT = globalThis.Bare ? [] : [{ bigint: true }] // bare-fs's stat takes no options: Numbers

// The file's id as a string, exact; null when only a rounded one is known (NTFS ids exceed 2^53,
// and Bare gives Numbers): no rename found by id then, only by content.
function fileId (ino) {
  return typeof ino === 'bigint' || Number.isSafeInteger(ino) ? (ino ? String(ino) : null) : null
}

// Every record of `query` (a hypergraph query), page by page.
export async function all (query, opts = {}) {
  const items = []
  let complete = true
  for (let after;;) {
    const page = await query.latest(100, { ...opts, after })
    items.push(...page.items)
    complete = complete && page.complete
    if (page.items.length < 100) return { items, complete }
    after = page.items.at(-1)
  }
}

// This device's own records: complete at once, never waiting on other devices (hypergraph H10).
export function mine (hg, type) {
  return hg.personal.query(type).fromDevice(hg.device.publicKey)
}

// Where this device holds `root`, if the file is still as it was when hashed; else null.
export async function localPath (hg, root) {
  for (const h of (await all(mine(hg, 'held').where({ root }))).items) {
    const st = await stat(h.path)
    if (st && st.file && st.size === h.size && st.mtime === h.mtime) return h.path
  }
  return null
}

export async function recordHeld (hg, { root, path, size, space, entry }) {
  const { mtime } = await stat(path)
  return hg.personal.put('held', { root, path, size, mtime, space, entry })
}

// Hashes `file` in place and records it as an entry under `parent`, held here.
export async function addFile (hg, space, file, parent) {
  const { root, size, mtime } = await hash(file)
  const entry = await space.put('file', { name: path.basename(file), parent, content: contentRef(root, size) })
  await hg.personal.put('held', { root, path: file, size, mtime, space: space.key, entry: entry.id })
  return entry
}

// Files held here outside linked folders (added on their own, or fetched to a path): v1's
// rules. Edited → the entry gets the new content (with `base`); deleted → no longer held, the
// entry stays; its folder removed elsewhere → moved to the top. Never touches the file.
// Returns the paths whose entry it updated.
export async function rescanSingles (hg, linked) {
  const inside = (p) => linked.some((l) => p.startsWith(l + path.sep))
  const held = (await all(mine(hg, 'held'))).items.filter((h) => h.root !== '' && !inside(h.path))
  const updated = []
  for (const h of held) {
    const st = await stat(h.path)
    if (!st || !st.file) {
      await hg.personal.del(h.id)
    } else if (st.size !== h.size || st.mtime !== h.mtime) {
      const { root, size, mtime } = await hash(h.path)
      const space = spaceOf(hg, h.space)
      if (space && root !== h.root) {
        const { record } = await space.get(h.entry)
        if (record) {
          await space.edit(h.entry, { content: contentRef(root, size), base: rootOf(record.content) === h.root ? nextBase(record) : undefined })
          updated.push(h.path)
        }
      }
      await hg.personal.del(h.id)
      await hg.personal.put('held', { root, path: h.path, size, mtime, space: h.space, entry: h.entry })
    }
  }

  // A held file whose folder was removed elsewhere: keep it, at the top.
  for (const key of new Set(held.map((h) => h.space))) {
    const space = spaceOf(hg, key)
    if (!space) continue
    const folders = await all(space.query('folder'))
    const files = await all(space.query('file'))
    if (!folders.complete || !files.complete) continue
    const known = new Set(folders.items.map((f) => f.id))
    const ids = new Set(held.filter((h) => h.space === key).map((h) => h.entry))
    for (const f of files.items) {
      if (ids.has(f.id) && f.parent !== space.key && f.parent !== 'bin' && !known.has(f.parent)) await space.edit(f.id, { parent: space.key })
    }
  }
  return updated
}

export function spaceOf (hg, key) {
  try {
    return hg.space(key)
  } catch {
    return null // left on this device
  }
}
