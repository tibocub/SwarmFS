// Record types and rules. Permanent: later versions may only append fields, add types and add
// indexes (hypergraph refuses anything else), so fields are listed in the order they were added.

import b4a from 'b4a'
import { MemorySource } from 'swarmwire-lib'
import { SwarmFSError } from './errors.js'

/**
 * Hypergraph's own types, by the paths its package exports.
 * @typedef {import('hypergraph/next').Hypergraph} Hypergraph
 * @typedef {import('hypergraph/next').OpenOptions} OpenOptions
 * @typedef {NonNullable<OpenOptions['types']>} TypeDeclarations
 * @typedef {import('hypergraph/next').Space} Space
 * @typedef {import('hypergraph/next').Query} Query
 * @typedef {import('hypergraph/next').HgRecord} HgRecord
 * @typedef {import('hypergraph/next').Deletion} Deletion
 */

/**
 * A `ref` field: where the bytes are (`swarmwire://<root>`) and their BLAKE3 root.
 * @typedef {object} ContentRef
 * @property {string[]} src
 * @property {number} size
 * @property {string} type
 * @property {string} digest
 * @property {boolean} mutable
 */

/**
 * SwarmFS's records, as hypergraph returns them.
 * @typedef {HgRecord & { type: 'folder', name: string, parent: string, from?: string, binned?: number }} FolderRecord
 * @typedef {HgRecord & { type: 'file', name: string, parent: string, content: ContentRef, base?: string, from?: string, binned?: number, data?: Uint8Array | null }} FileRecord
 * @typedef {HgRecord & { type: 'upload', name: string, content: ContentRef, data?: Uint8Array | null }} UploadRecord
 * @typedef {FolderRecord | FileRecord} EntryRecord
 * @typedef {FileRecord | UploadRecord} ContentRecord
 * @typedef {HgRecord & { root: string, path: string, size: number, mtime: number, space: string, entry: string }} HeldRecord `root` '' for a folder
 * @typedef {HgRecord & { path: string, space: string, folder: string }} AddedRecord
 * @typedef {HgRecord & { name: string }} ProfileRecord
 * @typedef {HgRecord & { root: string }} HasRecord
 * @typedef {HgRecord & { pages: string, app?: string }} SiteRecord
 * @typedef {HgRecord & { space: string }} KeptRecord
 */

/**
 * A list read: `complete` false while something known of is still on its way.
 * @template [R=HgRecord]
 * @typedef {{ items: R[], complete: boolean }} Page
 */

/** @type {TypeDeclarations} */
export const types = {
  folder: {
    fields: { name: 'string', parent: 'string', from: 'string', binned: 'uint' },
    index: [['parent', 'stamp']],
    editable: 'members'
  },
  file: {
    fields: { name: 'string', parent: 'string', content: 'ref', base: 'string', from: 'string', binned: 'uint', data: 'bytes' },
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
  // in files spaces: a person's name, and (if they chose to show it) what each device holds
  // shared: in a private space that hides its history, newcomers read these too (hypergraph's shared types)
  profile: { fields: { name: 'string' }, onePerMember: true, shared: true },
  has: {
    fields: { root: 'string' },
    index: [['root', 'stamp']]
  },
  // in sites: uploads, and the site record (its pages sub-space, and `app`, the site whose code it runs)
  upload: { fields: { name: 'string', content: 'ref', data: 'bytes' } },
  site: { fields: { pages: 'space', app: 'string' }, put: { permission: 'decide' }, shared: true },
  // in the personal space: a site this device keeps whole (installed)
  kept: { fields: { space: 'string' }, index: [['space', 'stamp']] }
}

/**
 * A site's own types, next to SwarmFS's; never one of SwarmFS's names (that would break its pages).
 * @param {TypeDeclarations} own
 * @returns {TypeDeclarations}
 */
export function siteTypes (own) {
  if (!own || typeof own !== 'object' || Array.isArray(own)) throw new TypeError('types: { name: { fields: { field: kind } } }, as hypergraph takes them')
  const taken = Object.keys(own).find((name) => types[name])
  if (taken) throw new SwarmFSError('INVALID_TYPE', `"${taken}" is one of SwarmFS's own types: give the site's another name`)
  return own
}

// A site's file up to this size travels inside its record (`data`): a record is at most 64 KiB.
export const INLINE_MAX = 60 * 1024

// An entry in a shared space's bin has this parent; `from` is where it was.
export const BIN = 'bin'

/** @param {unknown} name */
export function validName (name) {
  return typeof name === 'string' && name.length > 0 && !/[/\0]/.test(name) && b4a.byteLength(name) <= 255
}

const SRC = 'swarmwire://'
/** @param {{ type: string }} r */
const entry = (r) => r.type === 'folder' || r.type === 'file'
/** @param {ContentRef | null | undefined} c */
const validRef = (c) => !!c && typeof c.src[0] === 'string' && c.src[0].startsWith(SRC) && c.digest === 'blake3:' + c.src[0].slice(SRC.length)

/** @type {NonNullable<OpenOptions['rules']>} */
export const rules = [
  { id: 'swarmfs/name-v1', validate: (r) => !entry(r) || (validName(r.name) && typeof r.parent === 'string' && r.parent.length > 0) },
  { id: 'swarmfs/content-v1', validate: (r) => r.type !== 'file' || validRef(r.content) },
  // the contents an edit replaced, newest first; a later rule id may allow more than 16
  { id: 'swarmfs/base-v1', validate: (r) => r.type !== 'file' || r.base == null || /^[0-9a-f]{64}( [0-9a-f]{64}){0,15}$/.test(r.base) },
  { id: 'swarmfs/bin-v1', validate: (r) => !entry(r) || r.parent !== BIN || (typeof r.from === 'string' && r.from.length > 0) },
  { id: 'swarmfs/profile-v1', validate: (r) => r.type !== 'profile' || validPersonName(r.name) },
  { id: 'swarmfs/upload-v1', validate: (r) => r.type !== 'upload' || (validName(r.name) && validRef(r.content)) },
  // inline bytes are the content's: every member hashes them before keeping the record
  {
    id: 'swarmfs/inline-v1',
    validate: (r) => (r.type !== 'file' && r.type !== 'upload') || !r.data?.length ||
      (r.data.length === r.content.size && r.data.length <= INLINE_MAX && MemorySource.from(r.data).root === rootOf(r.content))
  }
]

/** @param {unknown} name */
export function validPersonName (name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && !/[\x00-\x1f\x7f]/.test(name) // eslint-disable-line no-control-regex
}

/** @param {FileRecord} record @returns {string[]} */
export const bases = (record) => (record.base ? record.base.split(' ') : [])
/** @param {FileRecord} record */
export const nextBase = (record) => [rootOf(record.content), ...bases(record)].slice(0, 16).join(' ')

/** @param {string} root @param {number} size @returns {ContentRef} */
export const contentRef = (root, size) => ({ src: [SRC + root], size, type: '', digest: 'blake3:' + root, mutable: false })
/** @param {ContentRef} content */
export const rootOf = (content) => content.src[0].slice(SRC.length)
// checked by `inline-v1`, so a record's bytes can be trusted
/** @param {ContentRecord} r */
export const inlineOf = (r) => (r.data && r.data.length === r.content.size ? r.data : null)
