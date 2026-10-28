---
description: "Tasks for SwarmFS 002 — always on: linked folders that sync on their own"
---

# Tasks: SwarmFS 002 — always on

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/api.md](contracts/api.md), [quickstart.md](quickstart.md)

**Tests**: test-first (constitution II): each story's test file is written and seen failing before its
code. Every test runs on Node and on Bare (constitution III): `npm run test:all` green after each story.
Safety (SC-006) in every two-device test: hash every file before; after, each one is either at its
place, or byte-identical in a `.swarmfs-trash/<time>/` folder (a helper, T003).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- Paths are from the repository root (plan.md, Project Structure)

---

## Phase 1: Setup

- [X] T001 Check `fs.watch(dir, { recursive: true })` and `fs.promises.statfs` on Node and bare-fs
  (`watch` with `recursive`, `statfs`) through the `imports` map on this Windows PC: a scratch test in
  `test/smoke.test.js` (one event for a file written in a sub-folder; `statfs` gives `bavail`, `bsize`,
  `blocks`); green on Node and Bare. If bare-fs differs (event names, `statfs` fields), note it in
  research.md R7/R10 before going on
- [X] T002 [P] Empty `lib/sync.js`, `lib/watch.js`, `lib/ignore.js`, `lib/trash.js` (plan.md structure)
- [X] T003 [P] `test/helpers.js`: `linkedPair(t)` (paired `{ pc, laptop }`, both `sync()`ed, a folder
  added on the PC and linked on the laptop), `until(sfs, predicate, ms)` (waits on `sync` events),
  `snapshot(dir)` / `assertNothingLost(t, before, dirs)` (SC-006: every file hashed before is at its
  place or byte-identical in a trash; no file outside linked folders changed)

## Phase 2: Foundational

- [X] T004 `test/types.test.js` (failing first) then `lib/types.js`: append `base: 'string'` to `file`
  (last field; "hex roots separated by one space, newest first, at most 16"); rule `swarmfs/base-v1`:
  "`base` absent, or 1–16 roots of 64 hex characters separated by single spaces"; a v1 record (no
  `base`) still accepted; an instance folder made by v1's types opens with the new ones (no
  `INCOMPATIBLE_TYPES`)
- [X] T005 [P] `test/ignore.test.js` (failing first) then `lib/ignore.js`: `ignored(rules, relPath,
  isDir)`; the fixed list (`*.part`, `.swarmfs-trash`, `Thumbs.db`, `desktop.ini`, `.DS_Store`, `~$*`,
  `*.tmp`, `*.swp`) and `.swarmfsignore` lines (research R8: `#`, blank, `*`, `**`, trailing `/`, no-`/`
  patterns match a name at any depth, `/` patterns from the root); `\` paths on Windows matched as `/`
- [X] T006 [P] `lib/trash.js` with a unit test `test/trash.test.js` (failing first): `toTrash(linked,
  absPath)` (rename to `<linked>/.swarmfs-trash/<YYYY-MM-DD HH-MM-SS>/<relative path>`, parents made;
  never across disks), `listTrash(linked)` (`{ path, size, trashed }`, `.incoming` skipped),
  `emptyTrash(linked)` → `{ files, bytes }`, `floor(linked, minFree)` and `free(linked)` from `statfs`
  (floor = max(5 GB, 5 % of `blocks × bsize`) unless `minFree`)
- [X] T007 `lib/holdings.js`: folder `held` (`root: ''`, `size: 0`, `mtime: 0`) kept by rescan (today it
  deletes any `held` whose path isn't a file); `localPath` and holders skip `root: ''`; `edit` of
  content passes `base` (data-model.md). Failing first in `test/changes.test.js`: after `rescan()` a
  folder `held` (`root: ''`) survives, and a file edited on disk gets `base` = its old root; spec 001's
  tests stay green

**Checkpoint**: types, ignore, trash and floor work alone; 001's 24 tests green on Node and Bare.

---

## Phase 3: User Story 1 — Edits on disk reach the space by themselves (P1) 🎯 MVP

**Goal**: one device: `sync()` follows a linked folder and single added files.
**Independent Test**: `test/watch.test.js`, one device, no rescan called.

- [X] T008 [US1] Write `test/watch.test.js` (failing): story 1 scenarios 1–7 — create (entry within 5 s
  of the last write), a file written for 10 s hashed once (one `added` event, SC-005), save (new content,
  `base` = old root), rename and move (same entry id, `renamed`/`moved`), delete (entry gone,
  `removed`), the ignore list and a `.swarmfsignore` with `build/` and `*.log` (0 entries, SC-010; the
  `.swarmfsignore` itself an entry), a single added file edited (entry updated) and deleted (entry
  kept); a folder renamed (folder entry renamed, file entries unchanged, nothing hashed: no `updated`);
  a `.swarmfsignore` line added later applies to new files only (entries already there stay);
  one file deleted and a different one of the same size and mtime created in one batch → two
  entries with the right contents (not a rename: research R7's `ino`); changes made while closed found
  at `sync()` start (FR-011: a rename isn't re-hashed); `add` of a path
  inside a linked folder → `EXISTS`
- [X] T009 [US1] `lib/watch.js`: a recursive watcher per linked folder root and a non-recursive one per
  single added file's folder; dirty relative paths (a folder: walked); every 500 ms the paths whose size
  and mtime held for 2 s → one batch to a callback; ignored paths dropped (T005); `error` → close, ask
  for a full rescan (FR-012)
- [X] T010 [US1] `lib/holdings.js`: rescan becomes the local pass of data-model.md over a set of paths
  (all, or a batch): moves first (size + mtime + same name or same folder; else hash equal to a gone
  root), folder moves (same files), new (put + `held`), changed (R4: `C = H` → `edit(content, base)`),
  gone (`del` subtree, `held` deleted); single added files keep v1's rule; returns the actions for events
- [X] T011 [US1] `lib/swarmfs.js` + `lib/sync.js`: `sync()` (first pass = full local pass per linked
  folder, then watchers from T009 feeding the local pass, serialized per linked folder), `'sync'`
  events, stop on `close()`; `lib/drive.js`: `add` refuses a path inside or containing a linked folder
  (`EXISTS`); T008 green on Node and Bare

**Checkpoint**: story 1 alone: a running shell keeps the space following the disk.

---

## Phase 4: User Story 2 — Missing files arrive by themselves (P1)

**Goal**: entries of a linked space folder with no local file are fetched (or copied) into place.
**Independent Test**: `test/autofetch.test.js`, two devices.

- [X] T012 [US2] Write `test/autofetch.test.js` (failing): story 2 scenarios 1–5 — a 1 MB file added on
  the PC is on the laptop's disk, byte-identical, held by both, within 10 s (SC-002); holder offline →
  fetched once it reopens, no command; content already held at another path → copied, 0 bytes
  transferred; `minFree` above free space → 0 fetched, one `low-space` event with `free` and `floor`,
  nothing under the file's name; `minFree` lowered (reopen) → fetched within 15 s (SC-008); PC closed
  mid-fetch → nothing at the target, completes after it reopens; a name not valid on Windows (`a:b.txt`
  put by the PC's library) → `skipped`, entry kept
- [X] T013 [US2] `lib/sync.js`: the remote pass of data-model.md, steps 4–5 (folders made + folder
  `held`; file entries without `held`: local file at the path → same root = `held`; none → due), re-run
  on the space's `change` (debounced 500 ms; shortcut: full re-read until hypergraph H14), on `peers`,
  and every 10 s
- [X] T014 [US2] `lib/sync.js`: due fetches — `localPath` → `fs.copyFile` to `.incoming/<root>`, else
  `transfer.download({ root, size }, '<linked>/.swarmfs-trash/.incoming/<root>', { announce: false })`
  with 001's `stalled`/no-progress stop; floor checked before (free − size ≥ floor) and on `progress`
  (≤ once a second, stop below); done → place (target checked again; old file to trash), `held`,
  `fetched`; invalid local names → `skipped`; T012 green on Node and Bare

**Checkpoint**: v1's promise without commands: files appear on the other device.

---

## Phase 5: User Story 3 — Changes made elsewhere reach the disk, safely (P1)

**Goal**: renames, moves, edits, removals from another device applied locally; replaced and removed
files to the trash; `trash()` and `emptyTrash()`.
**Independent Test**: `test/mirror.test.js`, two devices.

- [X] T015 [US3] Write `test/mirror.test.js` (failing): story 3 scenarios 1–5 — rename and move on the PC
  → laptop renames/moves within 10 s, 0 bytes transferred (SC-003; also a folder of 100 files); edit →
  new version in place, old one byte-identical in the laptop's trash; file and folder deleted → in the
  trash with everything in it; `trash()` lists folder, path, size, time; `emptyTrash()` →
  `{ files, bytes }` and the trash empty; a file moved back out of the trash → an entry again; an entry
  moved to a folder not linked here → local file trashed; a trashed file is no longer listed as held
  (FR-025); the laptop reopened with the PC offline → nothing trashed, no entry removed (FR-023); a
  file the laptop fetched with `get` outside any linked folder, edited on the PC → the laptop's copy
  untouched (FR-008); `assertNothingLost` (SC-006) after each
- [X] T016 [US3] `lib/sync.js`: remote pass steps 1–3 (moves/renames of local files and folders, target
  taken → trashed first; removals only from a complete read (FR-023): local unchanged → trash, changed →
  put again (FR-019); content `C ≠ H`, `H ∈ base(C)` → fetch then trash the old and place)
- [X] T017 [US3] `lib/swarmfs.js`: `trash()` and `emptyTrash()` over every linked folder (paused ones
  skipped) using T006; `held` deleted before any file is trashed (FR-025); T015 green on Node and Bare

**Checkpoint**: both directions work; nothing is destroyed.

---

## Phase 6: User Story 6 — An unplugged folder is paused (P2)

Built right after story 3 because it guards their removals; the guard itself (`stat` the root before any
pass) goes into T011/T013 — this phase proves it and adds resume.

- [X] T018 [US6] Write `test/pause.test.js` (failing): story 6 scenarios 1–4 — the laptop's linked root
  renamed away → `paused`, 0 entries removed on both devices, 0 files trashed (SC-007); the PC adds
  files meanwhile → nothing written at the laptop's path (no folder recreated); renamed back → `resumed`
  within 15 s, catching up both ways; `sync()` started with the root missing → starts paused
- [X] T019 [US6] `lib/sync.js`: paused state per linked folder (root `stat` before each pass; a watcher
  error with the root gone → paused), the 10 s check, resume = full local pass then remote pass; events;
  T018 green on Node and Bare

---

- [X] T029 [US6] Extend `test/pause.test.js` (failing): story 6 scenarios 5–6 — 600 of 1,000 files of a
  linked folder deleted (root still there) → 0 entries removed on both devices, `paused` with reason
  `mass-delete` and `count: 600` (SC-012); `sfs.confirm(path)` → the 600 removed on both within 15 s;
  again, but the files restored → `resumed`, nothing removed; 80 of 100 and 150 of 1,000 deleted →
  removed as usual
- [X] T030 [US6] `lib/sync.js`: the mass-delete check (research R13) before a local batch's removals;
  `confirm(path)` in `lib/swarmfs.js`; `links()` gives the reason; T029 green on Node and Bare

## Phase 7: User Story 4 — Link a space folder on another device (P2)

- [X] T020 [US4] Write `test/link.test.js` (failing): story 4 scenarios 1–6 — `drive.link(folder, path)`
  into an empty path (fills); into a path with the same `b.jpg` (held, 0 bytes, not renamed), a different
  `a.jpg` (becomes `a (laptop's copy).jpg`, an entry on both devices; the space's `a.jpg` fetched), an
  extra local file (added); `drive.link(drive.top, path)`; `sfs.unlink(path)` (no more fetch, rename or
  follow; no file or entry removed; `.incoming` gone); overlap and already-linked → `EXISTS`; `links()`, also after a reopen (FR-005); two entries of
  one name in a folder (put by both devices while apart) → the second placed as a conflict-copy name;
  on this (case-insensitive) disk, entries `A.jpg` and `a.jpg` → one of them placed as a conflict-copy
  name, both files there (research R9)
- [X] T021 [US4] `lib/drive.js` `link()` (writes `added`; checks per contracts/api.md) and
  `lib/swarmfs.js` `unlink()`, `links()`; case-insensitivity detected once per linked folder (`stat` of
  the root with its case changed) and used when placing; `lib/sync.js`: remote pass step 5's "different content at the
  path" → conflict copy (data-model.md) then fetch; T020 green on Node and Bare

---

## Phase 8: User Story 5 — Two devices edit one file: both kept (P2)

- [X] T022 [US5] Write `test/conflict.test.js` (failing): story 5 scenarios 1–5 — both devices closed,
  the file edited differently in each linked folder, both reopened and `sync()`ed → within 20 s both
  have `report.docx` and `report (<loser>'s copy).docx`, same contents on both, nothing in any trash
  (SC-009); a non-concurrent edit chain (PC edits twice while the laptop is closed) → no copy
  (`base` history, research R4); a taken copy name → `… copy 2`; rename on one + content edit on the
  other → no content lost; delete on one while the other's edit is unrecorded → re-added; the same file renamed differently on
  each → both local files end at the winning name (FR-020)
- [X] T023 [US5] `lib/sync.js` + `lib/holdings.js`: R4's rules (local pass: changed file with `C ≠ H` →
  conflict copy; remote pass: `H ∉ base(C)` → conflict copy of `H`); copy naming
  `name (<device name>'s copy[ N]).ext`; `conflict` event; T022 green on Node and Bare

---

## Phase 9: User Story 7 — The shell does it all (P3)

- [ ] T024 [US7] Extend `test/cli.test.js` (failing): two shells; `add` a folder on the PC, `link` it on
  the laptop shell; a file written on the PC → a `fetched` line on the laptop and the file there; `links`;
  `unlink`; `trash` lists; `trash empty` asks, `no` keeps, `yes` empties; a one-shot `ls` doesn't sync
  (no `.incoming`, no fetch)
- [ ] T025 [US7] `bin/swarmfs.js`: the shell calls `sync()` and prints one line per `sync` event
  (contracts/api.md); commands `link`, `unlink`, `links`, `confirm`, `trash`, `trash empty` (confirmation
  on stdin);
  usage text; T024 green on Node and Bare

---

## Phase 10: Polish

- [ ] T026 [P] `test/slow/sync.test.js`: SC-001 (10,000 files linked, held, unchanged: `sync()` first pass
  done < 10 s) and SC-004 (1,000 new 1 KB files copied in → all on the other device < 60 s); note the
  times in this file and research.md R6 (H14's cost)
- [ ] T027 [P] README (linked folders, trash, the shell's lines, quickstart), `CLAUDE.md` state,
  spec 001 contract pointer to 002's additions
- [ ] T028 Re-check SC-011 by reading `lib/`: no networking, replication, crypto or transfer code;
  `shortcut:` comments for H14/H15; FR-012 (dropped events → rescan) and FR-017's stop mid-fetch
  checked by reading (hard to provoke in a test); update `specs/requests-to-*.md` with anything found while building

## Dependencies

- T029–T030 (lead review 2026-10-28) belong to story 6; numbered last to keep earlier ids stable.

- Setup (T001–T003) → Foundational (T004–T007) → stories.
- US1 → US2 (the remote pass uses US1's `sync()` loop) → US3 (same file, `lib/sync.js`) → US6 (proves
  the pause guard built into US1–US3) → US4 → US5 (conflict copies reuse US4's copy naming) → US7.
- Within a story: test task first, seen failing; then implementation.
- `lib/sync.js` is written by US2, US3, US6, US4, US5 in turn: one writer at a time.

## Parallel opportunities

- T002 and T003; T005 and T006 (T004 and T007 touch `types.js` / `holdings.js`: separate, also
  parallel); T026 and T027.
- Stories are sequential (they share `lib/sync.js` and `lib/holdings.js`).

## Implementation strategy

- MVP: Phases 1–3 (story 1): the space follows one device's disk with no `rescan`.
- Then stories 2 and 3 (the full two-way sync) and 6 (its safety net) before showing it to Tibo on two
  machines; then 4, 5, 7.
- Measure SC-001/SC-002 early (after US2) with the slow test's 10,000 files: if H14's full re-read
  misses 10 s, report before building on it.
