// SwarmFS: one Hypergraph instance; its spaces are files spaces (Drives); linked folders
// kept in step by sync() (spec 002).

import fs from 'fs'
import path from 'path'
import hypergraph from 'hypergraph/next'
import { types, rules, rootOf, inlineOf, siteTypes } from './types.js'
import { Drive } from './drive.js'
import { Site } from './site.js'
import { SwarmFSError } from './errors.js'
import { all, mine, stat, rescanSingles, spaceOf, localPath } from './holdings.js'
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

export class SwarmFS {
  // dir: the instance folder; app storage is in it (spec 004). appStorageMax: its cap, bytes.
  constructor (hg, { dir, fetchTimeout = 30000, minFree, appStorageMax = 1024 ** 3 } = {}) {
    this.hg = hg
    this.appStorage = path.join(path.resolve(dir), 'app-storage')
    this.appStorageMax = appStorageMax
    this._used = new Map() // app storage path -> last read, while open (research R6)
    this._holding = new Map() // app storage path -> its fetch in progress
    this._kept = new Set() // top spaces checked for "a site I own or installed" (kept while syncing)
    this._keepers = new Map() // site key -> its keeping pass, while syncing
    this.fetchTimeout = fetchTimeout
    this.minFree = minFree // bytes; default max(5 GB, 5 % of the disk), research R10
    this._fetching = new Map() // root -> Set of space keys it is downloading for
    this.transfer = transfer(hg, this._fetching) // the Swarmwire
    this._drives = new Map()
    this._listeners = new Set()
    this._live = new Map() // linked path -> Link, while syncing
    this._syncing = null
  }

  static async open (dir, { password, joinCode, joinTimeout, deviceName, bootstrap, fetchTimeout, minFree, appStorageMax } = {}) {
    const hg = await Hypergraph.open(dir, { types, rules, password, joinCode, joinTimeout, deviceName, bootstrap })
    const sfs = new SwarmFS(hg, { dir, fetchTimeout, minFree, appStorageMax })
    sfs._people()
    await sfs.rescan() // before connecting: writes don't wait for peers
    await hg.connectToSwarm()
    return sfs
  }

  get device () {
    return this.hg.device.publicKey
  }

  addDevice ({ password } = {}) {
    return this.hg.addDevice({ password })
  }

  // Online: connected to this device in the personal space (only the person's devices meet there).
  async devices () {
    const online = new Set(this.hg.personal.peers().map((p) => p.device))
    return (await this.hg.devices()).map((d) => ({ ...d, online: d.current || online.has(d.publicKey) }))
  }

  // 'spaces': a space appeared or left, also on another device of the person.
  // 'sync': one per thing sync() does (contracts/api.md).
  // 'members': { space, joined, left } people let in or gone (spec 003).
  on (event, fn) {
    if (event === 'sync') this._listeners.add(fn)
    else if (event === 'members') this._memberListeners.add(fn)
    else this.hg.on(event, fn)
    return this
  }

  off (event, fn) {
    if (event === 'sync') this._listeners.delete(fn)
    else if (event === 'members') this._memberListeners.delete(fn)
    else this.hg.off(event, fn)
    return this
  }

  _emitSync (e) {
    for (const fn of this._listeners) fn(e)
  }

  // A swarmwire download of `root` for space `key`: while it runs, members of that space may get
  // its verified parts (transfer.js `allowed`).
  _download (root, size, file, key) {
    const download = this.transfer.download({ root, size }, file, { announce: false })
    const keys = this._fetching.get(root) || new Set()
    this._fetching.set(root, keys.add(key))
    // shortcut: two downloads of one root for one space share an entry; the first to end refuses the other's peers until it ends too
    const done = () => { keys.delete(key); if (!keys.size) this._fetching.delete(root) }
    download.then(done, done)
    return download
  }

  // invites: who may invite people (spec 003 story 5): 'everyone' | 'chosen' | 'admins'.
  async createSpace (name, { invites = 'admins' } = {}) {
    const space = await this.hg.createSpace({ name, private: true })
    await setInvites(space, invites)
    await publishName(this.hg, space)
    return this.space(space.key)
  }

  // Joins a space with an invite code; its Drive. Hypergraph's INVITE_* errors as they are.
  async join (code, { timeout } = {}) {
    const space = await this.hg.redeemInvite(code, { timeout })
    await publishName(this.hg, space).catch(() => {}) // again on 'spaces' if it can't write yet
    return this.space(space.key)
  }

  // Leaves a space on this device: its linked folders stop (files stay), then hypergraph drops it.
  async leave (key) {
    for (const l of await this._links()) if (l.space === key) await this.unlink(l.path)
    this._drives.delete(key)
    // its keeping pass and members watch were on the old handles: made anew if it is joined again
    this._keepers.delete(key)
    this._kept.delete(key)
    for (const s of this.hg.spaces()) if (s.key === key || s.parent === key) this._known?.delete(s.key)
    await this.hg.leaveSpace(key)
  }

  // The person's name, the same on every device, shown to the people of their spaces.
  async setName (name) {
    if (!validPersonName(name)) throw new SwarmFSError('INVALID_NAME', `not a valid name: ${JSON.stringify(name)}`)
    await this.hg.setSetting('name', name)
    for (const { key } of this.hg.spaces()) await publishName(this.hg, this.hg.space(key)).catch(() => {})
  }

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

  spaces () {
    return this.hg.spaces().map(({ key, name }) => ({ key, name }))
  }

  // --- sites (spec 004) ---

  // A closed space (sites are read: research R1), its pages in a sub-space only owner and admins write.
  // `types`: a dynamic site's own record types (spec 005), after SwarmFS's. `app`: the key of the site whose
  // code this one runs (an app's instance, spec 007); its own pages stay empty. `private`: read by its
  // members only (an app's private instance: a chat, spec 008); it can never be made public.
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

  // Into a site with an invite or its public link; writes nothing there (FR-009).
  async visit (link, { timeout = 30000 } = {}) {
    const space = await this.hg.redeemInvite(link, { timeout })
    return this.site(space.key, { timeout })
  }

  // A site held here; NOT_FOUND if the space isn't one (once its records say so, up to `timeout`).
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

  // A site file's bytes (`record` in `drive`), verified: inside the record, held here, or
  // fetched into app storage, which is then kept under its cap (spec 004 story 3).
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
  // first); kept uploads aren't in it.
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

  // A top space that is a site this person owns or installed (spec 006): what it keeps of it
  // followed while syncing (FR-013). `again`: checked anew (its site record or kept choice is new).
  // `opts`: the pass's reads (a timeout: wait for records known but not here yet).
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

  // This device's linked folders: [{ path, space, folder, paused }].
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

  // A folder paused for a mass delete: the removals applied, and it resumes (research R13).
  async confirm (localPath) {
    const link = this._live.get(path.resolve(localPath))
    if (!link || link.paused !== 'mass-delete') throw new SwarmFSError('NOT_FOUND', `${localPath} is not paused for a mass delete`)
    await link.run(() => link.pass([''], { confirmed: true }))
    link.pump()
  }

  // --- sync ---

  // Keeps every linked folder in step with its space folder until close(); resolves once the
  // first pass of each is done (spec 002).
  sync () {
    if (!this._syncing) {
      this._syncing = (async () => {
        for (const rec of await this._links()) if (!this._closed) await this._start(rec)
        if (this._closed) return
        await this._watchSingles()
        if (this._closed) return this._unwatchSingles() // close() came first (F3): nothing left running
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
    // removed or let back in (spec 003): access changes show in status
    let access = space.status().access
    space.on('status', (st) => {
      if (st.access === access) return
      access = st.access
      for (const link of linksOf()) link.run(() => link.pass([''])).then(() => link.pump())
    })
  }

  // Files added on their own: edits followed (FR-008), one watcher per folder holding some.
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

  // Follow the disk once (also at open): linked folders with the local pass of spec 002,
  // files added on their own with v1's rules (data-model.md).
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

  // Every linked folder's trash: [{ folder, path, size, trashed }].
  async trash () {
    const items = []
    for (const { path: folder } of await this._links()) {
      if (!(await stat(folder))) continue // paused: not there
      for (const i of await listTrash(folder)) items.push({ folder, ...i })
    }
    return items
  }

  // The only call that deletes bytes (constitution I): on the person's command.
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

  async close () {
    this._closed = true
    clearInterval(this._timer)
    this._unwatchSingles()
    for (const link of this._live.values()) link.stop()
    this._live.clear()
    await this.transfer.destroy() // stops fetches in progress, resume state kept
    await this.hg.close()
  }
}
