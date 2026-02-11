## ! EARLY ALPHA - breaking changes expected !

# SwarmFS

SwarmFS is a P2P file-sharing protocol that aims to be faster
than IPFS and easier than BitTorrent to setup and use.

It's heavily inspired from BitTorrent and IPFS but here is what's different:

SwarmFS vs BitTorrent
- BitTorrent uses a centralized tracker to find peers, SwarmFS is 100% decentralized
- SwarmFS uses content-addressing regardless of the file's name, owner, path, or any other metadata. That means data is more resilient in SwarmFS than in a torrent.

SwarmFS vs IPFS
- IPFS do content-addressing on the entire network (all connected peers), which takes a lot of time
- SwarmFS do content-addressing over specific topics. SwarmFS encourages the users to make specific topics reather that mixing every file and request together (much fast and it's easier to make private networks)
- SwarmFS don't forces you to know the hash of the file you want to download, it comes with a public-sharing and public content browsing features to easily share and download files in a topic.


At its core:

- **Content addressing** (BLAKE3) and **Merkle trees** for integrity
- **Chunked transfers** (BitTorrent-style)
- **Topic-scoped peer discovery** via Hyperswarm
- A small protocol for **browsing**, **metadata exchange**, and **chunk transfer**


This repository’s README/docs are written for:

- new contributors who want to understand the architecture quickly
- ourselves as a dev log/reference for “what exists and how it works”


## Project goals (engineering)

- Verified downloads from untrusted peers
- Resume/repair at the chunk level
- Multi-peer downloads and endgame mode
- Topic-scoped content discovery (browse what peers in a topic share)

Non-goals (for now):

- Global IPFS-like DHT content routing
- A polished end-user UX (website/video will cover that)


## Running the project

### Requirements

- Node.js (ESM project: `"type": "module"`)
- Bun is supported as a runtime (TUI integration already checks `process.versions.bun`)

### Install (also compatible with Bun)

```bash
npm install
```

### CLI (main entrypoint)

```bash
node cli.js help

node cli.js add [path]
node cli.js status
node cli.js verify <path>
node cli.js info <path>
node cli.js stats

node cli.js topic create <name>
node cli.js topic join <name>
node cli.js topic share <topic> <path>
node cli.js browse <topic>
node cli.js download <topic> <merkleRoot> <outputPath>
```

Interactive modes (keeps the P2P networking alive):

```bash
node cli.js shell
node cli.js tui
```

### Debugging

- Set `SWARMFS_VERBOSE=1` to enable verbose logs in networking/protocol.
- The protocol currently prints a lot of `[DEBUG] ...` output during message handling and proof generation.


## Architecture (high level)

Data flow for a typical download:

1. Join topic (Hyperswarm)
2. Browse topic → aggregate file list (Merkle roots)
3. Request metadata by Merkle root (chunk list)
4. Schedule chunk requests across peers
5. Receive chunks → verify hash → write at correct offsets
6. Verify final Merkle root

### Concepts

- **Topic**: 32-byte key used for Hyperswarm discovery. Stored in DB as hex.
- **Merkle root**: file identifier.
- **Chunk hash**: leaf hash in the file Merkle tree.
- **Chunk size**: stored per file (`file.chunk_size`). Files may have different chunk sizes.

### Codebase tour

- `cli.js`
  - Commander CLI wiring + keep-alive commands (`topic join`, `request`, `tui`, `shell`).
- `src/commands.js`
  - CLI command implementations (thin wrappers around `SwarmFS`).
- `src/swarmfs.js`
  - Main coordinator: DB, hashing/Merkle, directory scanning, network/protocol wiring.
- `src/database.js`, `src/sqlite.js`
  - Persistent metadata store.
- `src/network.js`
  - Hyperswarm wrapper; topic-aware peer tracking.
- `src/protocol.js`
  - Message framing + request/offer/download/chunk_data + browse/metadata.
- `src/download.js`
  - Download session state machine, scheduling, endgame, verification/write.
- `src/chunk-scheduler.js`, `src/peer-manager.js`, `src/bitfield.js`
  - Scheduling + peer state.
- `src/merkle.js`
  - Merkle tree construction + proof helpers.
- `src/merkle-tree-parallel.js`, `src/merkle-worker.js`
  - Parallel Merkle building experiments.


## Developer documentation

- `docs/Chunks, Hashes and Merkle Trees.md` — Content addressing + Merkle tree implementation notes
- `docs/P2P Networking and File Transfer.md` — Protocol, message framing, and networking behavior
- `docs/Database and Local Data.md` — Local metadata model + topic sharing semantics


## Roadmap

This is the living roadmap: what’s done, what’s next, and what we know needs work.

### Done

- Adaptative-size chunking and SHA-256 hashing // Replaced with BLAKE3 hashing
- Merkle tree construction + per-chunk verification
- File metadata + chunk metadata persisted (SQLite via `better-sqlite3` on Node and Bun's built-in SQLite on Bun)
- Topic-based peer discovery (Hyperswarm)
- Chunk transfer protocol (request/offer/download/chunk_data)
- Multi-peer downloads and endgame mode
- Final file verification and corruption diagnostics
- Directory tracking and deterministic directory hashing
- Basic CLI, REPL and TUI
- Replace SHA256 with BLAKE3 (with WASM and SIMD)

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
- Refactor current browsing system (request every user's shared files and aggregate localy) with autobase
- IPNS-like topic-based domains (a permanent addresses with and editable endpoint) with autobase
- Virtual directories (manage your tracked files, links and virtual directories in the SwarmFS virtual file-system)

### Known issues / drawbacks

- Availability depends on peers (there is no central always-on pinning by default)
- NAT traversal isn’t perfect; some networks may reduce connectivity
- Content discovery is still evolving (topic-scoped index is young)
- Performance is bad but right now we're focussing developing on the protocol itself

### Performance TODOs (ideas to evaluate)

- **Adaptive chunk size per file**
  - Keep a small default for small files.
  - Increase chunk size for very large files to reduce message/CPU overhead.
  - Requires keeping chunk size in metadata (already supported).
- **Batch transfers / grouped chunks**
  - Allow requesting/serving a contiguous range of chunks in one response.
  - Receiver verifies and writes a group as a unit.
- **Merkle multi-proofs / subtree proofs**
  - Instead of per-chunk proofs, request/serve proofs for a whole range/subtree.
  - Align chunk groups to power-of-two subtrees to make proofs compact.
- **Pipelined hashing + verification**
  - Keep downloads flowing while verification happens in parallel batches.
- **Adaptive download strategy**
  - Many peers: rarest-first / parallel chunking.
  - Few peers: larger sequential ranges.
  - One peer: sequential streaming (torrent-style).
- **Proof caching / reuse**
  - Cache proof fragments per file to avoid recomputing siblings repeatedly.
- **Compression of protocol metadata**
  - Compact encodings (varints), hash dedup in proofs, optional compression for proof blocks.


## License

MIT
