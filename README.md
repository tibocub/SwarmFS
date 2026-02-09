# SwarmFS

SwarmFS is a peer-to-peer file sharing system that lets you share files and folders **without a central server**.

It combines:
- **BitTorrent-style chunking** (download from multiple peers, resume, repair)
- **IPFS-style content addressing** (files are identified by what they contain, not where they are or who hosts them)
- **Hyperswarm discovery** (find peers by “topic”, with NAT traversal/hole-punching)

If you can share a link, you can share a file.

## Why SwarmFS (non-technical view)

Centralized services (Google Drive, Dropbox, etc.) are convenient, but:
- your data is stored on someone else’s servers
- access can be limited by accounts, regions, pricing, quotas, policy changes
- availability depends on the service staying up (and you keeping access)

SwarmFS aims to make sharing feel like sending a link, while the storage is **distributed across the people who care about the data**.

## The idea in one minute

- **A “topic”** is a group you join (think “music”, “my-friends”, “project-x”).
- When you join a topic, SwarmFS uses Hyperswarm to discover peers.
- Files are split into chunks; each chunk is hashed; the full file is identified by a **Merkle root**.
- To download a file, you request its Merkle root in a topic; peers offer chunks; you verify chunks as they arrive.

You don’t download “from a server”. You download from the swarm.

## How SwarmFS compares

### Compared to Google Drive / Dropbox

- **No central storage provider**: peers collectively provide availability.
- **No account required to share**: sharing is content-addressed.
- **Integrity by default**: Merkle verification detects corruption and tampering.

Tradeoff: there is no single company guaranteeing uptime; availability comes from peers staying online.

### Compared to BitTorrent

- **No trackers required** (peer discovery via Hyperswarm topics).
- **Not tied to “.torrent files”**: the content identifier is the Merkle root.
- **Designed for “share this folder in this community”** workflows.

### Compared to IPFS

- **Topic-scoped discovery** instead of a global DHT.
  This makes “communities” and “private groups” a first-class concept.
- Still **content-addressed**, still verified.

Tradeoff: SwarmFS is not trying to be a single global network for all content.

## Quick start

### Requirements

- Node.js (project uses ESM: `"type": "module"`)

### Install

```bash
npm install
```

### Local file tracking

```bash
node cli.js add [path]
node cli.js status
node cli.js verify <path>
node cli.js info <path>
node cli.js stats
```

### Networking (topics)

```bash
node cli.js topic create <name>
node cli.js topic join <name>

node cli.js browse <topic>
node cli.js download <topic> <merkleRoot> <outputPath>
node cli.js network
```

Interactive modes:

```bash
node cli.js shell
node cli.js tui
```

## Concepts

- **Topic**: a human name (or shared secret) turned into a 32-byte key used for discovery.
- **Swarm**: peers currently connected under a topic.
- **Chunks**: fixed-size pieces of files (default ~256 KiB).
- **Merkle root**: the file identifier; also used to verify the full file at the end.

## Documentation (deep dives)

Docs are intentionally kept for topics that are too long for the README:

- `docs/PHASE_1_COMPLETE.md` — Content addressing, chunking, Merkle trees
- `docs/PHASE_2_COMPLETE.md` — Protocol + networking model (topics, messages, verification)
- `docs/PHASE_3_COMPLETE.md` — Database model + sharing/indexing semantics

## Roadmap

This is the living roadmap: what’s done, what’s next, and what we know needs work.

### Done

- Fixed-size chunking and SHA-256 hashing
- Merkle tree construction + per-chunk verification
- File metadata + chunk metadata persisted (SQLite via `better-sqlite3` on Node and Bun's built-in SQLite on Bun)
- Topic-based peer discovery (Hyperswarm)
- Chunk transfer protocol (request/offer/download/chunk_data)
- Multi-peer downloads and endgame mode
- Final file verification and corruption diagnostics
- Directory tracking and deterministic directory hashing
- CLI + REPL + TUI

### Next (high priority)

- Improve “public index” browsing UX (search, filters, pagination)
- Better resilience when peers go offline mid-transfer
- Smarter peer selection and rate limiting
- Better sharing controls (per-topic allowlist/denylist, “private share” tokens)

### Planned

- Background re-announce + periodic integrity checks
- Partial file download (ranges / selective chunks)
- Multi-file bundles (directory download as a single request)
- DHT-free “invite links” for private swarms
- Optional encryption-at-rest for local metadata

### Known issues / drawbacks

- Availability depends on peers (there is no central always-on pinning by default)
- NAT traversal isn’t perfect; some networks may reduce connectivity
- Content discovery is still evolving (topic-scoped index is young)
- Performance tuning is ongoing (disk IO scheduling, backpressure, congestion control)

## License

MIT
