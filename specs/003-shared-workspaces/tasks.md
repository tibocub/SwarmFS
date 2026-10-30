---
description: "Tasks for SwarmFS 003 — shared workspaces: several people, one space of folders"
---

# Tasks: SwarmFS 003 — shared workspaces

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/api.md](contracts/api.md), [quickstart.md](quickstart.md)

**Tests**: test-first (constitution II): each story's test file is written and seen failing before its
code. Every test runs on Node and on Bare (constitution III): `npm run test:all` green after each story,
run with `TEMP=/e/Code/P2P/.tmp TMP=/e/Code/P2P/.tmp` (C: nearly full; delete leftovers there after).
Safety (SC-004) in every test with linked folders: 002's `assertNothingLost`.

**Blocked**: T009 needs swarmwire **S10**; T023's scenario 2 (trusted invites) needs hypergraph **H20**. Build
the rest; keep those tests marked `todo` with the request id until it lands. Never work around them.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- Paths are from the repository root (plan.md, Project Structure)

---

## Phase 1: Setup

- [ ] T001 [P] `test/helpers.js`: `person(t, label, opts)` (a new identity in its own instance folder,
  `SwarmFS.open` with `bootstrap`, `setName(label)`), `sharedPair(t, files)` (Alice creates a space,
  adds a folder of `files`, invites Bob; Bob joins and links it; both `sync()`ed; returns `{ alice, bob,
  aliceDrive, bobDrive, aliceDir, bobDir }`), like `linkedPair`
- [ ] T002 [P] Empty `lib/members.js` (plan.md structure)

## Phase 2: Foundational

- [ ] T003 `test/types.test.js` (failing first) then `lib/types.js`: append `from: 'string'` and
  `binned: 'uint'` (last fields) to `folder` and `file`; new types `profile: { fields: { name: 'string'
  }, onePerMember: true }` and `has: { fields: { root: 'string' }, index: [['root', 'stamp']] }`; rule
  `swarmfs/bin-v1`: "`parent !== 'bin'` or `from` non-empty"; rule `swarmfs/profile-v1`: "`name` 1–64
  characters, no control characters". A 002 instance folder opens with the new types; 002 records
  (no `from`, `binned`) accepted
- [ ] T004 `lib/members.js`: `isShared(space)` (more than one identity in `members()`, removed and
  banned included; cached per space, cleared on the space's `members` event) — used by T020, T024
- [ ] T005 `lib/members.js` + `lib/swarmfs.js`: `sfs.setName(name)` / `sfs.name()` (`hg.setSetting
  ('name')`), `publishName(space)` (`put('profile', { name })` when this person's latest differs), run
  on `setName`, `createSpace`, join, and `hg.on('spaces')` for every files space; `namesOf(space)` →
  Map identity → name (from `query('profile')`). Test in `test/invite.test.js` (T006)

## Phase 3: User Story 1 — Invite someone into a space (P1)

**Goal**: Bob joins Alice's space with a code, sees the tree, links a folder that fills.
**Independent test**: `test/invite.test.js`.

- [ ] T006 [US1] `test/invite.test.js` (failing first): spec story 1 scenarios 1–5 (join and list;
  link fills; used code `INVITE_USED_UP`; `uses`/`expires`; revoked `INVITE_REVOKED`, members stay);
  names shown in `members()`
- [ ] T007 [US1] `lib/swarmfs.js`: `createSpace(name, { invites = 'admins' })` defines roles `editor`
  and `trusted` (data-model.md "Roles"), `sfs.join(code)` (`hg.redeemInvite`, hypergraph's errors
  passed on, then `publishName`, → the Drive)
- [ ] T008 [US1] `lib/drive.js`: `invite({ uses = 1, expires })` → code (role `editor`),
  `revokeInvite(code)`, `members()` → `[{ identity, name, role, you, removed, banned, online }]`
  (`space.members()` + `namesOf` + `peers()`)
- [ ] T009 [US1] (**S10**) `test/invite.test.js` scenario 6 (failing first): Alice holds a file in her
  personal sync space and one in "Family"; Bob, in "Family" only, asks the first's root: 0 bytes
  (SC-005); the second arrives. Then `lib/transfer.js`: `resolve(root, peer)` answers from own
  `held` with that root whose `space` has `peer.publicKey` among `memberConnections()` devices; null
  otherwise (research R2)
- [ ] T010 [US1] `lib/sync.js` `holderOnline`: true also when a member device of the space other than
  this person's is online and connected after this root's last failed try (research R7); keep the
  per-root "tried with" set in memory, cleared on `peers`. `test/invite.test.js` scenario 2 green

## Phase 4: User Story 3 — Deleting in a shared space goes to the bin (P1)

Built before story 2: story 2's tests delete.
**Goal**: deletes in a shared space are moves to the bin; restore; empty by author/admin.
**Independent test**: `test/bin.test.js`.

- [ ] T011 [US3] `test/bin.test.js` (failing first): spec story 3 scenarios 1–6 with `sharedPair`;
  bin entries show `by` (the deleting person, from the version's `device` via `members()`), `binned`,
  `from`; a never-shared space deletes as 002; mass delete paused first; edge cases: restore into a
  folder emptied for good → top; a linked folder whose space folder is binned → paused `in-bin`,
  restored → resumed; Bob edits a file Alice bins (kept on Bob's disk, 002 FR-016)
- [ ] T012 [US3] `lib/drive.js` `remove(id)`: shared (T004) → `edit(id, { parent: 'bin', from:
  record.parent, binned: Date.now() })`, emit-free; else 002's subtree `del`
- [ ] T013 [US3] `lib/drive.js` `bin()` (`query('folder'|'file').where({ parent: 'bin' })`, newest
  `binned` first), `restore(id)` (`edit(id, { parent: from exists ? from : key, from: '', binned: 0 })`;
  NOT_FOUND if not in the bin), `emptyBin()` → `{ removed, kept }` (owner/admin: every entry, subtree
  first, `del`; others: entries they authored whose subtree is all theirs)
- [ ] T014 [US3] `lib/sync.js`: the local pass removes through `Drive.remove` (one place, T012);
  `read()` leaves `parent: 'bin'` out of orphans; a linked folder whose space folder or an ancestor has
  `parent: 'bin'` → paused `in-bin` (no file touched), resumed when not; `binned`/`restored` sync
  events for local paths leaving/re-entering through the bin
- [ ] T015 [US3] `lib/swarmfs.js` `links()`: `paused` may be `'in-bin'`; contracts/api.md matches

## Phase 5: User Story 2 — Everyone edits, nothing is lost (P1)

**Goal**: 002's linked folders between people; copy names by person.
**Independent test**: `test/shared.test.js`.

- [ ] T016 [US2] `test/shared.test.js` (failing first): spec story 2 scenarios 1–4 (Bob adds, edits,
  renames, moves Alice's files; concurrent edits → `report (<loser's name>'s copy).docx` on both
  within 20 s, SC-003; own devices → device name; no name → device name); SC-002 (1 MB across people
  < 10 s); two members with one name → `(Bob's copy 2)`
- [ ] T017 [US2] `lib/sync.js` `conflictCopy`: name = this person's name when the winning record's
  `author` ≠ this identity and a name is set, else this device's name; `read()`'s same-name placing
  uses the writer's person name (`namesOf`) for other identities, device names for own devices

## Phase 6: User Story 4 — Remove or ban a member (P2)

**Goal**: removal pauses the removed person's folders; ban "drop all" reaches disks as trash.
**Independent test**: `test/removal.test.js`.

- [ ] T018 [US4] `test/removal.test.js` (failing first): spec story 4 scenarios 1–5 with Alice, Bob,
  Carol (SC-006: 0 entries and 0 bytes reach Carol after removal); ban `dropAll` → Carol's files in
  Bob's trash, never re-added; Carol let back in → resumes; `leave`
- [ ] T019 [US4] `lib/drive.js`: `setRole(identity, role)` (`'admin' | 'trusted' | 'editor'`),
  `removeMember(identity, { ban, dropAll })` (`removeRole`, or `moderateAction('ban', who, { drop:
  dropAll ? 'all' : undefined })`)
- [ ] T020 [US4] `lib/sync.js` + `lib/swarmfs.js`: on the space's `status`, `access === 'none'` →
  every linked folder of that space paused `removed` (nothing written, fetched or trashed); `'full'`
  again → resumed with 002's catch-up; `links()` shows `'removed'`
- [ ] T021 [US4] `lib/swarmfs.js` `leave(spaceKey)`: `unlink` each linked folder of that space, then
  `hg.leaveSpace`; files stay
- [ ] T022 [US4] `lib/swarmfs.js`: `sfs.on('members', ({ space, joined, left }))` from each files
  space's `members` event, diffing identities (names from `namesOf`)

## Phase 7: User Story 5 — The creator chooses who may invite (P2)

**Goal**: everyone / chosen people / owner and admins, changeable.
**Independent test**: `test/invites.test.js`.

- [ ] T023 [US5] `test/invites.test.js` (failing first): spec story 5 scenarios 1, 3, 4, 5; scenario 2
  (`trusted` invites) `todo` until **H20**
- [ ] T024 [US5] `lib/members.js` + `lib/drive.js`: `invites()` read from `roles()` (`editor` has
  `invite` → `everyone`; else `trusted` has it → `chosen`; else `admins`), `setInvites(setting)`
  (`defineRole('editor' | 'trusted', perms)`); `invite()` refused with hypergraph's `NOT_ALLOWED`
  reason passed on

## Phase 8: User Story 6 — Choose to show what you hold (P3)

**Goal**: per person, per space, off by default; holders shown without paths.
**Independent test**: `test/holdings.test.js`.

- [ ] T025 [US6] `test/holdings.test.js` (failing first): spec story 6 scenarios 1–4; no `has` record
  in a space where the choice is off; never a path in another person's holder entry
- [ ] T026 [US6] `lib/drive.js` `showHoldings(on)`: setting `show-holdings` (array of space keys) on
  the person; off → this device deletes its `has` in that space; on → one `has` per root it holds
  there. Other devices apply it on `hg.on('settings')`
- [ ] T027 [US6] `lib/holdings.js`: wherever `held` is put or deleted for a space in `show-holdings`,
  put `has { root }` (none yet from this device) / delete it (no `held` of that root left there)
- [ ] T028 [US6] `lib/drive.js` `#withHolders`: add `{ identity, name, online }` per other person's
  device from `query('has').where({ root })` (online: `peers()`); own devices as before

## Phase 9: User Story 7 — From the shell (P3)

**Goal**: contracts/api.md's commands and lines. **Independent test**: `test/cli.test.js`.

- [ ] T029 [US7] `test/cli.test.js` (failing first): three shell processes, three identities: `name`,
  `create --invites`, `invite`, `accept`, a file across, `bin`, `restore`, `bin empty` (confirmation),
  `remove` → `paused … (removed from …)` line on the removed one
- [ ] T030 [US7] `bin/swarmfs.js`: commands `name`, `create --invites`, `invite`, `accept`, `invites`,
  `revoke`, `members`, `role`, `remove [--ban] [--drop-all]`, `leave`, `bin`, `restore`, `bin empty`,
  `show-holdings`; `<member>` by unique name or key prefix; lines `joined`, `left`, `binned`,
  `restored`, `paused … (removed from …)`, `paused … (in the bin)`

## Phase 10: Polish

- [ ] T031 [P] `specs/003-shared-workspaces/quickstart.md` played by hand on two shells; fix drift
- [ ] T032 [P] `CLAUDE.md` state line for spec 003; `specs/requests-to-*.md`: H19, H20, S10 status
- [ ] T033 `npm run test:all` on Node and Bare (TEMP/TMP on `E:\Code\P2P\.tmp`), leftovers deleted;
  SC-008: no networking, replication, crypto, permission or transfer code in `lib/` (grep for imports)

## Dependencies

- Setup → Foundational (T003 types first; T004, T005 after) → stories.
- US1 → US3 → US2 (US2's tests delete through the bin) → US4, US5, US6 (independent of each other)
  → US7 → Polish.
- T009 waits on swarmwire S10; T023's scenario 2 on hypergraph H20.

## Parallel opportunities

- T001 ∥ T002. After US1: US4, US5 and US6 touch different test files; `lib/drive.js` is shared by
  T019, T024, T026, T028 — one writer at a time there.

## Implementation strategy

- MVP: Phases 1–4 (invite + bin): two people share a folder safely, once S10 lands.
- Then US2 (names on copies), US4 (stop sharing), US5, US6, the shell.
