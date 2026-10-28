---
description: "Tasks for SwarmFS v1 — personal sync across two devices of one identity"
---

# Tasks: SwarmFS v1 — personal sync

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/api.md](contracts/api.md)

**Tests**: test-first (constitution II): each story's test file is written and seen failing before
its implementation. Every test runs on Node and Bare (constitution III).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency)
- Paths are from the repository root (plan.md, Project Structure)

---

## Phase 1: Setup

- [X] T001 Add devDependencies to `package.json`: `brittle` (as swarmwire/hypergraph use it, with
  `brittle-node`/`brittle-bare`), `bare`, `bare-fs`, `bare-path`, `bare-os`, `bare-process`, `b4a`,
  `hyperdht` pinned `6.32.0` (testnet; also as `overrides` like hypergraph); run `npm install`; check
  `hypergraph` and `swarmwire-lib` are junctions (`cmd //c "dir /AL node_modules"`), not copies
- [X] T002 [P] `index.js` exporting `SwarmFS` and `SwarmFSError`; empty `lib/` files from plan.md
- [X] T003 [P] `test/helpers.js`: tmp dir per test (removed at teardown), a local DHT per test from
  `hyperdht/testnet` (loopback), `device(t, label, opts)` opening a `SwarmFS`, `pair(t)` giving a
  paired `{ pc, phone }`; plus a smoke test `test/smoke.test.js` (`SwarmFS.open` + `close`), green with
  `npm test` and `npm run test:bare`

## Phase 2: Foundational

- [X] T004 `lib/types.js`: the four types and two rules of data-model.md; a unit test
  `test/types.test.js` that `Hypergraph.open` accepts them and the rules refuse a bad name and a
  digest not matching `src` (RULE_REJECTED)
- [X] T005 `lib/swarmfs.js`: `SwarmFS.open(dir, opts)` → `Hypergraph.open(dir, { types, rules,
  password, joinCode, deviceName, bootstrap })`, `hg.connectToSwarm()`; `hg`, `device`, `close()`;
  `SwarmFSError` with `code`

**Checkpoint**: an instance opens and closes on Node and Bare.

---

## Phase 3: User Story 1 — Add files in place and see the tree (P1) 🎯 MVP

**Goal**: one device: create a space, add a folder in place, list the tree.
**Independent Test**: `test/tree.test.js`, no second device.

- [X] T006 [US1] Write `test/tree.test.js` (failing): story 1 scenarios 1–3 — tree of `photos/` with a
  nested folder; a duplicate file is one hash held at two paths; after `add`, no new file anywhere
  outside the instance folder and the added files' bytes and mtimes unchanged; `INVALID_NAME`
- [X] T007 [US1] `lib/swarmfs.js`: `createSpace(name)` (`hg.createSpace({ name, private: true })`),
  `spaces()`, `space(key)` returning a `Drive`
- [X] T008 [US1] `lib/holdings.js`: `hash(path)` (`ContentSource.open` → `{ root, size }`, `close()`);
  `recordHeld({ root, path, size, mtime, space, entry })` and `recordAdded()` (`hg.personal.put`);
  `localPath(root)` (`hg.personal.query('held').where({ root }).fromDevice(me)` + stat check)
- [X] T009 [US1] `lib/drive.js`: `add(path, { parent })` (walk with `fs`; `put('folder')`,
  `put('file')` with the ref of research R2; holdings via T008), `list(folder, { limit, after,
  timeout })` (`query('folder'|'file').where({ parent }).latest()`, folders first then by name),
  `get(id)`, `top`; T006 green on Node and Bare

**Checkpoint**: story 1 works alone.

---

## Phase 4: User Story 2 — A second device sees everything (P1)

**Goal**: pair a phone; it lists the tree and who holds what, also with the PC offline.
**Independent Test**: `test/devices.test.js`, two devices on the local DHT.

- [X] T010 [US2] Write `test/devices.test.js` (failing): story 2 scenarios 1–4 — pair by code (wrong
  and reused codes refused); phone lists the space and the tree within 10 s (SC-002); holders show
  `pc` online; PC closed → entries still listed, `online: false`; a stranger's `space(key)` is
  `NOT_FOUND`
- [X] T011 [US2] `lib/swarmfs.js`: `addDevice({ password })` (`hg.addDevice`), `devices()`
  (`hg.devices()` + `online` from the files spaces' `peers()`); spaces re-read after open (H2 pending:
  test documents that a space created on the other device appears after reopening)
- [X] T012 [US2] `lib/drive.js`: `holders` in `list`/`get` — `hg.personal.query('held').where({ root })`
  → `record.device`, names from `hg.devices()`, `online` from `space.peers()`, `path` only for this
  device; `on('change')` from the space's `change` event; T010 green on Node and Bare
- [X] T013 [US2] Check hypergraph request H4 (where + fromDevice) in these tests; record results in `specs/requests-to-hypergraph.md`

**Checkpoint**: v1's "see on the phone what the PC holds" works.

---

## Phase 5: User Story 3 — Fetch a file from the other device (P1)

Uses hypergraph H1, swarmwire S2, S5 and S7 (swarmwire c1e06d0, 2026-10-28): `test/fetch.test.js` and
the 100 MB test pass on Node and Bare.

**Goal**: fetch a file the PC holds, verified, resumable; nothing downloaded if held locally.
**Independent Test**: `test/fetch.test.js`, two devices.

- [X] T014 [US3] Write `test/fetch.test.js` (failing): story 3 scenarios 1–5 — bytes equal, phone
  listed as holder on both; held locally → `{ bytes: 0 }` and the existing path; existing target →
  `EXISTS`; PC offline → `NOT_AVAILABLE` at once; PC closed mid-fetch → `NOT_AVAILABLE`, nothing at
  the target path (only the `.part`), reopened → fetch again resumes and completes (shallow swarmwire
  window); a file changed on the PC after hashing → not served (`NOT_AVAILABLE` within
  `fetchTimeout`), never wrong bytes; no DHT topic joined for any file (the adapter's `join` is never
  called with an announce); the phone paired after the space was made gets the PC's member stream
  (hypergraph H5). A 100 MB case (SC-003) in a separate `slow` test (`test/slow/`, `npm run test:slow`)
- [X] T015 [US3] `lib/transfer.js`: one `Swarmwire({ swarm: adapter, resolve })`; the adapter:
  `join()` → `{ destroy () {} }`, `connection` re-emits each files space's member streams (H1) once
  per stream; `resolve` = own `held` lookup of T008 with a size/mtime check (S2)
- [X] T016 [US3] `lib/drive.js`: `fetch(id, path)` per research R8 (`localPath` → refuse existing path
  → online holders → `download({ root, size }, path, { announce: false })`; `stalled` or no `progress`
  for `fetchTimeout` → `stop()` → `NOT_AVAILABLE`; done → `recordHeld`); T014 green on Node and Bare

**Checkpoint**: v1's promise complete: see and fetch.

---

## Phase 6: User Story 4 — Keep the tree up to date (P2)

**Goal**: rescan follows the disk; rename, move, remove entries; local files never touched.
**Independent Test**: `test/changes.test.js`, two devices.

- [X] T017 [US4] Write `test/changes.test.js` (failing): story 4 scenarios 1–5 and the edge cases
  "both offline then reconnect", "two renames offline → same winner on both", "folder removed while the
  other adds into it → moved to the top at that device's rescan"; every local file byte- and
  mtime-identical after `remove`/`rename`/`move` (SC-006); checks hypergraph H3 (moves leave the old
  folder's listing)
- [X] T018 [US4] `lib/drive.js`: `rename(id, name)`, `move(id, folder)` (`edit`), `remove(id)` (subtree
  deepest first, `del`)
- [X] T019 [US4] `lib/holdings.js` + `lib/swarmfs.js`: `rescan()` per data-model.md transitions (own
  `held`/`added` pages via `fromDevice(me)`; rehash changed files; `del` missing held; new files in added
  folders; orphans to the top); run once in `open`; T017 green on Node and Bare

---

## Phase 7: User Story 5 — Try it on two machines (P3)

- [X] T020 [US5] Write `test/cli.test.js` (failing): two CLI processes (`process.execPath`, so it also
  runs on Bare) on the local DHT: `init`, `create`, `add`, `pair` / `join`, `ls`, `get`
- [X] T021 [US5] `bin/swarmfs.js`: the commands of contracts/api.md over the library only; print with
  `console.log` (swarmwire's Bare lesson); `bin` in `package.json`; T020 green

---

## Phase 8: Polish

- [X] T022 [P] SC-001: a 1,000-file add test (no content written; listable right after); note time
  (2026-10-28: 1,000 files of 1 KB added and listed in ~2.5 s, Node and Bare, this Windows PC)
- [X] T023 [P] README: what works, the quickstart, Node/Bare commands; `CLAUDE.md` current
- [X] T024 Re-check SC-008 by reading `lib/`: only hypergraph and swarmwire calls for network, crypto,
  replication and transfer; update `specs/requests-to-*.md` with anything found while building

## Dependencies

- Setup (T001–T003) → Foundational (T004–T005) → stories.
- US1 → US2 (holders need entries) → US3 (needs hypergraph H1, swarmwire S2, S5) → US4 (rescan edits what US1–US3
  write) → US5 (CLI over all). US4's T018 (rename/move/remove) only needs US1 and can start after it.
- Within a story: test task first, seen failing; then implementation.

## Parallel opportunities

- T002 and T003; T022 and T023.
- T018 alongside US3 if a second session works on `drive.js`'s other half (same file: one writer at a
  time — prefer sequential).

---

## Phase 9: Lead review 2026-10-28 (reopen cost, the CLI as a shell, a password)

- [X] T025 SC-009: test (failing first: > 120 s) paired PC + phone, 1,000 files, both closed, the PC
  reopened alone in < 5 s; `rescan` reads entries by the space, not per file (data-model.md).
  2026-10-28, this Windows PC: ~0.5 s on Node and Bare.
