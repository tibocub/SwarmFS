# SwarmFS

A decentralized filesystem. Folders and files are records in
[hypergraph](../hypergraph) spaces; file bytes move through [swarmwire](../swarmwire),
content-addressed and verified, served from where they already sit on disk — never copied
into a store.

One building block, the **space**: a personal sync folder is a space with only you in it; a
shared workspace or a community archive is a bigger space. Every member sees the whole file
list, even files nobody online holds right now. A file is one hash with possibly many local
paths, and a hash held locally is never downloaded again.

> Status: **rewrite starting** (2026-10-22). Nothing runs yet. First version: two devices of
> one identity — see on the phone what the PC holds, fetch it while the PC is online.
> Spec: [specs/001-personal-sync](specs/001-personal-sync/spec.md).
> The previous code is in `SwarmFS-old` (reference only).

## Layering

```
SwarmFS      names, folders, who holds what        (records in hypergraph spaces)
hypergraph   identity, devices, spaces, replication
swarmwire    hash → bytes, verified, served in place
```

## License

MIT
