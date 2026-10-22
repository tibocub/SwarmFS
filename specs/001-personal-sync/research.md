# Research: SwarmFS v1 — personal sync

Decisions for spec 001, where they come from, and where the 2026-09/10 design discussion (session
"SwarmFS bittorrent tracker integration", Q1–Q30) was overtaken by hypergraph's `ROADMAP.md` and
spec 011. Newer documents win.

## R1. The tree: typed records with a `parent` field

- **Decision**: two record types in the files space, `folder { name, parent }` and
  `file { name, parent, content }`; `parent` is a string — a folder's record id, or the space key for
  the top. Both declare `index: [['parent', 'stamp']]` (list a folder with `where({ parent })`) and
  `editable: 'members'`.
- **Why**: one index query per folder, paged; no root record to create (two devices could race to make
  one); `editable` can't change later (hypergraph: `INCOMPATIBLE_TYPES`), and shared workspaces
  (later story 1) need any member to rename and move. Fields can only be appended later: `space` (a
  folder that is a sub-space, later story 3) and `base` (conflict copies, later story 1) fit.
- **Rejected**: v1-graph relations for directories (Q18's "entities + relations": the new core has
  link fields and indexes instead); a `link` field for `parent` (no way to list the top, whose parent
  is no record).

## R2. Content reference: hypergraph's `ref` kind

- **Decision**: `content: { src: ['swarmwire://<hex root>'], size, type: '', digest: 'blake3:<hex>',
  mutable: false }` (spec 001 envelope, hypergraph `lib/fields.js`). Size lives in the ref.
- **Why**: Q4 settled `swarmwire://<root>` for content and keeps `swarmfs://` for names. No `k`
  (secret) and no size/name hints in `src`: bytes move only between the space's peers in v1.

## R3. Holdings: records in the personal space

- **Decision**: type `held { root, path, size, mtime, space, entry }` in `hg.personal`, written by the
  holding device, `index: [['root', 'stamp']]`. "What does the PC hold": `query('held').fromDevice(pc)`;
  "who holds X": `query('held').where({ root })`, each record's `device`; "do I hold X":
  `.where({ root }).fromDevice(me)`. A file removed on disk: `del()` its held record.
- **Why**: hypergraph's personal space is exactly "what each device holds" (spec 011 story 3,
  `hg.personal.put('held', { path, holder })` in its docs); it is private to the identity, encrypted,
  never dropped by budgets, readable while the holder is offline (FR-006). It is also the local
  hash → paths index (FR-007, FR-009): no second store.
- **Conflict with Q16/Q19** ("hyperbee in the same corestore"; "publish hashes, never local paths"):
  the new core gives apps no corestore, and the personal space is seen by the person's own devices
  only, so paths there are nobody else's business. In shared spaces (later story 1) holdings are
  published as hashes only.

## R4. Bytes: swarmwire over the space's own connections

- **Decision**: one swarmwire node per SwarmFS instance, carried by `space.addProtocol('swarmwire/0',
  …)` on each files space: peers are exactly the space's devices, already connected and proven. No
  DHT announce, no content topic. Serving resolves a requested root through this device's `held`
  records, checks the file's size and change time, then lets swarmwire hash and serve it in place.
- **Why**: Q22/Q25/Q27: one topic per space (hypergraph's), swarmwire on the same connections. Only
  space peers can ask (FR-012).
- **Needs**: swarmwire today owns a swarm and opens its channel on raw streams, and serves only what was
  `serve()`d (which announces on the DHT): requests S1 and S2 in `../requests-to-swarmwire.md`.
- **Conflict with Q25 (c)**: the content-topic fallback for holders outside the space is left to a
  later story (5): v1 fetches from the person's own devices only.

## R5. Spaces are private

- **Decision**: `hg.createSpace({ name, private: true })`.
- **Why**: file names are personal; a closed space is readable by anyone holding its key. Private costs
  nothing in the API; a new device reads once a device holding the key is online (it must be, to pair).
  Later shared workspaces need removed members cut off, which only private gives.

## R6. Changes on disk: rescan, no watcher

- **Decision**: `rescan()` (at open and on demand) walks the folders this device added (`added`
  records in the personal space: `{ path, space, folder }`) and its `held` records: new file → entry +
  held; changed (size or mtime differ) → rehash, edit the entry's content, new held; missing → del
  held, entry kept; an own entry whose parent folder is gone → moved to the top.
- **Why**: smallest thing that follows changes (FR-008). Watching folders is later story 4.

## R7. Concurrent edits: latest wins in v1

- **Decision**: v1 shows hypergraph's latest version of an entry; nothing on disk is lost (each device
  keeps its files and their `held` records).
- **Conflict with Q11** ("keep both", Dropbox-style conflicted copies): moved to later story 1 (shared
  workspaces), where it matters. Possible without hypergraph changes: an edit carries `base` (the
  content it replaced, an appended field); a device whose edit lost sees a winner whose `base` isn't
  its own content and re-adds its version as "name (device's copy)". Request H3 asks whether hypergraph
  would rather expose concurrent versions.

## R8. Fetch

- **Decision**: `fetch(entry, path)`: (1) own `held` for the root with the file still matching →
  return that path, 0 bytes; (2) refuse an existing `path`; (3) holders = `held` records of the root
  whose device is in `space.peers()`; none → `NOT_AVAILABLE` at once; (4) swarmwire download over the
  space's channel, bounded (`fetchTimeout`, default 30 s without progress) → on timeout stop, keep the
  partial file and its resume sidecar; (5) on completion `put('held')`.
- **Why**: FR-009–FR-013; "look locally first" is the old SwarmFS feature Tibo kept (Q6 follow-up).
- **Conflict with Q9** (prompt / per-space paths / local search): v1 takes a path from the caller
  (the CLI asks); path rules and searching the disk are later story 4.
- A partial download sits at the target path with swarmwire's sidecar; the edge case "nothing left
  half-written" is met by the sidecar marking it partial, and by `held` being written only on
  completion. (If Tibo wants no file at the path until complete, swarmwire would need a temporary
  name — not requested yet.)

## R9. Language, runtimes, tests

- **Decision**: ESM (as swarmwire), `import hypergraph from 'hypergraph/next'` (CommonJS default
  import works on Node and Bare); `brittle` on Node (`brittle-node`) and Bare (`brittle-bare`);
  `imports` map for `fs`/`path`/`os`/`process`; local DHT from `hyperdht/testnet` (a dependency
  hypergraph already uses, pinned 6.32.0 like hypergraph), servers bound to loopback.
- **Why**: Principle III; hypergraph's tests use the same testnet.

## R10. Library + thin CLI

- **Conflict with Q2** (library, client and daemon): v1 is the library and a thin CLI (story 5); a
  client and a daemon are later story 5. Matches Q2's own first step.

## Other answers carried over unchanged

- One primitive, the space (Q7); personal sync first (Q5, Q29); fresh repo (Q3); hex roots, 16 KiB
  groups (swarmwire format); deleting an entry never deletes a local file (Q12); invites carrying a
  role (Q13, now hypergraph's); per-subtree write rules (Q17/Q21/Q24) → hypergraph app rules and
  sub-spaces with `writeRoles` (ROADMAP 2026-10-08), later stories; roles inside each space (Q30, the
  new core's model); full file list per member, huge archives split into sub-spaces (Q10, Q18, Q28 →
  ROADMAP 2026-10-08); git mode not forbidden (strict-delete stays possible per space later).
