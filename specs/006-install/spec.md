# Spec 006: an installed site kept whole; the bytes a site holds here

**Branch**: `claude/trusting-chatterjee-29a46f` · **Created**: 2026-11-07 · **Status**: done

**Input**: HyperBrowser requests F4 and F5 (`E:\Code\P2P\HyperBrowser\specs\requests-to-swarmfs.md`, `main`).
Tibo: "install" = kept whole on disk and seeded; "bookmark" = cached, evicted as usual.

## F4: `site.keep(true | false)`

- **true**: every page and upload of the site fetched into `app-storage/kept/` (inline ones are in their
  records already), outside eviction, held (so served to the site's members: seeded). Resolves after that
  first pass; a file no one online holds is fetched on a later pass (a peer arrives, a change).
- While `sync()` runs, the kept copies follow the site: new and edited files fetched, the copies of removed
  ones dropped.
- A file already in app storage's cache is moved into `kept/`, not fetched again.
- **false**: the kept copies go back into the cache (`app-storage/<root>`), evicted as usual; an owner's
  uploads stay kept (spec 004 FR-013).
- Remembered on this device across restarts: a `kept` record in the personal space (this device's own;
  another device of the person keeps its own choice). `site.kept()` → whether it is.

## F5: `site.held()`

- Bytes of the site's files on this device: files held here (app storage's cache, `kept/`, the owner's own
  folder and uploads; each path once, only while still as hashed) plus the inline ones (pages and uploads
  ≤ 60 KiB, inside their records).

## Plan

- `types.js`: personal type `kept: { space }` (a new type: older SwarmFS versions keep and ignore it).
- `site.js`: `keep`, `kept`, `held`; `_keep` takes pages too when kept, hands back instead of deleting
  what is still in the site, and touches only this site's copies (it used to drop another site's kept
  uploads: a bug for an owner of two sites).
- `swarmfs.js` `_keep(key)`: a site the person owns *or keeps*; listens on the pages sub-space too.
- Regression test `test/install.test.js`; perf scenario `site.install` (a visitor installs a site: storage
  and transfers); README.

## Tasks

- [x] T1 test: installed site survives a tight cap, a bookmark doesn't; remembered after restart; new page
  followed; `keep(false)` hands back; `held()` equals the bytes on disk plus inline ones.
- [x] T2 `kept` type, `site.keep/kept/held`, `_keep` generalized.
- [x] T3 perf scenario `site.install`, run before/after.
- [x] T4 README, CLAUDE.md state.
