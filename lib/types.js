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
    fields: { name: 'string', parent: 'string', content: 'ref', base: 'string' }, // base: appended in 002
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
  },
  // the contents an edit replaced, newest first (research R4); a later rule id may allow more than 16
  { id: 'swarmfs/base-v1', validate: (r) => r.type !== 'file' || r.base == null || /^[0-9a-f]{64}( [0-9a-f]{64}){0,15}$/.test(r.base) }
]

export const bases = (record) => (record.base ? record.base.split(' ') : [])
// The base of an edit replacing `record`'s content: that root, then its own base.
export const nextBase = (record) => [rootOf(record.content), ...bases(record)].slice(0, 16).join(' ')

// A file's content field from its BLAKE3 root (hex) and size (research R2).
export const contentRef = (root, size) => ({ src: [SRC + root], size, type: '', digest: 'blake3:' + root, mutable: false })
export const rootOf = (content) => content.src[0].slice(SRC.length)
