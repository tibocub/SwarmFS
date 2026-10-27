# Requests to hypergraph

What SwarmFS needs from `hypergraph/next` (or finds awkward), with why. SwarmFS doesn't work around
these and doesn't edit hypergraph; the lead conversation decides.

## Needed for SwarmFS v1 (spec 001)

- **H1 — The streams of a space's proven members** (accepted by the lead, being built 2026-10-27).
  SwarmFS gives swarmwire a network adapter whose `connection` event is these streams, so swarmwire
  talks only to the space's members, over hypergraph's connections, with no topic of its own.
  Replaces the first draft's `addProtocol` route (and swarmwire S1). Needed: each stream with the
  peer's device key (swarmwire's peer id), for streams open now and later, and its close.
- **H2 — An event when `hg.spaces()` changes.** A space created or joined on another device of the
  identity (or left) appears in `hg.spaces()`, but nothing tells the app. SwarmFS must hand each new
  files space's member streams to swarmwire and show the space; without an event it can only poll or
  wait for a restart. Something like `hg.on('spaces', (spaces) => {})`. Until then v1 reads the list
  at open and after `createSpace`.
  **Done in hypergraph; used** (`sfs.on('spaces')`, checked in `test/devices.test.js`).

## To confirm (SwarmFS's first tests will check; a reply saves a surprise)

- **H3 — `where()` on an index over an `editable: 'members'` string field follows edits.** Moving an
  entry is `edit(id, { parent })`; listing a folder is `query(type).where({ parent })`. The old
  version must leave the old folder's listing and the new one appear in the new folder's, on every
  device.
- **H4 — `where({ root })` and `fromDevice(dev)` combine.** "Do I hold X" is
  `hg.personal.query('held').where({ root }).fromDevice(hg.device.publicKey)`. The docs say filters
  combine (AND); no test combines these two.
  **Checked 2026-10-27** (`test/devices.test.js`): combine as expected, on Node and Bare.
- **H5 — Member streams of a private space** include the person's newly paired device once it holds
  the key.

## Found while building (2026-10-27)

- **H10 — A read of this device's own records that doesn't wait.** After a restart with the other
  device offline, every read is incomplete ("hasn't looked at another member's list of logs") and
  waits the full `readTimeout` — also `personal.query('held').fromDevice(me)`, whose answer is all
  local. SwarmFS's rescan (run at every open) does dozens of such reads: 5 s each made opening a
  phone take 10–40 s in tests. Meanwhile rescan passes `{ timeout: 200 }` and acts on anything
  depending on others' records (a removed folder) only when `complete`. Wanted: own-device queries
  complete without waiting, or a documented `{ timeout: 0 }` "what is here" read.

## For later stories (not blocking v1)

- **H6 — Read-only members.** Community archives (later story 2) want readers who don't upload. A role
  without `post` "cuts like a removal"; in a private space does such a member keep receiving the key
  and reading? If not, a `read` role (reads, never writes) is needed.
- **H7 — Concurrent versions of a record.** Shared workspaces (later story 1) keep both versions when
  two members change one file offline (decided: Dropbox-style conflict copies). SwarmFS can do it on its
  own with an appended `base` field (the content an edit replaced) — the losing device re-adds its
  version as a copy. Say if hypergraph would rather expose "versions that lost to a concurrent edit"
  (today only `inspect({ record })`, diagnostics).
- **H8 — A public test helper for apps.** SwarmFS's tests need a local DHT; it uses
  `hyperdht/testnet` directly (as hypergraph's `test/next/helpers.js` does). A documented
  `hypergraph/testing`-style helper (bootstrap + tmp dirs) would keep apps' tests in step with
  hypergraph's (e.g. the hyperdht 6.32.0 pin).

## Docs

- **H9 — ECOSYSTEM.md's SwarmFS rows are stale**: the map still says "PAUSED"; "Where each project
  documents itself" points at `AGENTS.md`/`INVARIANTS.md` and a `dev` branch (the old repo). Now:
  `CLAUDE.md` → constitution → `specs/`; branch `main`. swarmwire's package is now `swarmwire-lib`.
