# Contract: SwarmFS 002 public API (additions to spec 001's)

Spec 001's contract ([../../001-personal-sync/contracts/api.md](../../001-personal-sync/contracts/api.md))
stays; below is only what 002 adds or changes. Error codes: no new ones (`EXISTS`, `NOT_FOUND` reused).

```js
const sfs = await SwarmFS.open('./data', {
  ...,                // spec 001's options
  minFree             // bytes: the free-space floor; default max(5 GB, 5 % of the linked folder's disk)
})

await drive.add(localFolder)        // as v1, and the folder is now linked (two-way) on this device;
                                    //   EXISTS if inside or containing a folder linked here
await drive.link(folder, localPath) // link a space folder (an id, or drive.top) to a local path on this
                                    //   device; the path is made if missing. Files already there:
                                    //   same content at the same place → held; same name, other
                                    //   content → conflict copy; others → added (applied by sync()).
                                    //   EXISTS: overlaps a linked folder here, or that folder is
                                    //   already linked here; NOT_FOUND: no such folder
await sfs.unlink(localPath)         // stop following it; no file, no entry removed; NOT_FOUND
await sfs.links()                   // [{ path, space, folder, paused }] on this device
                                    //   paused: null | 'missing' | 'mass-delete'
await sfs.confirm(localPath)        // a folder paused for a mass delete: apply the removals, resume;
                                    //   NOT_FOUND if not linked or not so paused

await sfs.sync()                    // start: watch linked folders and single added files, fetch
                                    //   what's missing, apply changes made elsewhere, until close();
                                    //   resolves once the first pass is done. Idempotent.
sfs.on('sync', (e) => {})           // one per action:
// { action: 'added' | 'updated' | 'removed' | 'renamed' | 'moved'   (local → space)
//         | 'fetched' | 'trashed' | 'conflict'                       (space → local)
//         | 'paused' | 'resumed' | 'low-space' | 'skipped' | 'error',
//   space, path,            // path: local, absolute
//   to,                     // renamed/moved: the new path; conflict: the copy's path
//   free, floor,            // low-space: bytes
//   reason,                 // paused: 'missing' | 'mass-delete'; skipped: 'name'; error: the message
//   count }                 // paused for a mass delete: files the change would remove

await sfs.trash()                   // [{ folder, path, size, trashed }]: every linked folder's trash
                                    //   (folder: the linked folder's path; path: where the file was,
                                    //   relative to it; trashed: ms)
await sfs.emptyTrash()              // → { files, bytes }: deletes them; the only call that deletes bytes

await sfs.rescan()                  // as v1, with linked-folder rules (local deletes remove entries,
                                    //   renames found; data-model.md "Local pass")
```

Behaviour summary (details: [../data-model.md](../data-model.md), [../research.md](../research.md)):
settle 2 s; ignore list fixed + `.swarmfsignore`; downloads go through
`<linked>/.swarmfs-trash/.incoming/`; replaced and removed files to
`<linked>/.swarmfs-trash/<YYYY-MM-DD HH-MM-SS>/`; a linked folder whose root is missing is paused.

## CLI (story 7)

The shell (`swarmfs`, `swarmfs shell`) calls `sync()` once open and prints one line per `sync` event:

```text
fetched   <path>
updated   <path>
trashed   <path>
conflict  <path> -> <copy path>
paused    <linked folder> (not found: unplugged?)
paused    <linked folder>: 600 files deleted at once; "confirm <folder>" removes them everywhere,
          or restore them
resumed   <linked folder>
low-space <linked folder>: 3.2 GB free, floor 5.0 GB; fetching stopped
skipped   <path> (name not valid on this disk)
```

New commands (shell and one-shot):

```text
link <space> <folder> <path>   link a space folder (id from ls, or the space's name/key for its top)
unlink <path>                  stop syncing it; files and entries stay
links                          linked folders here: path, space, paused or not (and why)
confirm <path>                 apply a mass delete the folder was paused for
trash                          what is in the trash: folder, path, size, when
trash empty                    asks "delete N files (X MB) for good? (yes/no)"; only "yes" empties
```

`SWARMFS_MIN_FREE` (bytes) sets the floor for the shell (tests; the settings story later).
One-shot commands never call `sync()` (as v1: open, act, close). `trash empty` one-shot asks too
(stdin: a script pipes `yes`).
