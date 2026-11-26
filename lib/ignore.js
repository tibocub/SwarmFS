// A small .gitignore subset: #, *, **, a trailing / (folders); without / a pattern matches at
// any depth, with / from the root.

/** @typedef {{ re: RegExp, anchored: boolean, dirOnly: boolean }} Rule */

const FIXED = ['*.part', '.swarmfs-trash', 'Thumbs.db', 'desktop.ini', '.DS_Store', '~$*', '*.tmp', '*.swp']

// Photos stay out of linked folders on an I2P-only instance: their metadata (camera, time, place) would be served
// as it is, and a stripped copy can't be kept in sync both ways. Added one by one, they're stripped (lib/strip.js).
const IMAGE = { re: /^.*\.(jpe?g|png|webp)$/i, anchored: false, dirOnly: false }

/** @param {string} rel @returns {boolean} a photo, by its name (what `images` leaves out) */
export const isPhoto = (rel) => IMAGE.re.test(rel)

/**
 * @param {string} [text] - a .swarmfsignore
 * @param {{ images?: boolean }} [opts] - images: leave JPEG, PNG and WebP files out (an I2P-only instance)
 * @returns {Rule[]}
 */
export function compile (text = '', { images = false } = {}) {
  const rules = [...FIXED, ...text.split(/\r?\n/)].map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(rule)
  return images ? [...rules, IMAGE] : rules
}

/**
 * @param {string} line
 * @returns {Rule}
 */
function rule (line) {
  const dirOnly = line.endsWith('/')
  const p = dirOnly ? line.slice(0, -1) : line
  const anchored = p.includes('/')
  const body = (anchored ? p.replace(/^\//, '') : p).split('**').map((/** @type {string} */ part) =>
    part.split('*').map((/** @type {string} */ s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')
  ).join('.*').replace(/\.\*\//g, '(?:.*/)?')
  return { re: new RegExp('^' + body + '$'), anchored, dirOnly }
}

/**
 * A matching folder ignores everything under it, so every prefix is checked.
 * @param {Rule[]} rules
 * @param {string} rel
 * @param {boolean} isDir
 * @returns {boolean}
 */
export function ignored (rules, rel, isDir) {
  const parts = rel.split(/[\\/]/).filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const dir = i < parts.length - 1 || isDir
    const prefix = parts.slice(0, i + 1).join('/')
    for (const r of rules) {
      if (r.dirOnly && !dir) continue
      if (r.re.test(r.anchored ? prefix : parts[i])) return true
    }
  }
  return false
}
