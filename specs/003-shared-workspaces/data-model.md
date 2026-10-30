# Data model: SwarmFS 003 — shared workspaces

Specs 001/002's types stay (`lib/types.js`, permanent: only appending fields, adding types and
indexes). 003 appends two fields to `folder` and `file`, adds two types, one rule. Reasons:
[research.md](research.md).

## Changes to the types

```js
folder: {
  fields: { name: 'string', parent: 'string', from: 'string', binned: 'uint' },              // appended
  index: [['parent', 'stamp']], editable: 'members'
},
file: {
  fields: { name: 'string', parent: 'string', content: 'ref', base: 'string', from: 'string', binned: 'uint' },
  index: [['parent', 'stamp']], editable: 'members'
},
profile: { fields: { name: 'string' }, onePerMember: true },        // NEW, in files spaces (R4)
has: { fields: { root: 'string' }, index: [['root', 'stamp']] }     // NEW, in files spaces (R7)
// held, added: unchanged
```

- In the bin: `parent: 'bin'`, `from`: the former parent id (or the space key), `binned`: ms.
  Restored: `parent: from` (or the space key if that folder is gone), `from: ''`, `binned: 0`.
- New rule `swarmfs/bin-v1`: `parent !== 'bin'` or `from` non-empty. Also `profile.name`: 1–64
  characters, no control characters (`swarmfs/profile-v1`). Earlier records have neither field
  (`null`): accepted.

## Roles (per files space, defined by SwarmFS at `createSpace`)

```js
editor:  ['post'] + ['invite'] if the invite setting is 'everyone'   // what invitees get
trusted: ['post'] + ['invite'] unless the setting is 'admins'
```

Setting read back: `editor` has `invite` → `everyone`; else `trusted` has it → `chosen`; else `admins`.

## Personal settings (`hg.setSetting`, same on all the person's devices)

- `name`: string, the person's name.
- `show-holdings`: array of space keys where this person shows holdings.

## State transitions

- **remove(id)** in a shared space (R1) → `edit(id, { parent: 'bin', from: parent, binned: now })`;
  not shared → spec 002 (`del`, subtree first). Local deletes go through it (sync.js's local pass).
- **restore(id)** → `edit(id, { parent: from exists ? from : key, from: '', binned: 0 })`.
- **emptyBin()** → for each bin entry: owner/admin → `remove`-for-good (subtree, `del`); else only
  if this identity authored it and its whole subtree → `del`; others left.
- **Linked folder pass**: entries under `parent: 'bin'` are outside every linked folder (local copy
  to the trash); orphans exclude `parent: 'bin'`; the linked folder's own space folder (or an
  ancestor) in the bin → paused `in-bin`.
- **access 'none'** (`status`) → every linked folder of that space paused `removed`; `'full'` →
  resumed (spec 002's catch-up).
- **held put/del** in a space listed in `show-holdings` → `has` put / del (last path of that root).
- **show-holdings off** for a space → this device deletes its `has` there.
- **setName / createSpace / join / 'spaces'** → `put('profile', { name })` where it differs.
- **Conflict copy** (spec 002) → name after the person if the winner's `author` ≠ this identity.
- **resolve(root, peer)** → own `held` with that root whose `space` has `peer` in
  `memberConnections()`; else null.
