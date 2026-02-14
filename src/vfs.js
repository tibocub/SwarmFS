import crypto from 'crypto'

export const VDIR_CHILD_TYPE = {
  FILE: 0,
  VDIR: 1
}

function newUuid() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return crypto.randomBytes(16).toString('hex')
}

function splitVfsPath(vfsPath) {
  if (typeof vfsPath !== 'string' || vfsPath.length === 0) {
    throw new Error('VFS path must be a non-empty string')
  }
  return vfsPath
    .split('/')
    .filter((p) => p.length > 0)
}

function normalizeVfsPath(vfsPath) {
  if (typeof vfsPath !== 'string' || vfsPath.length === 0) {
    throw new Error('VFS path must be a non-empty string')
  }
  if (vfsPath === '/') {
    return '/'
  }
  const trimmed = vfsPath.trim()
  if (trimmed.length === 0) {
    throw new Error('VFS path must be a non-empty string')
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

export class VFS {
  constructor(db) {
    this.db = db
  }

  ensureRoot() {
    const root = this.db.getVfsRoot()
    if (root?.id) {
      return root
    }

    const rootId = newUuid()
    this.db.ensureVfsRoot(rootId)
    return this.db.getVfsRoot()
  }

  resolvePath(vfsPath) {
    const root = this.ensureRoot()

    const normalized = normalizeVfsPath(vfsPath)
    if (normalized === '/') {
      return root
    }

    const parts = splitVfsPath(normalized)
    let current = root

    for (const part of parts) {
      const next = this.db.getVdirByNameAndParent(part, current.id)
      if (!next) {
        return null
      }
      current = next
    }

    return current
  }

  mkdir(vfsPath) {
    const root = this.ensureRoot()
    const normalized = normalizeVfsPath(vfsPath)
    const parts = splitVfsPath(normalized)

    let current = root
    for (const part of parts) {
      let next = this.db.getVdirByNameAndParent(part, current.id)
      if (!next) {
        const id = newUuid()
        this.db.addVdir(id, part, current.id)
        next = this.db.getVdirById(id)
      }
      current = next
    }

    return current
  }

  ls(vfsPath) {
    const normalized = normalizeVfsPath(vfsPath)
    const dir = this.resolvePath(normalized)
    if (!dir) {
      throw new Error(`Vdir not found: ${normalized}`)
    }

    const dirs = this.db.listVdirsByParent(dir.id)
    const entries = this.db.listVdirEntries(dir.id)
    return { dir, dirs, entries }
  }

  addLocalFile(vfsDirPath, localFilePath, suggestedName = null) {
    const normalizedDirPath = normalizeVfsPath(vfsDirPath)
    const dir = this.resolvePath(normalizedDirPath)
    if (!dir) {
      throw new Error(`Vdir not found: ${normalizedDirPath}`)
    }

    if (dir.is_root === 1) {
      throw new Error('Cannot add files directly to VFS root. Create a vdir (e.g. "vdir mkdir photos") and add into it.')
    }

    const fileInfo = this.db.getFile(localFilePath)
    if (!fileInfo) {
      throw new Error(`Local file not tracked: ${localFilePath}`)
    }

    const name = typeof suggestedName === 'string' && suggestedName.length > 0
      ? suggestedName
      : null

    const entryId = this.db.addVdirEntry(
      dir.id,
      VDIR_CHILD_TYPE.FILE,
      fileInfo.merkle_root,
      null,
      name
    )

    return { entryId, vdirId: dir.id, file: fileInfo }
  }
}
