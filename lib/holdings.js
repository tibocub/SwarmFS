// What this device holds: `held` and `added` records in the personal space,
// hashing in place, and rescan (data-model.md, state transitions).

import fs from 'fs'
import path from 'path'
import { hashFile } from 'swarmwire-lib'
import { contentRef, rootOf } from './types.js'

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
    const st = await fs.promises.stat(file)
    return { size: st.size, mtime: Math.floor(st.mtimeMs), directory: st.isDirectory(), file: st.isFile() }
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
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

// Reads of entries (others' records too) are bounded short: an offline device would make
// each wait the full read bound. What depends on them (is a folder gone?) is acted on only
// when the answer is complete.
const LOCAL = { timeout: 200 }

// Follows the disk for what this device added and holds.
export async function rescan (hg) {
  const held = (await all(mine(hg, 'held'))).items
  const heldPaths = new Set(held.map((h) => h.path))

  for (const a of (await all(mine(hg, 'added'))).items) {
    const space = spaceOf(hg, a.space)
    if (!space) continue
    const folder = await space.get(a.folder, LOCAL)
    if (!folder.record) {
      if (folder.complete) await hg.personal.del(a.id) // the folder's entry was removed: stop following it
      continue
    }
    await addNew(hg, space, a.path, a.folder, heldPaths)
  }

  for (const h of held) {
    const space = spaceOf(hg, h.space)
    const { record: entry } = space ? await space.get(h.entry, LOCAL) : { record: null }
    const st = await stat(h.path)
    if (!st || !st.file) {
      await hg.personal.del(h.id)
    } else if (st.size !== h.size || st.mtime !== h.mtime) {
      const { root, size, mtime } = await hash(h.path)
      if (entry && rootOf(entry.content) !== root) await space.edit(entry.id, { content: contentRef(root, size) })
      await hg.personal.del(h.id)
      await hg.personal.put('held', { root, path: h.path, size, mtime, space: h.space, entry: h.entry })
    }
    if (entry && entry.parent !== space.key) {
      const parent = await space.get(entry.parent, LOCAL)
      // its folder was removed elsewhere: keep it, at the top
      if (!parent.record && parent.complete) await space.edit(entry.id, { parent: space.key })
    }
  }
}

function spaceOf (hg, key) {
  try {
    return hg.space(key)
  } catch {
    return null // left on this device
  }
}

// Files under `dir` not held here yet become entries under `folder`; a sub-folder's
// entry is made (or found by name) only when it has such a file.
async function addNew (hg, space, dir, folder, heldPaths) {
  const children = await all(space.query('folder').where({ parent: folder }), LOCAL)
  const subfolders = new Map(children.items.map((f) => [f.name, f.id]))

  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!(await hasNew(full, heldPaths))) continue
      let id = subfolders.get(e.name)
      if (!id && !children.complete) continue // it may exist elsewhere: next rescan, not a duplicate
      if (!id) id = (await space.put('folder', { name: e.name, parent: folder })).id
      await addNew(hg, space, full, id, heldPaths)
    } else if (e.isFile() && !heldPaths.has(full)) {
      await addFile(hg, space, full, folder)
    }
  }
}

async function hasNew (dir, heldPaths) {
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isFile() && !heldPaths.has(full)) return true
    if (e.isDirectory() && await hasNew(full, heldPaths)) return true
  }
  return false
}
