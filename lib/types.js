// Record types and rules (data-model.md). Permanent: later versions only append
// fields, add types and add indexes.

import b4a from 'b4a'

export const types = {
  folder: {
    fields: { name: 'string', parent: 'string', from: 'string', binned: 'uint' }, // from, binned: appended in 003 (the bin)
    index: [['parent', 'stamp']],
    editable: 'members'
  },
  file: {
    fields: { name: 'string', parent: 'string', content: 'ref', base: 'string', from: 'string', binned: 'uint' }, // base: 002; from, binned: 003
    index: [['parent', 'stamp']],
    editable: 'members'
  },
  held: {
    fields: { root: 'string', path: 'string', size: 'uint', mtime: 'uint', space: 'string', entry: 'string' },
    index: [['root', 'stamp']]
  },
  added: {
    fields: { path: 'string', space: 'string', folder: 'string' }
  },
  // 003, in files spaces: a person's name, and (if they chose to show it) what each device holds
  profile: { fields: { name: 'string' }, onePerMember: true },
  has: {
    fields: { root: 'string' },
    index: [['root', 'stamp']]
  }
}

// An entry in a shared space's bin has this parent; `from` is where it was (spec 003, R3).
export const BIN = 'bin'

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
  { id: 'swarmfs/base-v1', validate: (r) => r.type !== 'file' || r.base == null || /^[0-9a-f]{64}( [0-9a-f]{64}){0,15}$/.test(r.base) },
  { id: 'swarmfs/bin-v1', validate: (r) => !entry(r) || r.parent !== BIN || (typeof r.from === 'string' && r.from.length > 0) },
  { id: 'swarmfs/profile-v1', validate: (r) => r.type !== 'profile' || validPersonName(r.name) }
]

export function validPersonName (name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && !/[\x00-\x1f\x7f]/.test(name) // eslint-disable-line no-control-regex
}

export const bases = (record) => (record.base ? record.base.split(' ') : [])
// The base of an edit replacing `record`'s content: that root, then its own base.
export const nextBase = (record) => [rootOf(record.content), ...bases(record)].slice(0, 16).join(' ')

// A file's content field from its BLAKE3 root (hex) and size (research R2).
export const contentRef = (root, size) => ({ src: [SRC + root], size, type: '', digest: 'blake3:' + root, mutable: false })
export const rootOf = (content) => content.src[0].slice(SRC.length)
