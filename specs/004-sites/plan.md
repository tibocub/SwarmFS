# Implementation Plan: SwarmFS 004 — sites

**Branch**: `claude/site-prereqs-be3a52` | **Date**: 2026-11-06 | **Spec**: [spec.md](spec.md)

## Summary

A site is a SwarmFS space that isn't private, with one sub-space `pages` (`writeRoles: ['admin']`)
holding the site's folder tree as spec 001's `folder`/`file` records, and a `site` record (put by
deciders only) naming it. Uploads are a new `upload` type in the site's space, editable by their
author only. Roles: `reader` (no permissions) next to 003's `editor`. Public: the space and its pages
made public. Visitors read pages by path: inline bytes from the record (files ≤ 60 KB in sites), else a
local copy, else a fetch into **app storage** (`<instance dir>/app-storage/`), an LRU cache under a cap;
the owner's syncing app keeps every upload in `app-storage/kept/`. Reasons: [research.md](research.md);
types: [data-model.md](data-model.md); API: [contracts/api.md](contracts/api.md).

## Technical Context

**Language/Version**: JavaScript, ESM, no build; Node ≥ 20 and Bare ≥ 1.27
**Primary Dependencies**: `hypergraph/next` (master: sub-spaces, `writeRoles`, `put` permissions,
`makePublic`, `hypergraph/testing`), `swarmwire-lib` (`MemorySource` to hash bytes) — no new dependency
**Storage**: records in hypergraph; app storage: files named by their hash in the instance folder
**Testing**: `brittle`, local DHT, `node scripts/test-runner.js` (+ `--bare`), `HG_TEST_TMP` on the SSD
**Project Type**: library + thin CLI (no CLI change)
**Performance Goals**: SC-001 (entry page ~½ of today's flow), perf `site` scenario
**Constraints**: nothing outside app storage written for a visit; no record written by a visit
**Scale/Scope**: sites of tens to thousands of files; app storage default cap 1 GiB

## Constitution Check

*Gate before research, re-checked after design: passes with amendment 1.2.0 (below).*

- **I. Bytes stay where they are**: the person's files are untouched (uploads served from where they
  lie; nothing inlined outside sites). Sites' bytes held in app storage and inside records: not the
  person's files, they are what the engine reads for a web view. **Amendment 1.2.0 (MINOR)** says so,
  for sites only. ✅ with amendment
- **II. Test-first, public API**: `test/site.test.js` (stories 1, 2), `test/app-storage.test.js`
  (story 3), `test/inline.test.js` (story 4); each failing first. ✅
- **III. Node and Bare**: `b4a`, no new built-ins. ✅
- **IV. Compose**: roles, `writeRoles`, `put` permission, public spaces, author-only edits are
  hypergraph's; bytes and serving are swarmwire's; hashing bytes is swarmwire's `MemorySource`. Filed:
  **H6** confirmed (readers in a private space get no key), **H22** (a public joiner doesn't get a closed
  sub-space), **H23** (a public site can't refuse writes from public joiners). ✅
- **V. Smallest**: one new file (`lib/site.js`), two types, one appended field, one role, two rules. ✅

## Which calls each part uses

| Part (file) | hypergraph | swarmwire |
|---|---|---|
| Types (`lib/types.js`) | `data` appended to `file`; `upload`, `site` (`put: { permission: 'decide' }`); rules `inline-v1`, `upload-v1` | `MemorySource.from(bytes).root` |
| Site (`lib/site.js`) | `createSpace({ private: false })`, `createSubspace({ writeRoles })`, `put('site')`, `makePublic`, `publicLink`, `query('upload')`, `edit`, `del` | — |
| Roles (`lib/members.js`, `lib/drive.js`) | `defineRole('reader', [])`, `createInvite({ role })` | — |
| Inline (`lib/holdings.js`, `lib/sync.js`, `lib/drive.js`) | `put`/`edit` with `data` | `MemorySource` |
| App storage (`lib/swarmfs.js`, `lib/site.js`) | `personal.put('held')` / `del` | `download` (via `_download`), serving as 003 |

## Project Structure

```
lib/site.js        new: Site (extends Drive on the site's space; .pages a Drive of the sub-space)
lib/types.js       file.data; upload, site; rules
lib/members.js     reader role in every invite setting; publishName skips sites
lib/drive.js       invite({ role }); fetch writes inline bytes; entries of uploads
lib/holdings.js    contentOf() (content + inline bytes); rescanSingles skips app storage
lib/sync.js        content via contentOf(); a due inline file written from its record
lib/swarmfs.js     createSite, site, visit; app storage (dir, cap, evict); owner keeps uploads in sync()
test/site.test.js, test/app-storage.test.js, test/inline.test.js
perf/scenarios/site.mjs   + the site variant (createSite, publish, visit, read)
```

## Complexity Tracking

| Violation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Constitution I: bytes in app storage and records (sites) | a browser engine must hold what it shows; ROADMAP decision | serving from the person's folders: visits would fill them |
