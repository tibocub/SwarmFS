// A linked folder kept in step with its space folder, both ways (data-model.md, state
// transitions). Every pass of one linked folder runs in turn (`run`); downloads run beside.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { contentRef, rootOf, bases, nextBase, BIN } from './types.js'
import { namesOf, syncHas, isShared, writers } from './members.js'
import { hash, stat, all, mine, localPath } from './holdings.js'
import { compile, ignored } from './ignore.js'
import { TRASH, INCOMING, toTrash, incoming, freeSpace, floor } from './trash.js'
import { watch } from './watch.js'

const MASS = 100 // a local change removing more than this and more than half: confirm first (R13)
const PARALLEL = 8 // downloads at once per linked folder
const RETRY = 60000 // a fetch that failed (not "no holder": an error) is tried again after this
const RETRY_OTHERS = 30000 // other people's devices that didn't give a file: asked again after this, or when another connects
const WINDOWS = os.platform() === 'win32'

export class Link {
  constructor (sfs, rec) {
    this.sfs = sfs
    this.hg = sfs.hg
    this.rec = rec // the `added` record: { id, path, space, folder }
    this.path = rec.path
    this.space = sfs.hg.space(rec.space)
    this.paused = null // null | 'missing' | 'mass-delete' | 'removed' | 'in-bin'
    this.inos = new Map() // abs path -> ino, from the stats a pass makes (research R7)
    this.due = new Map() // entry id -> { id, root, size, target }
    this.fetching = new Set()
    this.skipped = new Set()
    this.failed = new Map() // entry id -> when its fetch last failed (tried again after RETRY)
    this.tried = new Map() // root -> { devices, at }: other people's devices that didn't give it
    this.low = false
    this.watcher = null
    this.live = false
    this._chain = Promise.resolve()
    this.entries = null // id -> folder or file record: read whole at start and on resume, then kept by `change`
    this.dirty = new Map() // ids `change` named since the last read -> its `deleted`
  }

  get folder () { return this.rec.folder }

  // One pass at a time; a failing pass is reported, never stops the next.
  run (fn) {
    const next = this._chain.then(fn).catch((err) => this.emit({ action: 'error', reason: err.message }))
    this._chain = next
    return next
  }

  emit (e) {
    this.sfs._emitSync({ space: this.rec.space, ...e })
  }

  // --- live (sync) ---

  async start () {
    this.live = true
    await this.run(() => this.pass(['']))
    this.pump()
  }

  stop () {
    this.live = false
    if (this.watcher) this.watcher.close()
    this.watcher = null
    for (const d of this.fetching) d.stop()
  }

  // The full cycle: root check, local pass over `scopes`, then (live, all of it) the remote pass.
  async pass (scopes, { confirmed = false } = {}) {
    if (!(await this.reachable())) return
    const done = await this.local(scopes, { confirmed })
    if (!done) return // paused for a mass delete
    // the space's own changes start remote passes ('change'): a batch of local paths needs none
    if (this.live && scopes.includes('')) await this.remote()
    if (this.live && !this.watcher) this.watcher = this.watch()
    await syncHas(this.hg, this.space)
  }

  watch () {
    return watch(this.path, {
      filter: (rel) => !ignored(this.rules, rel, false),
      onBatch: (rels) => this.run(() => this.pass(rels)),
      onError: () => {
        if (this.watcher) this.watcher.close()
        this.watcher = null
        if (this.live) this.run(() => this.pass([''])) // root gone → paused; events lost → full rescan
      }
    })
  }

  // Every 10 s: a paused folder back? due files fetchable now (space freed, a holder online)?
  async tick () {
    if (this.paused) await this.run(() => this.pass(['']))
    else this.pump()
  }

  async reachable () {
    const st = await stat(this.path).catch(() => null)
    if (st && st.directory) {
      if (this.paused === 'missing') {
        this.paused = null
        this.entries = null
        this.emit({ action: 'resumed', path: this.path })
      }
      if (!this.rules) await this.readRules()
      return !(await this.blocked())
    }
    if (this.paused !== 'missing') {
      this.paused = 'missing'
      this.emit({ action: 'paused', reason: 'missing', path: this.path })
    }
    if (this.watcher) this.watcher.close()
    this.watcher = null
    return false
  }

  // Paused while this person is out of the space (removed, banned), or while its space folder
  // is in the bin (spec 003): nothing written, fetched or trashed; resumed when that ends.
  async blocked () {
    const why = this.space.status().access === 'none' ? 'removed' : (await this.binned()) ? 'in-bin' : null
    const was = this.paused === 'removed' || this.paused === 'in-bin' ? this.paused : null
    if (why === was) return !!why
    if (why) {
      this.paused = why
      if (this.watcher) this.watcher.close()
      this.watcher = null
      for (const d of this.fetching) d.stop()
      this.emit({ action: 'paused', reason: why, path: this.path })
    } else {
      this.paused = null
      this.entries = null
      this.emit({ action: 'resumed', path: this.path })
    }
    return !!why
  }

  // Is `id` (default: the linked folder) in the bin, or under a folder that is?
  async binned (id = this.folder) {
    for (; id !== this.space.key;) {
      const { record } = await this.space.get(id)
      if (!record) return false
      if (record.parent === BIN) return true
      id = record.parent
    }
    return false
  }

  async readRules () {
    this.rules = compile(await fs.promises.readFile(path.join(this.path, '.swarmfsignore'), 'utf8').catch(() => ''))
    if (this.ci === undefined) this.ci = await caseInsensitive(this.path)
  }

  // --- reading ---

  rel (abs) { return path.relative(this.path, abs) }
  abs (rel) { return path.join(this.path, rel) }

  // The space's entries under this linked folder, each at its local path (`rel`). Two entries
  // that would land on one path (same name, or names differing only by case on this disk): the
  // later one gets a conflict-copy name. Removals and new folders act only on a complete read
  // (spec 001's rescan, FR-023).
  async read () {
    if (!this.entries) {
      this.dirty.clear()
      const records = [...(await all(this.space.query('folder'))).items, ...(await all(this.space.query('file'))).items]
      this.entries = new Map(records.map((r) => [r.id, r]))
    }
    for (const [id, said] of this.dirty) { // only the records `change` named are read again (hypergraph H14)
      this.dirty.delete(id)
      const { record, deleted } = await this.space.get(id)
      if (record) this.entries.set(id, record)
      else if (deleted || said) this.entries.delete(id) // `said`: a ban's drop, which get() doesn't report (H21) // else not here: left as it was, never taken as deleted
    }
    const complete = this.space.status().complete
    const folders = { items: [] }
    const files = { items: [] }
    for (const r of this.entries.values()) (r.type === 'folder' ? folders : files).items.push(r)
    const children = new Map()
    for (const r of [...folders.items, ...files.items]) {
      if (!children.has(r.parent)) children.set(r.parent, [])
      children.get(r.parent).push(r)
    }
    const names = await this.deviceNames()
    // a name every member computes the same: the writer's person in a shared space, else the device
    const shared = await isShared(this.space)
    const people = shared ? await namesOf(this.space) : null
    const owner = shared ? await writers(this.space) : null
    const who = (r) => (shared ? people.get(owner.get(r.device)) : names.get(r.device)) || 'device'
    const ids = new Map(folders.items.map((r) => [r.id, r]))
    const exists = this.folder === this.space.key || ids.has(this.folder)
    const byId = new Map() // id -> { record, rel }
    const byRel = new Map() // key(rel) -> id
    const walk = (parent, relDir) => {
      const kids = (children.get(parent) || []).sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.stamp - b.stamp || (a.id < b.id ? -1 : 1)))
      for (const r of kids) {
        let rel = path.join(relDir, r.name)
        for (let n = 1; byRel.has(this.key(rel)); n++) rel = path.join(relDir, copyName(r.name, who(r), n))
        byRel.set(this.key(rel), r.id)
        byId.set(r.id, { record: r, rel })
        if (r.type === 'folder') walk(r.id, rel)
      }
    }
    if (exists) walk(this.folder, '')
    // files whose folder was removed elsewhere while they were added here (spec 001's edge case)
    const orphans = new Map(files.items.filter((r) => r.parent !== this.space.key && r.parent !== BIN && !ids.has(r.parent)).map((r) => [r.id, r]))
    return { byId, byRel, complete, exists, children, orphans }
  }

  // From the space's `change`: true if it named entries.
  changed (records) {
    for (const r of records) if (r.type === 'folder' || r.type === 'file') this.dirty.set(r.id, r.deleted)
    // a name arriving can change where a same-name entry is placed (read()'s copy names)
    return records.some((r) => r.type === 'folder' || r.type === 'file' || r.type === 'profile')
  }

  key (rel) { return this.ci ? rel.toLowerCase() : rel }

  async deviceNames () {
    if (!this._names) {
      const devices = await this.hg.devices()
      this._names = new Map(devices.map((d) => [d.publicKey, d.name]))
      this.me = devices.find((d) => d.current)?.name || 'device'
    }
    return this._names
  }

  // This device's `held` under the linked folder (files, and folders with root ''), not in its trash.
  async held () {
    const prefix = this.path + path.sep
    const trash = prefix + TRASH + path.sep
    return (await all(mine(this.hg, 'held'))).items.filter((h) => h.space === this.rec.space && h.path.startsWith(prefix) && !h.path.startsWith(trash))
  }

  // What is on disk under `scopes` (relative paths; '' = all): rel -> { dir, size, mtime, ino }.
  async scan (scopes) {
    const out = new Map()
    const visit = async (rel) => {
      if (rel && ignored(this.rules, rel, false)) return
      const st = await stat(this.abs(rel)).catch(() => null)
      if (!st || (rel && ignored(this.rules, rel, st.directory))) return
      if (st.directory) {
        if (rel) out.set(rel, { dir: true })
        const entries = await fs.promises.readdir(this.abs(rel)).catch(() => [])
        for (const name of entries) await visit(path.join(rel, name))
      } else if (st.file) {
        out.set(rel, { dir: false, size: st.size, mtime: st.mtime, ino: st.ino })
        if (st.ino) this.inos.set(this.abs(rel), st.ino)
      }
    }
    for (const s of scopes.includes('') ? [''] : scopes) await visit(s)
    return out
  }

  // --- local → space ---

  // Returns false when paused for a mass delete (nothing applied).
  async local (scopes, { confirmed = false } = {}) {
    if (scopes.some((s) => s === '.swarmfsignore' || s === '')) await this.readRules()
    const view = await this.read()
    if (!view.exists) { // its space folder was removed: files added here meanwhile kept, at the top (spec 001)
      if (view.complete) for (const h of await this.held()) if (view.orphans.has(h.entry)) await this.space.edit(h.entry, { parent: this.space.key })
      return true
    }
    const held = await this.held()
    view.heldEntries = new Set(held.map((h) => h.entry))
    const everything = scopes.includes('')
    const inScope = (rel) => everything || scopes.some((s) => rel === s || rel.startsWith(s + path.sep))
    const disk = await this.scan(scopes)
    const heldAt = new Map(held.map((h) => [this.rel(h.path), h]))

    const isDir = (h) => h.root === ''
    const gone = held.filter((h) => {
      const rel = this.rel(h.path)
      if (!inScope(rel)) return false
      const d = disk.get(rel)
      return !d || d.dir !== isDir(h)
    })
    const fresh = [...disk].filter(([rel, d]) => { const h = heldAt.get(rel); return !h || d.dir !== isDir(h) })
    const changed = held.filter((h) => {
      const d = disk.get(this.rel(h.path))
      return d && !isDir(h) && !d.dir && (d.size !== h.size || d.mtime !== h.mtime)
    })

    // folder moves: a new folder holding exactly a gone folder's files, by identity
    const folderMoves = []
    const goneDirs = gone.filter(isDir)
    for (const [rel, d] of fresh) {
      if (!d.dir || fresh.some(([r, x]) => x.dir && rel.startsWith(r + path.sep))) continue
      const inside = [...disk].filter(([r, x]) => !x.dir && r.startsWith(rel + path.sep))
      for (const g of goneDirs) {
        const under = gone.filter((h) => !isDir(h) && h.path.startsWith(g.path + path.sep))
        if (!under.length || under.length !== inside.length) continue
        let same = true
        for (const h of under) { // same file id; no exact id known: same content
          const at = path.join(rel, path.relative(g.path, h.path))
          const x = disk.get(at)
          same = !!x && !x.dir && x.size === h.size && x.mtime === h.mtime &&
            (this.inos.get(h.path) && x.ino ? x.ino === this.inos.get(h.path) : (await hash(this.abs(at))).root === h.root)
          if (!same) break
        }
        if (same) { folderMoves.push({ g, rel }); break }
      }
    }
    const movedFrom = (p) => folderMoves.find((m) => p === m.g.path || p.startsWith(m.g.path + path.sep))
    const movedTo = (rel) => folderMoves.find((m) => rel === m.rel || rel.startsWith(m.rel + path.sep))

    // file moves: same identity, else same content (hashed)
    const goneFiles = gone.filter((h) => !isDir(h) && !movedFrom(h.path))
    const fileMoves = []
    const added = []
    for (const [rel, d] of fresh) {
      if (d.dir || movedTo(rel)) continue
      const g = goneFiles.find((h) => !fileMoves.some((m) => m.h === h) && this.inos.get(h.path) && this.inos.get(h.path) === d.ino && h.size === d.size && h.mtime === d.mtime)
      if (g) fileMoves.push({ h: g, rel })
      else added.push({ rel, d })
    }
    for (const a of added) {
      Object.assign(a, await hash(this.abs(a.rel)))
      const g = goneFiles.find((h) => !fileMoves.some((m) => m.h === h) && h.root === a.root)
      if (g) { fileMoves.push({ h: g, rel: a.rel }); a.moved = true }
    }
    const removed = goneFiles.filter((h) => !fileMoves.some((m) => m.h === h))

    // the mass-delete guard (R13): more than half of the files and more than MASS
    const total = held.filter((h) => !isDir(h)).length
    if (removed.length > MASS && removed.length > total / 2 && !confirmed) {
      if (this.paused !== 'mass-delete') {
        this.paused = 'mass-delete'
        this.emit({ action: 'paused', reason: 'mass-delete', path: this.path, count: removed.length })
      }
      return false
    }
    if (this.paused === 'mass-delete') {
      this.paused = null
      this.emit({ action: 'resumed', path: this.path })
    }

    const folders = new Map(held.filter(isDir).map((h) => [this.rel(h.path), h.entry]))
    const ensure = (rel) => this.ensureFolder(rel, folders, view)

    for (const { g, rel } of folderMoves) {
      const parent = await ensure(path.dirname(rel) === '.' ? '' : path.dirname(rel))
      if (parent === null) continue
      await editIfThere(this.space, g.entry, { name: path.basename(rel), parent })
      const to = this.abs(rel)
      for (const h of held.filter((h) => h.path === g.path || h.path.startsWith(g.path + path.sep))) {
        const p = to + h.path.slice(g.path.length)
        await this.hg.personal.edit(h.id, { path: p })
        if (h.root === '') folders.set(this.rel(p), h.entry)
      }
      this.emit({ action: path.dirname(g.path) === path.dirname(to) ? 'renamed' : 'moved', path: g.path, to })
    }
    for (const [rel] of fresh.filter(([, d]) => d.dir).sort(([a], [b]) => a.length - b.length)) {
      if (!movedTo(rel)) await ensure(rel)
    }
    for (const { h, rel } of fileMoves) {
      const parent = await ensure(dirOf(rel))
      if (parent === null) continue
      const to = this.abs(rel)
      await editIfThere(this.space, h.entry, { name: path.basename(rel), parent })
      await this.hg.personal.edit(h.id, { path: to })
      this.inos.set(to, this.inos.get(h.path))
      this.emit({ action: dirOf(this.rel(h.path)) === dirOf(rel) ? 'renamed' : 'moved', path: h.path, to })
    }
    for (const a of added.filter((a) => !a.moved)) await this.addLocal(a, view, ensure)
    for (const h of changed) await this.editLocal(h, view, ensure)

    // removals: a folder with its subtree, files one by one
    const removedDirs = goneDirs.filter((g) => !movedFrom(g.path))
    const top = removedDirs.filter((g) => !removedDirs.some((o) => o !== g && g.path.startsWith(o.path + path.sep)))
    for (const g of top) await this.sfs.space(this.rec.space).remove(g.entry).catch(notFound)
    for (const h of removed) {
      if (!top.some((g) => h.path.startsWith(g.path + path.sep))) await this.sfs.space(this.rec.space).remove(h.entry).catch(notFound)
      this.emit({ action: 'removed', path: h.path })
    }
    for (const h of [...removed, ...removedDirs]) await this.hg.personal.del(h.id)
    return true
  }

  // The folder entry for a local folder (rel), adopted by name or made; null: not yet
  // (a read that isn't complete may not show an existing one: never a duplicate).
  async ensureFolder (rel, folders, view) {
    if (!rel) return this.folder
    if (folders.has(rel)) return folders.get(rel)
    const parent = await this.ensureFolder(dirOf(rel), folders, view)
    if (parent === null) return null
    const name = path.basename(rel)
    let id = (view.children.get(parent) || []).find((r) => r.type === 'folder' && r.name === name)?.id
    if (!id && !view.complete) return null
    if (!id) {
      const r = await this.space.put('folder', { name, parent })
      view.children.set(parent, [...(view.children.get(parent) || []), r])
      id = r.id
      this.emit({ action: 'added', path: this.abs(rel) })
    }
    await this.hg.personal.put('held', { root: '', path: this.abs(rel), size: 0, mtime: 0, space: this.rec.space, entry: id })
    folders.set(rel, id)
    return id
  }

  // A new local file: the entry already at that place adopts it if the content is the same
  // (linking a folder that has the files, FR-003); a different content becomes a conflict copy.
  async addLocal ({ rel, root, size, mtime }, view, ensure) {
    const parent = await ensure(dirOf(rel))
    if (parent === null) return
    const at = view.byId.get(view.byRel.get(this.key(rel)))
    const file = this.abs(rel)
    if (at && at.record.type === 'file' && !view.heldEntries.has(at.record.id)) {
      if (rootOf(at.record.content) === root) {
        await this.hg.personal.put('held', { root, path: file, size, mtime, space: this.rec.space, entry: at.record.id })
        return
      }
      return this.conflictCopy(file, { root, size }, parent, null, at.record)
    }
    const entry = await this.space.put('file', { name: path.basename(rel), parent, content: contentRef(root, size) })
    await this.hg.personal.put('held', { root, path: file, size, mtime, space: this.rec.space, entry: entry.id })
    this.emit({ action: 'added', path: file })
  }

  // A held file changed on disk (R4): the space still has the version it was edited from →
  // publish with `base`; it moved on meanwhile → this version becomes a conflict copy.
  async editLocal (h, view, ensure) {
    const { root, size, mtime } = await hash(h.path)
    if (root === h.root) return this.hg.personal.edit(h.id, { size, mtime })
    const e = view.byId.get(h.entry)
    if (!e) {
      if (!view.complete) return
      // removed elsewhere while edited here: added again (FR-019)
      const parent = await ensure(dirOf(this.rel(h.path)))
      if (parent === null) return
      const entry = await this.space.put('file', { name: path.basename(h.path), parent, content: contentRef(root, size) })
      await this.hg.personal.edit(h.id, { root, size, mtime, entry: entry.id })
      return this.emit({ action: 'added', path: h.path })
    }
    if (rootOf(e.record.content) === h.root) {
      await this.space.edit(h.entry, { content: contentRef(root, size), base: nextBase(e.record) })
      await this.hg.personal.edit(h.id, { root, size, mtime })
      return this.emit({ action: 'updated', path: h.path })
    }
    await this.hg.personal.del(h.id)
    await this.conflictCopy(h.path, { root, size }, e.record.parent, h, e.record)
  }

  // Renames local `file` to "name (<who>'s copy[ n]).ext" and adds it as a new entry. <who>: this
  // person's name when the version kept under the name is another person's, else this device's.
  async conflictCopy (file, { root, size }, parent, h, winner) {
    const dir = path.dirname(file)
    const name = path.basename(file)
    const taken = new Set((await fs.promises.readdir(dir)).map((n) => this.key(n)))
    await this.deviceNames()
    const own = winner && (await this.deviceNames()).has(winner.device)
    const person = winner && !own ? await this.sfs.name() : null
    let copy
    for (let n = 1; taken.has(this.key(copy = copyName(name, person || this.me, n))); n++);
    const to = path.join(dir, copy)
    await fs.promises.rename(file, to)
    const { mtime } = await stat(to)
    const entry = await this.space.put('file', { name: copy, parent, content: contentRef(root, size) })
    await this.hg.personal.put('held', { root, path: to, size, mtime, space: this.rec.space, entry: entry.id })
    this.emit({ action: 'conflict', path: file, to })
    return entry
  }

  // --- space → local ---

  async remote () {
    const view = await this.read()
    const held = await this.held()
    const byEntry = new Map(held.map((h) => [h.entry, h]))
    const heldPaths = new Set(held.map((h) => h.path))
    const entries = [...view.byId.values()]
    const depth = (rel) => rel.split(path.sep).length

    // folders: moved/renamed here too, or made
    for (const { record, rel } of entries.filter((e) => e.record.type === 'folder').sort((a, b) => depth(a.rel) - depth(b.rel))) {
      if (this.skip(rel, true)) continue
      const h = byEntry.get(record.id)
      const target = this.abs(rel)
      if (h && h.path !== target) {
        if (await stat(h.path)) {
          await this.clear(target)
          await fs.promises.mkdir(path.dirname(target), { recursive: true })
          await fs.promises.rename(h.path, target)
          this.emit({ action: dirOf(this.rel(h.path)) === dirOf(rel) ? 'renamed' : 'moved', path: h.path, to: target })
        }
        for (const x of held.filter((x) => x.path === h.path || x.path.startsWith(h.path + path.sep))) {
          const p = target + x.path.slice(h.path.length)
          await this.hg.personal.edit(x.id, { path: p })
          x.path = p
        }
      } else if (!h) {
        await fs.promises.mkdir(target, { recursive: true })
        await this.hg.personal.put('held', { root: '', path: target, size: 0, mtime: 0, space: this.rec.space, entry: record.id })
      }
    }

    // files
    this.due.clear()
    for (const { record, rel } of entries.filter((e) => e.record.type === 'file')) {
      if (this.skip(rel, false)) continue
      const target = this.abs(rel)
      const root = rootOf(record.content)
      const h = byEntry.get(record.id)
      const want = { id: record.id, root, size: record.content.size, target, held: h || null }
      if (h) {
        let st = await stat(h.path)
        if (!st) continue // gone here: the local pass removes it
        if (h.path !== target) {
          await this.clear(target)
          await fs.promises.mkdir(path.dirname(target), { recursive: true })
          await fs.promises.rename(h.path, target)
          await this.hg.personal.edit(h.id, { path: target })
          this.emit({ action: dirOf(this.rel(h.path)) === dirOf(rel) ? 'renamed' : 'moved', path: h.path, to: target })
          h.path = target
          st = await stat(target)
        }
        if (root === h.root || st.size !== h.size || st.mtime !== h.mtime) continue // in step, or a local edit (local pass)
        if (bases(record).includes(h.root)) this.due.set(record.id, want) // a newer version
        else {
          await this.hg.personal.del(h.id) // this version lost to a concurrent edit (R4): kept as a copy
          await this.conflictCopy(h.path, { root: h.root, size: h.size }, record.parent, h, record)
          this.due.set(record.id, { ...want, held: null })
        }
      } else {
        const st = await stat(target)
        if (st && st.file && !heldPaths.has(target)) {
          const local = await hash(target)
          if (local.root === root) {
            await this.hg.personal.put('held', { root, path: target, size: local.size, mtime: local.mtime, space: this.rec.space, entry: record.id })
            continue
          }
          await this.conflictCopy(target, local, record.parent, null, record)
        }
        this.due.set(record.id, want)
      }
    }

    // removals (FR-023: only from a complete read)
    if (!view.complete) return
    const gone = held.filter((h) => !view.byId.has(h.entry))
    const kept = [] // edited here: added again by a local pass (FR-019)
    const readd = []
    for (const h of gone.filter((h) => h.root !== '')) {
      const st = await stat(h.path)
      const orphan = view.orphans.get(h.entry)
      if (orphan && st && !view.exists) { // the linked folder itself removed: kept as a file on its own, at the space's top
        await this.space.edit(h.entry, { parent: this.space.key })
        continue
      }
      if (orphan && st) { // kept: moved to the top of the linked folder, entry and file
        const to = this.abs(orphan.name)
        await this.space.edit(h.entry, { parent: this.folder })
        await this.clear(to)
        await fs.promises.rename(h.path, to)
        await this.hg.personal.edit(h.id, { path: to })
        this.emit({ action: 'moved', path: h.path, to })
        continue
      }
      if (st && st.file && (st.size !== h.size || st.mtime !== h.mtime)) { kept.push(h.path); continue } // edit not recorded yet
      if (st && st.file && (await this.editedAfter(h))) { // no longer held: the local pass finds it new
        kept.push(h.path)
        readd.push(this.rel(h.path))
      }
      if (st && !kept.includes(h.path) && (await this.binned(h.entry))) {
        // in the bin: its trash copy stays held, so a restore finds it here or from this device (spec 003)
        await this.hg.personal.edit(h.id, { path: await this.trash(h.path) })
        continue
      }
      await this.hg.personal.del(h.id)
      if (st && !kept.includes(h.path)) await this.trash(h.path)
    }
    for (const h of gone.filter((h) => h.root === '').sort((a, b) => b.path.length - a.path.length)) {
      await this.hg.personal.del(h.id)
      if (kept.some((p) => p.startsWith(h.path + path.sep))) continue // its folder made again with it
      if (await stat(h.path)) await this.trash(h.path)
    }
    if (readd.length) this.run(() => this.pass(readd)) // after this pass (the watcher sees no change)
    if (!view.exists) await this.sfs.unlink(this.path) // the linked space folder itself was removed
  }

  // A file deleted elsewhere: saved here after the delete (Tibo: then the edit wins)? A take-down
  // ({ by: 'space' }) never is. The file's mtime is when it was saved; stamps are milliseconds too.
  async editedAfter (h) {
    const { deleted } = await this.space.get(h.entry)
    return deleted?.by === 'author' && h.mtime > deleted.stamp
  }

  // Ignored, or a name this disk can't have (reported once).
  skip (rel, dir) {
    if (ignored(this.rules, rel, dir)) return true
    if (!WINDOWS || validLocal(rel.split(path.sep).pop())) return false // not basename: 'a:b' reads as a drive
    if (!this.skipped.has(rel)) {
      this.skipped.add(rel)
      this.emit({ action: 'skipped', reason: 'name', path: this.abs(rel) })
    }
    return true
  }

  async trash (abs) {
    const to = await toTrash(this.path, abs)
    this.emit({ action: 'trashed', path: abs })
    return to
  }

  // Makes room at `abs`: whatever is there goes to the trash.
  async clear (abs) {
    if (await stat(abs)) await this.trash(abs)
  }

  // --- fetching ---

  // Starts due fetches, up to PARALLEL at once; each placed through `run` when complete.
  pump () {
    if (!this.live || this.paused) return
    for (const d of this.due.values()) {
      if (this.fetching.size >= PARALLEL) return
      if ([...this.fetching].some((f) => f.id === d.id)) continue
      if (Date.now() - (this.failed.get(d.id) || 0) < RETRY) continue
      const job = { id: d.id, stop () { this.stopped = true; if (this.download) this.download.stop() } }
      this.fetching.add(job)
      this.fetch(d, job).then((ok) => {
        this.fetching.delete(job)
        if (ok) this.pump()
      }, (err) => {
        this.fetching.delete(job)
        this.failed.set(d.id, Date.now())
        this.emit({ action: 'error', reason: err.message, path: d.target })
      })
    }
  }

  async fetch (d, job) {
    const min = await floor(this.path, this.sfs.minFree)
    const room = async () => (await freeSpace(this.path)).free - d.size >= min
    if (!(await room())) {
      if (!this.low) {
        this.low = true
        this.emit({ action: 'low-space', path: this.path, free: (await freeSpace(this.path)).free, floor: min })
      }
      return false
    }
    this.low = false
    const inc = incoming(this.path, d.root)
    await fs.promises.mkdir(path.dirname(inc), { recursive: true })
    const here = await localPath(this.hg, d.root)
    if (here) {
      await fs.promises.copyFile(here, inc) // held here at another path: a copy, 0 bytes transferred (R9)
    } else if (!(await stat(inc))) {
      if (!(await this.holderOnline(d.root))) return false
      const download = this.sfs._download(d.root, d.size, inc, this.space.key)
      job.download = download
      let timer
      let checked = 0
      const idle = () => { clearTimeout(timer); timer = setTimeout(() => download.stop(), this.sfs.fetchTimeout) }
      download.on('progress', async () => {
        idle()
        if (Date.now() - checked < 1000) return
        checked = Date.now()
        if (!(await room())) download.stop() // below the floor: stopped, resumable (FR-017)
      })
      download.on('stalled', () => download.stop())
      idle()
      try {
        await download
      } finally {
        clearTimeout(timer)
      }
      if (job.stopped || !(await stat(inc))) {
        if (!job.stopped) this.tried.set(d.root, { devices: new Set(await this.others()), at: Date.now() })
        return false
      }
      this.tried.delete(d.root)
    }
    await this.run(() => this.place(d, inc))
    return true
  }

  // One of this person's devices holding it is online (spec 002), or another person's device is
  // connected (their holdings may be private, spec 003 R7) that wasn't asked for it lately.
  async holderOnline (root) {
    const me = this.hg.device.publicKey
    const online = new Set(this.space.peers().map((p) => p.device))
    if ((await all(this.hg.personal.query('held').where({ root }))).items.some((h) => h.device !== me && online.has(h.device))) return true
    const tried = this.tried.get(root)
    const stale = !tried || Date.now() - tried.at > RETRY_OTHERS
    return (await this.others()).some((d) => stale || !tried.devices.has(d))
  }

  // Other people's devices connected in this space.
  async others () {
    const mine = new Set((await this.hg.devices()).map((d) => d.publicKey))
    return this.space.memberConnections().map((m) => m.device).filter((d) => !mine.has(d))
  }

  // A complete download (or copy) into its place; whatever is there goes to the trash, or
  // becomes a conflict copy if it is an edit not yet in the space (FR-016).
  async place (d, inc) {
    if (!this.live || this.paused) return
    const { record } = await this.space.get(d.id)
    if (!record || rootOf(record.content) !== d.root) return // changed meanwhile: the next pass decides
    const h = d.held // as the remote pass saw it; the file is checked against it below
    const st = await stat(d.target)
    if (st) {
      if (h && h.path === d.target && st.size === h.size && st.mtime === h.mtime) await this.trash(d.target)
      else if (st.file) await this.conflictCopy(d.target, await hash(d.target), record.parent, null, record)
      else await this.trash(d.target)
    }
    await fs.promises.mkdir(path.dirname(d.target), { recursive: true })
    await fs.promises.rename(inc, d.target)
    const { mtime, size, ino } = await stat(d.target)
    if (h) await this.hg.personal.del(h.id)
    await this.hg.personal.put('held', { root: d.root, path: d.target, size, mtime, space: this.rec.space, entry: d.id })
    if (ino) this.inos.set(d.target, ino)
    this.due.delete(d.id)
    this.emit({ action: 'fetched', path: d.target })
  }

  async unlinked () {
    this.stop()
    await fs.promises.rm(path.join(this.path, TRASH, INCOMING), { recursive: true, force: true }).catch(() => {})
  }
}

export function copyName (name, who, n) {
  const ext = path.extname(name)
  const base = ext ? name.slice(0, -ext.length) : name
  return `${base} (${who}'s copy${n > 1 ? ' ' + n : ''})${ext}`
}

// Windows: no <>:"|?* or control characters, no trailing dot or space, no reserved device names.
function validLocal (name) {
  const control = /[\x00-\x1f]/ // eslint-disable-line no-control-regex
  return !/[<>:"|?*]/.test(name) && !control.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)
}

// The root with its case changed found too → names differing only by case are one path (R9).
async function caseInsensitive (dir) {
  const swapped = dir.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
  if (swapped === dir) return WINDOWS || os.platform() === 'darwin'
  return !!(await stat(swapped).catch(() => null))
}

const dirOf = (rel) => (path.dirname(rel) === '.' ? '' : path.dirname(rel))

function notFound (err) {
  if (err.code !== 'NOT_FOUND') throw err
}

async function editIfThere (space, id, changes) {
  await space.edit(id, changes).catch(notFound)
}
