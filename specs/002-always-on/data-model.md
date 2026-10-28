# Data model: SwarmFS 002 — always on

Spec 001's types stay as they are (`lib/types.js`, permanent: only appending fields, adding types and
indexes is allowed). 002 appends **one field** and gives two existing records a wider meaning.
Reasons: [research.md](research.md) R2–R4.

## Changes to the types

```js
file: {
  fields: { name: 'string', parent: 'string', content: 'ref', base: 'string' },   // base: appended
  index: [['parent', 'stamp']],
  editable: 'members'
}
// folder, held, added: unchanged declarations
```

- `file.base`: hex roots separated by one space, newest first, at most 16: the content this version
  replaced, then that version's own `base`. Absent (`null`) on a new file and on v1 records.
  - local edit publishing `L` over recorded `H`: `edit(id, { content: ref(L), base: [H, ...base(H)].slice(0, 16).join(' ') })`
    where `base(H)` is the `base` of the version whose content was `H` (the entry's current `base` when
    `C = H`).
  - A conflict copy is a new entry (`put`): no `base`.
- New rule `swarmfs/base-v1`: `base` absent, or 1–16 roots of 64 hex characters separated by single
  spaces. The rule set grows (hypergraph: new rule ids accept what earlier versions wrote — v1 records
  have no `base`, accepted).

## Wider meanings (no declaration change)

- **`added { path, space, folder }`** = a **linked folder** on the writing device. Written by `add`
  (a folder) and `link`; deleted by `unlink`. `folder` may be the space key (the top).
- **`held { root, path, size, mtime, space, entry }`**: also written for a **folder** entry a device has
  on disk inside a linked folder: `root: ''`, `size: 0`, `mtime: 0`. Holder lists and `localPath` only
  look at non-empty roots.

## On disk, inside a linked folder (no records)

```text
<linked>/.swarmfs-trash/<YYYY-MM-DD HH-MM-SS>/<relative path>   # trashed files and folders
<linked>/.swarmfs-trash/.incoming/<root>(.part)                 # fetches in progress / done, not placed yet
<linked>/.swarmfsignore                                          # an ordinary entry (synced)
```

## Runtime state (memory only, per `sync()`)

- Per linked folder: `paused` (`missing` or `mass-delete`, with the pending removals), `ino` per held
  path, case-insensitive or not, its watcher, its dirty paths with their
  last (size, mtime, seen at), `low` (the free-space floor was hit), its compiled ignore rules.
- Per instance: the due fetches (entry ids per linked folder) and the downloads running.

## State transitions

One linked folder `L` (space `S`, folder `F`, path `P`); `E` the entries under `F` (paths from their
names, `F` = `P`); `Hd` this device's `held` under `P`. Runs as one serialized step per `L`.

**Paused** (reason `missing`): `stat(P)` fails or `P` isn't a readable folder → nothing below runs;
`paused` event; checked again every 10 s; back → `resumed`, a full local pass, then a remote pass.

**Paused** (reason `mass-delete`, research R13): a local batch whose gone files are more than half of
the folder's held files and more than 100 → none of its removals applied, nothing else done in the
folder; `sfs.confirm(P)` → the removals applied, resumed; the files back (count again every 10 s and on
watch events) → resumed.

**Local pass** (a batch of settled dirty paths; at `sync()` start and after resume: every path):
1. Ignored paths dropped (fixed list, `P/.swarmfsignore`).
2. Moves (research R7): gone `held` + new path with the same `ino` (kept in memory, non-zero), size and
   mtime, or else the same hash → `S.edit(entry, { name, parent })`, `held` re-put at the new path. Folder moves by their
   files' names/sizes/mtimes → the folder entry edited; its files' `held` re-put.
3. New file → hash → `S.put('file', { name, parent, content })` + `held`. New folder → `put('folder')` +
   folder `held`.
4. Changed file (size or mtime ≠ `held`) → hash; root = `held.root` → only `held` refreshed; else R4's
   rule: entry content `C = H` → `edit(content, base)`; `C ≠ H` → conflict copy (below).
5. Mass-delete check (R13) before any removal.
6. Gone file/folder (in `Hd`, missing, `P` present) → `S.del` (subtree, deepest first), `held` deleted.
   Single added files keep v1's rule: entry kept, `held` deleted.

**Remote pass** (on `change`, `peers`, timers; needs a complete read of `S`'s folders and files to act
on removals):
1. Entry in `Hd` at another path → rename/move the local file or folder (target taken → trashed first);
   `held` re-put.
2. Entry in `Hd`, gone from a complete read → local unchanged: trash it (`held` deleted first); local
   changed: `put` again as a new entry (FR-019).
3. File entry content `C ≠ held.root`, local unchanged: `H ∈ base(C)` → fetch `C`, then trash the old
   file and place; else conflict copy of `H`, then fetch `C`.
4. Folder entry with no `held` → mkdir, folder `held`.
5. File entry with no `held`: local file at its path → hash: same root → `held` (linking, FR-003);
   different → conflict copy of the local file, then fetch. No local file → due: copied if this device
   holds the content at another path (`localPath`), else fetched when a holder is online — if the name
   is valid here, it isn't ignored and the floor allows.

**Case-insensitive disk** (R9, detected once per linked folder): names compared case-insensitively
when placing; an entry whose path is taken by another entry differing only by case → placed under a
conflict-copy name (not a new entry: the copy name is local only).

**Conflict copy** of local file `X` (content `R`) for entry `id` (`name.ext`): rename `X` to the first
free `name (<this device>'s copy[ N]).ext` in its folder; `put('file', { name: copyName, parent, content:
ref(R) })` + `held`; then the entry's content is fetched to the original name. `conflict` event.

**Fetch done** (`.incoming/<root>` complete) → check the target again (step 3/5 rules) → trash the old
file if any → rename into place → `held` (`mtime` from the placed file) → `fetched` event.

**Unlink** → stop watcher and the folder's downloads, delete `.incoming` (partial downloads SwarmFS wrote, never a person's file), `del(added)`; folder `held` deleted,
file `held` kept (the files stay served, followed as v1 followed held files: rescan only).

**Trash empty** → for each linked folder (not paused): remove every dated folder under
`.swarmfs-trash` (not `.incoming`).
