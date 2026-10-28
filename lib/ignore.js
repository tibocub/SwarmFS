// What a linked folder never syncs: a fixed list plus its .swarmfsignore, a small
// .gitignore subset (research R8): # comments, *, **, a trailing / (folders only); a
// pattern with no / matches a name at any depth, one with / matches from the root.

const FIXED = ['*.part', '.swarmfs-trash', 'Thumbs.db', 'desktop.ini', '.DS_Store', '~$*', '*.tmp', '*.swp']

export function compile (text = '') {
  return [...FIXED, ...text.split(/\r?\n/)].map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(rule)
}

function rule (line) {
  const dirOnly = line.endsWith('/')
  const p = dirOnly ? line.slice(0, -1) : line
  const anchored = p.includes('/')
  const body = (anchored ? p.replace(/^\//, '') : p).split('**').map((part) =>
    part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')
  ).join('.*').replace(/\.\*\//g, '(?:.*/)?')
  return { re: new RegExp('^' + body + '$'), anchored, dirOnly }
}

// `rel`: a path relative to the linked folder; a folder that matches ignores all under it.
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
