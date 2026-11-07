// A site (spec 004): a space that isn't private, its pages in a sub-space only the owner and
// admins write, members' uploads in the space itself. What is read lands in app storage
// (swarmfs.js `_bytes`).

import fs from 'fs'
import path from 'path'
import { Drive } from './drive.js'
import { SwarmFSError } from './errors.js'
import { validName, rootOf, inlineOf, siteTypes, BIN } from './types.js'
import { all, mine, stat, hash, contentOf, localPath, recordHeld, findHere } from './holdings.js'

export class Site extends Drive {
  constructor (sfs, space, pages) {
    super(sfs, space)
    this.pages = new Drive(sfs, pages)
  }

  get isPublic () { return this.space.isPublic }

  // The folder's files become the pages: a linked folder of this device (spec 002), so its edits
  // are published while syncing.
  async publish (localFolder) {
    await this.pages.link(this.pages.top, localFolder)
    if (!this.sfs._syncing) await this.sfs.rescan() // its first pass now
  }

  // Readable by anyone with the public link, for good (owner, admins).
  async makePublic () {
    await this.space.makePublic()
    await this.pages.space.makePublic() // a public joiner gets no closed sub-space (H22)
  }

  // Adds record types to this site (spec 005; owner and admins): fields at the end and new types only.
  async declareTypes (own) {
    await this.space.declareTypes(siteTypes(own))
  }

  publicLink () {
    return this.space.publicLink()
  }

  // A page's bytes by its path in the site ('docs/about.html'), verified.
  async read (p, { timeout = 10000 } = {}) {
    const names = p.split('/').filter(Boolean)
    let record = null
    for (const [i, name] of names.entries()) {
      const type = i === names.length - 1 ? 'file' : 'folder'
      const parent = record ? record.id : this.pages.top
      record = await findHere(this.pages.space.query(type).where({ parent }), (r) => r.name === name, { timeout })
      if (!record) throw new SwarmFSError('NOT_FOUND', `no page ${p}`)
    }
    if (!record) throw new SwarmFSError('NOT_FOUND', `no page ${p}`)
    return this.sfs._bytes(this.pages, record)
  }

  // --- uploads: by anyone who may post, edited by their author only ---

  // From where it lies (constitution I): served from there until others hold it.
  async upload (localFile, { name = path.basename(localFile) } = {}) {
    if (!validName(name)) throw new SwarmFSError('INVALID_NAME', `not a valid name: ${JSON.stringify(name)}`)
    const full = path.resolve(localFile)
    if (!(await stat(full))?.file) throw new SwarmFSError('NOT_FOUND', `no such file: ${full}`)
    const { root, size, mtime } = await hash(full)
    const r = await this.space.put('upload', { name, ...await contentOf(full, root, size, true) })
    await this.hg.personal.put('held', { root, path: full, size, mtime, space: this.key, entry: r.id })
    return upload(r)
  }

  async uploads () {
    return (await all(this.space.query('upload'))).items.map(upload)
  }

  async readUpload (id) {
    const { record } = await this.space.get(id)
    if (record?.type !== 'upload') throw new SwarmFSError('NOT_FOUND', `no upload ${id}`)
    return this.sfs._bytes(this, record)
  }

  async renameUpload (id, name) {
    if (!validName(name)) throw new SwarmFSError('INVALID_NAME', `not a valid name: ${JSON.stringify(name)}`)
    return upload(await this.space.edit(id, { name }))
  }

  // Its author, the owner or an admin.
  async removeUpload (id) {
    await this.space.del(id)
  }

  // --- installed (spec 006): kept whole on this device, never evicted, served ---

  // true: every page and upload fetched into app storage's kept/, and followed while syncing;
  // false: handed back to its cache. Remembered on this device. `timeout`: for the site's records
  // not here yet.
  async keep (on, { timeout = 10000 } = {}) {
    const recs = (await all(mine(this.hg, 'kept').where({ space: this.key }))).items
    if (on && !recs.length) await this.hg.personal.put('kept', { space: this.key })
    if (!on) for (const r of recs) await this.hg.personal.del(r.id)
    if (this.sfs._syncing) await this.sfs._keep(this.key, { again: true, timeout })
    else await this._keep({ timeout })
  }

  async kept () {
    return (await all(mine(this.hg, 'kept').where({ space: this.key }))).items.length > 0
  }

  // Bytes of this site here: its files held on this device (each path once, still as hashed),
  // plus the inline ones, inside their records.
  // shortcut: reads every held record of this device; keep a sum per site if the toolbar calls it often.
  async held () {
    const keys = new Set([this.key, this.pages.key])
    const paths = new Map()
    for (const h of (await all(mine(this.hg, 'held'))).items) if (h.root !== '' && keys.has(h.space)) paths.set(h.path, h)
    let bytes = 0
    for (const h of paths.values()) {
      const st = await stat(h.path)
      if (st?.file && st.size === h.size && st.mtime === h.mtime) bytes += h.size
    }
    for (const [space, type] of [[this.pages.space, 'file'], [this.space, 'upload']]) {
      for (const r of (await all(space.query(type))).items) if (inlineOf(r)) bytes += r.content.size
    }
    return bytes
  }

  // One pass: what this device keeps of the site (uploads for its owner, everything once
  // installed) copied, moved or fetched into kept/; this site's other kept copies handed back to
  // the cache, or dropped if no longer in the site (FR-013).
  async _keep (opts) {
    const sfs = this.sfs
    const dir = path.join(sfs.appStorage, 'kept')
    const installed = await this.kept()
    const owner = (await this.space.getRole(this.hg.identity.publicKey)) === 'owner'
    // what is here, at once; waits up to `opts.timeout` only when nothing of the site is (a publisher offline never completes it)
    const read = (o) => Promise.all([all(this.space.query('upload'), o), all(this.pages.space.query('file'), o)])
    let [uploads, pages] = await read()
    if (!uploads.items.length && !pages.items.length && !(uploads.complete && pages.complete) && opts?.timeout) [uploads, pages] = await read(opts)
    const inSite = [...uploads.items.map((r) => [this, r]), ...pages.items.filter((r) => r.parent !== BIN).map((r) => [this.pages, r])]
    const wanted = inSite.filter(([d]) => installed || (owner && d === this))
    const mineHeld = async (where) => (await all(where ? mine(this.hg, 'held').where(where) : mine(this.hg, 'held'))).items
    for (const [drive, r] of wanted) {
      if (inlineOf(r)) continue
      const root = rootOf(r.content)
      const target = path.join(dir, root)
      const held = await mineHeld({ root })
      if (held.some((h) => h.path === target)) { // there, maybe for another site: held for this one too
        if (!held.some((h) => h.path === target && h.space === drive.key)) await recordHeld(this.hg, { root, path: target, size: r.content.size, space: drive.key, entry: r.id })
        continue
      }
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.rm(target, { force: true }) // ours: a copy left without its held record
      const here = await localPath(this.hg, root)
      if (!here) {
        await drive.fetch(r.id, target).catch(() => {}) // no holder online: again on 'peers'
        continue
      }
      if (path.dirname(here) === sfs.appStorage) { // from the cache: moved, not fetched again
        await move(here, target)
        for (const h of held) if (h.path === here) await this.hg.personal.del(h.id)
        sfs._used.delete(here)
      } else {
        await fs.promises.copyFile(here, target)
      }
      await recordHeld(this.hg, { root, path: target, size: r.content.size, space: drive.key, entry: r.id })
    }
    if (!uploads.complete || !pages.complete) return
    const keys = new Set([this.key, this.pages.key])
    const keep = new Set(wanted.map(([d, r]) => d.key + rootOf(r.content)))
    const still = new Set(inSite.map(([, r]) => rootOf(r.content)))
    let handed = false
    for (const h of await mineHeld()) {
      if (path.dirname(h.path) !== dir || !keys.has(h.space) || keep.has(h.space + h.root)) continue
      await this.hg.personal.del(h.id)
      if ((await mineHeld({ root: h.root })).some((o) => o.path === h.path)) continue // kept for another site too
      const cached = path.join(sfs.appStorage, h.root)
      try {
        if (still.has(h.root) && !(await stat(cached))) {
          await move(h.path, cached)
          await recordHeld(this.hg, { root: h.root, path: cached, size: h.size, space: h.space, entry: h.entry })
          handed = true
        } else {
          await fs.promises.rm(h.path, { force: true })
        }
      } catch {
        await recordHeld(this.hg, h) // being served (Windows): the next pass
      }
    }
    if (handed) await sfs._evict()
  }
}

// rename, or a copy where it can't (another drive, a file being served on Windows).
async function move (from, to) {
  try {
    await fs.promises.rename(from, to)
  } catch {
    await fs.promises.copyFile(from, to)
    await fs.promises.rm(from, { force: true }).catch(() => {}) // left: no held record, overwritten when fetched again
  }
}

function upload (r) {
  return { id: r.id, name: r.name, size: r.content.size, hash: rootOf(r.content), author: r.author }
}
