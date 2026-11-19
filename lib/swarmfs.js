import fs from 'fs'
import path from 'path'
import hypergraph from 'hypergraph/next'
import { types, rules, rootOf, inlineOf, siteTypes, BIN } from './types.js'
import { Drive } from './drive.js'
import { Site } from './site.js'
import { SwarmFSError } from './errors.js'
import { all, mine, stat, rescanSingles, spaceOf, localPath, hash, recordHeld } from './holdings.js'
import { Link } from './sync.js'
import { listTrash, emptyTrash } from './trash.js'
import { watch } from './watch.js'
import { transfer } from './transfer.js'
import { setInvites, publishName, namesOf, syncHas, siteOf } from './members.js'
import { validPersonName } from './types.js'

const { Hypergraph } = hypergraph

const TICK = 10000 // paused folders, due fetches and the free-space floor checked again
const DEBOUNCE = 500 // a burst of a space's changes: one remote pass
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One SwarmFS instance: a hypergraph identity on this device, its spaces as drives and sites,
 * and the linked folders kept in sync by {@link SwarmFS#sync}. Open it with {@link SwarmFS.open}.
 */
export class SwarmFS {
  /**
   * Use {@link SwarmFS.open}; the constructor takes an already open Hypergraph.
   * @param {object} hg - an open `Hypergraph` (from `hypergraph/next`), opened with SwarmFS's types and rules
   * @param {object} [opts] - as {@link SwarmFS.open}, plus `dir`, the instance folder
   */
  constructor (hg, { dir, fetchTimeout = 30000, minFree, appStorageMax = 1024 ** 3 } = {}) {
    this.hg = hg
    this.appStorage = path.join(path.resolve(dir), 'app-storage')
    this.appStorageMax = appStorageMax
    this._used = new Map() // app storage path -> last read, while open
    this._holding = new Map() // app storage path -> its fetch in progress
    this._kept = new Set() // top spaces checked for "a site I own or installed" (kept while syncing)
    this._keepers = new Map() // site key -> its keeping pass, while syncing
    this.fetchTimeout = fetchTimeout
    this.minFree = minFree
    this._fetching = new Map() // root -> Set of space keys it is downloading for
    this.transfer = transfer(hg, this._fetching)
    this._drives = new Map()
    this._listeners = new Set()
    this._live = new Map() // linked path -> Link, while syncing
    this._syncing = null
  }

  /**
   * Opens (or makes) the instance in `dir`, rescans the disk and connects.
   * @param {string} dir - the instance folder; made if missing
   * @param {object} [opts]
   * @param {string} [opts.password] - seals the recovery phrase when the folder is made (new, or with
   *   `joinCode`); not needed at later opens
   * @param {string} [opts.joinCode] - a code from {@link SwarmFS#addDevice}: open as a new device of that person
   * @param {number} [opts.joinTimeout] - ms a `joinCode` is tried (hypergraph's default)
   * @param {string} [opts.deviceName] - this device's name, when made
   * @param {Array<{host: string, port: number}>} [opts.bootstrap] - DHT nodes (a private DHT, in tests)
   * @param {number} [opts.fetchTimeout=30000] - ms without progress before a fetch gives up
   * @param {number} [opts.minFree] - bytes left free on a linked folder's disk when fetching;
   *   default max(5 GB, 5 % of the disk)
   * @param {number} [opts.appStorageMax=1073741824] - bytes: the cap of app storage (site files read here)
   * @param {boolean} [opts.offline=false] - read the folder as it is: no rescan, no name published,
   *   never online (a build exporting sites with {@link SwarmFS#exportSites})
   * @returns {Promise<SwarmFS>}
   */
  static async open (dir, { password, joinCode, joinTimeout, deviceName, bootstrap, fetchTimeout, minFree, appStorageMax, offline = false } = {}) {
    const hg = await Hypergraph.open(dir, { types, rules, password, joinCode, joinTimeout, deviceName, bootstrap })
    const sfs = new SwarmFS(hg, { dir, fetchTimeout, minFree, appStorageMax })
    if (offline) return sfs
    sfs._people()
    await sfs.rescan() // before connecting: writes don't wait for peers
    await hg.connectToSwarm()
    return sfs
  }

  /** @type {string} this device's public key */
  get device () {
    return this.hg.device.publicKey
  }

  /**
   * A pairing code for a new device of this person (hypergraph's `addDevice`).
   * @param {object} [opts]
   * @param {string} [opts.password] - the password this device was made with
   * @returns {Promise<{code: string, added: Promise<object|null>}>} `added`: the new device once it
   *   joined, or null when the code expired
   */
  addDevice ({ password } = {}) {
    return this.hg.addDevice({ password })
  }

  /**
   * This person's devices.
   * @returns {Promise<Array<{publicKey: string, name: string, current: boolean, online: boolean}>>}
   *   `online`: connected to this device now (or this device itself)
   */
  async devices () {
    const online = new Set(this.hg.personal.peers().map((p) => p.device))
    return (await this.hg.devices()).map((d) => ({ ...d, online: d.current || online.has(d.publicKey) }))
  }

  /**
   * Listens to an event:
   * - `'spaces'`: a space appeared or left, also on another device of the person;
   * - `'sync'`: one per thing {@link SwarmFS#sync} does (see docs/sync.md for the event's shape);
   * - `'members'`: `{ space, joined, left }`, people let in or gone (`[{ identity, name }]`);
   * - any other: hypergraph's event of that name.
   * @param {string} event
   * @param {Function} fn
   * @returns {SwarmFS} this
   */
  on (event, fn) {
    if (event === 'sync') this._listeners.add(fn)
    else if (event === 'members') this._memberListeners.add(fn)
    else this.hg.on(event, fn)
    return this
  }

  /**
   * Stops listening (see {@link SwarmFS#on}).
   * @param {string} event
   * @param {Function} fn
   * @returns {SwarmFS} this
   */
  off (event, fn) {
    if (event === 'sync') this._listeners.delete(fn)
    else if (event === 'members') this._memberListeners.delete(fn)
    else this.hg.off(event, fn)
    return this
  }

  _emitSync (e) {
    for (const fn of this._listeners) fn(e)
  }

  // While a download of `root` for space `key` runs, members of that space may get its verified
  // parts from here (transfer.js `allowed`).
  _download (root, size, file, key) {
    const download = this.transfer.download({ root, size }, file, { announce: false })
    const keys = this._fetching.get(root) || new Set()
    this._fetching.set(root, keys.add(key))
    // shortcut: two downloads of one root for one space share an entry; the first to end refuses the other's peers until it ends too
    const done = () => { keys.delete(key); if (!keys.size) this._fetching.delete(root) }
    download.then(done, done)
    return download
  }

  /**
   * Makes a files space (private: only its members read it).
   * @param {string} name
   * @param {object} [opts]
   * @param {'everyone'|'chosen'|'admins'} [opts.invites='admins'] - who may invite people
   * @returns {Promise<Drive>}
   */
  async createSpace (name, { invites = 'admins' } = {}) {
    const space = await this.hg.createSpace({ name, private: true })
    await setInvites(space, invites)
    await publishName(this.hg, space)
    return this.space(space.key)
  }

  /**
   * Joins a space with an invite code. Hypergraph's `INVITE_*` errors pass through.
   * @param {string} code
   * @param {object} [opts]
   * @param {number} [opts.timeout] - ms to wait for the space (hypergraph's default)
   * @returns {Promise<Drive>}
   */
  async join (code, { timeout } = {}) {
    const space = await this.hg.redeemInvite(code, { timeout })
    await publishName(this.hg, space).catch(() => {}) // again on 'spaces' if it can't write yet
    return this.space(space.key)
  }

  /**
   * Leaves a space on this device: its linked folders are unlinked (files stay), then the space is dropped.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async leave (key) {
    for (const l of await this._links()) if (l.space === key) await this.unlink(l.path)
    this._drives.delete(key)
    // its keeping pass and members watch were on the old handles: made anew if it is joined again
    this._keepers.delete(key)
    this._kept.delete(key)
    for (const s of this.hg.spaces()) if (s.key === key || s.parent === key) this._known?.delete(s.key)
    await this.hg.leaveSpace(key)
  }

  /**
   * Sets the person's name, the same on every device, shown to the people of their files spaces.
   * @param {string} name - 1 to 64 characters, no control characters; else `INVALID_NAME`
   * @returns {Promise<void>}
   */
  async setName (name) {
    if (!validPersonName(name)) throw new SwarmFSError('INVALID_NAME', `not a valid name: ${JSON.stringify(name)}`)
    await this.hg.setSetting('name', name)
    for (const { key } of this.hg.spaces()) await publishName(this.hg, this.hg.space(key)).catch(() => {})
  }

  /**
   * The person's name.
   * @returns {Promise<string|null>}
   */
  async name () {
    return (await this.hg.settings()).name || null
  }

  // Per files space: the name published once writable, 'members' events, shown holdings kept.
  _people () {
    this._known = new Map() // space key -> Set of identities
    const watchSpace = (space) => {
      if (this._known.has(space.key)) return
      this._known.set(space.key, null)
      const diff = async () => {
        const now = new Set((await space.members()).filter((m) => m.role).map((m) => m.identity))
        const before = this._known.get(space.key)
        this._known.set(space.key, now)
        if (!before) return
        const joined = [...now].filter((i) => !before.has(i))
        const left = [...before].filter((i) => !now.has(i))
        if (!joined.length && !left.length) return
        // A newcomer publishes their name once let in, so it arrives a moment after they do.
        // shortcut: polls up to 10 s; listen for the name record arriving if this ever matters.
        let names = await namesOf(space)
        for (let i = 0; i < 20 && joined.some((id) => !names.has(id)); i++) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          names = await namesOf(space)
        }
        const named = (ids) => ids.map((identity) => ({ identity, name: names.get(identity) || null }))
        for (const fn of this._memberListeners) fn({ space: space.key, joined: named(joined), left: named(left) })
      }
      space.on('members', () => diff().catch(() => {}))
      diff().catch(() => {})
    }
    const each = () => {
      for (const { key } of this.hg.spaces()) {
        const space = spaceOf(this.hg, key)
        if (!space) continue
        watchSpace(space)
        publishName(this.hg, space).catch(() => {})
      }
    }
    this._memberListeners = new Set()
    this.hg.on('spaces', each)
    this.hg.on('settings', () => { for (const { key } of this.hg.spaces()) { const s = spaceOf(this.hg, key); if (s) syncHas(this.hg, s).catch(() => {}) } })
    each()
  }

  /**
   * The spaces held here (files spaces, sites and their sub-spaces).
   * @returns {Array<{key: string, name: string}>}
   */
  spaces () {
    return this.hg.spaces().map(({ key, name }) => ({ key, name }))
  }

  // --- sites ---

  /**
   * Makes a site: a space anyone let in can read (not private unless asked), its pages in a
   * sub-space only the owner and admins write.
   * @param {string} name
   * @param {object} [opts]
   * @param {'everyone'|'chosen'|'admins'} [opts.invites='admins'] - who may invite people
   * @param {object} [opts.types={}] - the site's own record types, as hypergraph takes them
   *   (`{ post: { fields: { title: 'string' } } }`); `INVALID_TYPE` for one of SwarmFS's names
   * @param {string|null} [opts.app=null] - the key of the site whose code this one runs (an app's
   *   instance); its own pages stay empty
   * @param {boolean} [opts.private=false] - read by its members only; it can never be made public
   * @returns {Promise<Site>}
   */
  async createSite (name, { invites = 'admins', types: own = {}, app = null, private: priv = false } = {}) {
    if (app !== null && (typeof app !== 'string' || !app)) throw new SwarmFSError('INVALID_PARAMS', 'app is a site key')
    if (typeof priv !== 'boolean') throw new SwarmFSError('INVALID_PARAMS', 'private is true or false')
    const space = await this.hg.createSpace({ name, private: priv, types: { ...types, ...siteTypes(own) } })
    await setInvites(space, invites)
    const pages = await space.createSubspace({ name: 'pages', writeRoles: ['admin'] })
    await space.put('site', app ? { pages: pages.key, app } : { pages: pages.key })
    if (this._syncing) await this._keep(space.key, { again: true }) // 'spaces' may have checked it before its site record
    return this.site(space.key)
  }

  /**
   * Enters a site with an invite or its public link. A visit writes nothing into the site.
   * @param {string} link
   * @param {object} [opts]
   * @param {number} [opts.timeout=30000] - ms to wait for the space and its site record
   * @returns {Promise<Site>}
   */
  async visit (link, { timeout = 30000 } = {}) {
    const space = await this.hg.redeemInvite(link, { timeout })
    return this.site(space.key, { timeout })
  }

  /**
   * A site held here. `NOT_FOUND` if the space isn't a site, or its pages never arrive.
   * @param {string} key
   * @param {object} [opts]
   * @param {number} [opts.timeout=10000] - ms to wait for its site record and pages sub-space when not here yet
   * @returns {Promise<Site>}
   */
  async site (key, { timeout = 10000 } = {}) {
    const known = this._drives.get(key)
    if (known instanceof Site) return known
    const { space } = this.space(key)
    const { site } = await siteOf(space, { timeout })
    if (!site) throw new SwarmFSError('NOT_FOUND', `not a site: ${key}`)
    // shortcut: polls for the pages sub-space to be held here; wait on 'spaces' if this is ever slow
    let pages = null
    for (const until = Date.now() + timeout; !(pages = spaceOf(this.hg, site.pages)) && Date.now() < until;) await sleep(50)
    if (!pages) throw new SwarmFSError('NOT_FOUND', `the pages of ${key} never arrived`)
    const s = new Site(this, space, pages, site.app || null)
    this._drives.set(key, s)
    return s
  }

  // --- packs: sites shipped inside an app, as their own signed data ---

  /**
   * Writes what a visitor downloads of public sites into the folder `out`: their spaces and pages
   * sub-spaces (hypergraph's `exportSpaces`, in `out/spaces`) and the bytes of their files too big for a
   * record (`out/files/<root>`). No key, identity, personal space or setting. A build opens the owner's
   * folder with `{ offline: true }` first.
   * `NOT_FOUND` for a space that isn't a site here or a file not held here (a pack is whole);
   * hypergraph's `NOT_ALLOWED` for a site that isn't public.
   * @param {string[]} keys - site keys
   * @param {string} out - a folder; made if missing
   * @returns {Promise<void>}
   */
  exportSites (keys, out) {
    return exportSites(this.hg, keys, out)
  }

  /**
   * Joins the sites of a pack ({@link SwarmFS#exportSites}) with nobody online, as visits. The spaces are
   * checked as replicated data (hypergraph's `importSpaces`), and a file is kept only if a record of the
   * sites names its hash, so a pack can't add what the sites' writers didn't sign. `IMPORT_INVALID` (a
   * changed file, missing blocks, a site not public): nothing kept.
   * @param {string} from - the pack's folder
   * @param {object} [opts]
   * @param {number} [opts.timeout] - passed to hypergraph's import
   * @returns {Promise<string[]>} the sites' keys
   */
  async importSites (from, { timeout } = {}) {
    const dir = path.join(from, 'files')
    let names = []
    try { names = await fs.promises.readdir(dir) } catch (err) { if (err.code !== 'ENOENT') throw err }
    for (const name of names) { // before anything is kept: a changed file refuses the whole pack
      if ((await hash(path.join(dir, name))).root !== name) throw new SwarmFSError('IMPORT_INVALID', `the pack's file ${name} was changed`)
    }
    const keys = await this.hg.importSpaces(path.join(from, 'spaces'), { timeout })
    const named = new Map() // root -> [[space key, record id]]
    for (const key of keys) {
      const space = this.hg.space(key)
      for (const type of ['file', 'upload']) {
        for (const r of (await all(space.query(type))).items) {
          if (inlineOf(r) || !r.content) continue
          const root = rootOf(r.content)
          if (!named.has(root)) named.set(root, [])
          named.get(root).push([key, r.id])
        }
      }
    }
    for (const name of names) {
      const uses = named.get(name)
      if (!uses || await localPath(this.hg, name)) continue // named by no record here, or held already
      const file = path.join(this.appStorage, name)
      await fs.promises.mkdir(this.appStorage, { recursive: true })
      await fs.promises.copyFile(path.join(dir, name), file)
      const { size } = await stat(file)
      const spaces = new Map(uses)
      for (const [space, entry] of spaces) await recordHeld(this.hg, { root: name, path: file, size, space, entry })
    }
    const sites = []
    for (const key of keys) if (!this.hg.space(key).parent && (await siteOf(this.hg.space(key))).site) sites.push(key)
    return sites
  }

  // A site file's bytes (`record` in `drive`), verified: inside the record, held here, or
  // fetched into app storage, which is then kept under its cap.
  async _bytes (drive, record) {
    const inline = inlineOf(record)
    if (inline) return inline
    const root = rootOf(record.content)
    let file = await localPath(this.hg, root)
    if (!file) {
      file = path.join(this.appStorage, root)
      let fetching = this._holding.get(file)
      if (!fetching) {
        fetching = (async () => {
          await fs.promises.mkdir(this.appStorage, { recursive: true })
          await fs.promises.rm(file, { force: true }) // ours: a copy left without its held record
          await drive.fetch(record.id, file)
        })().finally(() => this._holding.delete(file))
        this._holding.set(file, fetching)
      }
      await fetching
      this._used.set(file, Date.now())
      await this._evict()
    } else if (path.dirname(file) === this.appStorage) {
      this._used.set(file, Date.now())
    }
    return fs.promises.readFile(file)
  }

  // App storage back under its cap: least recently read first (unread since open: oldest held
  // first); kept files aren't in it.
  // shortcut: reads every held record of this device per fetch; keep a list in memory if that shows in perf.
  async _evict () {
    const cached = (await all(mine(this.hg, 'held'))).items.filter((h) => path.dirname(h.path) === this.appStorage).reverse()
    let total = cached.reduce((n, h) => n + h.size, 0)
    cached.sort((a, b) => (this._used.get(a.path) || 0) - (this._used.get(b.path) || 0))
    for (const h of cached) {
      if (total <= this.appStorageMax) return
      if (this._holding.has(h.path)) continue
      try {
        await fs.promises.rm(h.path, { force: true })
      } catch {
        continue // being served (Windows): next time
      }
      await this.hg.personal.del(h.id)
      this._used.delete(h.path)
      total -= h.size
    }
  }

  // A top space that is a site this person owns or installed: what it keeps of it followed while
  // syncing. `again`: checked anew (its site record or kept choice is new). `opts`: the pass's
  // reads (a timeout: wait for records known but not here yet).
  async _keep (key, { again = false, ...opts } = {}) {
    const pass = this._keepers.get(key)
    if (pass) return pass(opts)
    if (this._kept.has(key) && !again) return
    this._kept.add(key)
    const space = spaceOf(this.hg, key)
    if (!space || space.parent || !(await siteOf(space)).site) return
    const site = await this.site(key)
    if ((await space.getRole(this.hg.identity.publicKey)) !== 'owner' && !(await site.kept())) return
    if (this._keepers.has(key)) return this._keepers.get(key)(opts) // set up meanwhile
    let running = Promise.resolve()
    const next = (o) => (running = running.then(() => site._keep(o)).catch(() => {}))
    for (const s of [space, site.pages.space]) {
      s.on('change', ({ records }) => { if (records.some((r) => r.type === 'upload' || r.type === 'file')) next() })
      s.on('peers', () => next())
    }
    this._keepers.set(key, next)
    return next(opts)
  }

  /**
   * The drive of a space held here (a site's too, as a plain Drive). `NOT_FOUND` if not held here.
   * @param {string} key
   * @returns {Drive}
   */
  space (key) {
    let drive = this._drives.get(key)
    if (!drive) {
      let space
      try {
        space = this.hg.space(key)
      } catch (err) {
        throw err.code === 'NOT_FOUND' ? new SwarmFSError('NOT_FOUND', `no space ${key}`) : err
      }
      drive = new Drive(this, space)
      this._drives.set(key, drive)
    }
    return drive
  }

  // --- linked folders ---

  /**
   * This device's linked folders.
   * @returns {Promise<Array<{path: string, space: string, folder: string, paused: string|null}>>}
   *   `folder`: the space folder's id (the space key for its top); `paused` (while syncing):
   *   null, `'missing'`, `'mass-delete'`, `'removed'` or `'in-bin'`
   */
  async links () {
    return (await this._links()).map(({ path, space, folder }) => ({ path, space, folder, paused: this._live.get(path)?.paused ?? null }))
  }

  async _links () {
    return (await all(mine(this.hg, 'added'))).items
  }

  // EXISTS if `full` is a linked folder, inside one, or holds one (one local file, one entry).
  async _overlaps (full) {
    for (const l of await this._links()) {
      if (full === l.path || full.startsWith(l.path + path.sep) || l.path.startsWith(full + path.sep)) {
        throw new SwarmFSError('EXISTS', `${full} overlaps the linked folder ${l.path}`)
      }
    }
  }

  // A folder just added or linked: followed now if syncing.
  async _linked (rec) {
    if (this._syncing) await this._start(rec)
  }

  /**
   * Stops syncing a linked folder. No file and no entry is removed. `NOT_FOUND` if not linked here.
   * @param {string} localPath
   * @returns {Promise<void>}
   */
  async unlink (localPath) {
    const full = path.resolve(localPath)
    const rec = (await this._links()).find((l) => l.path === full)
    if (!rec) throw new SwarmFSError('NOT_FOUND', `${full} is not linked here`)
    const live = this._live.get(full)
    this._live.delete(full)
    if (live) await live.unlinked()
    await this.hg.personal.del(rec.id)
    for (const h of (await all(mine(this.hg, 'held'))).items) {
      if (h.root === '' && h.path.startsWith(full + path.sep)) await this.hg.personal.del(h.id)
    }
  }

  /**
   * Applies the removals a linked folder was paused for (a mass delete), and resumes it.
   * `NOT_FOUND` if it isn't paused for a mass delete (or not syncing).
   * @param {string} localPath
   * @returns {Promise<void>}
   */
  async confirm (localPath) {
    const link = this._live.get(path.resolve(localPath))
    if (!link || link.paused !== 'mass-delete') throw new SwarmFSError('NOT_FOUND', `${localPath} is not paused for a mass delete`)
    await link.run(() => link.pass([''], { confirmed: true }))
    link.pump()
  }

  // --- sync ---

  /**
   * Keeps every linked folder in step with its space folder, both ways, until {@link SwarmFS#close}:
   * watches the folders and files added on their own, fetches what is missing, applies changes made
   * elsewhere, and keeps the sites this person owns or installed. Calling it again returns the same promise.
   * @returns {Promise<void>} resolves once the first pass of each linked folder is done
   */
  sync () {
    if (!this._syncing) {
      this._syncing = (async () => {
        for (const rec of await this._links()) if (!this._closed) await this._start(rec)
        if (this._closed) return
        await this._watchSingles()
        if (this._closed) return this._unwatchSingles() // close() came first: nothing may be left running
        const keep = () => { for (const { key } of this.hg.spaces()) this._keep(key).catch(() => {}) }
        this.hg.on('spaces', keep)
        keep()
        this._timer = setInterval(() => { for (const l of this._live.values()) l.tick() }, TICK)
      })()
    }
    return this._syncing
  }

  async _start (rec) {
    if (this._live.has(rec.path) || !spaceOf(this.hg, rec.space)) return
    const link = new Link(this, rec)
    this._live.set(rec.path, link)
    this._listen(link.space)
    await link.start()
  }

  // A space's changes → its linked folders' remote pass; a peer came → due fetches retried.
  _listen (space) {
    this._listened ??= new Set()
    if (this._listened.has(space.key)) return
    this._listened.add(space.key)
    const linksOf = () => [...this._live.values()].filter((l) => l.space === space)
    let timer = null
    const changed = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        for (const link of linksOf()) {
          link.run(async () => { if ((await link.reachable()) && !link.paused) await link.remote() }).then(() => link.pump())
        }
      }, DEBOUNCE)
    }
    space.on('change', ({ records }) => { if (linksOf().filter((l) => l.changed(records)).length) changed() })
    space.on('peers', () => { for (const link of linksOf()) link.pump() })
    // removed or let back in: access changes show in status
    let access = space.status().access
    space.on('status', (st) => {
      if (st.access === access) return
      access = st.access
      for (const link of linksOf()) link.run(() => link.pass([''])).then(() => link.pump())
    })
  }

  // Files added on their own: edits followed, one watcher per folder holding some.
  _unwatchSingles () {
    for (const w of this._singles || []) w.close()
    this._singles = []
  }

  async _watchSingles () {
    this._unwatchSingles()
    const linked = [...(await this._links()).map((l) => l.path), this.appStorage]
    const inside = (p) => linked.some((l) => p.startsWith(l + path.sep))
    const files = (await all(mine(this.hg, 'held'))).items.filter((h) => h.root !== '' && !inside(h.path)).map((h) => h.path)
    const dirs = new Map()
    for (const f of files) {
      if (!dirs.has(path.dirname(f))) dirs.set(path.dirname(f), new Set())
      dirs.get(path.dirname(f)).add(path.basename(f))
    }
    this._singles = []
    for (const [dir, names] of dirs) {
      if (!(await stat(dir))) continue
      this._singles.push(watch(dir, {
        recursive: false,
        filter: (rel) => names.has(rel),
        onBatch: async () => {
          for (const p of await rescanSingles(this.hg, [...(await this._links()).map((l) => l.path), this.appStorage])) this._emitSync({ action: 'updated', path: p })
        },
        onError: () => {}
      }))
    }
  }

  /**
   * Follows the disk once (also done at open): linked folders get a local pass (edits, new files,
   * renames, moves, deletions); files added on their own get their edits recorded, and stop being
   * held when deleted (their entries stay).
   * @returns {Promise<void>}
   */
  async rescan () {
    const recs = await this._links()
    for (const rec of recs) {
      const live = this._live.get(rec.path)
      if (live) {
        await live.run(() => live.pass(['']))
        continue
      }
      if (!spaceOf(this.hg, rec.space)) continue
      const link = new Link(this, rec)
      if (await link.reachable()) await link.local([''])
    }
    await rescanSingles(this.hg, [...recs.map((r) => r.path), this.appStorage]) // app storage: not the person's files
    if (this._syncing) await this._watchSingles()
  }

  // --- trash ---

  /**
   * What syncing replaced or removed, in every linked folder's trash (paused folders left out).
   * @returns {Promise<Array<{folder: string, path: string, size: number, trashed: number}>>}
   *   `folder`: the linked folder; `path`: where the file was, relative to it; `trashed`: ms
   */
  async trash () {
    const items = []
    for (const { path: folder } of await this._links()) {
      if (!(await stat(folder))) continue // paused: not there
      for (const i of await listTrash(folder)) items.push({ folder, ...i })
    }
    return items
  }

  /**
   * Deletes every linked folder's trash. The only call that deletes a person's bytes.
   * @returns {Promise<{files: number, bytes: number}>}
   */
  async emptyTrash () {
    let files = 0
    let bytes = 0
    for (const { path: folder } of await this._links()) {
      if (!(await stat(folder))) continue
      const r = await emptyTrash(folder)
      files += r.files
      bytes += r.bytes
    }
    return { files, bytes }
  }

  /**
   * Stops syncing and fetching (partial downloads stay, resumable) and closes the instance.
   * @returns {Promise<void>}
   */
  async close () {
    this._closed = true
    clearInterval(this._timer)
    this._unwatchSingles()
    for (const link of this._live.values()) link.stop()
    this._live.clear()
    await this.transfer.destroy()
    await this.hg.close()
  }
}

async function exportSites (hg, keys, out) {
  const spaces = []
  const files = new Map() // root -> where it is held here
  for (const key of keys) {
    const space = spaceOf(hg, key)
    if (!space) throw new SwarmFSError('NOT_FOUND', `no site ${key} here`)
    await space.ready()
    const { site } = await siteOf(space)
    const pages = site && spaceOf(hg, site.pages)
    if (!pages) throw new SwarmFSError('NOT_FOUND', `not a site held here: ${key}`)
    await pages.ready()
    spaces.push(key, site.pages)
    for (const [s, type] of [[space, 'upload'], [pages, 'file']]) {
      for (const r of (await all(s.query(type))).items) {
        if ((type === 'file' && r.parent === BIN) || inlineOf(r)) continue
        const root = rootOf(r.content)
        const at = await localPath(hg, root)
        if (!at) throw new SwarmFSError('NOT_FOUND', `${r.name} of ${key} isn't held here: a pack holds every file`)
        files.set(root, at)
      }
    }
  }
  await hg.exportSpaces(spaces, path.join(out, 'spaces'))
  await fs.promises.mkdir(path.join(out, 'files'), { recursive: true })
  for (const [root, at] of files) await fs.promises.copyFile(at, path.join(out, 'files', root))
}
