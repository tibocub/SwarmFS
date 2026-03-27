import crypto from 'crypto'
import { hashBuffers } from './hash.js'

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
        
        // Add entry to parent's vdir_entries so merkle calculation works
        // Use the child's UUID as placeholder (will be replaced with merkle root when child has content)
        if (!current.is_root) {
          this.db.addVdirEntry(current.id, VDIR_CHILD_TYPE.VDIR, id, part)
        }
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
      name
    )

    return { entryId, vdirId: dir.id, file: fileInfo }
  }

  /**
   * Calculate merkle root for a vdir based on its children
   * Algorithm: sort children by merkle_root, concatenate (merkle_root + type_flag), hash
   * @param {string} vdirId - The vdir UUID
   * @returns {Promise<string|null>} - Hex-encoded merkle root, or null if empty
   */
  async calculateVdirMerkleRoot(vdirId) {
    const children = this.db.listVdirEntries(vdirId)

    if (children.length === 0) {
      return null // Empty vdir
    }

    // Resolve any UUID placeholders to actual merkle roots
    const resolvedChildren = children.map(c => {
      let childRoot = c.child_merkle_root
      
      // If child is a vdir and the root looks like a UUID (36 chars with dashes),
      // try to resolve it to the actual merkle root
      if (c.child_type === VDIR_CHILD_TYPE.VDIR && childRoot.length === 36 && childRoot.includes('-')) {
        const childVdir = this.db.getVdirById(childRoot)
        if (childVdir?.merkle_root) {
          childRoot = childVdir.merkle_root
        }
      }
      
      return { ...c, resolved_merkle_root: childRoot }
    })

    // Sort by resolved merkle_root (lexicographic)
    resolvedChildren.sort((a, b) => a.resolved_merkle_root.localeCompare(b.resolved_merkle_root))

    // Concatenate: merkle_root + type_flag for each child
    const buffers = resolvedChildren.map(c => {
      const merkleBuf = Buffer.from(c.resolved_merkle_root, 'hex')
      const typeFlag = Buffer.from([c.child_type]) // 0x00 for file, 0x01 for vdir
      return Buffer.concat([merkleBuf, typeFlag])
    })

    // Single hash of concatenated data
    return await hashBuffers(buffers)
  }

  /**
   * Update a vdir's merkle root and propagate to parent entries
   * @param {string} vdirId - The vdir UUID to update
   * @returns {Promise<string|null>} - The new merkle root
   */
  async updateVdirMerkleRoot(vdirId) {
    const newRoot = await this.calculateVdirMerkleRoot(vdirId)
    
    // Update the vdir's own merkle root
    this.db.updateVdirMerkleRoot(vdirId, newRoot)
    
    // Find any parent entries that reference this vdir by UUID and update them
    const parentEntries = this.db.findVdirEntriesByChildId(vdirId)
    for (const entry of parentEntries) {
      if (newRoot) {
        // Update the entry to use the actual merkle root
        this.db.updateVdirEntryMerkleRoot(entry.parent_vdir_id, vdirId, newRoot)
      }
    }
    
    return newRoot
  }

  /**
   * Recursively update merkle roots for a vdir and all its ancestors
   * @param {string} vdirId - The vdir UUID to start from
   * @returns {Promise<void>}
   */
  async updateAncestorMerkleRoots(vdirId) {
    let currentId = vdirId

    while (currentId) {
      const vdir = this.db.getVdirById(currentId)
      if (!vdir) break

      // Calculate and update this vdir's merkle root
      await this.updateVdirMerkleRoot(currentId)

      // Move to parent
      currentId = vdir.parent_id
    }
  }

  /**
   * Add a file to a vdir and update merkle roots
   * @param {string} vfsDirPath - VFS path to the directory
   * @param {string} localFilePath - Local filesystem path of the tracked file
   * @param {string|null} suggestedName - Optional display name
   * @returns {Promise<object>}
   */
  async addFile(vfsDirPath, localFilePath, suggestedName = null) {
    const result = this.addLocalFile(vfsDirPath, localFilePath, suggestedName)

    // Update merkle roots for this vdir and all ancestors
    await this.updateAncestorMerkleRoots(result.vdirId)

    return result
  }

  /**
   * Add a subdirectory to a vdir
   * @param {string} parentVfsPath - VFS path to parent directory
   * @param {string} childName - Name for the new subdirectory
   * @returns {Promise<object>}
   */
  async addSubdir(parentVfsPath, childName) {
    // Create the child vdir
    const childPath = parentVfsPath === '/' 
      ? `/${childName}` 
      : `${parentVfsPath}/${childName}`
    const childVdir = this.mkdir(childPath)

    // Add entry in parent
    const parentVdir = this.resolvePath(parentVfsPath)
    if (!parentVdir) {
      throw new Error(`Parent vdir not found: ${parentVfsPath}`)
    }

    // Wait for child to have a merkle root (it's empty, so null for now)
    // But we still add it as an entry
    this.db.addVdirEntry(
      parentVdir.id,
      VDIR_CHILD_TYPE.VDIR,
      childVdir.id, // For now, use the UUID as placeholder (will be replaced when child has content)
      childName
    )

    // Update ancestors
    await this.updateAncestorMerkleRoots(parentVdir.id)

    return { childVdir, parentVdir }
  }

  /**
   * Remove an entry from a vdir and update merkle roots
   * @param {string} vdirId - The vdir UUID
   * @param {string} childMerkleRoot - The child's merkle root
   * @returns {Promise<void>}
   */
  async removeEntry(vdirId, childMerkleRoot) {
    this.db.removeVdirEntry(vdirId, childMerkleRoot)
    await this.updateAncestorMerkleRoots(vdirId)
  }

  /**
   * Repair vdir_entries for existing vdirs that were created before the fix
   * Creates missing entries based on parent_id relationships
   */
  repairVdirEntries() {
    // Get all vdirs (except root)
    const allVdirs = this.db.listVdirsByParent(null)
    const root = this.db.getVfsRoot()
    
    // Recursively collect all vdirs
    const collect = (parentId) => {
      const children = this.db.listVdirsByParent(parentId)
      let result = [...children]
      for (const child of children) {
        result = result.concat(collect(child.id))
      }
      return result
    }
    
    const all = collect(root?.id || null)
    
    let repaired = 0
    for (const vdir of all) {
      if (!vdir.parent_id) continue
      
      // Check if entry already exists in parent
      const existingEntries = this.db.listVdirEntries(vdir.parent_id)
      const hasEntry = existingEntries.some(e => 
        e.child_merkle_root === vdir.id || e.child_merkle_root === vdir.merkle_root
      )
      
      if (!hasEntry) {
        // Create missing entry
        this.db.addVdirEntry(
          vdir.parent_id,
          VDIR_CHILD_TYPE.VDIR,
          vdir.merkle_root || vdir.id,
          vdir.name
        )
        repaired++
      }
    }
    
    return repaired
  }
}
