# Research: SwarmFS 002 — always on

Decisions for spec 002. Tibo's (lead conversation 2026-10-28, hypergraph `ROADMAP.md`) are marked
**Tibo**; the rest are this worker's, for the lead to review (listed again in the report).
Spec 001's research (R1–R10) still holds unless replaced here.

## R1. Where sync runs: `sfs.sync()`, hosted by the shell

- **Decision**: the library gets `sfs.sync()`: starts watching every linked folder and single added
  file, fetching and applying changes, until `close()`; resolves once the first pass is done. The shell
  calls it; one-shot commands don't (**Tibo**: the running shell acts on its own; no service, no IPC).
- **Why**: tests drive it through the public API (constitution II); one-shot commands stay inert.
- **Rejected**: syncing inside `open()` (a one-shot `ls` would start fetching); an option on `open`
  (a method is the same size and clearer).

## R2. A linked folder is v1's `added` record

- **Decision**: no new type. `added { path, space, folder }` (personal space, written by the device)
  already means "this local folder follows this space folder on this device". `add` of a folder
  writes it (as in v1); `link` writes one for an existing space folder; `unlink` deletes it. Paused is
  runtime state (the root is missing now), never stored.
- **Why**: smallest; v1's added folders become linked folders with no migration (**Tibo**: every added
  folder is a linked folder).
- **Overlaps**: `link`/`add` refuse a path inside or containing a linked folder of this device
  (`EXISTS`), so a local file follows one entry at most.

## R3. Folders get holdings too (`held` with `root: ''`)

- **Decision**: a device records each folder entry it has on disk inside a linked folder as a `held`
  record with `root: ''`, `size: 0`, `mtime: 0`, `entry`: the folder's id. Files: unchanged.
- **Why**: without it a local folder with no entry is ambiguous (made here → add it; removed elsewhere
  → trash it), and an entry with no local folder too (deleted here → remove it; not made yet → mkdir).
  For files `held` already settles this (spec 001); folders need the same fact. No new type: `held`
  reads as "this device has this entry at this path" (and for a file, this content).
- **Rejected**: inferring from files (an emptied folder would come back; a deleted empty folder would be
  recreated); a new type `placed` (one more type for the same fact).
- **Touches**: v1's rescan deletes `held` whose path isn't a file: it must keep folder ones; `localPath`
  and holders never look up root `''`.

## R4. `file.base`: the contents an edit replaced, newest first

- **Decision**: append `base: 'string'` to `file` (only appending is allowed; **Tibo**: design it once).
  Value: space-separated hex roots, newest first: the content the edit replaced, then that version's
  own `base`, cut to 16 roots. `put` of a new file: no `base`.
- **Rule** (a device, for one entry with space content `C`, its own recorded content `H`, local file
  unchanged or not):
  - local file unchanged, `C = H`: in sync.
  - local file unchanged, `C ≠ H`, `H` in `base(C)`: a newer version → fetch `C`, old file to trash.
  - local file unchanged, `C ≠ H`, `H` not in `base(C)`: `H` lost to a concurrent edit → `H` becomes
    a conflict copy (local rename + new entry), `C` fetched into place. Nothing to the trash.
  - local file changed (unrecorded edit `L`), `C = H`: publish `L` (`content: L, base: H + base(H)`).
  - local file changed, `C ≠ H`: concurrent → `L` becomes a conflict copy, `C` fetched into place.
- **Why a chain, not one root**: with one root, a device offline while two edits were made
  (`H → C1 → C2`) would see `base(C2) = C1 ≠ H` and make a needless conflict copy of an old version on
  every device — the common case of a laptop asleep for a week. With the chain it fast-forwards.
  16 roots × 65 bytes ≈ 1 KB per edit at most.
- **Mistakes are safe either way**: a chain cut short (17+ edits missed) makes an extra conflict copy;
  nothing is ever lost (the trash catches the other direction).
- **The limit lives in the rule, not the field** (lead review 2026-10-28): rule `swarmfs/base-v1`
  accepts 1-16 roots; a later rule id can accept more. The field (`base: 'string'`) is permanent.
- **Rejected**: one root (above); hypergraph exposing concurrent versions (request H7, still open: if
  hypergraph adds it, `base` stays harmless); version vectors (per-device counters: bigger, same result
  for one person).
- **Who makes the copy**: only the device whose version lost (hypergraph's latest-wins picks the same
  winner everywhere), so a conflict makes exactly one copy. Name: `name (<device name>'s copy).ext`,
  then `… copy 2`, `… copy 3` (**Tibo**: the name pattern; the number is this worker's).

## R5. Names and places: latest wins, no copies

- **Decision**: renames and moves follow hypergraph's latest-wins (a whole record version: a rename and
  a concurrent content edit can't both win). Content is protected by R4: if the content edit lost to a
  rename, the losing device's `H`/`L` is not in the winner's `base`, so it becomes a copy. A lost name
  is just a name.
- **Edit after a delete** (spec FR-019): a remote removal arriving while the local file has an
  unrecorded edit → re-added as a new entry. When the edit was already in the space, hypergraph can't
  tell the delete's time from a "not held" (`get()` returns `null` for both) → the file goes to the
  editing device's trash (kept, not shown). Request **H15** asks for the delete's stamp; then "edit
  newer than the delete" re-adds it.

## R6. Following the space: re-read on `change`

- **Decision**: on a files space's `change` event (debounced 500 ms), each linked folder of that space
  re-reads the space's `folder` and `file` records (one paged query each, as rescan does since T025)
  and reconciles with this device's `held` records under its path. Removals are acted on only from a
  complete read (FR-023; spec 001 did the same for orphans).
- **Measured** (2026-10-28, this PC): with 10,000 entries, a full remote pass and the first pass of
  `sync()` take ~3.8 s; a new file is recorded 3.2 s after it was written. Batches of local paths
  don't run a remote pass (only the space's own changes do), else 1,000 placed files ran 81 full
  passes (SC-004 took 109 s, now ~50 s).
- **H16** (found building): `change` doesn't fire for another device's edit; `logs` is listened too.
- **Cost**: 10,000 entries are 200 pages per change. `change` says which types changed, not which
  records; nothing gives "what changed since". Request **H14** (a changes feed or ids in `change`).
  Marked as a shortcut in code until then.
- Also re-run on `peers` (a holder came online: due fetches retried, FR-014) and every 10 s for paused
  folders and the free-space floor (cheap: a `stat` and a `statfs` per linked folder).

## R7. Following the disk: watch, settle 2 s, one batch

- **Decision**: one recursive watcher per linked folder root, `fs.watch(root, { recursive: true })` on
  Node, bare-fs `watch(root, { recursive: true })` on Bare (same `imports` map, same API); a single
  added file: a non-recursive watch on its folder, filtered to its name. An event marks a relative path
  dirty (a folder: walked). Every 500 ms, dirty paths whose size and mtime haven't changed for 2 s
  (**Tibo**) are taken as one batch.
- **A batch**: new paths hashed; gone `held` paths; renames found before removals:
  - a file: gone and new with the same **file identity** (`ino` from `stat`, which a rename keeps),
    size and mtime → the entry is renamed/moved, not hashed again. Size + mtime alone can mislabel two
    files (copy tools keep mtime: delete `a.jpg`, copy in a different `b.jpg` of the same size), so
    without a usable `ino` (unknown or 0) new files are hashed, and a hash equal to a gone file's root
    is the rename/move (lead review 2026-10-28).
  - `ino` is not recorded: `held` has no field for it. `sync()` keeps each held path's `ino` in memory
    from the `stat`s it makes anyway (first pass, each batch). Gone files of the first pass (changes
    made while closed) have no known `ino` → hashed (correct, slower for big renamed files).
  - Checked 2026-10-28 on this Windows PC (NTFS): Node `fs.promises.stat` and bare-fs `stat` both give a
    non-zero `ino` (e.g. `281474979734290`, below 2^53), the same after a rename, a different one for a
    new file at the old name. On FAT/exFAT drives `ino` may not be stable: hashing covers it when 0;
    a non-zero but unstable `ino` can only cause a missed match (a hash then), never a wrong one,
    because size and mtime must match too.
  - a folder: a gone folder and a new folder in one batch whose files (relative names, `ino`s, sizes,
    mtimes) are the same → the folder entry is renamed/moved; its files keep their entries.
  - what's left: new → entries; gone → entries removed (`del`, subtree first), `held` deleted.
- **Pause first**: before a batch or a reconcile, the linked folder's root is `stat`ed; missing or
  unreadable → paused (nothing done), checked again every 10 s (**Tibo**: a vanished linked folder is
  paused, never read as deleted). A watcher error (root gone, events dropped) → close it; on resume a
  full rescan of that folder (FR-012).
- **Start**: the first pass is v1's rescan of each linked folder with these rules (FR-011): renames
  made while closed are found the same way (size + mtime), so nothing is re-uploaded.
- **Bare on Linux**: libuv's recursive flag works on Windows and macOS only; on Linux, Bare would see
  the root folder's events only. Desktops run the shell on Node (Node watches recursively on Linux).
  A later story (spec, later story 7: a Pear desktop app on Bare), not 002.
- **Checked 2026-10-28** (Windows, Node and Bare): a file written in a new sub-folder gives `rename`
  and `change` events for `sub` and `sub\x.txt` (paths relative to the root, `\` separators).
- **Rejected**: periodic full rescans (slow on 10,000 files, misses the 10 s target); chokidar (a
  dependency, not Holepunch-stack, not on Bare).

## R8. Ignore rules: own small matcher

- **Decision** (**Tibo**): fixed list `*.part`, `.swarmfs-trash`, `Thumbs.db`, `desktop.ini`,
  `.DS_Store`, `~$*`, `*.tmp`, `*.swp`; plus `.swarmfsignore` at the linked folder's root: `#` comments,
  blank lines, `*` (within a name), `**` (any folders), trailing `/` (folders only); a pattern with no
  `/` (other than a trailing one) matches a name at any depth, one with `/` matches from the root.
  Compiled to one regular expression per pattern (~30 lines, `lib/ignore.js`, unit-tested).
- `.swarmfsignore` is a normal entry, so it syncs. Read again when it changes. Ignored paths are never
  added and never fetched; entries already in the space for newly ignored paths are left alone.
- **Rejected**: `ignore`/`minimatch` packages (a dependency for 30 lines; constitution IV).

## R9. Writing into a linked folder: the incoming folder and the trash

- **Decision**: every fetch into a linked folder downloads to
  `<linked>/.swarmfs-trash/.incoming/<root>` (swarmwire writes `<root>.part` first; ignored, same disk,
  resumable by name). When complete: the target path is checked again (a file there not matching what
  SwarmFS recorded → R4's conflict rule); the old file, if any, is moved to the trash; the new one is
  renamed into place; `held` written. Nothing ever sits half-written under a real name, and swarmwire
  never renames over a file.
- **Trash**: `<linked>/.swarmfs-trash/<YYYY-MM-DD HH-MM-SS>/<relative path>` (one folder per second
  of trashing; a file trashed twice keeps both). A move is a rename on the same disk (no space needed).
  Its `held` is deleted first (FR-025: never served). `trash` lists every linked folder's trash (not
  `.incoming`); `trash empty` removes the dated folders — the only bytes SwarmFS ever deletes, on the
  person's command (**Tibo**; constitution 1.1.0).
- **Content already held here at another path** (spec 001: never downloaded again): copied from that
  path into `.incoming/<root>` (`fs.copyFile`), checked unchanged (size + mtime as `localPath` does)
  after, then placed like a fetch. 0 bytes transferred. A copy in the person's own folder, asked for by
  linking it, is not a store (constitution I). **Tibo, 2026-10-28: yes; no hard links.**
- **Case-insensitive disks** (lead review 2026-10-28): `A.jpg` and `a.jpg` are one path on Windows and
  macOS (default). Once per linked folder, SwarmFS `stat`s its root with the case changed: found → the
  disk is case-insensitive, and names are compared case-insensitively when placing: a second entry
  whose name differs only by case is placed under a conflict-copy name, like two entries of the same
  name. (Checked on this PC: the root path upper-cased is found.)
- **Names not valid on this disk** (Windows: `<>:"|?*`, trailing dot or space, `CON`, `NUL`…): not
  fetched, an event says so; the entry stays.
- **Rejected**: downloading straight to the target (swarmwire's rename would replace a file the
  person just made there); a trash outside the linked folder (a move across disks copies bytes).

## R13. The mass-delete guard

- **Decision** (**Tibo**, lead review 2026-10-28): before applying a local batch's removals, count the
  linked folder's held files and the batch's gone ones. More than half and more than 100 → none of the
  batch's removals is applied; the folder is paused with reason `mass-delete` (apart from `missing`);
  `sync` event `{ action: 'paused', reason: 'mass-delete', count }`. While so paused, nothing is done
  in that folder (no remote pass either); every 10 s and on watch events the count is taken again:
  below the threshold (files restored) → resumed, the batch processed normally (what is still gone is
  removed: a small delete). `sfs.confirm(path)` applies the pending removals and resumes. The shell:
  `confirm <folder>`.
- **Why "and more than 100"**: a small folder emptied on purpose (80 of 100 files) shouldn't need a
  confirmation; a large one losing most files at once is the failure Tibo wants stopped.
- Counted on files only (folders follow their files).

## R10. Free-space floor

- **Decision** (**Tibo**): before each fetch, `statfs(linked root)` (Node `fs.promises.statfs`, bare-fs
  `statfs`): free = `bavail × bsize`, disk = `blocks × bsize`; floor = max(5 GB, 5 % of disk). A fetch
  starts only if free − size ≥ floor; while fetching, checked on `progress` (at most once a second) and
  stopped (resumable) below it. One `low-space` event per linked folder until space is back.
- **This PC** (2026-10-28): 57 GB free on a 1 TB disk → floor 50 GB: the shell fetches only while more
  than 50 GB stay free. Tests pass `minFree: 0`.
- **Tests**: `SwarmFS.open(dir, { minFree })` overrides the floor in bytes (a test can't fill a disk;
  the later "settings" story uses the same option). This worker's decision.

## R11. Telling the person: one `sync` event

- **Decision**: `sfs.on('sync', (e) => {})`, `e = { action, space, path, … }` with `action` one of
  `added`, `updated`, `removed`, `renamed`, `moved`, `fetched`, `trashed`, `conflict`, `paused`,
  `resumed`, `low-space`, `skipped` (name not valid here), `error`. The shell prints one line each.
- **Why**: one event to wire, one shape to test.

## R12. What hypergraph and swarmwire must do (and the gaps)

- hypergraph: `space.on('change')`, `space.on('peers')`, `query(...).latest`, `put`/`edit`/`del`,
  `hg.personal` (`held`, `added`), type versions (append `base`). Gaps: **H14** (what changed),
  **H15** (a delete's stamp; deleted vs not held). Neither blocks: shortcuts named above.
- swarmwire: `download(link, path, { announce: false })` to the incoming path, `stop()`, `progress`,
  `stalled` (as v1), `resolve` (as v1). No new request.
- One person's devices only (shared workspaces later need `resolve` scoped by peer and space).
