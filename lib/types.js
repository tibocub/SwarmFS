// Record types and rules (data-model.md). Permanent: later versions only append
// fields, add types and add indexes.

import b4a from 'b4a'

export const types = {
  folder: {
    fields: { name: 'string', parent: 'string' },
    index: [['parent', 'stamp']],
    editable: 'members'
  },
  file: {
    fields: { name: 'string', parent: 'string', content: 'ref' },
    index: [['parent', 'stamp']],
    editable: 'members'
  },
  held: {
    fields: { root: 'string', path: 'string', size: 'uint', mtime: 'uint', space: 'string', entry: 'string' },
    index: [['root', 'stamp']]
  },
  added: {
    fields: { path: 'string', space: 'string', folder: 'string' }
  }
}

export function validName (name) {
  return typeof name === 'string' && name.length > 0 && !/[/\0]/.test(name) && b4a.byteLength(name) <= 255
}

const SRC = 'swarmwire://'
const entry = (r) => r.type === 'folder' || r.type === 'file'

export const rules = [
  { id: 'swarmfs/name-v1', validate: (r) => !entry(r) || (validName(r.name) && typeof r.parent === 'string' && r.parent.length > 0) },
  {
    id: 'swarmfs/content-v1',
    validate: (r) => r.type !== 'file' || (!!r.content && typeof r.content.src[0] === 'string' &&
      r.content.src[0].startsWith(SRC) && r.content.digest === 'blake3:' + r.content.src[0].slice(SRC.length))
  }
]

// A file's content field from its BLAKE3 root (hex) and size (research R2).
export const contentRef = (root, size) => ({ src: [SRC + root], size, type: '', digest: 'blake3:' + root, mutable: false })
export const rootOf = (content) => content.src[0].slice(SRC.length)
