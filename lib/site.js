import fs from 'fs'
import path from 'path'
import { Drive } from './drive.js'
import { SwarmFSError } from './errors.js'
import { validName, rootOf, inlineOf, siteTypes, BIN } from './types.js'
import { all, mine, stat, hash, contentOf, localPath, recordHeld, findHere } from './holdings.js'

/**
 * @typedef {import('./types.js').Space} Space
 * @typedef {import('./types.js').HeldRecord} HeldRecord
 * @typedef {import('./types.js').ContentRecord} ContentRecord
 * @typedef {import('./types.js').FileRecord} FileRecord
 * @typedef {import('./types.js').UploadRecord} UploadRecord
 */

/**
 * An upload of a site.
 * @typedef {object} Upload
 * @property {string} id
 * @property {string} name
 * @property {number} size - bytes
 * @property {string} hash - the BLAKE3 root (hex)
 * @property {string} author - the uploader's identity
 */

/**
 * A site: a space whose pages live in a sub-space only the owner and admins write, and whose
 * members' uploads live in the space itself. What a visitor reads lands in app storage. Members,
 * roles and invites work as on any {@link Drive}. Get one from {@link SwarmFS#createSite},
 * {@link SwarmFS#visit} or {@link SwarmFS#site}.
 */
export class Site extends Drive {
  /**
   * @param {import('./swarmfs.js').SwarmFS} sfs
   * @param {Space} space
   * @param {Space} pages - its pages sub-space
   * @param {string|null} [app] - the key of the site whose code it runs
   */
  constructor (sfs, space, pages, app = null) {
    super(sfs, space)
    /** @type {Drive} the pages: list, get, rename... (owner and admins write) */
    this.pages = new Drive(sfs, pages)
    /** @type {string|null} the key of the site whose code this one runs (an app's instance), or null */
    this.app = app
  }

  /** @type {boolean} readable by anyone with the public link */
  get isPublic () { return this.space.isPublic }

  /**
   * Makes a folder's files the pages: it becomes a linked folder of this device, so its edits are
   * published while {@link SwarmFS#sync} runs.
   * @param {string} localFolder
   * @returns {Promise<void>}
   */
  async publish (localFolder) {
    await this.pages.link(this.pages.top, localFolder)
    if (!this.sfs._syncing) await this.sfs.rescan() // not syncing: rescan gives it its first pass
  }

  /**
   * Makes the site readable by anyone with its public link, for good (owner, admins). Refused for a private site.
   * @returns {Promise<void>}
   */
  async makePublic () {
    await this.space.makePublic()
    await this.pages.space.makePublic() // a public joiner gets no closed sub-space
  }

  /**
   * Adds record types to the site (owner, admins): new types, and new fields at the end of existing
   * ones only (hypergraph's `INCOMPATIBLE_TYPES` otherwise). `INVALID_TYPE` for one of SwarmFS's names.
   * @param {import('./types.js').TypeDeclarations} own - `{ name: { fields: { field: kind } } }`, as hypergraph takes them
   * @returns {Promise<void>}
   */
  async declareTypes (own) {
    await this.space.declareTypes(siteTypes(own))
  }

  /**
   * The link anyone reads the site with; hypergraph's `NOT_ALLOWED` before it is public.
   * @returns {string}
   */
  publicLink () {
    return this.space.publicLink()
  }

  /**
   * A page's bytes by its path in the site, verified: from its record (small files), from this
   * device, or fetched into app storage. Answers at once from what is here, its publisher offline
   * or not. `NOT_FOUND`: no such page; `NOT_AVAILABLE`: no holder online.
   * @param {string} p - `'docs/about.html'`
   * @param {object} [opts]
   * @param {number} [opts.timeout=10000] - ms to wait for a page not here yet
   * @returns {Promise<Uint8Array>}
   */
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
    return this.sfs._bytes(this.pages, /** @type {FileRecord} */ (record))
  }

  /**
   * Uploads a file (members with the `editor` role), from where it lies: served from there.
   * `INVALID_NAME`, `NOT_FOUND` (no such file).
   * @param {string} localFile
   * @param {object} [opts]
   * @param {string} [opts.name] - default: the file's name
   * @returns {Promise<Upload>}
   */
  async upload (localFile, { name = path.basename(localFile) } = {}) {
    if (!validName(name)) throw new SwarmFSError('INVALID_NAME', `not a valid name: ${JSON.stringify(name)}`)
    const full = path.resolve(localFile)
    if (!(await stat(full))?.file) throw new SwarmFSError('NOT_FOUND', `no such file: ${full}`)
    const { root, size, mtime } = await hash(full)
    const r = await this.space.put('upload', { name, ...await contentOf(full, root, size, true) })
    await this.hg.personal.put('held', { root, path: full, size, mtime, space: this.key, entry: r.id })
    return upload(/** @type {UploadRecord} */ (r))
  }

  /**
   * The site's uploads, latest first.
   * @returns {Promise<Upload[]>}
   */
  async uploads () {
    return /** @type {UploadRecord[]} */ ((await all(this.space.query('upload'))).items).map(upload)
  }

  /**
   * An upload's bytes, as {@link Site#read}. `NOT_FOUND` if there is no such upload.
   * @param {string} id
   * @returns {Promise<Uint8Array>}
   */
  async readUpload (id) {
    const { record } = await this.space.get(id)
    if (record?.type !== 'upload') throw new SwarmFSError('NOT_FOUND', `no upload ${id}`)
    return this.sfs._bytes(this, /** @type {UploadRecord} */ (record))
  }

  /**
   * Renames an upload (its author only).
   * @param {string} id
   * @param {string} name
   * @returns {Promise<Upload>}
   */
  async renameUpload (id, name) {
    if (!validName(name)) throw new SwarmFSError('INVALID_NAME', `not a valid name: ${JSON.stringify(name)}`)
    return upload(/** @type {UploadRecord} */ (await this.space.edit(id, { name })))
  }

  /**
   * Removes an upload (its author, the owner or an admin).
   * @param {string} id
   * @returns {Promise<void>}
   */
  async removeUpload (id) {
    await this.space.del(id)
  }

  /**
   * Installs the site on this device (`true`): every page and upload fetched into app storage's
   * `kept/`, never evicted, served to its members, followed while {@link SwarmFS#sync} runs; or hands
   * it back to the cache (`false`). Remembered on this device. Resolves after one pass; a file no one
   * online holds comes on a later one.
   * @param {boolean} on
   * @param {object} [opts]
   * @param {number} [opts.timeout=10000] - ms to wait for the site's records when none is here yet
   * @returns {Promise<void>}
   */
  async keep (on, { timeout = 10000 } = {}) {
    const recs = (await all(mine(this.hg, 'kept').where({ space: this.key }))).items
    if (on && !recs.length) await this.hg.personal.put('kept', { space: this.key })
    if (!on) for (const r of recs) await this.hg.personal.del(r.id)
    if (this.sfs._syncing) await this.sfs._keep(this.key, { again: true, timeout })
    else await this._keep({ timeout })
  }

  /**
   * Whether this device keeps the site ({@link Site#keep}).
   * @returns {Promise<boolean>}
   */
  async kept () {
    return (await all(mine(this.hg, 'kept').where({ space: this.key }))).items.length > 0
  }

  /**
   * Bytes of the site on this device: its files held here (each path once, while still as hashed),
   * plus the small ones inside their records.
   * @returns {Promise<number>}
   */
  // shortcut: reads every held record of this device; keep a sum per site if the toolbar calls it often.
  async held () {
    const keys = new Set([this.key, this.pages.key])
    /** @type {Map<string, HeldRecord>} */
    const paths = new Map()
    for (const h of /** @type {HeldRecord[]} */ ((await all(mine(this.hg, 'held'))).items)) if (h.root !== '' && keys.has(h.space)) paths.set(h.path, h)
    let bytes = 0
    for (const h of paths.values()) {
      const st = await stat(h.path)
      if (st?.file && st.size === h.size && st.mtime === h.mtime) bytes += h.size
    }
    for (const [space, type] of /** @type {Array<[Space, string]>} */ ([[this.pages.space, 'file'], [this.space, 'upload']])) {
      for (const r of /** @type {ContentRecord[]} */ ((await all(space.query(type))).items)) if (inlineOf(r)) bytes += r.content.size
    }
    return bytes
  }

  /**
   * One keeping pass (see {@link Site#keep}).
   * @param {{ timeout?: number }} [opts]
   * @returns {Promise<void>}
   */
  async _keep (opts) {
    const sfs = this.sfs
    const dir = path.join(sfs.appStorage, 'kept')
    const installed = await this.kept()
    const owner = (await this.space.getRole(this.hg.identity.publicKey)) === 'owner'
    // what is here, at once; waits up to `opts.timeout` only when nothing of the site is (a publisher offline never completes it)
    /** @param {{ timeout?: number }} [o] */
    const read = (o) => /** @type {Promise<[import('./types.js').Page<UploadRecord>, import('./types.js').Page<FileRecord>]>} */ (Promise.all([all(this.space.query('upload'), o), all(this.pages.space.query('file'), o)]))
    let [uploads, pages] = await read()
    if (!uploads.items.length && !pages.items.length && !(uploads.complete && pages.complete) && opts?.timeout) [uploads, pages] = await read(opts)
    /** @type {Array<[Drive, ContentRecord]>} */
    const inSite = [...uploads.items.map((r) => /** @type {[Drive, ContentRecord]} */ ([this, r])), ...pages.items.filter((r) => r.parent !== BIN).map((r) => /** @type {[Drive, ContentRecord]} */ ([this.pages, r]))]
    const wanted = inSite.filter(([d]) => installed || (owner && d === this))
    /** @param {{ root: string }} [where] */
    const mineHeld = async (where) => /** @type {HeldRecord[]} */ ((await all(where ? mine(this.hg, 'held').where(where) : mine(this.hg, 'held'))).items)
    for (const [drive, r] of wanted) {
      if (inlineOf(r)) continue
      const root = rootOf(r.content)
      const target = path.join(dir, root)
      const held = await mineHeld({ root })
      if (held.some((h) => h.path === target)) { // already there for another site: held for this one too
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
      if (path.dirname(here) === sfs.appStorage) {
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

/**
 * rename, or a copy where it can't (another drive, a file being served on Windows).
 * @param {string} from
 * @param {string} to
 */
async function move (from, to) {
  try {
    await fs.promises.rename(from, to)
  } catch {
    await fs.promises.copyFile(from, to)
    await fs.promises.rm(from, { force: true }).catch(() => {}) // left: no held record, overwritten when fetched again
  }
}

/**
 * @param {UploadRecord} r
 * @returns {Upload}
 */
function upload (r) {
  return { id: r.id, name: r.name, size: r.content.size, hash: rootOf(r.content), author: r.author }
}
