// What this device holds: `held` and `added` records in the personal space,
// hashing in place, and rescan (data-model.md, state transitions).

import fs from 'fs'
import path from 'path'
import { ContentSource } from 'swarmwire-lib'
import { contentRef, rootOf } from './types.js'

// shortcut: ContentSource is swarmwire's unstable export (request S6), switch to hashFile() once stable.
export async function hash (file) {
  const src = await ContentSource.open(file)
  const { root, size } = src
  await src.close()
  return { root, size }
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

export function mine (hg, type) {
  return hg.personal.query(type).fromDevice(hg.device.publicKey)
}

// Hashes `file` in place and records it as an entry under `parent`, held here.
export async function addFile (hg, space, file, parent, st) {
  const { root, size } = await hash(file)
  const entry = await space.put('file', { name: path.basename(file), parent, content: contentRef(root, size) })
  await hg.personal.put('held', { root, path: file, size, mtime: st.mtime, space: space.key, entry: entry.id })
  return entry
}

// Follows the disk for what this device added and holds.
export async function rescan (hg) {
  const held = (await all(mine(hg, 'held'))).items
  const heldPaths = new Set(held.map((h) => h.path))

  for (const a of (await all(mine(hg, 'added'))).items) {
    const space = spaceOf(hg, a.space)
    if (!space) continue
    if (!(await space.get(a.folder)).record) {
      await hg.personal.del(a.id) // the folder's entry was removed: stop following it
      continue
    }
    await addNew(hg, space, a.path, a.folder, heldPaths)
  }

  for (const h of held) {
    const space = spaceOf(hg, h.space)
    const { record: entry } = space ? await space.get(h.entry) : { record: null }
    const st = await stat(h.path)
    if (!st || !st.file) {
      await hg.personal.del(h.id)
    } else if (st.size !== h.size || st.mtime !== h.mtime) {
      const { root, size } = await hash(h.path)
      if (entry && rootOf(entry.content) !== root) await space.edit(entry.id, { content: contentRef(root, size) })
      await hg.personal.del(h.id)
      await hg.personal.put('held', { root, path: h.path, size, mtime: st.mtime, space: h.space, entry: h.entry })
    }
    if (entry && entry.parent !== space.key && !(await space.get(entry.parent)).record) {
      await space.edit(entry.id, { parent: space.key }) // its folder was removed elsewhere: keep it, at the top
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
  const subfolders = new Map()
  for (const f of (await all(space.query('folder').where({ parent: folder }))).items) subfolders.set(f.name, f.id)

  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!(await hasNew(full, heldPaths))) continue
      let id = subfolders.get(e.name)
      if (!id) id = (await space.put('folder', { name: e.name, parent: folder })).id
      await addNew(hg, space, full, id, heldPaths)
    } else if (e.isFile() && !heldPaths.has(full)) {
      await addFile(hg, space, full, folder, await stat(full))
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
