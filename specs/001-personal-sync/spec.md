# Feature Specification: SwarmFS v1 — personal sync across two devices of one identity

**Feature Branch**: `001-personal-sync`

**Created**: 2026-10-22

**Status**: Draft

**Input**: User description: "SwarmFS v1: personal sync across two devices of one identity" — see on
the phone what the PC holds, fetch it while the PC is online. Folders and files are records in a
hypergraph space (`hypergraph/next`, spec 011); bytes move through swarmwire, served in place, never
copied into a store. Decisions: hypergraph `ROADMAP.md` (2026-10-08 and newer) and the SwarmFS design
discussion of 2026-09/10 (Q1–Q30), newer documents winning where they differ.

Who the "user" is: a developer embedding SwarmFS (library), and the person using an app built on it.
v1's proof is a set of scenario tests through the public API (like hypergraph's forum tests), plus a
thin CLI to try it on two real machines.

Words used below:
- **Space**: hypergraph's one building block. A personal sync folder is a space with only you in it.
- **Entry**: a folder or a file in a space's tree, seen by every device of every member.
- **Content**: a file's bytes, named by their BLAKE3 hash (the value `b3sum` prints).
- **Held**: a device has a local file whose content is that hash. One hash, possibly many local paths.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Add files in place and see the tree (Priority: P1)

On the PC, the person creates a space ("My files") and adds a folder from their disk. SwarmFS lists
it as a tree of folders and files, without copying any byte: each file is hashed where it lies and
stays where it is. Two identical files are one content with two local paths.

**Why this priority**: everything else reads this tree; it proves "the bytes stay where they are".

**Independent Test**: one device, no network: add a folder of files (with a duplicate and a nested
folder), list the tree, check no file was written or copied anywhere.

**Acceptance Scenarios**:

1. **Given** a folder `photos/` with `a.jpg`, `b.jpg` and `trip/c.jpg`, **When** the person adds it to
   a space, **Then** the space lists `photos` with `a.jpg`, `b.jpg` and the folder `trip` holding
   `c.jpg`, each file with its name, size and content hash.
2. **Given** `a.jpg` and a copy of it elsewhere, **When** both are added, **Then** they are two entries
   with one content, held here at two paths.
3. **Given** a file added, **When** the add completes, **Then** nothing was written next to the file or
   into any store; the instance folder grew only by records.

---

### User Story 2 - A second device sees everything, and who holds what (Priority: P1)

The person pairs their phone with the PC by a code. The phone then shows the same spaces and the
whole tree, and for each file which of the person's devices holds it — also when the PC is off.

**Why this priority**: "see on the phone what the PC holds" is the v1 promise.

**Independent Test**: two devices on a local network: pair by code, list the tree on the phone, close
the PC, list again on the phone.

**Acceptance Scenarios**:

1. **Given** a PC with a space and added files, **When** the phone joins with a code shown on the PC,
   **Then** the phone lists the same space and tree without retyping anything.
2. **Given** the paired phone, **When** it lists a file, **Then** it sees that the PC holds it, and
   whether the PC is online now.
3. **Given** the PC closed, **When** the phone lists the tree, **Then** every entry is still shown,
   marked as held by the PC, not available now.
4. **Given** someone who is not one of the person's devices, **When** they try to open the space or the
   holdings, **Then** they get nothing.

---

### User Story 3 - Fetch a file from the other device (Priority: P1)

On the phone, the person picks a file held by the PC and a place to put it. SwarmFS fetches it from
the PC while the PC is online, verifies every piece before writing it, and records that the phone now
holds it too. If the phone already holds that content somewhere, nothing is downloaded.

**Why this priority**: the transfer half of v1; proves hypergraph and swarmwire work together.

**Independent Test**: two devices: fetch a file to a chosen path, compare bytes; fetch a file whose
content the phone already holds; fetch with the PC offline; interrupt and resume.

**Acceptance Scenarios**:

1. **Given** the PC online holding `a.jpg`, **When** the phone fetches it to a path, **Then** the file
   at that path has the same bytes, and both devices now show the phone as a holder.
2. **Given** the phone already holds that content at another path, **When** it fetches the entry,
   **Then** nothing is downloaded or copied and the existing local path is given back.
3. **Given** the PC offline, **When** the phone fetches, **Then** it is told "not available now"
   within a bound, and nothing is left half-written at the path.
4. **Given** a fetch interrupted halfway (the PC goes offline), **When** the PC comes back and the
   fetch is asked again, **Then** it resumes and ends with the right bytes.
5. **Given** a peer sending wrong bytes, **When** the phone fetches, **Then** no wrong byte is written.

---

### User Story 4 - Keep the tree up to date (Priority: P2)

The person changes things: a file edited or removed on disk, new files, renaming or moving entries,
removing entries. A rescan updates the tree from the disk; removing an entry never deletes a local
file.

**Why this priority**: a sync tool must follow changes; the safety rule on deletes is decided.

**Independent Test**: two devices: edit, delete and add files on the PC's disk, rescan, check the
phone's tree; rename, move and remove entries from the phone, check the PC's tree and disk.

**Acceptance Scenarios**:

1. **Given** an added file edited on disk, **When** the device rescans, **Then** the entry shows the
   new size and content on every device, and the old content is no longer listed as held there.
2. **Given** an added file deleted from disk, **When** the device rescans, **Then** the entry stays in
   the tree and is no longer held by that device.
3. **Given** a new file in an added folder, **When** the device rescans, **Then** it appears.
4. **Given** an entry renamed or moved on the phone, **When** the PC lists, **Then** it sees the new
   name or place; no local file was renamed or moved.
5. **Given** an entry (or a folder) removed on the phone, **When** the PC lists, **Then** it is gone
   for both devices, and the PC's local files are untouched.

---

### User Story 5 - Try it on two machines (Priority: P3)

A thin command line lets the person do stories 1–4 on two real machines: create a space, add a
folder, pair a device, list, fetch, rescan.

**Why this priority**: lets Tibo use v1 for real; adds no behavior of its own.

**Independent Test**: the CLI run as two processes against a local DHT: pair, add, list, fetch.

**Acceptance Scenarios**:

1. **Given** two machines, **When** the person runs the documented commands, **Then** the second lists
   the first's files and fetches one.

### Edge Cases

- **Both devices offline, then reconnecting**: entries added on each while apart appear on both.
- **Concurrent edits of one entry from two offline devices** (renamed differently on each): one
  version wins, the same on both devices (hypergraph's latest-wins). No local file is lost: each
  device keeps its own files. (Keeping both as two entries is a later story.)
- **A file changed on disk but not rescanned yet**: a peer asking for the old content gets "not
  available" from this device, never wrong bytes.
- **Two files with the same name in one folder** (added from two devices): both listed.
- **Removing a folder while the other device adds a file into it offline**: the orphan entry is moved
  to the top of the space at the next rescan of the device that added it, never lost.
- **A pairing code used twice, expired, or wrong**: refused, nothing changed.
- **Fetching to a path that already exists**: refused; SwarmFS never overwrites a local file.
- **A device removed from the account** (lost phone): it no longer receives new entries or bytes.

## Requirements *(mandatory)*

### Functional Requirements

**Tree**

- **FR-001**: A person MUST be able to create a space for their files and see it on all their devices.
- **FR-002**: Adding a local file or folder MUST hash each file in place and record an entry per file
  and folder (name, place in the tree, size, content hash); it MUST NOT copy or write any file content.
- **FR-003**: Every device MUST see the whole tree of every space, including entries no online device
  holds.
- **FR-004**: Entries MUST be renamable, movable and removable from any of the person's devices.
- **FR-005**: Removing an entry MUST NOT delete, move or change any local file, on any device.

**Holdings**

- **FR-006**: Each device MUST record which content it holds (hash, local path, size, last change
  time), privately to the person's own devices, so every device sees what each one holds even while it
  is offline.
- **FR-007**: A content MUST be able to have several local paths on one device; identical files are
  one content.
- **FR-008**: A rescan MUST update entries and holdings from the disk: changed files (new hash),
  removed files (no longer held; entry kept), new files in added folders.

**Transfer**

- **FR-009**: Fetching an entry MUST first look for its content held on this device; if found, give
  that local path and transfer nothing.
- **FR-010**: Otherwise it MUST download from the person's online devices holding it, to a path the
  caller gives, verifying every piece against the hash before writing it, resuming after interruption.
- **FR-011**: A fetch MUST NOT overwrite an existing local file, and MUST end within a bound with "not
  available now" when no holder answers.
- **FR-012**: A device MUST serve only content it holds, read in place, and only to peers of the space;
  a file changed on disk since it was hashed MUST NOT be served under the old hash.
- **FR-013**: A finished fetch MUST be recorded as held by the fetching device.

**Devices**

- **FR-014**: A second device MUST join the person's account with a code from a device already in, and
  then see every space, the trees and the holdings; a removed device stops receiving them.

**Runtimes and proof**

- **FR-015**: The library and its tests MUST run on Node and on Bare.
- **FR-016**: Stories 1–4 MUST each be played by scenario tests through the public API, with real
  devices on a local network.

### Key Entities

- **Space**: a set of people and their devices, holding a tree of entries. v1: one person.
- **Folder entry**: a name and a parent folder (or the space's top).
- **File entry**: a name, a parent folder, a size and a content reference (hash).
- **Holding**: "this device holds this content at this local path (this size, this change time)" —
  private to the person's devices.
- **Device**: one of the person's computers or phones; holds, serves and fetches.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Adding a folder of 1,000 files writes no file content anywhere (only records), and the
  tree is listable right after.
- **SC-002**: A paired device shows the other device's tree and holdings within 10 seconds on a local
  network, and still shows them with the other device offline.
- **SC-003**: A fetched 100 MB file is byte-identical to the original, and a fetch interrupted at any
  point resumes to the same result.
- **SC-004**: A fetch of content already held locally transfers 0 bytes.
- **SC-005**: A fetch with no online holder returns "not available now" within its bound (default
  stated in the docs), in every test.
- **SC-006**: No test or flow deletes, moves or overwrites a local file.
- **SC-007**: The whole suite passes on Node and on Bare.
- **SC-008**: SwarmFS's library code has no networking, replication, cryptography or transfer code of
  its own (only hypergraph and swarmwire calls).

## Later stories (outline, not built in v1)

Named so v1 doesn't block them; each gets its own spec.

1. **Shared workspaces**: invite people with a role (hypergraph invite links carry roles); every
   member adds, renames, moves, removes; who holds what is shared as hashes only (no paths) in the
   space; conflicting edits of one file kept as two entries ("name (device's copy)").
2. **Community archives**: many members, readers vs uploaders (roles), moderation (hypergraph's
   hide/remove/ban), public read invites.
3. **Sub-spaces for big archives**: a folder made a sub-space (its own records, members, write roles);
   a folder entry pointing at a space; a member holds only the sub-spaces it opens.
4. **Local paths and "download when available"**: per-device rules mapping a folder to a local path
   (`Pictures` → `~/Pictures`), a want list fetched when a holder comes online, automatic download per
   space, finding a file's content anywhere on disk, folder watching.
5. **Beyond own devices for bytes**: fetching from holders outside the space (swarmwire content topics),
   a daemon that keeps seeding, a desktop/mobile client (Pear).

## Assumptions

- The person's devices are on ordinary home connections; figures are measured on a local test network.
- v1 has one person per space; spaces are private (only the person's devices read them).
- Fetching is explicit (no automatic download in v1); the caller (app or CLI) chooses the path.
- A device hosts everything it holds; nothing is announced or hashed per file for serving: peers
  meet on the space's one topic, and a file is opened only when a peer asks for it (Tibo,
  2026-10-27). Adding a file hashes it once, because the hash is the entry.
- A partial download stays under a temporary name until complete and verified.
- Changes on disk are picked up by a rescan (asked by the app, and at open), not by watching folders.
- Budgets and storage policies of hypergraph cover the records, not the files (hypergraph FR-027).
- Hypergraph's latest-wins settles concurrent edits of one entry; v1 shows the winner only.
