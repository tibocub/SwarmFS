# Quickstart: SwarmFS 002 — check "always on" by hand

Two machines (or two folders on one machine with a local DHT, as the tests do). Commands:
[contracts/api.md](contracts/api.md). Everything below is also a scenario test (tasks.md).

## Setup

```bash
SWARMFS_PASSWORD=pw swarmfs init --dir ./pc --name pc
SWARMFS_PASSWORD=pw swarmfs --dir ./pc          # the PC's shell, left open
```

In the PC shell: `create "My files"`, `add "My files" ./Photos`, `pair` → a code. On the laptop:

```bash
SWARMFS_PASSWORD=pw swarmfs join <code> --dir ./laptop --name laptop
SWARMFS_PASSWORD=pw swarmfs --dir ./laptop
```

In the laptop shell: `ls "My files"` → the `Photos` id; `link "My files" <id> ./Photos`.

## Check

| Do | Expect |
|---|---|
| (after link) | laptop prints `fetched` per file; `./Photos` on the laptop matches the PC's (`b3sum`) |
| PC: save a new `a.jpg` | laptop: `fetched …/a.jpg` within 10 s; old version under `.swarmfs-trash/<time>/a.jpg` |
| PC: rename `b.jpg` → `c.jpg` | laptop renames it; nothing downloaded |
| PC: delete `c.jpg` | laptop: `trashed …/c.jpg`, the file in its trash |
| PC: create `x.tmp`, `~$doc.docx` | nothing on the laptop |
| close the laptop shell; edit `d.txt` on both; reopen | both: `d.txt` and `d (<loser>'s copy).txt` |
| rename the laptop's `./Photos` away | laptop: `paused`; PC: no entry removed. Rename back → `resumed` within 15 s |
| laptop: `links`, `trash`, `trash empty` → `yes` | the trash listed, then emptied |
| `swarmfs ls "My files" --dir ./laptop` while no shell runs | lists; doesn't sync |

## Tests

```bash
npm run test:all     # Node and Bare; stories 1-7
npm run test:slow    # SC-001 (10,000 files), SC-004 (1,000 files)
```
