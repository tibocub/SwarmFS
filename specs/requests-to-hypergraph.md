# Requests to hypergraph

What SwarmFS needs from `hypergraph/next` (or finds awkward), with why. SwarmFS doesn't work around
these and doesn't edit hypergraph; the lead conversation decides. Newest at the bottom of each list.

## Needed for SwarmFS v1 (spec 001)

- **H1 — An event when `hg.spaces()` changes.** A space created or joined on another device of the
  identity (or left) appears in `hg.spaces()`, but nothing tells the app. SwarmFS must attach its
  transfer protocol (`space.addProtocol`) to every files space and show new ones; without an event
  it can only re-read the list (polling) or wait for a restart. Something like
  `hg.on('spaces', (spaces) => {})`. Until then v1 reads the list at open and after `createSpace`.

## To confirm (SwarmFS's first tests will check; a reply saves a surprise)

- **H2 — `where()` on an index over an `editable: 'members'` string field follows edits.** Moving an
  entry is `edit(id, { parent })`; listing a folder is `query(type).where({ parent })`. The old
  version must leave the old folder's listing and the new one appear in the new folder's, on every
  device.
- **H3 — `where({ root })` and `fromDevice(dev)` combine.** "Do I hold X" is
  `hg.personal.query('held').where({ root }).fromDevice(hg.device.publicKey)`. The docs say filters
  combine (AND); no test combines these two.
- **H4 — `addProtocol` on a private space** opens with the person's other device once it holds the
  key (a newcomer device of a private space). Tested only on closed spaces (`test/next/net/protocol.js`).

## For later stories (not blocking v1)

- **H5 — Read-only members.** Community archives (later story 2) want readers who don't upload. A role
  without `post` "cuts like a removal"; in a private space does such a member keep receiving the key
  and reading? If not, a `read` role (reads, never writes) is needed.
- **H6 — Concurrent versions of a record.** Shared workspaces (later story 1) keep both versions when
  two members change one file offline (decided: Dropbox-style conflict copies). SwarmFS can do it on its
  own with an appended `base` field (the content an edit replaced) — the losing device re-adds its
  version as a copy. Say if hypergraph would rather expose "versions that lost to a concurrent edit"
  (today only `inspect({ record })`, diagnostics).
- **H7 — A public test helper for apps.** SwarmFS's tests need a local DHT; it uses
  `hyperdht/testnet` directly (as hypergraph's `test/next/helpers.js` does). A documented
  `hypergraph/testing`-style helper (bootstrap + tmp dirs) would keep apps' tests in step with
  hypergraph's (e.g. the hyperdht 6.32.0 pin).

## Docs

- **H8 — ECOSYSTEM.md's SwarmFS rows are stale**: the map still says "PAUSED"; "Where each project
  documents itself" points at `AGENTS.md`/`INVARIANTS.md` and a `dev` branch (the old repo). Now:
  `CLAUDE.md` → constitution → `specs/`; branch `main`.
