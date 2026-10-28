// A linked folder's trash (research R9) and the free-space floor (R10). The trash is
// emptied only by emptyTrash(), on the person's command (constitution I).

import fs from 'fs'
import path from 'path'

export const TRASH = '.swarmfs-trash'
export const INCOMING = '.incoming'

const pad = (n) => String(n).padStart(2, '0')
function stamp (d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}
function parseStamp (name) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d)-(\d\d)-(\d\d)( \d+)?$/.exec(name)
  return m ? new Date(m[1], m[2] - 1, m[3], m[4], m[5], m[6]).getTime() : null
}

export const incoming = (linked, root) => path.join(linked, TRASH, INCOMING, root)

// Moves a file or folder of `linked` into its trash, keeping its relative path: a rename on
// the same disk. A version already there this second: a folder "<time> 2" (3…) instead.
export async function toTrash (linked, abs) {
  const rel = path.relative(linked, abs)
  const time = stamp()
  let dest = path.join(linked, TRASH, time, rel)
  for (let n = 2; await exists(dest); n++) dest = path.join(linked, TRASH, `${time} ${n}`, rel)
  await fs.promises.mkdir(path.dirname(dest), { recursive: true })
  await fs.promises.rename(abs, dest)
  return dest
}

// [{ path, size, trashed }]: path relative to the linked folder, as it was.
export async function listTrash (linked) {
  const items = []
  for (const day of await dates(linked)) {
    const trashed = parseStamp(day)
    for (const { rel, size } of await files(path.join(linked, TRASH, day))) items.push({ path: rel, size, trashed })
  }
  return items
}

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

export async function freeSpace (dir) {
  const st = await fs.promises.statfs(dir)
  return { free: st.bavail * st.bsize, total: st.blocks * st.bsize }
}

// max(5 GB, 5 % of the disk), or `minFree` (bytes) when given.
export async function floor (dir, minFree) {
  if (typeof minFree === 'number') return minFree
  const { total } = await freeSpace(dir)
  return Math.max(5e9, Math.floor(0.05 * total))
}

async function dates (linked) {
  const all = await fs.promises.readdir(path.join(linked, TRASH)).catch(() => [])
  return all.filter((d) => parseStamp(d) !== null)
}

async function files (dir, base = dir) {
  const out = []
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...await files(full, base))
    else out.push({ rel: path.relative(base, full), size: (await fs.promises.stat(full)).size })
  }
  return out
}

async function exists (p) {
  try {
    await fs.promises.stat(p)
    return true
  } catch {
    return false
  }
}
