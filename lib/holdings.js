import fs from 'fs'
import path from 'path'
import { hashFile, MemorySource } from 'swarmwire-lib'
import { contentRef, rootOf, nextBase, INLINE_MAX } from './types.js'

// Hashed again if the file changed while read; after 3 tries the stale values keep it unserved until a rescan.
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

// From what is here at once; waits only when nothing matches and the answer is incomplete
// (it never completes while a publisher is offline).
export async function findHere (query, pred, { timeout } = {}) {
  const here = await all(query)
  const found = here.items.find(pred)
  if (found || here.complete || !timeout) return found || null
  return (await all(query, { timeout })).items.find(pred) || null
}

// Only this device's records: complete at once, never waiting on other devices.
export function mine (hg, type) {
  return hg.personal.query(type).fromDevice(hg.device.publicKey)
}

// Only a file still as it was hashed counts: a changed file is never served.
export async function localPath (hg, root, inSpace = () => true) {
  for (const h of (await all(mine(hg, 'held').where({ root }))).items) {
    if (!inSpace(h.space)) continue
    const st = await stat(h.path)
    if (st && st.file && st.size === h.size && st.mtime === h.mtime) return h.path
  }
  return null
}

export async function recordHeld (hg, { root, path, size, space, entry }) {
  const { mtime } = await stat(path)
  return hg.personal.put('held', { root, path, size, mtime, space, entry })
}

// SwarmFS makes sub-spaces only for sites' pages, and those inline small files.
export const inlines = (space) => !!space.parent

export async function contentOf (file, root, size, inline) {
  const content = contentRef(root, size)
  if (!inline) return { content }
  if (size > INLINE_MAX) return { content, data: null }
  const data = await fs.promises.readFile(file)
  return { content, data: MemorySource.from(data).root === root ? data : null } // changed since hashed: the next rescan
}

export async function addFile (hg, space, file, parent) {
  const { root, size, mtime } = await hash(file)
  const entry = await space.put('file', { name: path.basename(file), parent, ...await contentOf(file, root, size, inlines(space)) })
  await hg.personal.put('held', { root, path: file, size, mtime, space: space.key, entry: entry.id })
  return entry
}

// Files held outside linked folders: an edit updates the entry, a deletion drops only `held`
// (the entry stays), an orphan moves to the top. Never touches the file.
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
        if (record?.type === 'file') { // an upload is a snapshot: its edits aren't followed
          await space.edit(h.entry, { ...await contentOf(h.path, root, size, inlines(space)), base: rootOf(record.content) === h.root ? nextBase(record) : undefined })
          updated.push(h.path)
        }
      }
      await hg.personal.del(h.id)
      await hg.personal.put('held', { root, path: h.path, size, mtime, space: h.space, entry: h.entry })
    }
  }

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
