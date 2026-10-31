# Quickstart: SwarmFS 003 — check shared workspaces by hand

Two people (two identities, two instance folders; one machine with a local DHT works, as the tests).
Commands: [contracts/api.md](contracts/api.md). Each step below is also a scenario test (tasks.md).

## Setup

```bash
SWARMFS_PASSWORD=pw swarmfs init --dir ./alice --name pc
SWARMFS_PASSWORD=pw swarmfs init --dir ./bob --name pc
SWARMFS_PASSWORD=pw swarmfs --dir ./alice
SWARMFS_PASSWORD=pw swarmfs --dir ./bob
```

Alice: `name Alice`, `create Family --invites admins`, `add Family ./Photos`, `invite Family` → code.
Bob: `name Bob`, `accept <code>`, `ls Family`, `link Family Photos ./Photos`.

## Check

1. Bob's `./Photos` fills; `members Family` on both shows Alice (owner) and Bob (editor).
2. Bob edits a photo: Alice's copy updated, her old version in `./Photos/.swarmfs-trash`.
3. Both offline, both edit `notes.txt`, reconnect: `notes (Bob's copy).txt` (or Alice's) on both.
4. Bob deletes Alice's photo: gone from both folders (in each trash), listed by `bin Family`;
   `restore Family <id>`: back on both.
5. Bob `bin empty Family`: Alice's entry is kept (not his); Alice `bin empty Family`: gone for good.
6. Bob `invite Family`: refused ("owner and admins"); Alice `invites Family everyone`; Bob's works.
7. Alice `show-holdings Family on`: Bob's `ls` shows "Alice, online" on her files.
8. Alice `remove Family Bob`: Bob's shell prints `paused ./Photos (removed from Family)`; his files
   stay; Alice's next file never reaches him.

Leftovers: delete `./alice`, `./bob` and `E:\Code\P2P\.tmp` test folders when done.
