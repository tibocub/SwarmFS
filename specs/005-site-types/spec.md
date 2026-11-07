# Spec 005: a dynamic site's own record types; close() right after sync()

**Branch**: `005-site-types` · **Created**: 2026-11-07 · **Status**: done

**Input**: HyperBrowser requests F1 and F3 (`E:\Code\P2P\HyperBrowser\specs\requests-to-swarmfs.md`, branch
`001-engine`). Needs hypergraph spec 019 (`space.declareTypes`, branch `019-space-types`).

## F1: a site's types

- **Need**: the official forum is a site; its records (`post`, `comment`, `vote`) live in the site's space,
  next to its pages. The engine opens SwarmFS with SwarmFS's types only.
- **API**: `sfs.createSite(name, { types })`: the space records SwarmFS's types, then the site's.
  `site.declareTypes(types)`: adds to an existing site (owner, admins), through hypergraph's
  `space.declareTypes` (additions only: `INCOMPATIBLE_TYPES` otherwise; `NOT_ALLOWED` for others).
- A site's type named like one of SwarmFS's (`file`, `upload`, `site`...): `INVALID_TYPE`. Replacing it
  would break the site's pages and uploads.
- A SwarmFS update adding its own fields or types still reaches sites (hypergraph 019: a decider's app keeps
  a space's types it lacks).

## F3: close() right after sync()

- **Seen**: `sync()` sets its 10 s interval after a few awaits; a `close()` in between cleared nothing, so
  the interval ran forever and the process never exited.
- **Fix**: `close()` marks the instance closed; `sync()` checks before starting each link, before watching
  single files, and before its listener and interval. Watchers made meanwhile are closed. `close()` doesn't
  wait for a first pass (it can be long).

## Tests

- `test/site-types.test.js`: a site with its own types, a visitor reads and writes them, `declareTypes`
  later, refusals (visitor, breaking change, SwarmFS's names); F3: no interval after `close()` (fails on the
  old code: assert and a process that never exits).
- Not a hot path: one decision at a site's creation. No perf scenario.
