# Requests to swarmwire

What SwarmFS needs from `swarmwire-lib` (branch `main`, 0.5.0; app contract `docs/contract.md`), with
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

## New

- **S6 — A stable "hash this file"**. SwarmFS hashes each added file once (the hash is the entry).
  The stable `rootOf(bytes)` needs the whole file in memory; `ContentSource.open(path)` streams it but is
  "exported for tests and advanced use, may change in any 0.x". Wanted: a stable
  `hashFile(path) → { root, size }` (or `ContentSource.open` made stable).

## For later

- **S4 — Persistent hash cache.** After a restart, serving a file rehashes it on first request (cache
  in memory only). Fine for v1; big archives will want the outboard kept.
