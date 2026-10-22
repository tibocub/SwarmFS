# Requests to swarmwire

What SwarmFS needs from swarmwire (or finds awkward), with why. SwarmFS doesn't work around these and
doesn't edit swarmwire; the lead conversation decides. swarmwire's boundary rule stays: none of these
makes it import hypergraph — they make it take a channel and a lookup function from whoever embeds it.

## Needed for SwarmFS v1 (spec 001, story 3 blocked on S1 and S2)

- **S1 — Run over a channel the app gives, not a swarm it owns.** SwarmFS's peers are a hypergraph
  space's peers: already connected, proven members, with a Protomux channel opened for the app by
  `space.addProtocol(name, { messages: [{ encoding, onmessage(msg, peer) }], onopen(peer),
  onclose(peer) })`, `peer.send(i, msg)`. Today `Swarmwire` needs `{ swarm }` and opens its own
  channel with `Protomux.from(stream)` on every connection. Wanted:
  - the wire as data: the message encodings in protocol order (`wire.js`'s `ORDER`/`encodings`), so
    they can be passed to `addProtocol`;
  - `node.addPeer(id, send)` → a handle receiving inbound messages (`handle.onmessage(i, msg)`), and
    `node.removePeer(id)`; the peer id chosen by the app (SwarmFS: space + device key, since one device
    is a peer in several spaces);
  - `new Swarmwire()` without a swarm; `serve`/`download` that never join a DHT topic in that mode
    (`download` has `{ announce: false }`; `serve` always joins `discoveryTopic`).
  Why not hand swarmwire the raw connections: it would talk to every hypergraph peer, not only the
  space's members, and hypergraph doesn't expose streams.

- **S2 — Serve on demand through a lookup.** A device holds thousands of files; `serve(path)` hashes
  each at once and keeps a source open per file. Wanted: `new Swarmwire({ resolve })` with
  `resolve(rootHex) → path | null`, called when a peer wants a root not being served; swarmwire then
  opens and hashes the file (`ContentSource.open`) and serves it only if its root matches (the file may
  have changed on disk since SwarmFS recorded it — it must answer `unavailable`, never wrong bytes).
  SwarmFS's resolver looks up its own records.

- **S3 — A fetch that can end.** With no holder answering, a `Download` waits forever. SwarmFS bounds a
  fetch itself (timeout without progress → `stop()`), which works; a `stalled`/`progress` event, or the
  download failing once every connected peer said `unavailable`, would let it answer "not available"
  at once instead of after the timeout. Also: confirm `stop()` keeps the resume sidecar so the same
  `download()` later resumes (spec 001 story 3 #4).

## For later

- **S4 — Persistent hash cache.** After a restart, serving a file rehashes it (cache in memory only,
  roadmap M1 gap). Fine for v1; big archives will want the outboard kept (swarmwire-side, e.g. next to
  the sidecar or in a cache folder the app names).
- **S5 — Download to a temporary name.** While partial, the bytes sit at the target path (with a
  sidecar). If users find half files confusing, an option to download to `<path>.part` and rename at
  the end. Not requested yet; noted from SwarmFS spec 001's edge cases.
