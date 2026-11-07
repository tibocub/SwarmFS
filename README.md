# SwarmFS

A decentralized filesystem. Folders and files are records in
[hypergraph](../hypergraph) spaces; file bytes move through [swarmwire](../swarmwire),
content-addressed and verified, served from where they already sit on disk — never copied
into a store.

One building block, the **space**: a personal sync folder is a space with only you in it; a
shared workspace or a community archive is a bigger space. Every member sees the whole file
list, even files nobody online holds right now. A file is one hash with possibly many local
paths, and a hash held locally is never downloaded again.

> Status: **v1 works** (2026-10-28): two devices of one identity — see on the phone what the PC
> holds, fetch it while the PC is online. Spec: [specs/001-personal-sync](specs/001-personal-sync/spec.md).
> **002 "always on"** built on its branch, waiting for review: linked folders kept in sync by the
> running shell. Spec: [specs/002-always-on](specs/002-always-on/spec.md).
> The previous code is in `SwarmFS-old` (reference only).

## What works (v1)

- Add a file or folder in place: hashed where it lies (BLAKE3), nothing copied or written.
- A second device joins by a code and sees every space, the whole tree, and which device holds
  what — also with the other device offline.
- Fetch a file from an online device: verified piece by piece, resumable, never overwrites; content
  already held here is not downloaded again.
- Rescan follows the disk (edits, deletions, new files); rename, move, remove entries from any
  device; removing never touches a local file.
- Node and Bare, library and CLI.

## What 002 adds (always on)

- Every added folder is a **linked folder**, two-way; `link` ties a space folder to a local path on
  another device, `unlink` stops (files stay). While the shell runs: edits, new files, renames,
  moves and deletes on disk reach the space (a file is hashed once it is still for 2 s), and the
  other device's linked folder follows: missing files fetched (or copied if held here), renamed,
  moved, updated, removed.
- Nothing destroyed: what syncing replaces or removes goes to the folder's `.swarmfs-trash`; only
  `trash empty` (asks first) deletes it.
- Both devices edited one file apart: both kept, `name (device's copy).ext`.
- A linked folder that vanishes (unplugged drive) is paused, never read as deleted; deleting more than
  half of a folder's files (over 100) at once waits for `confirm <folder>`.
- Ignored: `*.part`, `*.tmp`, `*.swp`, `~$*`, `Thumbs.db`, `desktop.ini`, `.DS_Store`, and what the
  folder's `.swarmfsignore` lists (`*`, `**`, trailing `/`, `#`).
- Fetching stops below max(5 GB, 5 % of the disk) free (`SWARMFS_MIN_FREE` for another floor).

Known gaps (requests filed): a device paired after a private space got big (~1,000 files) never
gets access (hypergraph H17: pair first, then add); on Windows a folder can't be renamed while the
other device is fetching from it (swarmwire S9). Not yet: shared spaces with other people, start at
login, a desktop app (later stories in the spec).

## What 004 adds (sites, for HyperBrowser)

A **site** is a space with the site's pages and its members' uploads: one key. API:
[specs/004-sites/contracts/api.md](specs/004-sites/contracts/api.md) (library only, no shell commands).

- Pages (`site.publish(folder)`, a linked folder of the owner) are written by the owner and admins only;
  everyone else's change is refused.
- Uploads (`site.upload(file)`): by members with the `editor` role, edited by their author only; the
  owner's app keeps every upload while syncing, so a picture outlives its poster going offline.
- Read-only visitors: `site.invite({ role: 'reader' })`; `site.makePublic()` and `publicLink()`: anyone
  reads, no one lets them in. A visit writes nothing into the site.
- `site.read(path)`: verified bytes. Files up to 60 KB travel inside their record (no transfer); the
  rest land in the engine's **app storage** (`<data folder>/app-storage`, 1 GB cap by default,
  `appStorageMax`), least recently read removed first. Never in the person's folders.
- A dynamic site's own records (spec 005): `createSite(name, { types })` records the site's types next to
  SwarmFS's; `site.declareTypes(types)` adds more later (owner, admins; additions only). Members write them
  with `site.space.put(...)`. A site's type can't take one of SwarmFS's names (`INVALID_TYPE`).

Known gaps (filed): readers can't read a *private* space (hypergraph H6: refused `NOT_SUPPORTED`);
anyone joining a public site may upload (H23).

## Quickstart

Library: [quickstart.md](specs/001-personal-sync/quickstart.md), API: [contracts/api.md](specs/001-personal-sync/contracts/api.md).

CLI on two machines (`npm install`, then `npx swarmfs …`, `node bin/swarmfs.js …` or `bare bin/swarmfs.js …`):

```bash
# PC
swarmfs init                      # asks for a password (keeps the recovery phrase sealed)
swarmfs                           # a shell, online (serving) until quit
> create "My files"
> add "My files" ~/photos
> pair                            # prints a code

# second machine
swarmfs join <code>               # asks for a password too
swarmfs
> ls "My files"
> ls "My files" photos
> get "My files" photos/a.jpg ./a.jpg     # a path of names, or an id from ls
> link "My files" photos ~/photos         # kept in sync both ways while the shell runs
> trash                                  # what syncing replaced or removed
```

`help` in the shell lists every command; `SWARMFS_PASSWORD` gives the password without asking (scripts). Data in `~/.swarmfs` (`--dir` for another folder).

## Tests

```bash
npm test             # Node
npm run test:bare    # Bare
npm run test:all     # both
npm run test:slow    # 100 MB fetch; 10,000- and 1,000-file sync (SC-001, SC-004)
```

Hypergraph and swarmwire are sibling folders (`../hypergraph`, `../swarmwire`), see `CLAUDE.md`.

## Layering

```
SwarmFS      names, folders, who holds what        (records in hypergraph spaces)
hypergraph   identity, devices, spaces, replication
swarmwire    hash → bytes, verified, served in place
```

## License

MIT
