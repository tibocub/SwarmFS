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

Not yet: shared spaces with other people, automatic download, folder watching (later stories in the spec).

## Quickstart

Library: [quickstart.md](specs/001-personal-sync/quickstart.md), API: [contracts/api.md](specs/001-personal-sync/contracts/api.md).

CLI on two machines (`npm install`, then `npx swarmfs …`, `node bin/swarmfs.js …` or `bare bin/swarmfs.js …`):

```bash
# PC: a shell, online (serving) until quit
swarmfs
> create "My files"
> add "My files" ~/photos
> pair                            # prints a code

# second machine
swarmfs join <code>
swarmfs
> ls "My files"
> ls "My files" <folder id>
> get "My files" <file id> ./a.jpg
```

`help` in the shell lists every command. Data in `~/.swarmfs` (`--dir` for another folder).

## Tests

```bash
npm test             # Node
npm run test:bare    # Bare
npm run test:all     # both
npm run test:slow    # 100 MB fetch, both
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
