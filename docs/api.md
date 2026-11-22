# API

```js
import { SwarmFS, SwarmFSError } from 'swarmfs'
```

Everything is async unless marked *sync*. Keys and ids are hypergraph's z32 strings. Hashes are
BLAKE3 roots in hex.

## Opening

```js
const sfs = await SwarmFS.open(dir, {
  password,        // seals the recovery phrase when the folder is made (new, or with joinCode);
                   //   not needed at later opens; addDevice asks for it again
  joinCode,        // open as a new device of an existing person (a code from addDevice)
  joinTimeout,     // ms a joinCode is tried (hypergraph's default)
  mnemonic,        // a 24-word recovery phrase: restore that identity into a new folder
                   //   (NOT_ALLOWED if the folder holds another identity)
  deviceName,      // this device's name when made, e.g. 'phone'
  bootstrap,       // [{ host, port }]: DHT nodes (a private DHT, in tests)
  fetchTimeout,    // ms without progress before a fetch gives up (default 30000)
  minFree,         // bytes a fetch into a linked folder leaves free (default max(5 GB, 5 % of the disk))
  appStorageMax,   // bytes: app storage's cap (default 1 GiB)
  offline          // true: read the folder as it is: no rescan, no name published, never online
})
```

`open` rescans the disk once, then connects. `sfs.hg` is the underlying `Hypergraph` (recovery
phrase, removing a device...); `sfs.device` (*sync*) is this device's key.

| Call | Returns | Notes |
|---|---|---|
| `sfs.addDevice({ password })` | `{ code, added }` | `added` resolves to the new device, or null when the code expired |
| `sfs.devices()` | `[{ publicKey, name, current, online }]` | |
| `sfs.setName(name)` / `sfs.name()` | | the person's name, the same on every device; `INVALID_NAME` |
| `sfs.close()` | | stops syncing and fetching (partial downloads stay) |

## Spaces and entries ([files.md](files.md))

| Call | Returns | Notes |
|---|---|---|
| `sfs.createSpace(name, { invites })` | `Drive` | a private files space; `invites`: `'everyone'`, `'chosen'`, `'admins'` (default) |
| `sfs.join(code, { timeout })` | `Drive` | hypergraph's `INVITE_*` errors |
| `sfs.leave(key)` | | its linked folders unlinked here (files stay) |
| `sfs.spaces()` *sync* | `[{ key, name }]` | |
| `sfs.space(key)` *sync* | `Drive` | `NOT_FOUND` |
| `drive.key`, `drive.name`, `drive.top` *sync* | | `top`: the top folder's id, the space key |
| `drive.add(localPath, { parent })` | entry | in place; a folder becomes linked; `NOT_FOUND`, `EXISTS` |
| `drive.list(folder, { limit, after, timeout })` | `{ items, complete }` | folders first, then files, by name; `limit` 100 |
| `drive.get(id)` | entry | `NOT_FOUND` |
| `drive.fetch(id, localFile)` | `{ path, bytes }` | `EXISTS`, `NOT_AVAILABLE`, `NOT_FOUND`; `bytes` 0 when already held |
| `drive.rename(id, name)` | entry | `INVALID_NAME` |
| `drive.move(id, folder)` | entry | `MOVE_INTO_SELF`, `NOT_FOUND` |
| `drive.remove(id)` | | to the bin in a shared space; local files never touched |
| `drive.on(event, fn)` / `off` | | the space's events: `'change'`, `'peers'`, `'members'`... |

An entry: `{ id, kind: 'folder' | 'file', name, parent, size, hash, holders }`; a holder:
`{ device, identity?, name, online, path }` (`path` only for this device).

## Linked folders and sync ([sync.md](sync.md))

| Call | Returns | Notes |
|---|---|---|
| `drive.link(folder, localPath)` | | `folder`: an id or `drive.top`; the path is made if missing; `EXISTS`, `NOT_FOUND` |
| `sfs.unlink(localPath)` | | no file or entry removed; `NOT_FOUND` |
| `sfs.links()` | `[{ path, space, folder, paused }]` | `paused`: null, `'missing'`, `'mass-delete'`, `'removed'`, `'in-bin'` |
| `sfs.confirm(localPath)` | | applies a mass delete; `NOT_FOUND` if not so paused |
| `sfs.sync()` | | runs until `close()`; resolves after the first pass; calling again returns the same promise |
| `sfs.rescan()` | | follows the disk once |
| `sfs.trash()` | `[{ folder, path, size, trashed }]` | |
| `sfs.emptyTrash()` | `{ files, bytes }` | the only call that deletes a person's bytes |

Events: `sfs.on('sync', e)` (shape in [sync.md](sync.md#events)), `sfs.on('spaces', fn)`,
`sfs.on('members', ({ space, joined, left }) => {})` (`joined`, `left`: `[{ identity, name }]`).

## People ([sharing.md](sharing.md))

| Call | Returns | Notes |
|---|---|---|
| `drive.invite({ role, uses, expires })` | code | `role`: `'editor'` (default) or `'reader'`; `uses` 1; `expires` ms timestamp, 0 never; `NOT_ALLOWED`, `NOT_SUPPORTED` |
| `drive.revokeInvite(code)` | | |
| `drive.invites()` / `drive.setInvites(setting)` | setting | `'everyone'`, `'chosen'`, `'admins'` |
| `drive.members()` | `[{ identity, name, role, you, removed, banned, online }]` | |
| `drive.setRole(identity, role)` | | `'admin'`, `'trusted'`, `'editor'`, `'reader'` |
| `drive.removeMember(identity, { ban, dropAll })` | | `dropAll` also drops what they added |
| `drive.bin()` | `[entry & { from, binned, by: { identity, name } }]` | latest first |
| `drive.restore(id)` | entry | back to `from`, or the top if gone |
| `drive.emptyBin()` | `{ removed, kept }` | `kept`: what this person may not delete |
| `drive.showHoldings(on)` | | default off |

## Sites ([sites.md](sites.md))

`Site` extends `Drive` (members, roles, invites as above).

| Call | Returns | Notes |
|---|---|---|
| `sfs.createSite(name, { invites, types, app, private })` | `Site` | `INVALID_TYPE`, `INVALID_PARAMS` |
| `sfs.visit(link, { timeout })` | `Site` | an invite or a public link; `timeout` 30000 |
| `sfs.site(key, { timeout })` | `Site` | `NOT_FOUND`; `timeout` 10000 |
| `site.pages` *sync* | `Drive` | the pages sub-space |
| `site.app`, `site.isPublic` *sync* | | |
| `site.publish(localFolder)` | | the folder becomes the pages (linked) |
| `site.read(path, { timeout })` | bytes | `NOT_FOUND`, `NOT_AVAILABLE`; `timeout` 10000 |
| `site.makePublic()` / `site.publicLink()` *sync* | link | for good |
| `site.declareTypes(types)` | | additions only |
| `site.upload(localFile, { name })` | upload | `INVALID_NAME`, `NOT_FOUND` |
| `site.uploads()` | `[upload]` | latest first |
| `site.readUpload(id)` | bytes | |
| `site.renameUpload(id, name)` / `site.removeUpload(id)` | | |
| `site.keep(on, { timeout })` / `site.kept()` | | installed or not, on this device |
| `site.held()` | bytes count | |
| `sfs.exportSites(keys, folder)` | | a pack of public sites |
| `sfs.importSites(folder, { timeout })` | site keys | `IMPORT_INVALID` |

An upload: `{ id, name, size, hash, author }`.

## Errors

`SwarmFSError` has a `code`: `NOT_FOUND`, `EXISTS`, `NOT_AVAILABLE`, `MOVE_INTO_SELF`,
`INVALID_NAME`, `INVALID_PARAMS`, `INVALID_TYPE`, `NOT_SUPPORTED`, `IMPORT_INVALID`. Hypergraph's
errors pass through unchanged: `NOT_ALLOWED` (with its reason), `RULE_REJECTED`,
`INCOMPATIBLE_TYPES`, `INVITE_EXPIRED`, `INVITE_USED_UP`, `INVITE_REVOKED`, `INVITE_INVALID`.
A wrong `invites` setting or invite `role` throws a plain `TypeError`.
