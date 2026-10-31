# Implementation Plan: SwarmFS 003 — shared workspaces

**Branch**: `003-shared-workspaces` (worktree branch `claude/003-shared-workspaces-4ddccc`) | **Date**: 2026-10-30 |
**Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-shared-workspaces/spec.md`

## Summary

Several people in one files space. Hypergraph already does invites, roles, removal, bans with "drop
all", private keys and shared editing; SwarmFS adds what is about files: a **bin** (deleting = an edit
moving the entry to `parent: 'bin'`, because only authors and moderators may truly delete), copy names
by **person** (a `profile` record per space), an **invite setting** built from two custom roles,
linked folders **paused** when this person is removed or their folder is in the bin, opt-in **shown
holdings** (a `has` record per held root), and serving **scoped by peer and space** (swarmwire S10).
Reasons: [research.md](research.md); types: [data-model.md](data-model.md); API:
[contracts/api.md](contracts/api.md).

## Technical Context

**Language/Version**: JavaScript, ESM, no build step; Node ≥ 20 and Bare ≥ 1.27 (as 001/002)
**Primary Dependencies**: `hypergraph` (`hypergraph/next`, master with spec 014), `swarmwire-lib` (needs
S10) — no new dependency
**Storage**: none of our own; records in hypergraph; trash as 002
**Testing**: `brittle` on Node and Bare, local DHT, two or three identities per test; `TEMP`/`TMP` on
`E:\Code\P2P\.tmp`
**Target Platform**: desktops running the shell (Node); library and tests also on Bare
**Project Type**: library + thin CLI
**Performance Goals**: SC-001 (join + list 1,000 entries < 15 s), SC-002 (1 MB across people < 10 s),
SC-003 (conflict settled < 20 s), SC-007 (restore < 10 s)
**Constraints**: nothing destroyed (bin, trash); nothing served outside its space; removed members
receive nothing new; members of a space update together (new types and rules)
**Scale/Scope**: 2–20 people per space, folders of thousands of files

## Constitution Check

*Gate before research, re-checked after design (constitution 1.1.0): passes.*

- **I. Bytes stay where they are**: no store; the bin is records only (no bytes kept or fetched for
  binned entries); everything leaving a linked folder goes to its trash (002); a removed member's
  files are never touched; a ban's "drop all" reaches disks as removals → trash. ✅
- **II. Test-first through the public API**: one scenario test file per story with 2–3 identities;
  safety asserted with 002's `assertNothingLost`; SC-005 tested by asking another space's hash. ✅
- **III. Node and Bare**: no new built-ins; same suite on both. ✅
- **IV. Compose, don't reimplement**: invites, roles, removal, bans, keys, shared editing,
  `put`/`del` permissions are hypergraph's; bytes and peer scoping swarmwire's. Gaps filed, not worked
  around: **S10** (resolve by peer: blocks FR-008), **H19** (owner-only invites with admins), **H20**
  (a trusted role inviting editors). ✅
- **V. Smallest complete design**: two appended fields, two types, two rules, two custom roles, no new
  file in `lib/` but `members.js`; viewers, sub-spaces, bin auto-empty left as later stories. The
  permanent parts (fields, types, role names) decided once (R3–R5). ✅

## Which hypergraph and swarmwire calls each part uses

| Part (file) | hypergraph (`hypergraph/next`) | swarmwire |
|---|---|---|
| Types (`lib/types.js`) | `from`, `binned` appended; `profile`, `has`; rules `bin-v1`, `profile-v1` | — |
| Names (`lib/members.js`) | `setSetting('name')`, `settings`, `put('profile')`, `query('profile')` | — |
| Invites, roles, removal (`lib/members.js`, `lib/swarmfs.js` `join`/`leave`) | `createInvite`, `redeemInvite`, `revokeInvite`, `defineRole`, `roles`, `setRole`, `removeRole`, `moderateAction('ban', { drop })`, `members`, `leaveSpace` | — |
| Bin (`lib/drive.js`) | `edit`, `query().where({ parent: 'bin' })`, `del` (author; moderator take-down) | — |
| Pause removed / in-bin (`lib/sync.js`) | `status().access`, `on('status')`, `on('members')` | — |
| Copy names (`lib/sync.js`) | record `author`, `profile` | — |
| Shown holdings (`lib/holdings.js`, `drive.js`) | `put/del('has')`, `query('has').where({ root })`, `peers()` | — |
| Serving (`lib/transfer.js`) | `memberConnections()` | `resolve(root, peer)` (**S10**) |
| Due fetches (`lib/sync.js`) | `on('peers')` | `download`, `stalled` |
| CLI (`bin/swarmfs.js`) | through the library only | — |

## Project Structure

### Documentation (this feature)

```text
specs/003-shared-workspaces/
├── spec.md  plan.md  research.md  data-model.md  quickstart.md
├── contracts/api.md
├── checklists/requirements.md
└── tasks.md
specs/requests-to-hypergraph.md      # + H19, H20
specs/requests-to-swarmwire.md       # + S10
```

### Source Code (repository root)

```text
lib/
├── types.js       # + from, binned; profile, has; rules bin-v1, profile-v1
├── members.js     # NEW: names (profile), invite setting (roles), members list, join/leave helpers
├── swarmfs.js     # + setName, name, join, leave, createSpace({ invites }), 'members' events
├── drive.js       # + invite, revokeInvite, invites, setInvites, members, setRole, removeMember,
│                  #   remove → bin when shared, bin, restore, emptyBin, showHoldings; holders from `has`
├── holdings.js    # + `has` kept with `held` where shown
├── sync.js        # + pause 'removed' / 'in-bin', bin-aware orphans, copy names by person,
│                  #   fetch tries any member peer (R7)
└── transfer.js    # resolve(root, peer) scoped by space
bin/swarmfs.js     # commands of contracts/api.md, member and bin lines
test/
├── helpers.js         # + person(), sharedPair()
├── invite.test.js     # story 1
├── shared.test.js     # story 2
├── bin.test.js        # story 3
├── removal.test.js    # story 4
├── invites.test.js    # story 5
├── holdings.test.js   # story 6
└── cli.test.js        # + story 7
```

**Structure Decision**: 002's layout plus `members.js` (names, roles and the invite setting are one
job, kept out of `drive.js`, ~190 lines, and `sync.js`, ~690, past the ~300-line rule already).

## Sequencing and blockers

1. Ask first: **S10** (swarmwire) — blocks FR-008/SC-005, so nothing reaches real people before it.
   H19 and H20 block only "owner only with admins" (later) and trusted invites (story 5 scenario 2).
2. Order: types + helpers → story 1 (invite, join; serving scope test red until S10) → story 3 (bin;
   before 2, because shared editing tests delete) → story 2 → story 4 → story 5 → story 6 → story 7.
3. Upgrade: 003 adds types and rules: all members on 003 before sharing (002 isn't released: no
   migration). A 002 app would treat binned entries as orphans (R3).
4. Risk: `members()` read per local pass to know "shared" — cached, refreshed on `members`.

## Complexity Tracking

None.
