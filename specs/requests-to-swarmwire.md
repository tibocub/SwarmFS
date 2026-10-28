# Requests to swarmwire

What SwarmFS needs from `swarmwire-lib` (branch `main`, 0.7.0; app contract `docs/contract.md`), with
why. SwarmFS doesn't work around these and doesn't edit swarmwire; the lead conversation decides.
None makes swarmwire import hypergraph.

## Status (2026-10-27)

- **S1 — Run over channels the app gives**: **dropped.** Contract §2/§3.6 already lets the app supply
  the network (`join(topic, opts)` → `{ destroy() }`, a `connection` event). SwarmFS passes an adapter
  re-emitting hypergraph's member streams (hypergraph H1). No swarmwire change.
- **S2 — Serve on demand** (being built): `resolve(rootHex) → path | null`, called when a peer wants a
  root not being served; swarmwire opens and hashes the file only then and answers "unavailable" if
  its root differs (the file changed on disk since SwarmFS recorded it — never wrong bytes). Plus a
  **no-announce mode**: with the adapter, nothing ever joins a per-content topic (`serve` joins
  `discoveryTopic` today). Why: Tibo's rule — a device hosts everything it holds, nothing per file is
  announced or hashed up front.
- **S3 — A fetch that can end**: **done** (`Download` events `progress`, `rejected`, `timeout`,
  `stalled`). One gap: when every connected peer answers `unavailable` (e.g. its file changed),
  `stalled` doesn't fire and the download waits; SwarmFS bounds it with its own no-progress timeout
  meanwhile. Firing `stalled` there too would answer "not available" at once.
- **S5 — Downloads under a temporary name** (being built; Tibo: yes): bytes go to a `.part` name and
  are renamed at the end, so nothing half-written sits at the target path.

## Status (2026-10-28, swarmwire-lib 0.7.0)

- **S2, S5: done; used** (`resolve`, `download(..., { announce: false })`, `temporary`). Checked in
  `test/fetch.test.js` (with S7 applied locally): no `join` call for any file; only a `.part` after a
  fetch cut short; a file rewritten keeping size and mtime is not served.
- **S3's gap: done** (`stalled` when every peer said unavailable): a changed file answers
  `NOT_AVAILABLE` in ~0.5 s.
- **S6: dropped** (2026-10-28). SwarmFS stats before and after `hashFile(path)` and hashes again if the
  file changed; size and mtime come from that stat, so no swarmwire change and no `ContentSource`.

## New (2026-10-28) — blocks story 3

- **S7: done** (swarmwire c1e06d0: the side whose open was rejected accepts the other's later open). **Accept a channel the remote opens first.** With an app-supplied network whose streams
  already carry a Protomux (hypergraph's member streams), swarmwire's `openChannel` only creates its
  channel; a remote open arriving before it is rejected by Protomux, and this side's own open is
  rejected if the remote's channel is already gone. Member streams reach each side at different
  moments, so two SwarmFS devices never complete the swarmwire handshake. With Hyperswarm it works
  by luck of timing (both sides open at `connection`).
  Smallest repro (no network; swarmwire `main`, 0.7.0):
  ```js
  // two piped streamx Duplexes sa/sb; Protomux.from(sa); Protomux.from(sb) (the app's mux)
  // A.emit('connection', sa, { publicKey: k2 }); later B.emit('connection', sb, { publicKey: k1 })
  // → peer-connected 0 of 2 (also with "later" = setTimeout 0). Without the pre-existing mux: 2 of 2.
  ```
  Script: `specs/repro-s7-late-open.mjs` (`node specs/repro-s7-late-open.mjs`).
  Fix tried locally (not committed): `Protomux.from(stream).pair({ protocol: 'swarmwire/0' }, () =>
  reopen on that stream)` when a stream is handed over. With it, `test/fetch.test.js` and the 100 MB
  test pass on Node and Bare. Belongs in swarmwire's `_onPeer`/`openChannel` (and `unpair` when the
  peer is gone), not in each app.

## New (2026-10-28, SC-008 re-check)

- **S8 — Stop talking to a stream the app handed over.** With an app-supplied network (§3.9),
  swarmwire learns of a stream from `connection`, but nothing tells it the app no longer wants that
  peer served (a device removed from the space) while the stream stays open (hypergraph's, shared
  with other spaces). SwarmFS today does it itself in `lib/transfer.js`: `Protomux.from(stream)`,
  find the channel whose `protocol === 'swarmwire/0'`, `close()` it. That is SwarmFS knowing
  swarmwire's wire protocol name and channel handling (against SC-008, and breaks if swarmwire
  renames or versions its protocol). Wanted: the adapter's own way to retract it, e.g. a
  `disconnection` event on the supplied network (`net.emit('disconnection', stream)`), or
  `wire.release(stream)`: close swarmwire's channel on it, end that peer's transfers, leave the
  stream open. Then SwarmFS drops its `protomux` dependency.
  Repro: none needed beyond reading `leave()` in `lib/transfer.js` (works today; the request is about
  owning it in the right place).

## Earlier

- **S6 — A stable "hash this file"**. SwarmFS hashes each added file once (the hash is the entry).
  The stable `rootOf(bytes)` needs the whole file in memory; `ContentSource.open(path)` streams it but is
  "exported for tests and advanced use, may change in any 0.x". Wanted: a stable
  `hashFile(path) → { root, size }` (or `ContentSource.open` made stable).

## For later

- **S4 — Persistent hash cache.** After a restart, serving a file rehashes it on first request (cache
  in memory only). Fine for v1; big archives will want the outboard kept.
