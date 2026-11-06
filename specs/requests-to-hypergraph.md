# Requests to hypergraph

What SwarmFS needs from `hypergraph/next` (or finds awkward), with why. SwarmFS doesn't work around
these and doesn't edit hypergraph; the lead conversation decides.

## Needed for SwarmFS v1 (spec 001)

- **H1 — The streams of a space's proven members** (accepted by the lead, being built 2026-10-27).
  SwarmFS gives swarmwire a network adapter whose `connection` event is these streams, so swarmwire
  talks only to the space's members, over hypergraph's connections, with no topic of its own.
  Replaces the first draft's `addProtocol` route (and swarmwire S1). Needed: each stream with the
  peer's device key (swarmwire's peer id), for streams open now and later, and its close.
  **Done in hypergraph (`member-connection`, `member-disconnection`, `memberConnections()`); used** in
  `lib/transfer.js`. Story 3 still blocked, on swarmwire S7 (see H11).
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
  **Checked 2026-10-28** (`test/fetch.test.js`, phone paired after the space was made): its stream
  comes on both sides, on Node and Bare (with S7's fix applied locally).

## Found while building (2026-10-27)

- **H10 — A read of this device's own records that doesn't wait.** After a restart with the other
  device offline, every read is incomplete ("hasn't looked at another member's list of logs") and
  waits the full `readTimeout` — also `personal.query('held').fromDevice(me)`, whose answer is all
  local. SwarmFS's rescan (run at every open) does dozens of such reads: 5 s each made opening a
  phone take 10–40 s in tests. Meanwhile rescan passes `{ timeout: 200 }` and acts on anything
  depending on others' records (a removed folder) only when `complete`. Wanted: own-device queries
  complete without waiting, or a documented `{ timeout: 0 }` "what is here" read.
  **Done in hypergraph; used**: own `held`/`added` reads have no bound now; entry reads keep the short
  one. Checked: a fetch with the PC offline answers `NOT_AVAILABLE` in ~0.5 s (`test/fetch.test.js`).

## Found while building (2026-10-28)

- **H11 — docs/next/api.md's swarmwire example doesn't work.** Two gaps:
  - `net.emit('connection', m.stream)` passes no peer info: swarmwire's peer id is
    `info.publicKey`, else `'unknown'`, so every peer becomes one. Needs
    `net.emit('connection', stream, { publicKey: stream.remotePublicKey })`.
  - Each side gets a member stream at a different moment (when it has proven the other). The side
    first to open its channel is turned down by the other's Protomux (no channel, no `pair` there
    yet), and its channel closes; the later side's open is then turned down too. No peer ever
    connects. hypergraph's own `network.js` and member-streams test use `mux.pair` for this. The fix
    belongs in swarmwire (S7); the example should say so, or show the `pair`.

## Found while building (2026-10-28, CLI)

- **H12 — `'spaces'` fires before a joined space has its name, and not again when it arrives.** On a
  newly paired device, `hg.spaces()` lists the space with `name: ''` when `'spaces'` fires; the name
  shows up ~0.2 s later with no event. An app finding a space by name (the CLI: `swarmfs ls "My
  files"` right after `join`) can't know when to look again: the CLI waits its full 15 s bound,
  then finds it. Wanted: `'spaces'` again when a listed space's name (or any field `spaces()` returns)
  changes — or list a space only once its name is known.
  Repro: `node specs/repro-h12-space-name.mjs` (local DHT, PC + paired phone):
  ```
  93 ms 'spaces': [{"key":"adtd…","name":"","parent":null}]
  3013 ms no event, but now: [{"key":"adtd…","name":"My files","parent":null}]
  ```
  Cost today: the CLI test takes 15 s longer (its timeout notes H12); no workaround in SwarmFS.
  Since the CLI is a shell (2026-10-28): no time lost there (`ls` answers `NOT_FOUND`, asked again a
  moment later works); a one-shot `ls` right after `join` still waits its 15 s. Still wanted for apps.

## Found while building (2026-10-28, lead review)

- **H13 — A code for "this instance folder is open in another process".** `Hypergraph.open` on a
  folder another process holds throws a plain `Error('File descriptor could not be locked')` (from
  storage), no `code`. The CLI tells the person a shell holds the folder; it matches the message
  (a shortcut, marked in `bin/swarmfs.js`). Wanted: `HypergraphError` with a code, e.g. `IN_USE`.

## Found while planning spec 002 "always on" (2026-10-28)

- **H14 — What changed, not only which types.** A device keeping a linked folder in step must learn
  which entries were put, edited or deleted since it last looked. `space.on('change', ({ types }))`
  names the types; queries list by put time (an edit or a delete doesn't show as "new"). So on every
  `change` SwarmFS re-reads every `folder` and `file` record of the space and diffs: a linked folder of
  10,000 files is 200 pages per change, even for one renamed file. Wanted, any of: the changed record
  ids in the `change` event (with "deleted"); or a changes feed, e.g.
  `space.changes({ since: cursor }) → { items: [{ id, type, deleted }], cursor }`. Not blocking:
  SwarmFS re-reads (debounced 500 ms), marked `shortcut:`, measured in its 10,000-file test.
- **H15 — Deleted, or just not here (and when).** `space.get(id)` returns `{ record: null }` both for a
  deleted record and one not held yet. SwarmFS acts on a removal only from a complete read (so an
  offline device's records aren't taken as deleted). It also needs the delete's stamp to settle "edited
  on one device, deleted on the other": keep the edit if it is newer than the delete. Today such an edit
  goes to the editing device's trash (kept, not shown). Wanted: `get()` saying `deleted: { stamp,
  device }` (or the same in a changes feed, H14).

## Found while building spec 002 (2026-10-28)

- **H16 — `change` doesn't fire for another device's edit.** On the phone, `space.on('change')`
  fires for the PC's `put` (`{ types: ['file'] }`) and `del`, but not for its `edit` (a rename, a
  move, new content), though `get()` shows the edit a moment later. `logs` fires for all three.
  docs/next/api.md says `change` is "records of these types changed": an edit is one. Linked folders
  follow renames, moves and edits from the other device through it. SwarmFS listens to `logs` too
  meanwhile (marked `shortcut:` in `lib/swarmfs.js`): one re-read per log growth, more than needed.
  Repro: `npx brittle-node specs/repro-h16-edit-change.mjs`:
  ```
  after put 4 {"types":["hg/grant"]} {"types":["hg/grant"]} {"types":["file"]} logs
  after edit true 1 logs
  after del true 2 {"types":["file"]} logs
  ```

- **H17 — A device paired after a private space got big never gets access.** **Done 2026-10-29** (hypergraph 053324d: the indexer stopped at a batch of locked records; SwarmFS repro passes, suite 63/63 Node and Bare). The PC adds a folder
  of 1,000 files to a private space (`createSpace({ private: true })`, with or without `policy:
  'everything'`), then pairs the laptop. The laptop lists the space in 0.4 s, but after 90 s its
  `status()` is `{ access: 'waiting', held: 'all', peers: 1 }`: no record readable, `get()` of the
  folder `null`, its listing `{ items: [], complete: false }`. With 100 or 300 files the same flow
  sees everything in 0.25–0.4 s. Looks like the "big spaces" newest-first read (over 2,000 records,
  concepts.md) never reaching what gives the newcomer the key. This is the everyday flow (add your
  photos, then pair your laptop): with it, linked folders never fill on the new device.
  **Blocks real use of spec 002 beyond ~300 files added before pairing.** SwarmFS's tests pair first,
  then add (as v1's SC-009 test did). Repro: `npx brittle-node specs/repro-h17-big-private-space.mjs`:
  ```
  space after 400
  docs after 90469 false
  status {"policy":"everything","access":"waiting","held":"all","heldFrom":null,...,"peers":1,...}
  list {"items":[],"complete":false}
  ```

## For later stories (not blocking v1)

- **H6 — Read-only members.** Community archives (later story 2) want readers who don't upload. A role
  without `post` "cuts like a removal"; in a private space does such a member keep receiving the key
  and reading? If not, a `read` role (reads, never writes) is needed.
  **Checked 2026-11-06 (spec 004): no.** A role with no permissions in a private space stays
  `access: 'waiting'` and reads nothing (15 s); in a closed space it reads at once. Repro:
  `npx brittle-node specs/repro-h22-site-roles.mjs` ("a reader ... in a private space"). Wanted: keys
  granted to members who can't write (the research note's guess: keys go to devices whose log the
  space knows, and a reader never writes one). SwarmFS refuses reader invites in private spaces
  (`NOT_SUPPORTED`) until then; sites are closed spaces, so milestone 1 isn't blocked.
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
  **Done 2026-10-29** (hypergraph ECOSYSTEM.md, by the lead).

## Done in hypergraph spec 012 (honest reads), adopted 2026-10-29 (branch adopt-012)

- **H10, H12, H14, H15, H16 done.** SwarmFS: `LOCAL = { timeout: 200 }` and `readTimeout` gone (reads
  answer at once); `logs` listener gone (`change` names edits); a linked folder reads the space whole at
  start/resume, then re-reads only the ids `change` names; "edit here, delete there": the file re-added
  if saved (mtime) after the delete's stamp, never after a take-down; one-shot `ls` waits `{ timeout }`.
  Measured, 10,000 entries: one rename followed in 843 ms (was 1,211, 500 ms debounce included); new
  file recorded 2.8 s (was 3.3 s, 2 s settle included); SC-002 3.2 s.
- **H18 (new, small)** — a record shows `edited: true`, not its version's stamp, so "compare `stamp`
  with an edit's" (docs/next/api.md) can't be done from a record. SwarmFS compares the file's mtime.

## Found while planning spec 003 "shared workspaces" (2026-10-30)

- **H19 — A space may take `invite` from its admins.** Tibo wants a space's creator to choose who
  invites: everyone, chosen people, or the owner only. Built-in `admin` always has `invite`, and a
  built-in role's permissions can't change, so "owner only" holds only while the space has no admin —
  against the docs' "give a space an admin". Wanted: a per-space way to leave `invite` out of
  `admin` (e.g. `defineRole`-like `setRolePermissions('admin', { invite: false })`, or an invite
  policy on the space). Not blocking: 003 ships "owner and admins" (Tibo, 2026-10-30).
- **H20 — A role with `invite` inviting to a custom role below or equal to it.** `mayInvite` lets a
  maker invite to `member`, `guest`, its own role (if it has no power), or a lower rank. Custom roles
  all rank as a member, so SwarmFS's `trusted` (`post`, `invite`) can't invite people as `editor`
  (`post`), the role everyone in a files space has. Wanted: a maker may invite to any custom role with
  no power over others (`decide`, `moderate`, `roles`) whose permissions it holds (the same check
  `grantable` already does). Blocks 003 story 5's "chosen people" for trusted members (owners and
  admins work).

## Found while building spec 003 (2026-10-30)

- **H21 — `get()` says `deleted: null` for a record a ban's `drop: 'all'` removed.** After
  `moderateAction('ban', carol, { drop: 'all' })`, Bob's `change` names Carol's file with
  `deleted: { by: 'space' }`, but `space.get(id)` then answers `{ record: null, deleted: null }` (on
  Alice's device too): "not here", not "taken down". docs/next/api.md: `deleted` is `{ by: 'space' }`
  for "a moderator's take-down, a ban". An app re-reading what `change` named (as the docs advise) and
  acting on removals only when `get()` says deleted keeps the file forever. SwarmFS now also trusts
  the `deleted` carried by `change` (`lib/sync.js` `read()`; marked H21). Wanted: `get()` reports
  `{ by: 'space' }` for records dropped by a ban (`from` or `drop: 'all'`) and by a write limit.
  Repro: SwarmFS `test/removal.test.js` "a ban dropping all" with the H21 line in `read()` reverted.

## Found while building spec 004 "sites" (2026-11-06)

- **H22 — A public joiner never gets a closed sub-space of the public space.** A site = a closed
  space made public + a sub-space `pages` (`writeRoles: ['admin']`). Eve joins by `publicLink()`: she
  reads the top space and `subspaces()` lists `pages`, but `hg.space(pages.key)` throws `NOT_FOUND`
  for 15 s. An invited `editor` gets it at once. docs/next/api.md: "Members of the parent have it at
  once, without joining"; a public joiner counts as `member`. With `pages.makePublic()` too, Eve has it
  at once by the top's link. SwarmFS makes a public site's pages public (right anyway for a site), so
  not blocking; wanted: either the docs say a public joiner gets only public sub-spaces, or she gets
  closed ones too. Repro: `specs/repro-h22-site-roles.mjs` ("a public space: a joiner by the public link").
- **H23 — A public space whose joiners only read.** Public joiners are `member` (spec 016 FR-001), who
  may `put`: anyone visiting a public static site can write records into it (probe: Eve's `upload`
  accepted), and the owner's app keeps uploads. Wanted (later, not milestone 1): the role public
  joiners get, chosen at `makePublic({ role })` (e.g. a role with no permissions). Today: write
  limits and bans.
