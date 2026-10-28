# Implementation Plan: SwarmFS 002 — always on: linked folders that sync on their own

**Branch**: `002-always-on` | **Date**: 2026-10-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-always-on/spec.md`

## Summary

`sfs.sync()` keeps every linked folder in step with its space folder, both ways, for as long as the
shell runs. Local → space: a recursive watcher per linked folder, paths settled 2 s, one batch (renames
found by size + mtime, then hash), v1's add/edit/del. Space → local: on the space's `change`, re-read
its entries and reconcile with this device's `held` records: rename/move local files, fetch missing
and newer content through an ignored `.incoming` folder, trash what is replaced or removed. Conflicts
by a `base` field appended to `file` (the contents an edit replaced). A missing root pauses its linked
folder. Fetches stop at a free-space floor. No new record type: v1's `added` is the linked folder,
`held` also marks folders. Reasons: [research.md](research.md); types: [data-model.md](data-model.md);
API: [contracts/api.md](contracts/api.md).

## Technical Context

**Language/Version**: JavaScript, ESM, no build step; Node ≥ 20 and Bare ≥ 1.27 (as 001)
**Primary Dependencies**: `hypergraph` (`hypergraph/next`), `swarmwire-lib`, `b4a`, `bare-fs`/`bare-path`/
`bare-os`/`bare-process` via `imports` — no new dependency (`fs.watch` and `statfs` exist in Node's `fs`
and bare-fs 4.8)
**Storage**: none of our own; records in hypergraph; trash and `.incoming` inside each linked folder
**Testing**: `brittle` on Node and Bare, local DHT (`hyperdht/testnet`), as 001; slow tests in `test/slow/`
**Target Platform**: desktops (Windows, macOS, Linux) running the shell on Node; library + tests also on
Bare (recursive watching on Bare: Windows and macOS only — research R7)
**Project Type**: library + thin CLI
**Performance Goals**: SC-001 (10,000-file folder starts in < 10 s), SC-002 (1 MB edit on the other disk
in < 10 s), SC-003 (rename in < 10 s, 0 bytes), SC-004 (1,000 files in < 60 s)
**Constraints**: nothing destroyed (trash); nothing written outside linked folders; paused never read as
deleted; free-space floor; removals only from a complete read
**Scale/Scope**: one person, 2–3 desktops, linked folders of tens of thousands of files

## Constitution Check

*Gate before research, re-checked after design (constitution 1.1.0): passes.*

- **I. Bytes stay where they are (1.1.0)**: no content copied into any store; inside linked folders
  SwarmFS renames, moves and replaces files, every replaced or removed one moved to that folder's
  `.swarmfs-trash` first (R9); fetches land in `.swarmfs-trash/.incoming` then are renamed (no partial
  file under a real name, no rename over a file); outside linked folders nothing is touched (single
  added files: edits followed, remote changes never applied; FR-008); bytes deleted only by
  `emptyTrash()`; a paused folder changes nothing (R7). A hash held locally isn't downloaded again: a
  linked folder wanting content held at another local path gets a local copy (via `.incoming`, then
  placed) — a file the person asked for in their own folder, not a store, cache or core (spec story 2
  scenario 3; research R9). ✅
- **II. Test-first through the public API**: a scenario test file per story, written first, through
  `sync()`, `link`, `unlink`, `trash`, events; two real devices on a local DHT; safety asserted by
  hashing every trashed file (SC-006). ✅
- **III. Node and Bare**: `fs.watch`/`statfs` through the `imports` map (bare-fs has both); the suite
  runs on both on this Windows PC; the Linux-on-Bare watch limit is documented, not worked around. ✅
- **IV. Compose, don't reimplement**: hypergraph for records and change events, swarmwire for every byte
  moved; SwarmFS adds watching, ignore matching and file placement (file-system work, not networking,
  replication, crypto or transfer). Gaps filed: H14 (what changed), H15 (a delete's stamp); no
  workaround beyond the documented re-read (marked `shortcut:`). ✅
- **V. Smallest complete design**: one appended field, one new rule, no new type; four new files of one
  job each; one option (`minFree`, needed by tests); later stories only outlined. `base` is decided once
  (16-root history, R4) because it can't change later. ✅

## Which hypergraph and swarmwire calls each part uses

| Part (file) | hypergraph (`hypergraph/next`) | swarmwire |
|---|---|---|
| Types (`lib/types.js`) | `file.base` appended; rule `swarmfs/base-v1` | — |
| Linked folders (`lib/drive.js` `link`, `lib/swarmfs.js` `unlink`, `links`) | `hg.personal.put/del('added')`, own `added` query (`fromDevice(me)`) | — |
| Local pass (`lib/holdings.js`: rescan with linked rules) | `space.put/edit/del`, `query('folder'\|'file').latest`, `hg.personal.put/del('held')` | `hashFile` (as 001) |
| Watching (`lib/watch.js`) | — | — (`fs.watch` recursive; `stat`) |
| Ignore (`lib/ignore.js`) | — | — |
| Remote pass, conflicts, placing (`lib/sync.js`) | `space.on('change')`, `space.on('peers')`, `space.peers()`, paged reads with `complete`, `edit`/`put` | `download({ root, size }, incomingPath, { announce: false })`, `progress`, `stalled`, `stop()` |
| Trash, floor (`lib/trash.js`) | — | — (`rename`, `rm`, `statfs`) |
| Serving | as 001 (`resolve` = own `held`) | as 001 |
| CLI (`bin/swarmfs.js`) | through the library only | — |

## Project Structure

### Documentation (this feature)

```text
specs/002-always-on/
├── spec.md  plan.md  research.md  data-model.md  quickstart.md
├── contracts/api.md
├── checklists/requirements.md
└── tasks.md
specs/requests-to-hypergraph.md      # + H14, H15
```

### Source Code (repository root)

```text
lib/
├── types.js        # + file.base, rule swarmfs/base-v1
├── swarmfs.js      # + sync(), unlink(), links(), trash(), emptyTrash(), minFree, 'sync' events
├── drive.js        # + link(); add() refuses overlaps
├── holdings.js     # rescan → the local pass with linked-folder rules (moves, deletes, base); folder held
├── sync.js         # NEW: per linked folder: pause, remote pass, conflicts, due fetches, placing
├── watch.js        # NEW: recursive watchers, dirty paths, 2 s settle, batches
├── ignore.js       # NEW: fixed list + .swarmfsignore matcher
├── trash.js        # NEW: move to trash, list, empty; free space and floor
└── transfer.js     # unchanged
bin/swarmfs.js      # sync() in the shell, event lines, link/unlink/links/trash/trash empty
test/
├── ignore.test.js      # matcher (unit)
├── watch.test.js       # story 1
├── autofetch.test.js   # story 2
├── mirror.test.js      # story 3 (+ trash)
├── link.test.js        # story 4
├── conflict.test.js    # story 5
├── pause.test.js       # story 6
├── cli.test.js         # + story 7
└── slow/sync.test.js   # SC-001 (10,000 files), SC-004 (1,000 files)
```

**Structure Decision**: the 001 layout plus four files with one job each (swarmwire's rule: past ~300
lines a file is two things). `holdings.js`' rescan grows into the local pass rather than a second copy
of the same walk.

## Sequencing and blockers

1. Types + ignore + trash (no network) → story 1 (one device) → story 2 → story 3 → story 6 (pause
   guards stories 1–3's removals: built with them, its tests after) → story 4 → story 5 → story 7.
2. Nothing blocks: H14 and H15 have shortcuts (full re-read on `change`; edit-vs-delete to the trash).
3. Risk: re-reading 10,000 entries on each `change` (H14) may miss SC-002 under bursts; measured in the
   slow test; the debounce (500 ms) bounds it to one re-read per burst.

## Complexity Tracking

None.
