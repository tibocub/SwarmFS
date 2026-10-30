# Feature Specification: SwarmFS 003 — shared workspaces: several people, one space of folders

**Feature Branch**: `003-shared-workspaces`

**Created**: 2026-10-30

**Status**: Draft

**Input**: User description: "SwarmFS spec 003 'shared workspaces': several people share a space of
folders (today one person on several devices)." Builds on specs 001 (personal sync) and 002 (always
on: linked folders, trash, conflict copies, pause). Tibo's choices (2026-10-30, this spec's session)
are marked *(Tibo)*; the rest are defaults listed under Assumptions.

Words used below (specs 001 and 002's words still hold: space, entry, content, held, linked folder,
trash, conflict copy):
- **Person / member**: someone in a space, with all their devices. Spec 001/002 had one person.
- **Shared space**: a space with more than one person in it, now or before.
- **Bin**: a shared space's list of deleted entries, the same for every member, restorable. Not the
  trash: the trash (spec 002) is a folder on one device's disk; the bin is in the space.
- **Name**: the name a person shows others ("Alice"), chosen by them.
- **Invite code**: a one-time code (or a code with several uses) that lets someone into a space.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Invite someone into a space (Priority: P1)

Alice has a space "Family" (made as in spec 001). She makes an invite code and sends it to Bob any way
she likes (chat, mail). Bob enters it; he is now a member: he sees the whole tree, and links the
folders he wants on his PC (spec 002). Alice and Bob each choose a name once; it is what the other
sees in member lists and copy names.

**Why this priority**: nothing is shared before someone else is in.

**Independent Test**: two people (two identities) on a local network: Alice makes a code, Bob joins
with it, lists the tree, links a folder; the folder fills. A used code is refused for a third person.

**Acceptance Scenarios**:

1. **Given** Alice's space with files, **When** she makes an invite and Bob joins with it, **Then**
   Bob lists the same tree, and Alice's member list shows "Bob, member".
2. **Given** Bob a member, **When** he links a space folder to a local path, **Then** it fills with
   Alice's files (fetched from Alice's online devices, verified), as between one person's devices.
3. **Given** a code with one use, already used, **When** Carol tries it, **Then** she is refused and
   told why; nothing changed.
4. **Given** a code made with several uses or an end date, **When** used beyond them, **Then** refused.
5. **Given** Alice revokes a code, **When** someone tries it, **Then** refused; members already in stay.
6. **Given** Alice's other files spaces and her personal space, **When** Bob is in "Family", **Then**
   he can't see or fetch anything from them, even knowing a file's hash.

---

### User Story 2 - Everyone edits, nothing is lost (Priority: P1)

Inside a shared space every member adds, edits, renames and moves files and folders, theirs and
others', exactly as one person did across devices in spec 002. Two people editing one file while apart
both keep their version: the losing one is kept as `report (Bob's copy).docx` — named after the
person, not the device *(Tibo)*.

**Why this priority**: the reason to share a folder.

**Independent Test**: Alice and Bob, a folder linked on each: each adds, renames, moves and edits the
other's files; disconnect, both edit `report.docx`, reconnect.

**Acceptance Scenarios**:

1. **Given** a folder linked by Alice and Bob, **When** Bob adds, edits, renames or moves a file
   Alice added, **Then** Alice's disk follows (spec 002's rules, replaced versions in her trash).
2. **Given** both edit `report.docx` while apart, **When** they reconnect, **Then** both have
   `report.docx` (the latest) and `report (<loser's name>'s copy).docx`, the same on both, no version
   lost.
3. **Given** two of Bob's own devices edit one file while apart, **When** they meet, **Then** the copy
   is named after the device, as in spec 002 (`report (laptop's copy).docx`).
4. **Given** a person who hasn't chosen a name, **When** their version loses, **Then** the copy is
   named after their device.

---

### User Story 3 - Deleting in a shared space goes to the bin (Priority: P1)

In a shared space, deleting a file or folder (on disk in a linked folder, or with `remove`) moves it to
the space's bin instead of erasing it, whoever added it *(Tibo)*. It leaves everyone's folders (into
each device's trash, spec 002); any member lists the bin and restores an entry to where it was. The
bin is emptied for good only by the entry's author, or by an owner or admin for anyone's entries.

**Why this priority**: in hypergraph only a record's author (and moderators) may delete it (Tibo,
2026-10-09: one vandal must not erase a shared page). Without the bin, Bob couldn't delete Alice's
file at all; with it, nobody's mistake is final.

**Independent Test**: Alice and Bob, a folder linked on each: Bob deletes Alice's file and a folder
holding files of both; check both disks, the bin, restore; Bob tries to empty the bin; Alice empties.

**Acceptance Scenarios**:

1. **Given** Alice's `budget.xlsx` in a linked folder on both, **When** Bob deletes it on his disk,
   **Then** it is in the bin (with who deleted it, when, and where it was) and gone from both folders
   (each copy in its device's trash).
2. **Given** a folder holding files of Alice and Bob, **When** Bob deletes the folder, **Then** the
   folder and all it holds go to the bin together.
3. **Given** an entry in the bin, **When** any member restores it, **Then** it is back where it was
   (or at the space's top if that folder is gone), and the linked folders fetch it again.
4. **Given** the bin, **When** Bob empties it, **Then** only entries Bob added are deleted for good;
   **When** Alice (owner) or an admin empties it, **Then** all are.
5. **Given** a space with only one person in it, ever, **When** they delete, **Then** spec 002's
   behaviour stays (the entry is deleted, no bin).
6. **Given** 600 of a 1,000-file shared folder deleted at once, **When** SwarmFS sees it, **Then**
   spec 002's mass-delete pause applies before anything goes to the bin.

---

### User Story 4 - Remove or ban a member (Priority: P2)

The owner or an admin removes Carol from "Family". Carol keeps every file on her disk; her linked
folders of that space stop syncing and her shell says so *(Tibo)*. She can't read what is added after.
The others keep her files' entries and their own copies. A ban can also drop everything she added;
on the others' disks those files go to the trash, never erased.

**Why this priority**: sharing needs a way to stop sharing.

**Independent Test**: Alice, Bob, Carol: Alice removes Carol, adds a file; Carol's disk unchanged, her
folder stopped, the new file never reaches her; Bob still has Carol's files. Then a ban with "drop
all": Carol's files leave Bob's folder into his trash.

**Acceptance Scenarios**:

1. **Given** Carol a member with a linked folder, **When** Alice removes her, **Then** Carol's local
   files are untouched, her linked folder is paused ("removed from Family"), and files added afterwards
   never reach her.
2. **Given** Carol removed, **When** Bob lists the tree, **Then** Carol's files are still there; files
   only Carol held are no longer fetchable from her.
3. **Given** Alice bans Carol with "drop all", **When** Bob's device applies it, **Then** Carol's
   entries are gone for everyone and Bob's copies are in his trash.
4. **Given** Carol let in again (a new invite), **When** she joins, **Then** her linked folders resume
   (spec 002's catch-up both ways).
5. **Given** a member who wants out, **When** they leave the space, **Then** its linked folders on
   their devices stop, their files stay on disk, and the others keep everything.

---

### User Story 5 - The creator chooses who may invite (Priority: P2)

When making a space, its creator chooses who may invite people, and can change it later *(Tibo)*:
**everyone** (any member invites), **chosen people** (the owner, admins and members given the
"trusted" role), or **owner and admins**. A space with no admins is then invited to by its owner only.

**Why this priority**: a family album and a club archive need different control; like "private or
public", it is the creator's call.

**Independent Test**: three spaces, one per setting: a plain member, a trusted member and an admin
each try to make an invite; switch a space's setting and try again.

**Acceptance Scenarios**:

1. **Given** "everyone", **When** Bob (member) makes an invite, **Then** it works, and whoever joins
   with it may invite too.
2. **Given** "chosen people", **When** Bob (member) tries, **Then** refused, saying who may;
   **When** Alice makes Bob trusted, **Then** Bob's invites work and let people in as plain members.
3. **Given** "owner and admins", **When** a member or a trusted member tries, **Then** refused.
4. **Given** a space switched from "everyone" to another setting, **When** a member tries, **Then**
   refused; codes made before stay valid until used, expired or revoked.
5. **Given** any setting, **When** anyone tries to invite someone as owner or admin, **Then** only
   the owner (admins: below admin) may, as hypergraph rules.

---

### User Story 6 - Choose to show what you hold (Priority: P3)

In each shared space, each person chooses whether the others see which files their devices hold
("Alice's PC has it, offline") *(Tibo)*. Off by default: in a space you don't fully trust, saying "I
hold this hash" tells anyone who knows that hash that you have that file. Off or on, a missing file
is fetched from any member online who has it.

**Why this priority**: useful in a family space (who to wait for), but fetching works without it.

**Independent Test**: Alice and Bob: with Alice's choice off, Bob sees "not here" for her file and
still fetches it while she is online; Alice turns it on, Bob sees "Alice, online / offline"; she turns
it off, Bob no longer sees it.

**Acceptance Scenarios**:

1. **Given** Alice's choice off (the default), **When** Bob lists her file, **Then** he sees only
   whether he holds it; **When** he fetches it with Alice online, **Then** it arrives.
2. **Given** Alice turns it on in "Family", **When** Bob lists, **Then** each file Alice's devices hold
   shows "Alice" with online or offline — never a path; her other spaces are unaffected.
3. **Given** Alice turns it off, **When** Bob lists, **Then** Alice no longer shows as a holder.
4. **Given** a file nobody online holds, **When** a member who holds it comes online, **Then** linked
   folders waiting for it fetch it (spec 002), whatever the choices.

---

### User Story 7 - From the shell (Priority: P3)

The `swarmfs` shell gets the commands for stories 1–6: `name`, `invite`, `accept`, `invites` (revoke,
list), `members`, `role`, `remove`, `ban`, `leave`, `bin`, `restore`, `bin empty`, `show-holdings`, and
the invite setting at `create`. It prints a line when someone joins, leaves, or when this device is
removed.

**Why this priority**: Tibo tries it with real people; adds no behaviour of its own.

**Independent Test**: three shell processes, three identities: invite, accept, a file across, a
delete to the bin, a restore, a removal.

**Acceptance Scenarios**:

1. **Given** two shells of two people, **When** one runs `invite Family` and the other `accept
   <code>`, **Then** the second lists "Family" and can link its folders.
2. **Given** `bin empty`, **When** run, **Then** it says how many entries will be deleted for good
   and asks for confirmation.

### Edge Cases

- **Bob edits a file while Alice moves it to the bin**: the edit lands on the entry in the bin; on
  Bob's disk the unrecorded edit is kept (spec 002 FR-016: re-added as an entry, not trashed).
- **Restoring into a folder that was emptied for good**: restored at the space's top.
- **A folder someone else linked goes to the bin** (Bob removes `Photos`, which Alice linked as a
  whole): Alice's linked folder is paused ("in the bin"), her files untouched; restored, it resumes.
- **Two people restore and delete one entry at once**: latest wins, the same for everyone.
- **A ban with "drop all" of someone who renamed others' files**: their edits up to the ban stay
  (hypergraph's rule); only their own entries go.
- **The last owner device lost**: hypergraph's "give a space an admin" applies; SwarmFS warns when a
  shared space has no admin (`status()` warning shown in `members`).
- **A removed member's device still connected**: it serves and receives nothing for that space at
  once (hypergraph's member streams end).
- **Same file in two spaces, Bob in only one**: Bob may fetch it only as an entry of a space he is in.
- **Names**: two members with the same name: copies get a number (`(Bob's copy 2)`), as in spec 002;
  a name is shown, never trusted as identity (member lists also show a short key).
- **A newcomer joining a big space** (thousands of files): sees the tree (hypergraph H17 fixed);
  fetches only what they link.
- **Leaving the last owner role**: refused by hypergraph (an owner can't leave ownership).

## Requirements *(mandatory)*

### Functional Requirements

**Members and invites**

- **FR-001**: An owner (and whoever the space's invite setting allows) MUST be able to make an invite
  code with a number of uses and an end date, list and revoke codes; a person MUST be able to join with
  a code and then see the space's whole tree.
- **FR-002**: The creator MUST choose who may invite when making a space — everyone, chosen people
  (owner, admins, members with the "trusted" role) or owner and admins — and the owner MUST be able
  to change it later; codes made before a change stay valid.
- **FR-003**: Owners and admins MUST be able to list members (name, role, short key), give or take the
  admin and trusted roles, remove and ban members (optionally dropping all they added).
- **FR-004**: A person MUST be able to set a name, the same on all their devices, shown to every
  member of their shared spaces.
- **FR-005**: A member MUST be able to leave a space; its linked folders on their devices stop; no
  local file is changed.

**Working together**

- **FR-006**: Every member MUST be able to add, edit, rename and move any entry (spec 002's linked
  folders work unchanged between people).
- **FR-007**: A conflict copy MUST be named after the person whose version lost when the winning
  version is another person's (`name (<name>'s copy).ext`), after the device otherwise; no name →
  the device.
- **FR-008**: A device MUST serve a file to a peer only if the file is an entry of a space that peer
  is a member of and this device holds it as that space's entry; nothing of other spaces or of the
  personal space, whatever hash is asked.
- **FR-009**: A missing file MUST be fetched from any online member who has it, whether or not
  holdings are shown (FR-015).

**Bin**

- **FR-010**: In a shared space, deleting an entry MUST move it (with its subtree) to the bin, kept
  with who deleted it, when, and where it was; a space never shared keeps spec 002's delete.
- **FR-011**: Every member MUST be able to list the bin and restore an entry to where it was (the top
  if that folder is gone).
- **FR-012**: Emptying the bin MUST delete for good only the entries this person may delete: their own;
  all of them for an owner or admin. The shell MUST confirm first.
- **FR-013**: Linked folders MUST treat an entry moved to the bin as removed (local file to the trash)
  and a restored one as new (fetched).

**Removal**

- **FR-014**: When this device's person is removed or banned from a space, its linked folders of that
  space MUST stop (no file changed, no entry written), say why, and resume if they are let back in.
  When a ban drops someone's entries, other devices MUST treat them as removed (trash, never erase).

**Holdings**

- **FR-015**: Each person MUST be able to choose, per shared space, whether their devices show the
  others which files they hold (content only, never paths); off by default; turning it off withdraws
  it.

**Host and proof**

- **FR-016**: The shell MUST offer stories 1–6's commands and print a line when a member joins or
  leaves and when this device is removed; one-shot commands as in spec 002.
- **FR-017**: Stories 1–6 MUST each be played by scenario tests through the public API with two or
  three people (identities) on a local network; story 7 by tests driving shell processes; the suite
  MUST run on Node and Bare.

### Key Entities

- **Member**: a person in a space: role (owner, admin, trusted, editor/member), name, devices.
- **Name**: chosen by a person, published in each shared space they are in.
- **Invite setting**: per space: everyone / chosen people / owner and admins.
- **Bin entry**: an entry moved to the bin: who deleted it, when, its former folder.
- **Shown holding**: "a device of this person holds this content", in one space, only if that person
  chose to show it there.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A newcomer joins with a code and lists a 1,000-file tree within 15 seconds (local
  network, inviter online).
- **SC-002**: A 1 MB file added by one person is on another person's linked folder, verified, within
  10 seconds (as spec 002 between devices).
- **SC-003**: Concurrent edits of one file by two people end, within 20 seconds of reconnecting, with
  both versions on both disks, the copy named after the losing person; 0 versions lost.
- **SC-004**: In every test, no file is destroyed: deleting, removing, banning and emptying the bin
  leave every local file either in place or in its linked folder's trash; only `trash empty` erases
  bytes on a disk.
- **SC-005**: A member asking for a hash held only in another space (or the personal space) gets 0
  bytes, in every test.
- **SC-006**: A removed member receives 0 entries and 0 bytes added after the removal.
- **SC-007**: Restoring an entry from the bin puts it back on every linked folder within 10 seconds.
- **SC-008**: The suite passes on Node and Bare; SwarmFS still has no networking, replication,
  cryptography, permission or transfer code of its own.

## Later stories (outline, not built here)

1. **Viewers (read-only members)**: see and fetch, never change *(Tibo: later; hypergraph H6)*; with
   community archives.
2. **Community archives**: many members, uploaders vs readers, public read invites, moderation.
3. **Owner-only invites with admins present**: needs hypergraph to let a space take `invite` from its
   admins (H19).
4. **Sub-spaces for big archives** (spec 001's later story 3): a folder made a sub-space with its own
   members.
5. **Fetching from outside the space** (swarmwire content topics), together with how much to reveal
   about what one holds.
6. **Bin auto-emptying** after N days (a user setting, with spec 002's trash settings).

## Assumptions

- Spaces stay private (hypergraph `private: true`): a removed member can't read what comes after, and
  newcomers read the whole history (hypergraph's default `visible`).
- Any existing space becomes shared by inviting someone into it; no separate "shared space" kind. Once
  a second person has been in, it stays a shared space for the bin rule (FR-010).
- Everyone invited can write (no viewers in 003, Tibo); invitees join as a writing role; roles beyond
  owner, admin and trusted are not offered.
- Names are labels chosen by each person; they aren't unique and aren't proof of who someone is.
- The bin keeps entries until emptied; their bytes stay wherever members hold them (on disks, in
  trashes) and are not fetched into linked folders while in the bin.
- A removed member's copies on their disk are theirs; SwarmFS can't and won't reach into them.
- Desktops, a handful of people per space (2–20), home connections; figures on a local test network.
