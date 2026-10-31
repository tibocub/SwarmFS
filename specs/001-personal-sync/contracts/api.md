# Contract: SwarmFS v1 public API

What an app writes. Async unless marked sync. Errors: hypergraph's `HypergraphError` codes pass
through; SwarmFS adds `SwarmFSError` with `code`: `NOT_AVAILABLE`, `EXISTS`, `NOT_FOUND`, `MOVE_INTO_SELF`,
`INVALID_NAME`. Keys and ids are z32 strings (hypergraph's).

```js
import { SwarmFS } from 'swarmfs'

const sfs = await SwarmFS.open('./data', {
  password,        // seals the recovery phrase (hypergraph): used when the folder is made (new or
                   //   joinCode), never in plain text there; not needed at later opens (an older
                   //   folder's plain phrase is sealed by it); addDevice needs it again
  joinCode,        // open as a new device of an existing account
  deviceName,      // 'phone'
  bootstrap,       // DHT nodes (tests)
  readTimeout,     // hypergraph's read bound, ms (default 5000; tests use less)
  joinTimeout,     // how long a joinCode is tried, ms (hypergraph's default)
  fetchTimeout     // ms without progress before a fetch gives up (default 30000)
})                 // connected; member streams handed to swarmwire; rescan() run once
sfs.hg             // sync: the Hypergraph (recoveryPhrase, protectRecoveryPhrase, removeDevice…)
sfs.device         // sync: this device's key

const { code, added } = await sfs.addDevice({ password })   // hg.addDevice
await sfs.devices()                                          // [{ publicKey, name, current, online }]

const drive = await sfs.createSpace('My files')   // a files space (private)
sfs.spaces()                                      // sync: [{ key, name }]
sfs.space(key)                                    // sync: the Drive; NOT_FOUND
sfs.on('spaces', () => {})                        // the list changed (needs hypergraph request H2)

drive.key; drive.name; drive.top                  // sync; top: the id of the top folder (= key)
await drive.add(localPath, { parent })            // a file or a folder, in place → the entry
await drive.list(folder = drive.top, { limit: 100, after, timeout })
// { items: [{ id, kind: 'folder' | 'file', name, parent, size, hash,
//             holders: [{ device, name, online, path }] }],   // path: only for this device
//   complete }                                   // folders first, then files, by name
await drive.get(id)                               // one entry, same shape; NOT_FOUND
await drive.rename(id, name)
await drive.move(id, folder)                      // MOVE_INTO_SELF: a folder into itself or its subtree; NOT_FOUND: not a folder
await drive.remove(id)                            // and its subtree; local files untouched
await drive.fetch(id, localPath)                  // → { path, bytes }: bytes 0 if held here (path is
                                                  //   the existing one); EXISTS if localPath exists;
                                                  //   NOT_AVAILABLE if no online holder, `stalled`, or
                                                  //   no progress for fetchTimeout (resumable later);
                                                  //   bytes land under a .part name until complete
drive.on('change', () => {})                      // entries changed (space 'change' event)

await sfs.rescan()                                // follow the disk: see data-model.md
await sfs.close()
```

CLI (story 5): `swarmfs [--dir d] [--name n] [--bootstrap host:port] [shell]`: online until `quit`,
end of input or Ctrl+C; reads, one per line: `create <name> | add <space> <path> | ls <space> [folder] |
get <space> <file> <path> | rescan | devices | pair | help | quit` (`folder`, `file`: a path of names from the top, or an id), each followed by a `>` line when piped (in a terminal, `> ` starts the line typed on). One-shot:
`init`, `join <code>`, and the shell's commands (scripts; `pair` then ends once the device joined;
`ls`/`get` wait up to 15 s for another device to connect); while a shell holds the folder they fail
with `IN_USE`. `<space>`: name or key, quoted if it has spaces. Password (ROADMAP 2026-10-09: the
recovery phrase is sealed by default): `init` and `join` ask for one (on a new folder; a terminal hides
it and asks twice), `pair` asks once per shell; `SWARMFS_PASSWORD` gives it instead (scripts, tests).
On a folder with no device yet, other commands fail with `NO_DEVICE` (init or join first).
