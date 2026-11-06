// A site (spec 004): a space that isn't private, its pages in a sub-space only the owner and
// admins write, members' uploads in the space itself. What is read lands in app storage
// (swarmfs.js `_bytes`).

import fs from 'fs'
import path from 'path'
import { Drive } from './drive.js'
import { SwarmFSError } from './errors.js'
import { validName, rootOf, inlineOf } from './types.js'
import { all, mine, stat, hash, contentOf, localPath, recordHeld } from './holdings.js'

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
      record = (await all(this.pages.space.query(type).where({ parent }), { timeout })).items.find((r) => r.name === name)
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

  // The owner's pass (while syncing): every upload not inline kept in app storage; the kept
  // copies of removed ones dropped (FR-013).
  async _keep () {
    const dir = path.join(this.sfs.appStorage, 'kept')
    const { items, complete } = await all(this.space.query('upload'))
    for (const r of items) {
      const root = rootOf(r.content)
      const target = path.join(dir, root)
      if (inlineOf(r) || (await stat(target))) continue
      await fs.promises.mkdir(dir, { recursive: true })
      const here = await localPath(this.hg, root)
      if (!here) {
        await this.fetch(r.id, target).catch(() => {}) // no holder online: again on 'peers'
        continue
      }
      await fs.promises.copyFile(here, target)
      await recordHeld(this.hg, { root, path: target, size: r.content.size, space: this.key, entry: r.id })
    }
    if (!complete) return
    const roots = new Set(items.map((r) => rootOf(r.content)))
    for (const h of (await all(mine(this.hg, 'held'))).items) {
      if (path.dirname(h.path) !== dir || roots.has(h.root)) continue
      try {
        await fs.promises.rm(h.path, { force: true })
      } catch {
        continue // being served (Windows): the next pass
      }
      await this.hg.personal.del(h.id)
    }
  }
}

function upload (r) {
  return { id: r.id, name: r.name, size: r.content.size, hash: rootOf(r.content), author: r.author }
}
