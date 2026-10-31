# Research: SwarmFS 003 — shared workspaces

Decisions for spec 003. Tibo's (2026-10-30, this spec's session) are marked **Tibo**; the rest are
this worker's, for the lead to review. Specs 001/002's research still holds unless replaced here.
Hypergraph facts are from `docs/next/api.md` and `lib/decisions/state.js` (master, 2026-10-30).

## R1. A shared space is any files space; "shared" = a second identity was ever a member

- **Decision**: no new kind of space. Inviting someone into any files space makes it shared.
  `shared` = `members()` lists more than one identity, removed and banned ones included (so it never
  flips back). Read once per pass; `members` event re-reads.
- **Why**: the bin rule (R3) must not change under a person's feet; smallest.
- **Rejected**: a `shared` flag at creation (one more choice; a personal space couldn't be shared later).

## R2. Serving scoped by peer and space — swarmwire S10 (blocking)

- **Decision**: `resolve(root, peer)` (swarmwire S10: the peer's `publicKey`). SwarmFS answers a path
  only from `held` records whose `space` is a files space where that device is in
  `memberConnections()`. The person's own devices are members of every files space, so nothing changes
  between them.
- **Why**: today `resolve(root)` serves any held root to any member peer of any space: Bob could fetch
  Alice's private files by hash (lead review 2026-10-28: "before shared workspaces, `resolve` must be
  scoped by peer and space"). `held.space` already names the space each local path belongs to: no new
  index.
- **Not worked around**: SwarmFS can't learn which peer asked without swarmwire (constitution IV).
  Until S10: everything but FR-008 can be built; its test (story 1 scenario 6, SC-005) stays red, and
  nothing ships to real people.

## R3. The bin: `parent: 'bin'` plus two appended fields

- **Decision**: moving to the bin is an edit any member may make (`editable: 'members'`):
  `edit(id, { parent: 'bin', from: <former parent>, binned: <ms> })`. `from` and `binned` are appended
  to `folder` and `file`. A folder goes with its subtree (its children keep `parent: folder`). Listing:
  `query(type).where({ parent: 'bin' })` (the existing index). Restore: `edit(id, { parent: from, or
  the top if gone, from: '', binned: 0 })` (an edit keeps fields it doesn't name, so they are reset). Who deleted: the version's `device`, mapped to a person through `members()`.
  Emptying: `del` of entries this person authored whose subtree is all theirs; an owner or admin's
  `del` takes anything down (hypergraph: a moderator's `del` of others' records).
- **Why**: hypergraph lets only the author (and moderators) delete (**Tibo** 2026-10-09); a move is
  allowed to all. `'bin'` can't be a record id or a space key (both are 52+ characters).
- **Rule**: `swarmfs/bin-v1`: `parent === 'bin'` ⇒ `from` non-empty. Older apps (002) see a file whose
  parent is no folder: spec 001's orphan rule would move it to the top on the adding device — the
  members must update together before using the bin (noted in the plan; 002 isn't released).
- **Linked folders**: a binned entry isn't under any linked folder → removed locally (trash, spec 002).
  A linked folder whose own space folder (or an ancestor) is in the bin is **paused** (`in-bin`), its
  files untouched; restored → resumes. Orphan rule skips `parent: 'bin'`.
- **Rejected**: a `bin` folder record (two members create two bins); `del` + a copy (`del` refused
  for others' records); a separate `binned` record type (one more type, joined on every read).

## R4. Names: a `profile { name }` record per person per space

- **Decision**: `profile: { fields: { name: 'string' }, onePerMember: true }` in each files space; the
  name kept in `hg.setSetting('name')` (same on every device); written into every files space on
  `setName`, `createSpace`, join, and on `spaces` (a space joined on another device). `members()` adds
  `name`.
- **Why**: hypergraph has no person names (forum uses the same `profile` pattern); device names are
  private to the person. Copy names and member lists need one.
- **Copy names**: the device that keeps its version as a copy (spec 002 R4) names it after its
  person's name when the winning version's `author` is another identity, after its device otherwise
  (FR-007). Same-name entries placed side by side (spec 002 R9): the writer's person name if it isn't
  this identity, else its device name.

## R5. Invite setting from two custom roles; H20 for "trusted"

- **Decision**: SwarmFS defines `editor` (`post`, plus `invite` when the setting is "everyone") and
  `trusted` (`post`, `invite`) in every files space it creates. Invitees join as `editor`.
  - everyone: `editor` has `invite` → invites to itself (hypergraph: a role with no power invites to
    itself).
  - chosen people: `editor` without `invite`; owners/admins give `trusted`.
  - owner and admins: `editor` and `trusted` without `invite`.
  The setting is read back from `roles()` (no record of its own). Changing it: `defineRole` again
  (a defined role may gain permissions, and lose `invite`, hypergraph).
- **Gap → H20**: `trusted` may not invite to `editor` (both rank as a member; only `member`, `guest`
  or its own role pass `mayInvite`). Asked: a role with `invite` may invite to any custom role with no
  power over others whose permissions it holds. Until then "chosen people" works for owners/admins
  only; story 5 scenario 2 waits.
- **Gap → H19** (**Tibo**: ship owner+admins now, ask hypergraph): true "owner only" with admins
  present needs a space to take `invite` from its admins.
- **Rejected**: inviting as built-in `member` (can never get `invite`: "everyone" impossible).

## R6. Removed, banned, left: a pause reason

- **Decision**: a linked folder of a space whose `status().access` is `'none'` (removed or banned:
  hypergraph answers at once) is paused, reason `removed`; `status` event → resumed when `'full'`
  again. Nothing written, nothing fetched, no file touched. `leave(space)` → `unlink` its linked
  folders, then `hg.leaveSpace`. A ban with `drop: 'all'` reaches others as deletes `{ by: 'space' }`:
  spec 002's removal path (trash; never re-added: a take-down).
- **Why**: spec 002's pause already means "touch nothing here"; **Tibo**: she keeps her copies.

## R7. Shown holdings: a `has { root }` record per device, per person's choice

- **Decision**: type `has: { fields: { root: 'string' }, index: [['root', 'stamp']] }` in files spaces.
  The choice is a setting `show-holdings: [space keys]` (same on all the person's devices, **Tibo**:
  per person, per space, off by default). While on, each device keeps one `has` per root it holds in
  that space (put with `held`, deleted with the last `held` of that root there); turning it off
  deletes this device's `has` there (each device its own: the others' on their next start or
  `settings` event). Holders shown: own devices from `held` (as today) + other people's devices from
  `has` (name from `profile`, online from `peers()`), never a path.
- **Fetch without shown holdings** (FR-009): a due file is tried when any member device of the space
  is online; a download every peer refuses ends `stalled` at once (swarmwire S3). To avoid retrying
  every 10 s for files nobody online holds, a root is tried again only after a peer connects that
  wasn't connected at its last try.
- **Rejected**: one record per person listing all roots (huge, rewritten on every change).

## R8. Tests with several people

- **Decision**: `test/helpers.js` gets `person(t, label)` (a new identity, own instance folder) and
  `sharedPair(t, files)` (Alice's space, Bob invited, a folder linked on each), like `linkedPair`.
- Run with `TEMP`/`TMP` on `E:\Code\P2P\.tmp` (C: nearly full).
