# SwarmFS

A peer-to-peer file system, as a JavaScript library for Node and Bare. Folders and files are
signed records in [hypergraph](../hypergraph) spaces, replicated between the devices of the people
who share them. File bytes move through [swarmwire](../swarmwire), content-addressed and verified,
and are served from where they already sit on disk: never copied into a store.

A personal sync folder is a space with only you in it; a shared workspace or a community archive is
a bigger space; a website is a space too. Every member sees the whole file list, even files nobody
online holds right now.

```
 your app / the swarmfs CLI
┌──────────────────────────────────────────────────────────────┐
│ SwarmFS     drives, sites, linked folders, sync, trash        │
├──────────────────────────────────────────────────────────────┤
│ hypergraph  identity, devices, spaces, records, replication   │──▶ peers in each space
│ swarmwire   hash → bytes, verified, served in place           │──▶ over the same connections
└──────────────────────────────────────────────────────────────┘
      reads and hashes files where they lie on your disk
```

## Core ideas

- **Drives.** A `Drive` is one space seen as a folder tree. `add` hashes a file or folder where it
  lies (BLAKE3) and records it; nothing is copied. A file is one hash with possibly many local paths,
  and a hash held here is never downloaded again.
- **Holdings.** Each device records which hashes it holds and where, in a personal space only the
  person's devices share. Listings show who holds each file and who is online; `fetch` gets it from
  one of them, verified piece by piece and resumable.
- **Linked folders.** An added folder is linked: a local folder kept in step with a folder of the
  space. On another device, `link` ties the same space folder to a local path.
- **Sync.** While `sync()` runs, edits, new files, renames, moves and deletes on disk reach the space
  once a file has been still for 2 s, and every other linked copy follows: missing files fetched (or
  copied if already held), renamed, moved, updated, removed.
- **Conflicts.** Two devices edited one file apart: both versions are kept, the losing one as
  `name (<device>'s copy).ext`. Each edit carries the versions it replaces, so a newer version is
  never mistaken for a conflict.
- **Trash.** Syncing never destroys a file: what it replaces or removes goes to the folder's
  `.swarmfs-trash`, which only `emptyTrash()` deletes. A folder that vanishes (an unplugged drive) is
  paused, never read as deleted, and deleting more than half of a folder at once waits for a
  confirmation. In a shared space, removed entries go to a bin anyone can restore from.
- **Sharing.** Invite people as editors or readers, choose who may invite, name yourself, remove or
  ban, and choose whether others see which of your devices hold what.
- **Sites.** A site is a space with pages only its owner and admins write and uploads by its
  members: read by invite or by public link, cached in a capped app storage, installable whole.

## Example

```js
import { SwarmFS } from 'swarmfs'

// PC
const pc = await SwarmFS.open('./pc', { password: 'secret', deviceName: 'pc' })
const drive = await pc.createSpace('My files')
await drive.add('/home/me/photos')            // hashed in place, now a linked folder
const { code, added } = await pc.addDevice({ password: 'secret' })

// phone, with the code
const phone = await SwarmFS.open('./phone', { password: 'secret', joinCode: code, deviceName: 'phone' })
await added
await new Promise((resolve) => {              // the space arrives a moment after pairing
  const here = () => phone.spaces().some((s) => s.key === drive.key) && resolve()
  phone.on('spaces', here)
  here()
})
const same = phone.space(drive.key)
const { items } = await same.list()           // the whole tree, with who holds each file
await same.link(same.top, '/sdcard/photos')   // keep a local copy in sync
await phone.sync()                            // keeps syncing until phone.close()
```

## Quick start

SwarmFS expects `hypergraph` and `swarmwire` checked out next to it (`../hypergraph`,
`../swarmwire`); `npm install` links them.

```bash
npm install
node bin/swarmfs.js init              # asks for a password that seals the recovery phrase
node bin/swarmfs.js                   # a shell, online until quit; "help" lists the commands
```

In the shell: `create "My files"`, `add "My files" ~/photos`, `pair` (prints a code). On a second
machine: `swarmfs join <code>`, then in its shell `ls "My files"`, `link "My files" photos ~/photos`.
More in [docs/cli.md](docs/cli.md).

## Tests

```bash
npm test             # Node
npm run test:bare    # Bare
npm run test:all     # both
npm run test:slow    # a 100 MB fetch; 10,000- and 1,000-file syncs
npm run perf         # performance scenarios, see docs/performance.md
```

Tests are scenarios through the public API, each on a local DHT. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Docs

[docs/](docs/README.md): the [API](docs/api.md), [spaces and bytes](docs/files.md),
[sync](docs/sync.md), [sharing](docs/sharing.md), [sites](docs/sites.md),
[data model](docs/data-model.md), [CLI](docs/cli.md), [performance](docs/performance.md).

## License

MIT
