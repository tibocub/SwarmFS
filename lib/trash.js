// The trash is emptied only by emptyTrash(), on the person's command.

import fs from 'fs'
import path from 'path'

export const TRASH = '.swarmfs-trash'
export const INCOMING = '.incoming'

/** @param {number} n */
const pad = (n) => String(n).padStart(2, '0')
/** @param {Date} [d] */
function stamp (d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}
/**
 * @param {string} name
 * @returns {number | null} ms
 */
function parseStamp (name) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d)-(\d\d)-(\d\d)( \d+)?$/.exec(name)
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null
}

/** @param {string} linked @param {string} root */
export const incoming = (linked, root) => path.join(linked, TRASH, INCOMING, root)

/**
 * A rename on the same disk; a second batch in the same second goes to "<time> 2".
 * @param {string} linked
 * @param {string} abs
 * @returns {Promise<string>} where it went
 */
export async function toTrash (linked, abs) {
  const rel = path.relative(linked, abs)
  const time = stamp()
  let dest = path.join(linked, TRASH, time, rel)
  for (let n = 2; await exists(dest); n++) dest = path.join(linked, TRASH, `${time} ${n}`, rel)
  await fs.promises.mkdir(path.dirname(dest), { recursive: true })
  await fs.promises.rename(abs, dest)
  return dest
}

/**
 * @param {string} linked
 * @returns {Promise<Array<{ path: string, size: number, trashed: number }>>} `trashed`: ms
 */
export async function listTrash (linked) {
  const items = []
  for (const day of await dates(linked)) {
    const trashed = /** @type {number} */ (parseStamp(day)) // dates() keeps only the ones it parses
    for (const { rel, size } of await files(path.join(linked, TRASH, day))) items.push({ path: rel, size, trashed })
  }
  return items
}

/**
 * @param {string} linked
 * @returns {Promise<{ files: number, bytes: number }>}
 */
export async function emptyTrash (linked) {
  let count = 0
  let bytes = 0
  for (const day of await dates(linked)) {
    const dir = path.join(linked, TRASH, day)
    for (const { size } of await files(dir)) { count++; bytes += size }
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
  return { files: count, bytes }
}

/**
 * @param {string} dir
 * @returns {Promise<{ free: number, total: number }>} bytes
 */
export async function freeSpace (dir) {
  const st = await fs.promises.statfs(dir)
  return { free: st.bavail * st.bsize, total: st.blocks * st.bsize }
}

/**
 * @param {string} dir
 * @param {number} [minFree]
 * @returns {Promise<number>} bytes
 */
export async function floor (dir, minFree) {
  if (typeof minFree === 'number') return minFree
  const { total } = await freeSpace(dir)
  return Math.max(5e9, Math.floor(0.05 * total))
}

/** @param {string} linked */
async function dates (linked) {
  const all = await fs.promises.readdir(path.join(linked, TRASH)).catch(() => /** @type {string[]} */ ([]))
  return all.filter((d) => parseStamp(d) !== null)
}

/**
 * @param {string} dir
 * @param {string} [base]
 * @returns {Promise<Array<{ rel: string, size: number }>>}
 */
async function files (dir, base = dir) {
  const out = []
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...await files(full, base))
    else out.push({ rel: path.relative(base, full), size: (await fs.promises.stat(full)).size })
  }
  return out
}

/** @param {string} p */
async function exists (p) {
  try {
    await fs.promises.stat(p)
    return true
  } catch {
    return false
  }
}
