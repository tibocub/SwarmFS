# Spaces, entries and bytes

## Spaces and drives

A **space** is hypergraph's unit of sharing: a set of signed records replicated between its
members' devices. SwarmFS uses three kinds:

- the **personal space** (`sfs.hg.personal`), shared only by one person's devices: what each
  device holds, which folders it links, which sites it keeps;
- **files spaces**, made by `sfs.createSpace`: private (only members read them), one folder tree;
- **sites** (see [sites.md](sites.md)).

A `Drive` wraps one space. Its tree is made of `folder` and `file` records, each with a `parent`:
another folder's id, or the space key for the top (`drive.top`). Every member sees the whole tree,
including files no device online holds right now.

## Adding in place

`drive.add(path)` hashes each file where it lies (BLAKE3, the hash swarmwire verifies with) and
writes:

- a `file` record in the space: name, parent, `content` (a swarmwire ref: the root and the size);
- a `held` record in the personal space: this device has that root at that path, with the size and
  mtime it had when hashed.

Nothing is copied or written to disk. A folder becomes a **linked folder** of this device (an
`added` record), kept in sync both ways while `sfs.sync()` runs ([sync.md](sync.md)).

A file is one hash with possibly many local paths. A hash held here is never downloaded again:
fetching it returns the existing path, and syncing copies it locally instead.

### When a file counts as held

A `held` record counts only while the file still has the size and mtime recorded with it
(`localPath` in `lib/holdings.js`). A file edited since it was hashed is not served until a rescan
hashes it again: a peer can never be sent bytes that don't match the hash it asked for. If a file
keeps changing while it is hashed, it is hashed up to three times; the last values won't match
the file, so it waits for the next rescan.

## Listing

`drive.list(folder, { limit, after, timeout })` returns one page (100 by default): folders first,
then files, each by name. `complete` is false while a device holding more of the space is offline:
what is listed is true, but more may exist. `timeout` waits that long for records other devices
know of.

Each file entry carries its `holders`: one per device, from the `held` records of this person's
devices, plus other people's devices that chose to show their holdings ([sharing.md](sharing.md)).
`path` is set only for this device.

## Fetching

`drive.fetch(id, localFile)`:

1. Held here already (still as hashed): returns that path, `bytes: 0`.
2. `localFile` exists: `EXISTS` (a fetch never overwrites).
3. A small file inside its record (sites only): written from the record, no transfer.
4. Otherwise a swarmwire download into `<localFile>.part`, verified piece by piece, renamed when
   complete. It stops, resumable later, when every peer says it doesn't hold the file or when no
   progress comes for `fetchTimeout` (30 s by default): `NOT_AVAILABLE`.

Before starting, it needs an online holder among this person's devices, or any connected device of
another person (their holdings may be private, so they are asked). Then a `held` record is written.

## Who serves whom

Bytes move only over the member connections of spaces (`lib/transfer.js`): nothing is announced or
looked up on the DHT for a file, so who holds what stays inside each space. A peer is served a file
only if this device holds it for a space that peer's device is a member of; while a download runs,
the parts already verified may be served to members of the space it is for. A peer that is no
longer a member of any space here stops being served.

## Rescans

`sfs.rescan()` (also run by `open`) follows the disk once:

- linked folders get a local pass ([sync.md](sync.md#local-pass));
- files held outside linked folders (added on their own, or fetched to a path): an edited file is
  hashed again and its entry gets the new content; a deleted one stops being held (its entry stays);
  a file whose folder was removed by another device is moved to the top. Rescans never touch a file.

While `sync()` runs, files added on their own are also watched, so their edits are recorded without
a rescan.

## Renaming, moving, removing

`rename`, `move` and `remove` change entries only, never a local file. A folder can't move into
itself or its subtree (`MOVE_INTO_SELF`). `remove` deletes the entry and its subtree, deepest first;
in a shared space it goes to the bin instead ([sharing.md](sharing.md#the-bin)). Linked folders on
other devices follow these changes ([sync.md](sync.md#remote-pass)).
