---
description: "Tasks for SwarmFS 004 — sites"
---

# Tasks: SwarmFS 004 — sites

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/api.md](contracts/api.md)

**Tests**: test-first (constitution II), each test file seen failing before its code; Node and Bare
(`node scripts/test-runner.js`, `--bare`, `HG_TEST_TMP` on the SSD), suites one after another.
Perf: `npm run perf` before (baseline in `perf/history.jsonl`) and after, site scenario extended.

## Phase 1: Setup

- [X] T001 Probe hypergraph (`specs/repro-h22-site-roles.mjs`); file H6 result, H22, H23 in
  `specs/requests-to-hypergraph.md`
- [X] T002 Constitution 1.2.0: sites' app storage and inline bytes (principle I)

## Phase 2: Foundational

- [ ] T003 `lib/types.js`: `file.data` appended; `upload`, `site` types; rules `inline-v1`,
  `upload-v1`; `INLINE_MAX`; `contentOf()` in `lib/holdings.js` (content + bytes if inlined)
- [ ] T004 `lib/members.js`: `reader` role in every setting; `publishName` skips sites

## Phase 3: Stories 1 + 2 — protected pages, read-only visitors (P1)

- [ ] T005 `test/site.test.js` (failing first): pages refused for an editor, his upload author-only,
  admin writes pages, reader reads and can't write, public site read by a stranger with the owner
  offline (from another visitor), a visit writes 0 records, reader invite in a private space
  `NOT_SUPPORTED`
- [ ] T006 `lib/site.js` Site; `sfs.createSite`, `sfs.site`, `sfs.visit`; `drive.invite({ role })`

## Phase 4: Story 3 — app storage (P1)

- [ ] T007 `test/app-storage.test.js` (failing first): read lands in app storage only, second read no
  transfer, eviction under the cap and read again, owner keeps an upload after its poster leaves,
  kept copy dropped when the upload is removed
- [ ] T008 app storage in `lib/swarmfs.js` / `lib/site.js`: `appStorageMax`, LRU eviction, kept
  uploads in `sync()`; app storage out of `rescanSingles` and the singles watcher

## Phase 5: Story 4 — small files inline (P2)

- [ ] T009 `test/inline.test.js` (failing first): small page carries bytes, big doesn't, read with no
  holder online, edit grows past the limit / shrinks back, wrong bytes refused (`RULE_REJECTED`),
  files spaces inline nothing
- [ ] T010 inline in `lib/holdings.js` (`addFile`), `lib/sync.js` (add, edit, conflict copy, a due
  inline file written from its record), `lib/drive.js` (`fetch`)

## Phase 6: Polish

- [ ] T011 `perf/scenarios/site.mjs`: the site variant (`site.app.*`); `npm run perf` after
- [ ] T012 README, CLAUDE.md state line; both suites green
