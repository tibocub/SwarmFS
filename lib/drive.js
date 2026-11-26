import fs from 'fs'
import path from 'path'
import { SwarmFSError } from './errors.js'
import { validName, rootOf, inlineOf, BIN } from './types.js'
import { setInvites, invitesOf, isShared, namesOf, syncHas } from './members.js'
import { addFile, all, stat, localPath, recordHeld } from './holdings.js'
import { compile, ignored } from './ignore.js'

/**
 * @typedef {import('./types.js').Space} Space
 * @typedef {import('./types.js').EntryRecord} EntryRecord
 * @typedef {import('./types.js').HeldRecord} HeldRecord
 * @typedef {import('./types.js').HasRecord} HasRecord
 * @typedef {import('./types.js').ContentRef} ContentRef
 * @typedef {import('./types.js').HgRecord & { name: string, parent?: string, content?: import('./types.js').ContentRef }} EntryLike a folder, file or upload record
 * @typedef {import('./ignore.js').Rule} Rule
 * @typedef {import('./members.js').InviteSetting} InviteSetting
 * @typedef {{ names: Map<string, string>, online: Set<string>, people: Map<string, string> }} HolderContext
 */

/**
 * An entry of a space: a folder or a file (or, read by id from a site's space, an upload).
 * @typedef {object} Entry
 * @property {string} id
 * @property {'folder'|'file'|'upload'} kind
 * @property {string} name
 * @property {string} [parent] - the folder's id, or the space key (the top); none for an upload
 * @property {number|null} size - bytes; null for a folder
 * @property {string|null} hash - the BLAKE3 root (hex); null for a folder
 * @property {Holder[]} holders - devices holding the file (filled by {@link Drive#list} and {@link Drive#get})
 */

/**
 * A removed entry, in a shared space's bin. `from`: the folder it was in; `binned`: ms; `by`: who removed it.
 * @typedef {Entry & { from: string, binned: number, by: { identity: string | null, name: string | null } }} BinnedEntry
 */

/**
 * A person of a space.
 * @typedef {object} Member
 * @property {string} identity
 * @property {string|null} name
 * @property {string|null} role
 * @property {boolean} you
 * @property {boolean} removed
 * @property {boolean} banned
 * @property {boolean} online
 */

/**
 * A device holding a file.
 * @typedef {object} Holder
 * @property {string} device - its public key
 * @property {string} [identity] - another person's device: their identity
 * @property {string} name - the device's name, or the other person's name
 * @property {boolean} online
 * @property {string|null} path - where this device holds it; null for other devices
 */

/**
 * A files space: folders and files as records, the bytes where they lie on each device.
 * Get one from {@link SwarmFS#createSpace}, {@link SwarmFS#join} or {@link SwarmFS#space}.
 */
export class Drive {
  /**
   * @param {import('./swarmfs.js').SwarmFS} sfs
   * @param {Space} space
   */
  constructor (sfs, space) {
    /** the instance it belongs to */
    this.sfs = sfs
    /** its open Hypergraph */
    this.hg = sfs.hg
    /** the hypergraph space */
    this.space = space
  }

  /** @type {string} the space key */
  get key () { return this.space.key }
  /** @type {string} the space name */
  get name () { return this.space.name }
  /** @type {string} the id of the top folder (the space key) */
  get top () { return this.space.key }

  /**
   * Listens to the space's events (hypergraph's: `'change'` when records change, `'peers'`, `'members'`...).
   * @param {string} event
   * @param {(...args: any[]) => void} fn - its arguments: hypergraph's, per event
   * @returns {this}
   */
  on (event, fn) {
    this.space.on(event, fn)
    return this
  }

  /**
   * @param {string} event
   * @param {(...args: any[]) => void} fn
   * @returns {this}
   */
  off (event, fn) {
    this.space.off(event, fn)
    return this
  }

  /**
   * Adds a file or a folder (with all under it) in place: hashed where it lies, nothing copied or
   * written to disk. A folder becomes a linked folder of this device, kept in sync both ways.
   * `NOT_FOUND`: no such path; `EXISTS`: it is, is inside, or holds a folder linked here.
   * @param {string} localPath
   * @param {object} [opts]
   * @param {string} [opts.parent=this.top] - the folder to add it to
   * @returns {Promise<Entry>}
   */
  async add (localPath, { parent = this.top } = {}) {
    const full = path.resolve(localPath)
    const st = await stat(full)
    if (!st) throw new SwarmFSError('NOT_FOUND', `no such file or folder: ${full}`)
    await this.sfs._overlaps(full)
    if (!st.directory) return entry(/** @type {EntryLike} */ (await addFile(this.hg, this.space, full, parent)))
    const folder = await this.space.put('folder', { name: path.basename(full), parent })
    const rules = compile(await fs.promises.readFile(path.join(full, '.swarmfsignore'), 'utf8').catch(() => ''), { images: this.hg.transport === 'i2p' })
    await this.#addChildren(full, folder.id, rules, full)
    const rec = /** @type {import('./types.js').AddedRecord} */ (await this.hg.personal.put('added', { path: full, space: this.key, folder: folder.id }))
    await this.sfs._linked(rec)
    return entry(/** @type {EntryLike} */ (folder))
  }

  /**
   * @param {string} dir
   * @param {string} parent
   * @param {Rule[]} rules
   * @param {string} root
   * @returns {Promise<void>}
   */
  async #addChildren (dir, parent, rules, root) {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (ignored(rules, path.relative(root, full), e.isDirectory())) continue
      if (e.isDirectory()) {
        const folder = await this.space.put('folder', { name: e.name, parent })
        await this.hg.personal.put('held', { root: '', path: full, size: 0, mtime: 0, space: this.key, entry: folder.id })
        await this.#addChildren(full, folder.id, rules, root)
      } else if (e.isFile()) {
        await addFile(this.hg, this.space, full, parent)
      }
    }
  }

  /**
   * Links a space folder to a local path on this device; {@link SwarmFS#sync} fills it and follows
   * it. The path is made if missing. Files already there: the same content at an entry's place is
   * taken as held; other content under an entry's name becomes a conflict copy; the rest is added.
   * `NOT_FOUND`: no such folder; `EXISTS`: the path overlaps a linked folder, or this folder is
   * already linked here.
   * @param {string} folder - a folder's id, or {@link Drive#top}
   * @param {string} localPath
   * @returns {Promise<void>}
   */
  async link (folder, localPath) {
    const full = path.resolve(localPath)
    if (folder !== this.top) {
      const { record } = await this.space.get(folder)
      if (!record || record.type !== 'folder') throw new SwarmFSError('NOT_FOUND', `no folder ${folder}`)
    }
    await this.sfs._overlaps(full)
    if ((await this.sfs._links()).some((l) => l.space === this.key && l.folder === folder)) {
      throw new SwarmFSError('EXISTS', `${folder} is already linked on this device`)
    }
    await fs.promises.mkdir(full, { recursive: true })
    const rec = /** @type {import('./types.js').AddedRecord} */ (await this.hg.personal.put('added', { path: full, space: this.key, folder }))
    await this.sfs._linked(rec)
  }

  /**
   * One page of a folder's entries: folders first, then files, by name.
   * @param {string} [folder=this.top]
   * @param {object} [opts]
   * @param {number} [opts.limit=100]
   * @param {Entry|string} [opts.after] - the last entry (or its id) of the previous page
   * @param {number} [opts.timeout] - ms to wait for entries other devices know of
   * @returns {Promise<{items: Entry[], complete: boolean}>} `complete` false: a device holding more
   *   of the space isn't online
   */
  // shortcut: reads the whole folder to sort it; fine for thousands, page server-side if folders get huge.
  async list (folder = this.top, { limit = 100, after, timeout } = {}) {
    const folders = /** @type {import('./types.js').Page<EntryRecord>} */ (await all(this.space.query('folder').where({ parent: folder }), { timeout }))
    const files = /** @type {import('./types.js').Page<EntryRecord>} */ (await all(this.space.query('file').where({ parent: folder }), { timeout }))
    /** @param {EntryRecord} a @param {EntryRecord} b */
    const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    let records = [...folders.items.sort(byName), ...files.items.sort(byName)]
    if (after) records = records.slice(records.findIndex((r) => r.id === (/** @type {Entry} */ (after).id || after)) + 1)
    const page = records.slice(0, limit)
    const ctx = await this.#holderContext()
    return {
      items: await Promise.all(page.map((r) => this.#withHolders(r, ctx))),
      complete: folders.complete && files.complete
    }
  }

  /**
   * One entry. `NOT_FOUND` if there is none.
   * @param {string} id
   * @returns {Promise<Entry>}
   */
  async get (id) {
    const { record } = await this.space.get(id)
    if (!record) throw new SwarmFSError('NOT_FOUND', `no entry ${id}`)
    return this.#withHolders(/** @type {EntryLike} */ (record), await this.#holderContext())
  }

  /**
   * Fetches a file from an online holder, verified piece by piece, into `<localFile>.part` until
   * complete (resumable). A file held here already is not fetched: its path is returned. A small
   * file inside its record is written from it.
   * `EXISTS`: `localFile` exists; `NOT_AVAILABLE`: no holder online, every holder refused, or no
   * progress for `fetchTimeout`; `NOT_FOUND`: no such file.
   * @param {string} id
   * @param {string} localFile
   * @returns {Promise<{path: string, bytes: number}>} `bytes`: transferred (0 when held or inline)
   */
  async fetch (id, localFile) {
    const { record } = await this.space.get(id)
    if (!record) throw new SwarmFSError('NOT_FOUND', `no entry ${id}`)
    const e = await this.#withHolders(/** @type {EntryLike} */ (record), await this.#holderContext())
    if (!e.hash) throw new SwarmFSError('NOT_FOUND', `not a file: ${id}`)
    const here = await localPath(this.hg, e.hash)
    if (here) return { path: here, bytes: 0 }
    const full = path.resolve(localFile)
    if (await stat(full)) throw new SwarmFSError('EXISTS', `already there: ${full}`)
    const bytes = inlineOf(/** @type {import('./types.js').ContentRecord} */ (record))
    if (bytes) {
      await fs.promises.mkdir(path.dirname(full), { recursive: true })
      await fs.promises.writeFile(full, bytes)
      await recordHeld(this.hg, { root: e.hash, path: full, size: /** @type {number} */ (e.size), space: this.key, entry: id })
      return { path: full, bytes: 0 }
    }
    const me = this.hg.device.publicKey
    // other people's holdings may be private: any of their connected devices may have it
    const mine = new Set((await this.hg.devices()).map((d) => d.publicKey))
    const others = this.space.memberConnections().some((m) => !mine.has(m.device))
    if (!others && !e.holders.some((h) => h.online && h.device !== me)) throw new SwarmFSError('NOT_AVAILABLE', `no holder online for ${id}`)

    const download = this.sfs._download(e.hash, /** @type {number} */ (e.size), full, this.key) // a file: a hash and a size
    // `stalled` covers peers that answer; the idle timer, peers that never do
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
    const idle = () => { clearTimeout(timer); timer = setTimeout(() => download.stop(), this.sfs.fetchTimeout) }
    download.on('progress', idle)
    download.on('stalled', () => download.stop())
    idle()
    try {
      await download
    } finally {
      clearTimeout(timer)
    }
    if (!(await stat(full))) throw new SwarmFSError('NOT_AVAILABLE', `not fetched: ${id}`)
    await recordHeld(this.hg, { root: e.hash, path: full, size: /** @type {number} */ (e.size), space: this.key, entry: id })
    return { path: full, bytes: /** @type {number} */ (e.size) }
  }

  /**
   * Renames an entry. `INVALID_NAME`: empty, over 255 bytes, or holding `/` or a NUL.
   * @param {string} id
   * @param {string} name
   * @returns {Promise<Entry>}
   */
  async rename (id, name) {
    if (!validName(name)) throw new SwarmFSError('INVALID_NAME', `not a valid name: ${JSON.stringify(name)}`)
    return entry(/** @type {EntryLike} */ (await this.space.edit(id, { name })))
  }

  /**
   * Moves an entry into `folder`. `MOVE_INTO_SELF`: a folder into itself or its subtree;
   * `NOT_FOUND`: `folder` isn't a folder.
   * @param {string} id
   * @param {string} folder - a folder's id, or {@link Drive#top}
   * @returns {Promise<Entry>}
   */
  async move (id, folder) {
    for (let at = folder; at !== this.top;) {
      if (at === id) throw new SwarmFSError('MOVE_INTO_SELF', `${id} cannot move into itself or its subtree`)
      const { record } = /** @type {{ record: EntryRecord | null }} */ (await this.space.get(at))
      if (!record || record.type !== 'folder') throw new SwarmFSError('NOT_FOUND', `no folder ${at}`)
      at = record.parent
    }
    return entry(/** @type {EntryLike} */ (await this.space.edit(id, { parent: folder })))
  }

  /**
   * Removes an entry with all under it. In a shared space (a second person was ever in it) it goes
   * to the bin; otherwise it is deleted for good. Local files are never touched.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async remove (id) {
    const { record } = /** @type {{ record: EntryRecord | null }} */ (await this.space.get(id))
    if (!record) throw new SwarmFSError('NOT_FOUND', `no entry ${id}`)
    if (record.parent === BIN) return
    if (await isShared(this.space)) return void await this.space.edit(id, { parent: BIN, from: record.parent, binned: Date.now() })
    await this.#erase(record)
  }

  /**
   * @param {EntryRecord} record
   * @returns {Promise<void>}
   */
  async #erase (record) {
    if (record.type === 'folder') {
      for (const child of await this.#children(record.id)) await this.#erase(child)
    }
    await this.space.del(record.id)
  }

  /**
   * @param {string} id
   * @returns {Promise<EntryRecord[]>}
   */
  async #children (id) {
    return /** @type {EntryRecord[]} */ ([...(await all(this.space.query('folder').where({ parent: id }))).items, ...(await all(this.space.query('file').where({ parent: id }))).items])
  }

  /**
   * What was removed in a shared space, latest first.
   * @returns {Promise<BinnedEntry[]>}
   */
  async bin () {
    // `bin-v1`: an entry in the bin has its `from`, and `binned` comes with it
    const records = /** @type {Array<EntryRecord & { from: string, binned: number }>} */ (await this.#children(BIN)).sort((a, b) => b.binned - a.binned)
    const names = await namesOf(this.space)
    /** @type {Map<string, string>} */
    const owner = new Map()
    for (const m of await this.space.members()) for (const d of m.devices) owner.set(d.device, m.identity)
    return records.map((r) => {
      const identity = owner.get(r.device) || null
      return { ...entry(r), from: r.from, binned: r.binned, by: { identity, name: names.get(/** @type {string} */ (identity)) || null } }
    })
  }

  /**
   * Puts an entry back where it was, or at the top if that folder is gone. `NOT_FOUND` if it isn't in the bin.
   * @param {string} id
   * @returns {Promise<Entry>}
   */
  async restore (id) {
    const { record } = /** @type {{ record: (EntryRecord & { from: string }) | null }} */ (await this.space.get(id)) // `bin-v1`: a `from` in the bin
    if (!record || record.parent !== BIN) throw new SwarmFSError('NOT_FOUND', `${id} is not in the bin`)
    const there = record.from === this.top || !!(await this.space.get(record.from)).record
    return entry(/** @type {EntryLike} */ (await this.space.edit(id, { parent: there ? record.from : this.top, from: '', binned: 0 })))
  }

  /**
   * Deletes the bin for good: everything for an owner or admin; for others, only what they added
   * (with all under it).
   * @returns {Promise<{removed: number, kept: number}>} `kept`: entries this person may not delete
   */
  async emptyBin () {
    const me = this.hg.identity.publicKey
    const everything = ['owner', 'admin'].includes(/** @type {string} */ (await this.space.getRole(me)))
    /** @type {(r: EntryRecord) => Promise<boolean>} */
    const theirs = async (r) => r.author === me && (r.type !== 'folder' || (await Promise.all((await this.#children(r.id)).map(theirs))).every(Boolean))
    let removed = 0
    let kept = 0
    for (const r of await this.#children(BIN)) {
      if (everything || await theirs(r)) {
        await this.#erase(r)
        removed++
      } else kept++
    }
    return { removed, kept }
  }

  /**
   * An invite code. `NOT_ALLOWED` (with why) if this person may not invite; `NOT_SUPPORTED` for a
   * reader in a private space.
   * @param {object} [opts]
   * @param {'editor'|'reader'} [opts.role='editor'] - an editor writes; a reader only reads
   * @param {number} [opts.uses=1]
   * @param {number} [opts.expires=0] - ms timestamp; 0: never
   * @returns {Promise<string>}
   */
  async invite ({ role = 'editor', uses = 1, expires = 0 } = {}) {
    if (role !== 'editor' && role !== 'reader') throw new TypeError('role: editor or reader')
    await this.space.ready()
    if (role === 'reader' && this.space.private) throw new SwarmFSError('NOT_SUPPORTED', 'a private space has no readers yet (hypergraph H6)')
    if (!(await invitesOf(this.space))) await setInvites(this.space, 'admins') // a space made before invite settings
    if (role === 'reader' && !(await this.space.roles()).some((r) => r.name === 'reader')) await this.space.defineRole('reader', []) // a space made before readers
    return this.space.createInvite({ role, uses, expires })
  }

  /**
   * No one else gets in with this code.
   * @param {string} code
   * @returns {Promise<void>}
   */
  revokeInvite (code) {
    return this.space.revokeInvite(code)
  }

  /**
   * Who may invite: `'everyone'`, `'chosen'` (trusted members), `'admins'`; null for a space made
   * before this setting.
   * @returns {Promise<'everyone'|'chosen'|'admins'|null>}
   */
  invites () {
    return invitesOf(this.space)
  }

  /**
   * Changes who may invite (owner, admins). A code is judged when used: its maker must still be allowed.
   * @param {InviteSetting} setting
   * @returns {Promise<void>}
   */
  setInvites (setting) {
    return setInvites(this.space, setting)
  }

  /**
   * The people of the space.
   * @returns {Promise<Member[]>}
   */
  async members () {
    const names = await namesOf(this.space)
    const online = new Set(this.space.peers().map((p) => p.identity))
    return (await this.space.members()).map(({ identity, role, you, removed, banned }) =>
      ({ identity, name: names.get(identity) || null, role, you, removed, banned, online: you || online.has(identity) }))
  }

  /**
   * Sets a member's role (hypergraph's rules decide who may).
   * @param {string} identity
   * @param {'admin'|'trusted'|'editor'|'reader'} role
   * @returns {Promise<void>}
   */
  setRole (identity, role) {
    return this.space.setRole(identity, role)
  }

  /**
   * Takes someone out of the space.
   * @param {string} identity
   * @param {object} [opts]
   * @param {boolean} [opts.ban=false] - keep them out
   * @param {boolean} [opts.dropAll=false] - ban, and drop everything they added
   * @returns {Promise<void>}
   */
  removeMember (identity, { ban = false, dropAll = false } = {}) {
    if (!ban && !dropAll) return this.space.removeRole(identity)
    return this.space.moderateAction('ban', identity, dropAll ? { drop: 'all' } : {})
  }

  /**
   * Whether this person's devices show the others which files they hold here (never paths). Off by default.
   * @param {boolean} on
   * @returns {Promise<void>}
   */
  async showHoldings (on) {
    const keys = new Set((await this.hg.settings())['show-holdings'] || [])
    if (on) keys.add(this.key)
    else keys.delete(this.key)
    await this.hg.setSetting('show-holdings', [...keys])
    await syncHas(this.hg, this.space)
  }

  /** @returns {Promise<HolderContext>} */
  async #holderContext () {
    const devices = await this.hg.devices()
    const names = new Map(devices.map((d) => [d.publicKey, d.name]))
    const online = new Set(this.space.peers().map((p) => p.device))
    online.add(this.hg.device.publicKey)
    return { names, online, people: await namesOf(this.space) }
  }

  /**
   * @param {EntryLike} record
   * @param {HolderContext} ctx
   * @returns {Promise<Entry>}
   */
  async #withHolders (record, { names, online, people }) {
    const e = entry(record)
    if (e.hash) {
      const me = this.hg.device.publicKey
      /** @type {Map<string, Holder>} */
      const seen = new Map()
      for (const h of /** @type {HeldRecord[]} */ ((await all(this.hg.personal.query('held').where({ root: e.hash }))).items)) {
        // one per device; for this device, the path of this very entry if it has one
        if (seen.has(h.device) && !(h.device === me && h.entry === e.id)) continue
        seen.set(h.device,{ device: h.device, name: names.get(h.device) ?? '', online: online.has(h.device), path: h.device === me ? h.path : null })
      }
      const self = this.hg.identity.publicKey
      for (const h of /** @type {HasRecord[]} */ ((await all(this.space.query('has').where({ root: e.hash }))).items)) {
        if (h.author === self || seen.has(h.device)) continue
        seen.set(h.device, { device: h.device, identity: h.author, name: people.get(h.author) ?? '', online: online.has(h.device), path: null })
      }
      e.holders = [...seen.values()]
    }
    return e
  }
}

/**
 * @param {EntryLike} r
 * @returns {Entry}
 */
export function entry (r) {
  const file = !!r.content // a file, or an upload
  return {
    id: r.id,
    kind: /** @type {Entry['kind']} */ (r.type),
    name: r.name,
    parent: r.parent,
    size: file ? /** @type {ContentRef} */ (r.content).size : null,
    hash: file ? rootOf(/** @type {ContentRef} */ (r.content)) : null,
    holders: []
  }
}
