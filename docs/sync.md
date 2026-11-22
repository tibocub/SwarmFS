# Linked folders and sync

A **linked folder** ties a folder of a space to a local path on one device. `drive.add(folder)`
links the folder it adds; `drive.link(folder, path)` links an existing space folder (or the top)
on another device, making the path if needed. `sfs.unlink(path)` stops it: no file and no entry is
removed. Linked folders can't overlap: one local file, one entry.

`sfs.sync()` keeps every linked folder in step with its space folder, both ways, until `close()`.
Without it (one-shot scripts), nothing is followed except by `rescan()`.

```
 disk ──watch, settle 2 s──▶ local pass ──▶ space records ──replicate──▶ other devices
 disk ◀──place / trash─────  remote pass ◀── 'change' (debounced 500 ms) ◀──┘
                                 │
                                 └──▶ due fetches (8 at once) ──▶ .swarmfs-trash/.incoming/
```

Each linked folder runs one pass at a time (`Link.run` in `lib/sync.js`); downloads run beside
them and are placed through a pass when complete. A failing pass emits an `error` event and never
stops the next one.

## Local pass

Runs on watcher batches (paths whose size and mtime held still for 2 s, checked every 500 ms), at
start, on resume and on `rescan()`.

The watcher covers the whole tree. Node watches a tree on every platform, Bare only on macOS and
Windows; elsewhere (Bare on Linux) `lib/watch.js` keeps one watcher per
folder, adding one when a folder appears (made or moved in, with every folder in it) and dropping
it when it goes. A folder that appears reaches the local pass as its own path, so files written
in it before its watcher started are found by that pass. Ignored folders
([below](#ignored-files): the trash, and what `.swarmfsignore` lists, such as `node_modules/`)
get no watcher; one un-ignored later is watched from the next `sync()`. A folder that can't be watched (past
the system's limit of watches, `fs.inotify.max_user_watches`) is missed until the next full pass (start, resume, `rescan()`).

1. Ignored paths dropped ([below](#ignored-files)).
2. **Moves.** A gone folder whose files all reappear under one new folder is a folder move. A gone
   file and a new one with the same file id, size and mtime are a move; failing that, the same hash.
   A file id is trusted only when exact: NTFS ids exceed 2^53, and Bare gives them as Numbers, so
   there a rename is found by content only.
3. **New files** are hashed and added. An entry already at that place with the same content adopts
   the file (linking a folder that already has the files); different content becomes a conflict copy.
4. **Edited files**: if the space still has the version this device last had, the edit is published
   with `base` (the versions it replaces); if the space moved on meanwhile, this version becomes a
   conflict copy. A file removed elsewhere but edited here is added again: the edit wins.
5. **Removals**, after the mass-delete check: a gone folder removes its subtree, a gone file its entry.

New folders and removals act only on a complete read of the space: with a device offline, an entry
not seen may still exist, and acting would duplicate or lose it.

## Remote pass

Runs when the space reports changed entries (debounced 500 ms), at start and on resume.

- An entry held here at another path: the local file or folder is renamed or moved to match
  (whatever was at the target goes to the trash first).
- A newer version of a held file (its `base` names the version here): fetched, the old file trashed.
  A version that isn't in its history lost to a concurrent edit: kept as a conflict copy, then the
  entry's content is fetched.
- An entry with no local file: due for fetching. If this device holds that hash at another path, it
  is copied, not downloaded. A local file already at that path with the same content is adopted.
- A held entry gone from a complete read: the local file goes to the trash, unless it was edited
  here meanwhile (then the local pass adds it again). A file deleted elsewhere but saved here after
  the delete wins; a take-down by the space never does.
- Its own space folder removed elsewhere: files kept, the folder unlinked.

Downloads land in `<linked>/.swarmfs-trash/.incoming/<root>` and are renamed into place when complete.
Entries of one content are fetched one after the other (they share that file): the first is
downloaded, the others copied from it once placed.
If the target changed meanwhile and isn't an edit already recorded, it becomes a conflict copy.

## Conflict copies

Two devices edited one file without seeing each other's edit: both versions are kept. The one that
loses is renamed `name (<who>'s copy).ext` (then `copy 2`, `copy 3`...) and added as a new entry.
`<who>` is this device's name, or this person's name when the version kept under the original name
was written by another person.

Two entries that would land on one path (the same name, or names differing only by case on a
case-insensitive disk) are placed with a conflict-copy name too, named after the writer of the
later one (the person in a shared space, else the device). That name is local only: the entry keeps
its own.

## The trash

Nothing syncing does destroys a file. What it replaces or removes goes to
`<linked>/.swarmfs-trash/<YYYY-MM-DD HH-MM-SS>/<relative path>` (local time; a second batch in the
same second gets ` 2`, ` 3`...), a rename on the same disk. `sfs.trash()` lists every linked
folder's trash; `sfs.emptyTrash()`, the only call that deletes a person's bytes, empties it.
`unlink` deletes only `.incoming` (partial downloads SwarmFS wrote).

## Pauses

A paused folder does nothing: no write, fetch or trash. `sfs.links()` shows why.

| `paused` | When | Resumed |
|---|---|---|
| `'missing'` | the folder is gone or not a folder (an unplugged drive): never read as everything deleted | checked every 10 s; back → a full pass |
| `'mass-delete'` | a local change would remove more than 100 files and more than half of the folder's | `sfs.confirm(path)` applies it; files put back → resumes |
| `'removed'` | this person was removed or banned from the space | let back in |
| `'in-bin'` | the linked space folder (or one above it) is in the bin | restored |

## Ignored files

Never synced: `*.part`, `*.tmp`, `*.swp`, `~$*`, `Thumbs.db`, `desktop.ini`, `.DS_Store`,
`.swarmfs-trash`, and what the folder's `.swarmfsignore` lists. That file is a small subset of
`.gitignore`: `#` comments, `*` (within a name), `**` (any depth), a trailing `/` (folders only);
a pattern without `/` matches a name at any depth, one with `/` matches from the folder's root.
A matched folder ignores everything under it. `.swarmfsignore` itself is an ordinary synced file.

On Windows, an entry whose name the disk can't have (`<>:"|?*`, control characters, a trailing dot
or space, `CON`, `NUL`, `COM1`...) is skipped, reported once.

## Free space

Fetches into a linked folder leave max(5 GB, 5 % of its disk) free, or `minFree` bytes
(`SWARMFS_MIN_FREE` in the CLI). Below the floor, fetching stops (resumable) and one `low-space`
event is emitted; due files are tried again every 10 s.

## Retries

- A fetch that failed with an error: tried again after 60 s.
- Other people's devices that didn't give a file: asked again after 30 s, or when another connects.
- A peer connecting retries due fetches at once.

## Events

`sfs.on('sync', (e) => {})`, one per action:

```js
{
  action,   // local → space: 'added' | 'updated' | 'removed' | 'renamed' | 'moved'
            // space → local: 'fetched' | 'trashed' | 'conflict' (and 'renamed', 'moved')
            // state: 'paused' | 'resumed' | 'low-space' | 'skipped' | 'error'
  space,    // the space key
  path,     // local, absolute
  to,       // renamed, moved: the new path; conflict: the copy's path
  reason,   // paused: 'missing' | 'mass-delete' | 'removed' | 'in-bin'; skipped: 'name'; error: the message
  count,    // paused for a mass delete: the files it would remove
  free, floor  // low-space: bytes
}
```

`updated` events for files added on their own carry no `space`.
