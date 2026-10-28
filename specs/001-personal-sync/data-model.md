# Data model: SwarmFS v1

All types are declared once, in `Hypergraph.open(dir, { types })` (`lib/types.js`). Between versions
hypergraph allows only appending fields, adding types and adding indexes: these declarations are
permanent.

## In a files space (`hg.createSpace({ name, private: true })`)

```js
folder: {
  fields: { name: 'string', parent: 'string' },   // parent: a folder's record id, or the space key (top)
  index: [['parent', 'stamp']],
  editable: 'members'
},
file: {
  fields: { name: 'string', parent: 'string', content: 'ref' },
  index: [['parent', 'stamp']],
  editable: 'members'
}
```

- `content`: `{ src: ['swarmwire://<64 hex>'], size, type: '', digest: 'blake3:<64 hex>', mutable: false }`.
- Rename / move: `space.edit(id, { name })` / `space.edit(id, { parent })`. Content change:
  `space.edit(id, { content })`. Remove: `space.del(id)` (a folder: its subtree first, deepest first).
- Rules (`rules` at open, every member checks): `name` non-empty, no `/` or `\0`, ≤ 255 bytes;
  `parent` non-empty; `content.digest` = `blake3:` + the root in `src[0]`. Rule ids: `swarmfs/name-v1`,
  `swarmfs/content-v1`.
- Later, appended only: `folder.space` (kind `space`: a sub-space, later story 3), `file.base`
  (kind `string`: the content an edit replaced, conflict copies, later story 1).

## In the personal space (`hg.personal`)

```js
held: {
  fields: { root: 'string', path: 'string', size: 'uint', mtime: 'uint', space: 'string', entry: 'string' },
  index: [['root', 'stamp']]
},
added: {
  fields: { path: 'string', space: 'string', folder: 'string' }   // a folder this device added: rescanned
}
```

- `held`: written by the device that holds the file; one per (content, local path). `record.device`
  says which device. `space`/`entry`: the entry it was added or fetched as (rescan edits that entry).
- `added`: written by the device that added a local folder; `folder` is the entry it maps to.
- Both `editable: 'author'` (the default: the identity, so any of the person's devices — only the
  writing device touches them by convention).

## State transitions

- **add(path)** → per folder `put('folder')`, per file hash then `put('file')` + `personal.put('held')`;
  for a folder also `personal.put('added')`.
- **rescan** (own `held` and `added`): new → as add; size/mtime differ → rehash, `edit(entry,
  { content })` if the root differs from `held.root`, `del` old held, `put` new held; missing →
  `del(held)`; entry's parent gone → `edit(entry, { parent: space.key })`. Entries are read by the
  space (one `folder` query, one `file` query), never by the file: with another device offline every
  such read waits its bound. What depends on others' records (a folder gone) acts only on `complete`.
- **fetch** done → `personal.put('held')`.
- **remove(entry)** → `del` (subtree first); `held` and local files untouched.
