# Contract: SwarmFS v1 public API

What an app writes. Async unless marked sync. Errors: hypergraph's `HypergraphError` codes pass
through; SwarmFS adds `SwarmFSError` with `code`: `NOT_AVAILABLE`, `EXISTS`, `NOT_FOUND`,
`INVALID_NAME`. Keys and ids are z32 strings (hypergraph's).

```js
import { SwarmFS } from 'swarmfs'

const sfs = await SwarmFS.open('./data', {
  password,        // seals the recovery phrase (hypergraph)
  joinCode,        // open as a new device of an existing account
  deviceName,      // 'phone'
  bootstrap,       // DHT nodes (tests)
  fetchTimeout     // ms without progress before a fetch gives up (default 30000)
})                 // connected; spaces' protocols attached; rescan() run once
sfs.hg             // sync: the Hypergraph (recoveryPhrase, protectRecoveryPhrase, removeDevice…)
sfs.device         // sync: this device's key

const { code, added } = await sfs.addDevice({ password })   // hg.addDevice
await sfs.devices()                                          // [{ publicKey, name, current, online }]

const drive = await sfs.createSpace('My files')   // a files space (private)
sfs.spaces()                                      // sync: [{ key, name }]
sfs.space(key)                                    // sync: the Drive; NOT_FOUND
sfs.on('spaces', () => {})                        // the list changed (needs hypergraph request H1)

drive.key; drive.name; drive.top                  // sync; top: the id of the top folder (= key)
await drive.add(localPath, { parent })            // a file or a folder, in place → the entry
await drive.list(folder = drive.top, { limit: 100, after, timeout })
// { items: [{ id, kind: 'folder' | 'file', name, parent, size, hash,
//             holders: [{ device, name, online, path }] }],   // path: only for this device
//   complete }                                   // folders first, then files, by name
await drive.get(id)                               // one entry, same shape; NOT_FOUND
await drive.rename(id, name)
await drive.move(id, folder)
await drive.remove(id)                            // and its subtree; local files untouched
await drive.fetch(id, localPath)                  // → { path, bytes }: bytes 0 if held here (path is
                                                  //   the existing one); EXISTS if localPath exists;
                                                  //   NOT_AVAILABLE if no online holder / no progress
drive.on('change', () => {})                      // entries changed (space 'change' event)

await sfs.rescan()                                // follow the disk: see data-model.md
await sfs.close()
```

CLI (story 5): `swarmfs [--dir d] init | pair | join <code> | create <name> | add <space> <path> |
ls <space> [folder] | get <space> <id> <path> | rescan | devices`.
