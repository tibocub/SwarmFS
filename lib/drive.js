// A files space: entries as `folder` and `file` records (data-model.md).

import fs from 'fs'
import path from 'path'
import { SwarmFSError } from './errors.js'
import { validName, rootOf } from './types.js'
import { addFile, all, stat, localPath, recordHeld } from './holdings.js'
import { compile, ignored } from './ignore.js'

export class Drive {
  constructor (sfs, space) {
    this.sfs = sfs
    this.hg = sfs.hg
    this.space = space
  }

  get key () { return this.space.key }
  get name () { return this.space.name }
  get top () { return this.space.key }

  on (event, fn) {
    this.space.on(event, fn)
    return this
  }

  off (event, fn) {
    this.space.off(event, fn)
    return this
  }

  // A file or a folder (with all under it), in place: nothing is copied or written to disk.
  // A folder becomes a linked folder of this device (two-way, spec 002).
  async add (localPath, { parent = this.top } = {}) {
    const full = path.resolve(localPath)
    const st = await stat(full)
    if (!st) throw new SwarmFSError('NOT_FOUND', `no such file or folder: ${full}`)
    await this.sfs._overlaps(full)
    if (!st.directory) return entry(await addFile(this.hg, this.space, full, parent))
    const folder = await this.space.put('folder', { name: path.basename(full), parent })
    const rules = compile(await fs.promises.readFile(path.join(full, '.swarmfsignore'), 'utf8').catch(() => ''))
    await this.#addChildren(full, folder.id, rules, full)
    const rec = await this.hg.personal.put('added', { path: full, space: this.key, folder: folder.id })
    await this.sfs._linked(rec)
    return entry(folder)
  }

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

  // Links a space folder (an id, or `top`) to a local path on this device: sync() fills it and
  // follows it (spec 002 story 4). The path is made if missing.
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
    const rec = await this.hg.personal.put('added', { path: full, space: this.key, folder })
    await this.sfs._linked(rec)
  }

  // Folders first, then files, by name.
  // shortcut: reads the whole folder to sort it; fine for thousands, page server-side if folders get huge.
  async list (folder = this.top, { limit = 100, after, timeout } = {}) {
    const folders = await all(this.space.query('folder').where({ parent: folder }), { timeout })
    const files = await all(this.space.query('file').where({ parent: folder }), { timeout })
    const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    let records = [...folders.items.sort(byName), ...files.items.sort(byName)]
    if (after) records = records.slice(records.findIndex((r) => r.id === (after.id || after)) + 1)
    const page = records.slice(0, limit)
    const ctx = await this.#holderContext()
    return {
      items: await Promise.all(page.map((r) => this.#withHolders(r, ctx))),
      complete: folders.complete && files.complete
    }
  }

  async get (id) {
    const { record } = await this.space.get(id)
    if (!record) throw new SwarmFSError('NOT_FOUND', `no entry ${id}`)
    return this.#withHolders(record, await this.#holderContext())
  }

  // From an online holder, verified, into `<path>.part` until complete (research R8).
  async fetch (id, localFile) {
    const e = await this.get(id)
    if (e.kind !== 'file') throw new SwarmFSError('NOT_FOUND', `not a file: ${id}`)
    const here = await localPath(this.hg, e.hash)
    if (here) return { path: here, bytes: 0 }
    const full = path.resolve(localFile)
    if (await stat(full)) throw new SwarmFSError('EXISTS', `already there: ${full}`)
    const me = this.hg.device.publicKey
    if (!e.holders.some((h) => h.online && h.device !== me)) throw new SwarmFSError('NOT_AVAILABLE', `no holder online for ${id}`)

    const download = this.sfs.transfer.download({ root: e.hash, size: e.size }, full, { announce: false })
    // stalled: every peer said it doesn't hold it; no progress for fetchTimeout: covers peers that never answer
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
    if (!(await stat(full))) throw new SwarmFSError('NOT_AVAILABLE', `not fetched: ${id}`) // stopped; resumable
    await recordHeld(this.hg, { root: e.hash, path: full, size: e.size, space: this.key, entry: id })
    return { path: full, bytes: e.size }
  }

  async rename (id, name) {
    if (!validName(name)) throw new SwarmFSError('INVALID_NAME', `not a valid name: ${JSON.stringify(name)}`)
    return entry(await this.space.edit(id, { name }))
  }

  async move (id, folder) {
    // up from the target: meeting `id` means it is the folder itself or inside it
    for (let at = folder; at !== this.top;) {
      if (at === id) throw new SwarmFSError('MOVE_INTO_SELF', `${id} cannot move into itself or its subtree`)
      const { record } = await this.space.get(at)
      if (!record || record.type !== 'folder') throw new SwarmFSError('NOT_FOUND', `no folder ${at}`)
      at = record.parent
    }
    return entry(await this.space.edit(id, { parent: folder }))
  }

  // The entry and its subtree, deepest first. Local files and `held` records stay.
  async remove (id) {
    const { record } = await this.space.get(id)
    if (!record) throw new SwarmFSError('NOT_FOUND', `no entry ${id}`)
    if (record.type === 'folder') {
      for (const type of ['folder', 'file']) {
        for (const child of (await all(this.space.query(type).where({ parent: id }))).items) await this.remove(child.id)
      }
    }
    await this.space.del(id)
  }

  async #holderContext () {
    const devices = await this.hg.devices()
    const names = new Map(devices.map((d) => [d.publicKey, d.name]))
    const online = new Set(this.space.peers().map((p) => p.device))
    online.add(this.hg.device.publicKey)
    return { names, online }
  }

  async #withHolders (record, { names, online }) {
    const e = entry(record)
    if (e.kind === 'file') {
      const me = this.hg.device.publicKey
      const seen = new Map()
      for (const h of (await all(this.hg.personal.query('held').where({ root: e.hash }))).items) {
        // one per device; here, the path this entry was added or fetched as, if any
        if (seen.has(h.device) && !(h.device === me && h.entry === e.id)) continue
        seen.set(h.device,{ device: h.device, name: names.get(h.device) ?? '', online: online.has(h.device), path: h.device === me ? h.path : null })
      }
      e.holders = [...seen.values()]
    }
    return e
  }
}

function entry (r) {
  const file = r.type === 'file'
  return {
    id: r.id,
    kind: r.type,
    name: r.name,
    parent: r.parent,
    size: file ? r.content.size : null,
    hash: file ? rootOf(r.content) : null,
    holders: []
  }
}
