import fs from 'fs'
import path from 'path'
import { hashFile, MemorySource } from 'swarmwire-lib'
import { contentRef, rootOf, nextBase, INLINE_MAX } from './types.js'
import { strip } from './strip.js'

/**
 * @typedef {import('./types.js').Hypergraph} Hypergraph
 * @typedef {import('./types.js').Space} Space
 * @typedef {import('./types.js').Query} Query
 * @typedef {import('./types.js').HgRecord} HgRecord
 * @typedef {import('./types.js').HeldRecord} HeldRecord
 * @typedef {import('./types.js').FileRecord} FileRecord
 * @typedef {import('./types.js').FolderRecord} FolderRecord
 * @typedef {import('./types.js').ContentRef} ContentRef
 * @typedef {{ size: number, mtime: number, directory: boolean, file: boolean, ino: string | null }} Stat
 */

/**
 * Hashed again if the file changed while read; after 3 tries the stale values keep it unserved until a rescan.
 * @param {string} file
 * @returns {Promise<{ root: string, size: number, mtime: number }>}
 */
export async function hash (file) {
  for (let tries = 1; ; tries++) {
    // there: hashFile throws ENOENT first
    const before = /** @type {Stat} */ (await stat(file))
    const root = await hashFile(file)
    const { size, mtime } = /** @type {Stat} */ (await stat(file))
    if ((before.size === size && before.mtime === mtime) || tries === 3) return { root, size, mtime }
  }
}

/**
 * @param {string} file
 * @returns {Promise<Stat | null>} null when there is nothing there
 */
export async function stat (file) {
  try {
    // the spread hides which overload applies: Stats or BigIntStats, never undefined (no throwIfNoEntry)
    const st = /** @type {import('fs').Stats | import('fs').BigIntStats} */ (await fs.promises.stat(file, ...EXACT))
    return { size: Number(st.size), mtime: Math.floor(Number(st.mtimeMs)), directory: st.isDirectory(), file: st.isFile(), ino: fileId(st.ino) }
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null
    throw err
  }
}


/** @type {Array<{ bigint: true }>} */
const EXACT = /** @type {{ Bare?: unknown }} */ (globalThis).Bare ? [] : [{ bigint: true }] // bare-fs's stat takes no options: Numbers

// The file's id as a string, exact; null when only a rounded one is known (NTFS ids exceed 2^53,
// and Bare gives Numbers): no rename found by id then, only by content.
/** @param {bigint | number} ino */
function fileId (ino) {
  return typeof ino === 'bigint' || Number.isSafeInteger(ino) ? (ino ? String(ino) : null) : null
}

/**
 * Every record a query matches, 100 per read.
 * @param {Query} query
 * @param {{ timeout?: number }} [opts]
 * @returns {Promise<import('./types.js').Page>}
 */
export async function all (query, opts = {}) {
  /** @type {HgRecord[]} */
  const items = []
  let complete = true
  for (let /** @type {HgRecord | undefined} */ after;;) {
    const page = await query.latest(100, { ...opts, after })
    items.push(...page.items)
    complete = complete && page.complete
    if (page.items.length < 100) return { items, complete }
    after = page.items.at(-1)
  }
}

// From what is here at once; waits only when nothing matches and the answer is incomplete
// (it never completes while a publisher is offline).
/**
 * @param {Query} query
 * @param {(r: HgRecord) => boolean} pred
 * @param {{ timeout?: number }} [opts]
 * @returns {Promise<HgRecord | null>}
 */
export async function findHere (query, pred, { timeout } = {}) {
  const here = await all(query)
  const found = here.items.find(pred)
  if (found || here.complete || !timeout) return found || null
  return (await all(query, { timeout })).items.find(pred) || null
}

// Only this device's records: complete at once, never waiting on other devices.
/**
 * @param {Hypergraph} hg
 * @param {string} type
 * @returns {Query}
 */
export function mine (hg, type) {
  return hg.personal.query(type).fromDevice(hg.device.publicKey)
}

// Only a file still as it was hashed counts: a changed file is never served.
/**
 * @param {Hypergraph} hg
 * @param {string} root
 * @param {(space: string) => boolean} [inSpace]
 * @returns {Promise<string | null>}
 */
export async function localPath (hg, root, inSpace = () => true) {
  for (const h of /** @type {HeldRecord[]} */ ((await all(mine(hg, 'held').where({ root }))).items)) {
    if (!inSpace(h.space)) continue
    const st = await stat(h.path)
    if (st && st.file && st.size === h.size && st.mtime === h.mtime) return h.path
  }
  return null
}

/**
 * @param {Hypergraph} hg
 * @param {{ root: string, path: string, size: number, space: string, entry: string }} held
 */
export async function recordHeld (hg, { root, path, size, space, entry }) {
  const { mtime } = /** @type {Stat} */ (await stat(path)) // just written or found there
  return hg.personal.put('held', { root, path, size, mtime, space, entry })
}

// SwarmFS makes sub-spaces only for sites' pages, and those inline small files.
/** @param {Space} space */
export const inlines = (space) => !!space.parent

/**
 * @param {string} file
 * @param {string} root
 * @param {number} size
 * @param {boolean} inline
 * @returns {Promise<{ content: ContentRef, data?: Uint8Array | null }>}
 */
export async function contentOf (file, root, size, inline) {
  const content = contentRef(root, size)
  if (!inline) return { content }
  if (size > INLINE_MAX) return { content, data: null }
  const data = await fs.promises.readFile(file)
  return { content, data: MemorySource.from(data).root === root ? data : null } // changed since hashed: the next rescan
}

/**
 * @param {Hypergraph} hg
 * @param {Space} space
 * @param {string} file
 * @param {string} parent
 */
export async function addFile (hg, space, file, parent) {
  const held = await served(hg, file)
  const { root, size, mtime } = await hash(held)
  const entry = await space.put('file', { name: path.basename(file), parent, ...await contentOf(held, root, size, inlines(space)) })
  await hg.personal.put('held', { root, path: held, size, mtime, space: space.key, entry: entry.id })
  return entry
}

/**
 * The file to hash and serve for `file`: itself, or on an I2P-only instance, for a photo with metadata, a copy
 * without it in the instance folder (the person's own file is never changed).
 * @param {Hypergraph} hg
 * @param {string} file
 * @returns {Promise<string>}
 */
export async function served (hg, file) {
  if (hg.transport !== 'i2p') return file
  const head = Buffer.alloc(12)
  const fd = await fs.promises.open(file, 'r')
  try { await fd.read(head, 0, 12, 0) } finally { await fd.close() }
  const image = (head[0] === 0xff && head[1] === 0xd8) || head.toString('latin1', 1, 4) === 'PNG' || head.toString('latin1', 8, 12) === 'WEBP'
  if (!image) return file // read whole only when it is one: a video could be gigabytes
  const clean = strip(await fs.promises.readFile(file))
  if (!clean) return file
  // shortcut: a copy stays when its entry is removed; clean them up if they ever take room that matters
  const dir = path.join(hg.dir, 'stripped')
  await fs.promises.mkdir(dir, { recursive: true })
  const copy = path.join(dir, Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '-' + path.basename(file))
  await fs.promises.writeFile(copy, clean)
  return copy
}

// Files held outside linked folders: an edit updates the entry, a deletion drops only `held`
// (the entry stays), an orphan moves to the top. Never touches the file.
/**
 * @param {Hypergraph} hg
 * @param {string[]} linked
 * @returns {Promise<string[]>} the files whose entries were updated
 */
export async function rescanSingles (hg, linked) {
  /** @param {string} p */
  const inside = (p) => linked.some((l) => p.startsWith(l + path.sep))
  const held = /** @type {HeldRecord[]} */ ((await all(mine(hg, 'held'))).items).filter((h) => h.root !== '' && !inside(h.path))
  const updated = []
  for (const h of held) {
    const st = await stat(h.path)
    if (!st || !st.file) {
      await hg.personal.del(h.id)
    } else if (st.size !== h.size || st.mtime !== h.mtime) {
      const { root, size, mtime } = await hash(h.path)
      const space = spaceOf(hg, h.space)
      if (space && root !== h.root) {
        const { record } = /** @type {{ record: FileRecord | null }} */ (await space.get(h.entry))
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
    const files = /** @type {import('./types.js').Page<FileRecord>} */ (await all(space.query('file')))
    if (!folders.complete || !files.complete) continue
    const known = new Set(folders.items.map((f) => f.id))
    const ids = new Set(held.filter((h) => h.space === key).map((h) => h.entry))
    for (const f of files.items) {
      if (ids.has(f.id) && f.parent !== space.key && f.parent !== 'bin' && !known.has(f.parent)) await space.edit(f.id, { parent: space.key })
    }
  }
  return updated
}

/**
 * @param {Hypergraph} hg
 * @param {string} key
 * @returns {Space | null}
 */
export function spaceOf (hg, key) {
  try {
    return hg.space(key)
  } catch {
    return null // left on this device
  }
}
