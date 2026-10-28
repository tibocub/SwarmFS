# Implementation Plan: SwarmFS v1 — personal sync across two devices of one identity

**Branch**: `001-personal-sync` | **Date**: 2026-10-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-personal-sync/spec.md`

## Summary

A small ESM library over two dependencies. hypergraph's new core holds the tree (records `folder` and
`file` in a private files space) and the holdings (records `held` and `added` in the personal space,
private to the person's devices). swarmwire (`swarmwire-lib` 0.5.0, contract in its
`docs/contract.md`) moves the bytes over the files spaces' member connections, which hypergraph hands
to a tiny network adapter; a file is opened and hashed for serving only when a peer asks. SwarmFS itself has no networking, replication,
cryptography or transfer code. Reasons: [research.md](research.md); types:
[data-model.md](data-model.md); API: [contracts/api.md](contracts/api.md).

## Technical Context

**Language/Version**: JavaScript, ESM, no build step; Node ≥ 20 and Bare ≥ 1.27
**Primary Dependencies**: `hypergraph` (`file:../hypergraph`, `hypergraph/next`), `swarmwire-lib`
(`file:../swarmwire`, branch `main`), `b4a`, `bare-fs`/`bare-path`/`bare-os`/`bare-process` (via `imports`)
**Storage**: none of our own — hypergraph's instance folder (records); files stay where they are
**Testing**: `brittle` on Node (`brittle-node`) and Bare (`brittle-bare`); local DHT from
`hyperdht/testnet` (devDependency `hyperdht` pinned 6.32.0, as hypergraph)
**Target Platform**: desktop (Node) now; Bare for mobile later, tested from the first test
**Project Type**: library + thin CLI
**Performance Goals**: SC-001–SC-005 (1,000-file add, 10 s to see a paired device's tree, 100 MB fetch)
**Constraints**: no file content copied; no local file deleted, moved or overwritten; bounded fetches
**Scale/Scope**: one person, two devices, thousands of files per space

## Constitution Check

*Gate before research, re-checked after design: passes.*

- **I. Bytes stay where they are**: add hashes in place (swarmwire `ContentSource`), serving reads in
  place, records hold refs only; `remove` never touches disk; `fetch` refuses an existing path. ✅
- **II. Test-first through the public API**: every story is a scenario test file written first, real
  instances on a local DHT. ✅
- **III. Node and Bare**: `imports` map, `b4a`, no `process` global; `test:bare` from task T003. ✅
- **IV. Compose, don't reimplement**: all networking via hypergraph (`connectToSwarm`, member
  streams), all transfer via swarmwire; the adapter only forwards hypergraph's streams (no dialing,
  no protocol). Gaps listed in `specs/requests-to-*.md`, no workarounds. Story 3 waits for hypergraph
  H1 (member streams) and swarmwire S2 (`resolve`, no-announce mode, `.part` downloads), all being
  built. ✅
- **V. Smallest complete design**: 5 source files, no options beyond `fetchTimeout`; later stories
  only outlined. ✅

## Which hypergraph and swarmwire calls each part uses

| Part (file) | hypergraph (`hypergraph/next`) | swarmwire |
|---|---|---|
| Open, devices (`lib/swarmfs.js`) | `Hypergraph.open(dir, { types, rules, password, joinCode, deviceName, bootstrap })`, `hg.connectToSwarm()`, `hg.addDevice({ password })`, `hg.devices()`, `hg.close()` | `new Swarmwire({ swarm: adapter, resolve })` (S2), `destroy()` |
| Spaces (`lib/swarmfs.js`) | `hg.createSpace({ name, private: true })`, `hg.spaces()`, `hg.space(key)`, event for new spaces (H2) | — |
| Tree (`lib/drive.js`) | `space.put('folder' \| 'file', …)`, `space.edit(id, { name \| parent \| content })`, `space.del(id)`, `space.get(id)`, `space.query(type).where({ parent }).latest(n, { after, timeout })`, `space.on('change')` | — |
| Hashing (`lib/holdings.js`) | — | `ContentSource.open(path)` → `{ root, size }`, `close()` (an unstable export: request S6) |
| Holdings (`lib/holdings.js`) | `hg.personal.put('held' \| 'added', …)`, `hg.personal.del(id)`, `hg.personal.query('held').where({ root }).fromDevice(dev).latest()`, `.fromDevice(dev).latest(n, { after })` | — |
| Holders online (`lib/drive.js`) | `space.peers()` (device keys), `hg.devices()` (names) | — |
| Transport (`lib/transfer.js`) | each files space's proven-member streams (H1, being built) | the adapter given as `swarm`: `join()` → `{ destroy () {} }`, `on('connection', (stream, info))` re-emitting each stream once (contract §2, §3.6) |
| Serving (`lib/transfer.js`) | own `held` lookup (above) | `resolve(root) → path \| null`, opened and hashed only when asked, "unavailable" if the root differs; no-announce mode (S2, being built) |
| Fetch (`lib/drive.js`) | own `held` lookup; `held` of others + `space.peers()` | `download({ root, size }, path, { announce: false })` to a `.part` name (S5, being built), await; events `progress`, `stalled` (contract §5); `stop()` |
| Rescan (`lib/holdings.js`) | own `held`/`added` pages, one `folder` and one `file` query per space, `space.edit`, `put`/`del` | `ContentSource.open(path)` for changed files |
| CLI (`bin/swarmfs.js`) | through the library only | — |

## Project Structure

### Documentation (this feature)

```text
specs/001-personal-sync/
├── spec.md  plan.md  research.md  data-model.md  quickstart.md
├── contracts/api.md
├── checklists/requirements.md
└── tasks.md
specs/requests-to-hypergraph.md      # gaps found, for the lead conversation
specs/requests-to-swarmwire.md
```

### Source Code (repository root)

```text
index.js            # export { SwarmFS, SwarmFSError }
lib/
├── types.js        # record types and rules (data-model.md)
├── swarmfs.js      # SwarmFS: open, devices, spaces, rescan, close
├── drive.js        # a files space: add, list, get, rename, move, remove, fetch
├── holdings.js     # held/added records, hashing, local lookup, rescan
└── transfer.js     # one swarmwire node; the member-stream adapter; resolve
bin/swarmfs.js      # thin CLI (story 5)
test/
├── helpers.js      # tmp dirs, local DHT, two paired devices
├── tree.test.js        # story 1
├── devices.test.js     # story 2
├── fetch.test.js       # story 3
├── changes.test.js     # story 4
└── cli.test.js         # story 5
```

**Structure Decision**: one package, five small files with one job each (swarmwire's convention:
a file past ~300 lines is two things).

## Sequencing and blockers

1. Setup, types, story 1, story 2: buildable now (hypergraph only).
2. Story 3 (fetch) needs hypergraph H1 (member streams) and swarmwire S2 + S5 (`resolve`,
   no-announce mode, `.part` downloads), all being built (2026-10-27). Built after they land.
3. `sfs.on('spaces')` needs hypergraph H2; until then spaces are read at open and after
   `createSpace` (a space created on the other device appears after reopening — tested, documented).

## Complexity Tracking

None.
