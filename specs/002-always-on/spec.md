# Feature Specification: SwarmFS 002 — always on: linked folders that sync on their own

**Feature Branch**: `002-always-on`

**Created**: 2026-10-28

**Status**: Draft

**Input**: User description: "SwarmFS spec 002 'always on'": the running `swarmfs` shell keeps the
person's folders in sync by itself — watching the disk, fetching what is missing, serving, applying
changes made elsewhere — with nothing ever destroyed (replaced or removed files go to a trash).
Every decision below is Tibo's (lead conversation, 2026-10-28; hypergraph `ROADMAP.md`) unless the
Assumptions section says otherwise. Builds on spec 001 (v1: personal sync, two devices, one person).

Words used below (spec 001's words still hold: space, entry, content, held):
- **Linked folder**: a local folder tied, on one device, to a folder of a space, two-way: what changes
  on either side is made on the other. Every folder added with v1's `add` is one; `link` makes one on
  another device.
- **Trash**: the folder `.swarmfs-trash` at the root of a linked folder. Whatever SwarmFS replaces or
  removes in that linked folder is moved there first. Only the person empties it.
- **Conflict copy**: when two devices changed one file's content without seeing each other's change,
  the losing version is kept as a new entry next to it, named `name (device's copy).ext`.
- **Paused**: a linked folder SwarmFS can't see right now (an unplugged drive, a folder renamed away,
  no permission). Nothing is changed in it or because of it until it is back.
- **Free-space floor**: the free space SwarmFS leaves on a disk: max(5 GB, 5 % of the disk).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Edits on disk reach the space by themselves (Priority: P1)

The person works in a linked folder with their usual programs: they save, create, rename, move and
delete files. While the shell runs, SwarmFS follows: a new file becomes an entry, a saved file's entry
gets its new content, a renamed or moved file's entry is renamed or moved, a deleted file's entry is
removed for everyone. A file is hashed once it has stopped changing for 2 seconds, so a file being
written is hashed once, not on every write. Temporary files of common programs (and what the folder's
`.swarmfsignore` lists) never become entries. A single file added on its own (not in a folder) is
followed for edits too.

**Why this priority**: "always on" starts here: nothing reaches another device unless the space
follows the disk without the person typing `rescan`.

**Independent Test**: one device, shell running: create, write slowly, rename, move, delete files in a
linked folder (and temporary files); check the space after each, without any rescan.

**Acceptance Scenarios**:

1. **Given** a linked folder, **When** the person creates `notes.txt` in it, **Then** an entry
   `notes.txt` appears in the matching space folder, held here, within 5 s of the file last changing.
2. **Given** a file written for 10 s in small steps, **When** the writing stops, **Then** it is hashed
   once (one change recorded), 2 s after the last write.
3. **Given** a held file, **When** the person saves a new version, **Then** its entry has the new
   content and size, and the content it replaced is recorded with it (for conflict detection).
4. **Given** a held file, **When** the person renames it or moves it to another folder inside the
   linked folder, **Then** the same entry is renamed or moved (no new entry, no entry removed).
5. **Given** a held file, **When** the person deletes it, **Then** its entry is removed from the space.
6. **Given** files named `~$report.docx`, `report.tmp`, `a.swp`, `Thumbs.db`, `desktop.ini`,
   `.DS_Store`, `x.part`, and a `.swarmfsignore` at the linked folder's root listing `build/` and
   `*.log`, **When** such files and folders are created, **Then** none becomes an entry; the
   `.swarmfsignore` itself is an entry like any file (so its rules reach the other devices).
7. **Given** a single file added on its own, **When** the person saves a new version, **Then** its
   entry gets the new content; when they delete it, the entry stays (v1's rule), no longer held here.

---

### User Story 2 - Missing files arrive by themselves (Priority: P1)

On the other device, the linked folder fills itself: every file of the space folder not here yet is
fetched into its place, verified, without the person asking. When no device holding a file is online,
it is fetched as soon as one comes online. Fetching stops before the disk gets too full (below the
free-space floor), and the shell says so.

**Why this priority**: the second half of "always on": the person opens the folder on their laptop
and the files are there.

**Independent Test**: two devices, both shells running, a folder linked on each: add files on the PC;
they appear on the laptop's disk. Close the PC before a file arrives, reopen it: the file arrives.
With a floor set above the free space: nothing is fetched and the shell says why.

**Acceptance Scenarios**:

1. **Given** a folder linked on both devices, **When** the PC adds `trip/c.jpg`, **Then** the laptop
   has `trip/c.jpg` in its linked folder, byte-identical, listed as held by both, within 10 s
   (a 1 MB file, local network).
2. **Given** a file whose only holder is offline, **When** the holder comes online, **Then** the file is
   fetched without any command.
3. **Given** a file whose content the laptop already holds at another path, **When** it is due,
   **Then** it is not downloaded again (spec 001's rule): the local file is copied into place (the
   person asked for the file in this folder; a copy in their own folder is not a store), 0 bytes
   transferred.
4. **Given** free space minus a file's size would fall below the floor, **When** that file is due,
   **Then** it is not fetched, nothing is left half-written, and the shell says how much is free and
   the floor; when space is freed, fetching resumes.
5. **Given** a fetch interrupted (the PC goes offline), **When** it comes back, **Then** the fetch
   resumes and completes; until then nothing sits under the file's name.

---

### User Story 3 - Changes made elsewhere reach the disk, safely (Priority: P1)

When an entry changes on another device, the linked folder follows: a renamed or moved entry renames
or moves the local file (nothing downloaded), new content replaces the local file, a removed entry
removes the local file. The version replaced and the file removed go to the linked folder's trash,
never destroyed. The person lists the trash with `trash` and empties it with `trash empty`, after a
confirmation; SwarmFS never empties it on its own.

**Why this priority**: makes the folder a mirror of the space — and the trash is what makes that
acceptable under the constitution (Principle I, 1.1.0).

**Independent Test**: two devices, a folder linked on both: rename, move, edit and delete on the PC;
check the laptop's disk and trash after each; `trash`, `trash empty`.

**Acceptance Scenarios**:

1. **Given** an entry renamed or moved on the PC, **When** the laptop sees it, **Then** its local file
   is renamed or moved to match, and 0 bytes are downloaded.
2. **Given** a file edited on the PC, **When** the laptop sees it, **Then** the new version is at the
   file's path and the previous version is in the laptop's trash, byte-identical to what it was.
3. **Given** a file (or a folder) deleted on the PC, **When** the laptop sees it, **Then** the laptop's
   file (or folder, with everything in it) is in its trash, nowhere else gone.
4. **Given** files in the trash, **When** the person runs `trash`, **Then** they see each one: its
   linked folder, its path, its size, when it was moved there; **When** they run `trash empty` and
   confirm, **Then** the trash folders are emptied; **When** they don't confirm, nothing changes.
5. **Given** a file the person moves back out of the trash, **When** SwarmFS sees it, **Then** it is a
   new file of the linked folder (an entry again).

---

### User Story 4 - Link a space folder on another device (Priority: P2)

On a device where a space folder isn't linked yet, the person links it to a local path:
`link <space> <folder> <path>`. If the path is empty or new, the folder fills itself (story 2). If the
path already has files (say the same photos copied by hand earlier), files with the same content at
the same place count as held (nothing downloaded), and a different file with the same name is kept
as a conflict copy. `unlink` stops the sync; files and entries stay as they are.

**Why this priority**: lets the person choose where each device keeps a space folder; "already copied
by hand" is the common start of a sync tool.

**Independent Test**: two devices: the PC adds `photos/`; the laptop links it to an empty folder (it
fills), then to a folder holding some of the same files and one different `a.jpg`; then unlinks.

**Acceptance Scenarios**:

1. **Given** a space folder and an empty local path, **When** the person links them, **Then** the
   path receives the folder's files (story 2) and its new files are added (story 1).
2. **Given** a local path already holding `b.jpg` with the same content as the space's `b.jpg`,
   **When** linked, **Then** `b.jpg` is held here, nothing downloaded, nothing renamed.
3. **Given** a local `a.jpg` different from the space's `a.jpg`, **When** linked, **Then** the local one
   becomes `a (laptop's copy).jpg` (a new entry, seen on all devices) and the space's `a.jpg` is
   fetched into place.
4. **Given** local files the space folder doesn't have, **When** linked, **Then** they are added.
5. **Given** a linked folder, **When** the person unlinks it, **Then** nothing is fetched, renamed or
   moved there any more, local edits are no longer followed, and no file and no entry is removed.
6. **Given** a path inside (or containing) a folder already linked on this device, **When** the
   person links or adds it, **Then** it is refused: one local file follows at most one entry.

---

### User Story 5 - Two devices edit one file: both versions kept (Priority: P2)

The person edits `report.docx` on the PC and, without the two devices seeing each other, on the
laptop. When they meet, nothing is lost: one version stays `report.docx`, the other becomes
`report (laptop's copy).docx` (named after the device whose version lost), on both devices.

**Why this priority**: latest-wins (v1) would silently drop a version once SwarmFS writes files by
itself; a sync tool losing an edit loses all trust.

**Independent Test**: two devices, a folder linked on both: disconnect, edit the same file differently
on each, reconnect; both devices end with both files, same names, same contents.

**Acceptance Scenarios**:

1. **Given** one file edited on both devices while apart, **When** they reconnect, **Then** both
   devices have `report.docx` (one version) and `report (<device>'s copy).docx` (the other), the same
   on both, within 20 s; no version is lost and nothing went to the trash.
2. **Given** an edit on the PC that the laptop had already received before editing, **When** the
   laptop's edit arrives, **Then** it simply replaces it (no conflict copy): it was not concurrent.
3. **Given** a conflict copy name already taken, **When** another conflict happens, **Then** the copy
   gets a number: `report (laptop's copy 2).docx`.
4. **Given** a file renamed on one device and its content edited on the other, **When** they meet,
   **Then** no content is lost; the name follows the latest change.
5. **Given** a file deleted on one device while the other edits it and the edit isn't recorded in the
   space yet, **When** the delete arrives, **Then** the edited file is kept (added again as an entry),
   not trashed. (An edit already recorded before the delete arrives: kept in that device's trash —
   FR-019.)

---

### User Story 6 - An unplugged folder is paused, never read as deleted (Priority: P2)

A linked folder on an external drive disappears when the drive is unplugged (or the folder is renamed
away, or can't be read). SwarmFS pauses it: no entry is removed, nothing is fetched into it, and the
shell says it is paused. When it is back, SwarmFS resumes and catches up with what changed meanwhile.

**Why this priority**: without it, unplugging a drive would remove every entry for every device — the
worst failure a sync tool can have.

The same pause guards against a mass delete (Tibo, lead review 2026-10-28): if one change on disk
would remove more than half of a linked folder's files and more than 100 files, SwarmFS doesn't apply
it. It pauses that folder, says why, and waits: `confirm <folder>` applies the removals, or the person
restores the files and it resumes.

**Independent Test**: two devices: rename the linked folder's root away (as an unplug does), check no
entry removed on either device; rename it back, check sync resumes. Empty a 1,000-file linked folder:
0 entries removed until confirmed.

**Acceptance Scenarios**:

1. **Given** a linked folder, **When** its root vanishes or can't be read, **Then** it is paused: no
   entry removed or changed because of it, on any device, and the shell says so.
2. **Given** a paused folder, **When** another device adds files to that space folder, **Then**
   nothing is written on this device (no folder recreated at that path).
3. **Given** a paused folder, **When** it is back, **Then** SwarmFS resumes within 15 s: it catches up
   both ways (local changes made elsewhere meanwhile, files missing here), and the shell says so.
4. **Given** SwarmFS starting while a linked folder is unplugged, **When** it starts, **Then** that
   folder starts paused.
5. **Given** a linked folder of 1,000 files, **When** the person (or a program) deletes 600 of them,
   **Then** 0 entries are removed, the folder is paused for a mass delete and the shell says so;
   **When** the person confirms, **Then** the 600 entries are removed; **When** instead they restore
   the files, **Then** it resumes with nothing removed.
6. **Given** 80 of 100 files deleted (not more than 100), or 150 of 1,000 (not more than half),
   **When** SwarmFS sees it, **Then** the removals are applied as usual.

---

### User Story 7 - The shell does it all, and says what it does (Priority: P3)

The person runs `swarmfs` on each desktop and leaves it open. It watches, fetches, serves and applies
changes by itself, printing a short line for each thing it does (fetched, updated, moved to trash,
conflict copy, paused, resumed, fetching stopped for space). New commands: `link`, `unlink`, `trash`,
`trash empty`. No service, no background process of its own: closing the shell stops everything.

**Why this priority**: the host for stories 1–6 on real machines; adds no behavior of its own.

**Independent Test**: two shell processes on a local network: `add` a folder on one, `link` it on the
other, edit a file on one, see the line and the file on the other; `trash`, `trash empty`.

**Acceptance Scenarios**:

1. **Given** two shells running, **When** the person adds a file to a linked folder on one, **Then**
   the other prints a line naming it and has it on disk.
2. **Given** the shell, **When** the person types `trash empty`, **Then** it asks for confirmation and
   says how much will be freed; only a "yes" empties.
3. **Given** a one-shot command (scripts), **When** it runs, **Then** it does not start syncing (it
   opens, acts, closes, as in v1).

### Edge Cases

- **Many files deleted at once** (a wrong command, a program emptying the folder, a drive half
  failing): more than half of a linked folder's files and more than 100 in one change → paused until
  confirmed (story 6).
- **Names differing only by case** (`A.jpg` and `a.jpg`, both valid on Linux): on a case-insensitive
  disk (Windows, macOS by default) they are one path; the second placed gets a conflict-copy name,
  like two entries of the same name.

- **A local change while SwarmFS is not running** (shell closed, PC off): picked up when the shell
  starts — saved, created, deleted, renamed and moved files alike (a renamed file isn't re-uploaded).
- **The person edits a file at the moment a newer version arrives**: the arriving version is a
  conflict with the unsaved-in-the-space local version (story 5's rule), never written over it.
- **An entry moved out of the linked folder's space folder** (to a folder not linked here): the local
  file goes to the trash; if that folder is linked on this device too, the file is fetched there like
  any missing file.
- **A folder renamed locally**: the folder entry is renamed; its files are not re-uploaded or re-fetched.
- **A local file at the path where a fetched file must go** (an ignored file of the same name): it goes
  to the trash first.
- **An entry whose name is valid in the space but not on this disk** (`:`, `?` and `*` on Windows,
  reserved names like `CON`): not fetched; the shell says so; the entry stays.
- **Two entries with the same name in one folder** (added on two devices while apart): the second one
  fetched here is placed as a conflict copy name.
- **The trash on a folder whose drive is full**: moving into the trash is a rename on the same disk; it
  needs no space.
- **A watched folder's events lost** (the system drops them under a burst of changes): SwarmFS rescans
  that linked folder rather than missing a change.
- **`.swarmfsignore` changed**: applies to files created or changed afterwards; entries already in the
  space for newly ignored paths stay (nothing removed because of an ignore rule).
- **A device whose free space drops below the floor while fetching**: the fetch in progress is stopped
  (resumable), no new one starts.
- **Both devices offline, edits on both**: each device's local changes are kept; story 5 settles content.
- **Unlinking a folder with fetches in progress**: they stop; partial downloads are kept out of the
  linked folder and removed.

## Requirements *(mandatory)*

### Functional Requirements

**Linked folders**

- **FR-001**: Adding a local folder (v1's `add`) MUST make it a linked folder on that device.
- **FR-002**: A person MUST be able to link a space folder (or a space's top) to a local path on a
  device (`link`), and stop it (`unlink`); unlinking MUST NOT remove, move or change any file or entry.
- **FR-003**: Linking into a non-empty path MUST count a local file with the same content at the same
  place as held (no transfer), keep a different local file of the same name as a conflict copy, and
  add local files the space folder lacks.
- **FR-004**: A device MUST refuse to link or add a path inside, or containing, a folder already linked
  on that device.
- **FR-005**: Linked folders MUST be kept per device across restarts, private to the person's devices
  (like holdings).

**Following the disk (local → space)**

- **FR-006**: While syncing, SwarmFS MUST watch every linked folder and every single added file, and
  process a changed file once its size and modification time have been unchanged for 2 s.
- **FR-007**: In a linked folder, a new file or folder MUST become an entry; a changed file's entry MUST
  get the new content and record the content it replaced; a deleted file or folder's entry MUST be
  removed; a renamed or moved file or folder MUST rename or move its entry (same entry, nothing
  re-uploaded).
- **FR-008**: For a single added file, an edit MUST update its entry; a delete MUST keep the entry
  (v1's rule); changes from elsewhere MUST NOT touch the local file (constitution I, outside linked
  folders).
- **FR-009**: Paths matching the fixed ignore list (`*.part`, `.swarmfs-trash`, `Thumbs.db`,
  `desktop.ini`, `.DS_Store`, `~$*`, `*.tmp`, `*.swp`) or the linked folder's `.swarmfsignore` MUST
  never become entries and MUST never be fetched.
- **FR-010**: `.swarmfsignore` MUST support: one pattern per line, `#` comments and blank lines, `*`
  (any characters within a name), `**` (any number of folders), a trailing `/` (folders only); a pattern
  without `/` matches a name at any depth, one with `/` matches from the linked folder's root.
- **FR-011**: Changes made while SwarmFS was not running MUST be picked up when syncing starts, with
  the same rules (renames and moves recognized, not re-uploaded).
- **FR-012**: If the system drops watch events, SwarmFS MUST rescan the affected linked folder.

**Following the space (space → local)**

- **FR-013**: While syncing, every file entry of a linked space folder with no matching local file
  MUST be fetched into its place (verified, resumable, nothing under the final name until complete),
  unless ignored, not valid as a local name, or below the free-space floor.
- **FR-014**: A file whose holders are all offline MUST be fetched when one comes online, without a
  command.
- **FR-015**: An entry renamed or moved elsewhere MUST rename or move the local file (no download); an
  entry whose content changed MUST replace the local file once the new version is complete; an entry
  removed MUST remove the local file or folder. Whatever is replaced or removed MUST first be moved to
  the linked folder's trash.
- **FR-016**: SwarmFS MUST NOT replace, move or trash a local file whose content differs from what it
  last recorded for it (an unrecorded local edit): that is a conflict (FR-018) or a re-add (FR-019).
- **FR-017**: A fetch MUST NOT start if it would leave less free space than the floor (max(5 GB, 5 % of
  the disk)), and a fetch in progress MUST stop if free space falls below it; SwarmFS MUST say so (free
  space and floor) and resume once space allows.

**Conflicts**

- **FR-018**: When two devices changed one file's content concurrently (neither had seen the other's
  version), both versions MUST be kept: the latest-winning one under the name, the other as a new entry
  `name (device's copy).ext` (device: the one whose version lost; a number added if taken), visible on
  all devices. Non-concurrent edits MUST NOT make copies.
- **FR-019**: A file deleted on one device and edited on another concurrently MUST be kept: added
  again as an entry if the edit had not reached the space yet; otherwise at least in the editing
  device's trash (re-added once hypergraph tells when the delete happened: request H15).
- **FR-020**: Concurrent renames or moves MUST settle on the latest one, the same on all devices; the
  local file follows it, no content lost.

**Safety**

- **FR-021**: SwarmFS MUST NOT destroy any file. Inside a linked folder, what it replaces or removes is
  moved to that folder's trash (`.swarmfs-trash`); outside linked folders it MUST NOT delete, move or
  change any local file (constitution 1.1.0, Principle I).
- **FR-022**: A linked folder whose root is missing or unreadable MUST be paused: no entry removed or
  changed because of it, nothing written into it; it MUST resume within 15 s of being back, catching
  up both ways, and start paused if it is missing when syncing starts.
- **FR-029**: A local change that would remove more than half of a linked folder's files and more than
  100 files MUST NOT be applied: the folder MUST be paused for a mass delete (said apart from "missing"),
  until the person confirms (the removals are applied) or the files are back (it resumes, nothing
  removed).
- **FR-023**: Remote removals MUST be applied only from a complete view of the space (never because
  an entry is merely not seen yet while another device is offline).

**Trash**

- **FR-024**: The trash MUST never be emptied automatically. A person MUST be able to list it (each
  item: linked folder, path, size, when trashed) and empty it; the shell MUST confirm before emptying.
- **FR-025**: Trashed files MUST NOT be held or served.

**Host and runtimes**

- **FR-026**: The `swarmfs` shell MUST sync (stories 1–6) for as long as it runs, printing one line per
  action (added, updated, fetched, renamed, moved, trashed, conflict copy, paused, resumed, fetching
  stopped for space, name not valid here); it MUST offer `link`, `unlink`, `trash`, `trash empty`.
  One-shot commands MUST NOT sync.
- **FR-027**: The library MUST let an app start syncing and receive those actions as events; the whole
  test suite MUST keep running on Node and on Bare.
- **FR-028**: Stories 1–6 MUST each be played by scenario tests through the public API with real devices
  on a local network; story 7 by tests driving two shell processes.

### Key Entities

- **Linked folder**: (device, local path, space, space folder). Private to the person's devices.
- **File entry** (spec 001), with one addition: the content its latest edit replaced (its base), so a
  device can tell a newer version from a concurrent one.
- **Holding** (spec 001): unchanged — "this device holds this content at this path".
- **Trash item**: a file or folder under a linked folder's `.swarmfs-trash`, with where it was and
  when it was moved there. Lives only on disk.
- **Ignore rules**: the fixed list plus the linked folder's `.swarmfsignore` (itself an ordinary entry).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A linked folder of 10,000 files (held, unchanged since last run) starts syncing — watching,
  and the first pass over the disk done — in under 10 seconds.
- **SC-002**: A 1 MB file created or saved on one device is on the other device's disk, verified, within
  10 seconds (both online, local network; this includes the 2 s settle time).
- **SC-003**: A renamed or moved file (or a folder of 100 files) is renamed or moved on the other device
  within 10 seconds, with 0 bytes transferred.
- **SC-004**: 1,000 new files (1 KB each) copied into a linked folder are all on the other device within
  60 seconds.
- **SC-005**: A file written continuously for 10 seconds is hashed and recorded once.
- **SC-006**: In every test, no file is destroyed: every file SwarmFS replaced or removed is found,
  byte-identical, in its linked folder's trash; no file outside a linked folder is moved or changed;
  only `trash empty`, confirmed, deletes bytes.
- **SC-007**: A linked folder unplugged (root gone) removes 0 entries on every device and moves 0 files to
  any trash; sync resumes within 15 seconds of it being back.
- **SC-012**: Emptying a 1,000-file linked folder (the folder itself still there) removes 0 entries on
  every device until the person confirms; after confirming, all 1,000 are removed within 15 seconds.
- **SC-008**: With the floor above the free space, 0 files are fetched and the shell says why; with space
  back, fetching resumes within 15 seconds.
- **SC-009**: Concurrent edits of one file on two devices end, within 20 seconds of reconnecting, with
  both versions on both devices (same names, same contents) and 0 versions lost.
- **SC-010**: Temporary files of common programs (the fixed ignore list) and `.swarmfsignore` matches
  create 0 entries.
- **SC-011**: The whole suite passes on Node and on Bare; SwarmFS's library still has no networking,
  replication, cryptography or transfer code of its own.

## Later stories (outline, not built here)

Named so 002 doesn't block them; each gets its own spec.

1. **User settings**: the free-space floor, emptying the trash after N days, default ignore rules.
2. **Bandwidth cap**: upload and download limits per device.
3. **Start at login**: the sync running without an open terminal.
4. **Desktop app**: a window and a tray icon hosting the sync (then login start, notifications).
5. **Phone app**: its own project, embedding the library on Bare (no folder watching on phones).
6. **Shared workspaces**: spaces with other people (spec 001's later story 1), with swarmwire's
   `resolve` scoped by peer and space (lead review 2026-10-28); conflict copies already work across
   members.
7. **Recursive watching on Bare on Linux**: a Pear desktop app runs on Bare, where libuv's recursive
   watch works on Windows and macOS only. A known gap, solved then: one watcher per folder, or an
   upstream bare-fs change. Not in 002 (the shell runs on Node; the suite runs on Bare on Windows).

## Assumptions

- Desktops only (Windows, macOS, Linux); the person runs the shell (Node) on each. The library and its
  tests also run on Bare; folder watching on Bare relies on the system's recursive watching (Windows,
  macOS; Linux: later story 7).
- One person per space, as in v1; a local delete removes the entry for all the person's devices.
- "Concurrent" means: the winning version doesn't descend from this device's version; detected by the
  contents each edit replaced, which every edit records as a short history (no clock comparisons). A
  device that missed many edits in a row may make one needless conflict copy; never a lost version.
- Names follow hypergraph's latest-wins (concurrent renames: one wins; no copy for names).
- Free space is that of the disk holding the linked folder, read before each fetch; the floor can be
  overridden by the app (tests; the later settings story).
- Moving to the trash keeps the file's path inside the linked folder under a folder named for the time
  it was trashed, so a file trashed twice keeps both versions.
- Fetching order is not specified (all due files are fetched; small and large alike).
- A one-person, two-device setup on a home network; figures measured on a local test network on this
  Windows PC, like spec 001's.
