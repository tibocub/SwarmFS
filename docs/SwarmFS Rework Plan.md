# SwarmFS Rework Plan (Notes)

## Scope

Compare:

- SwarmFS (`E:\Code\P2P\SwarmFS`)
- hyper-overlay (`E:\Code\P2P\hyper-overlay`)

Constraints:

- No implementation code here.
- Statements should be grounded in the repo code/docs.

## SwarmFS (as implemented)

### High-level modules

- `cli.js` (entrypoint)
- `src/swarmfs.js`: orchestrator
  - Tracks files (chunk+hash+Merkle)
  - Topic management (create/join/share)
  - Browse/download orchestration
- `src/database.js`: SQLite metadata DB (`files`, `file_chunks`, `topics`, `topic_shares`, `downloads`, plus VFS tables)
- `src/network.js`: Hyperswarm join/leave + connection bookkeeping
- `src/protocol.js` + `src/protocol/*`: Protomux multiplexed protocol on top of Hyperswarm conns
- `src/download.js` + `src/download/*`: per-file download session with subtree batching, scheduling, disk writer
- `src/merkle.js`, `src/hash.js`: BLAKE3 hashing and Merkle tree build/proof/verify (native accelerated via `swarmfs-native` when available)
- `src/vfs.js`: virtual directory structure stored in DB; derives a directory Merkle root from children

### Data flow (read/write paths)

#### Add/track local file

Source: `src/swarmfs.js:addFile()`

- Reads file from local filesystem in a stream (`_readFileChunksStream`)
- Uses **fixed 1MiB chunks** (`DEFAULT_CHUNK_SIZE`), regardless of input param
- Computes per-chunk hash via `hashBuffer` (BLAKE3)
- Computes file ID as **Merkle root over chunk hashes** (`getMerkleRoot`)
- Persists:
  - `files`: `{ path, merkle_root, size, chunk_size, chunk_count, file_modified_at, ... }`
  - `file_chunks`: `(file_id, chunk_index, chunk_hash, chunk_offset, chunk_size)`
- Dedup behavior: if `getFileByMerkleRoot(merkleRoot)` exists, adds a new `files` row for the new path but **skips writing chunk mappings** for the duplicate path.
  - Practical implication: DB can have multiple file paths per same root, but only the “first” one necessarily has a complete `file_chunks` map.

#### Share/browse

- Shares appear in DB as `topic_shares` (metadata), and browse is currently “aggregate from peers” style.
- `README.md`/`docs/ARCHITECTURE.md` state browse/discovery is a temporary design; Autobase-based discovery planned.

#### Download

Source: `src/swarmfs.js:browseTopic()` (request file list), `src/download.js`.

- Join topic (Hyperswarm)
- Request file list + metadata (Merkle root + chunk list)
- DownloadSession uses:
  - `PeerManager` + `ChunkScheduler` for selection
  - `DiskWriter` to preallocate/seek-write
  - Chunk verification using BLAKE3
  - Final verification using Merkle root / subtree proofs

Important implementation detail:

- The download loop uses **subtree requests**: a single in-flight request represents a range of chunks (power-of-two sized, aligned), not individual chunks.
- The invariants around `chunksInFlight` are explicitly documented in code and in `docs/ARCHITECTURE.md`.

### Networking model

- Peer discovery: **Hyperswarm topic** = 32-byte key per “topic” (`topics.topic_key`) and join/leave.
- Transport/mux: uses **Protomux** to frame messages on each Hyperswarm encrypted stream.
- `network.js` keeps:
  - `topics`: map topicKeyHex → `connections: Map<peerId, conn>`
  - `peerConnections`: peerId → conn + set of topics
- There is additional logic for “manual attribution” of connections to topics when Hyperswarm does not label incoming connections with topics.

### Protocol (SwarmFS)

From `src/protocol/message-codec.js` and `src/protocol.js`:

- Binary message encodings (`compact-encoding`)
- Message types include:
  - Chunk request/offer/data (classic)
  - File list request/response
  - Metadata request/response
  - Bitfield/bitfield request
  - Subtree request + subtree streaming parts + subtree proof

Integrity checks (implemented):

- Per-chunk integrity: receiver hashes received bytes and matches against expected chunk hash (`hashBuffer`)
- Subtree proof: receiver verifies a proof linking an internal subtree node to the trusted file Merkle root

Important tradeoff currently taken (explicit in code):

- `handleRequest()` notes an “alpha optimization”: **skip per-chunk Merkle proofs** and even skip `DOWNLOAD` RTT; stream chunk data immediately after `OFFER`.

### Storage strategy

- **In-place file storage**: the real bytes remain at user file paths.
- DB stores metadata and chunk maps.
- Downloads write to `outputPath` using `DiskWriter` (preallocate + random writes) and can resume by verifying existing chunks.

### Consistency & trust model

- Trust anchor for file correctness: **Merkle root** + expected chunk list (metadata). Once you trust a Merkle root, chunk content is self-verifying.
- Topic browsing is explicitly called “dangerous” in README for public topics: browsing can surface malicious content; safe usage is “download by trusted hash.”

### Performance characteristics (based on code)

- Chunking: fixed 1MiB chunks → predictable memory overhead and fewer hashes.
- Downsides:
  - Small-file overhead: 1MiB chunking is inefficient for many small files.
  - Cross-file dedup: coarse; only identical 1MiB-aligned blocks dedup.
- Download session uses subtree batching targeting up to ~64MiB per subtree but capped by a legacy 16MiB atomic write limit.
- There is a Merkle tree LRU cache (`MerkleTreeCache(10)`) for serving proofs.

### Developer experience

- SwarmFS is a standalone app/CLI with its own DB schema and protocol.
- It depends on Holepunch primitives (Hyperswarm, Protomux, Autobase in deps), but its main metadata layer is SQLite.

## hyper-overlay (as implemented)

### High-level modules

From `index.js`, `lib/*`, `docs/design-v2.md`, `SPEC.md`.

- Metadata index: `lib/file-index.js` (Hyperbee)
- Sync/consistency: `lib/sync-engine.js` (Hypercore feed + conflict logic)
- Transfer: `lib/transfer.js` (on-demand chunking and direct-to-disk partial file assembly)
- Protocol v2: `lib/protocol-v2.js` (Protomux channel `hyper-overlay/v2` for sync + transfer)
- Watcher: `lib/watch-manager.js` (localwatch integration; not reviewed yet)
- Pairing: `lib/pairing.js` uses blind pairing to exchange a shared topic

### Core invariants

- The filesystem is the storage of bytes. Hyperbee stores metadata only.
- Chunking is content-defined (FastCDC) with adaptive tiers. All peers must pick same tier for a given file size.
- Transfers stream only missing chunks; receiver verifies each chunk hash and uses atomic rename from `.overlay-partial`.

### Addressing and identifiers

- Chunk hash: blake2b-256 from `hypercore-crypto` (per `SPEC.md`)
- File hash: blake2b-256 of full file bytes
- Chunk boundaries: FastCDC-derived; stable under localized edits

### Persistence

- `file:<path>` → `{ contentHash, size, mtime, ... }`
- `chunkmap:<path>` → `[{ hash, offset, length }, ...]` (persisted for large files)
- `sync:<peerKey>:<path>` → `{ lastSeq, lastHash }`

### Protocol v2 flow

From `lib/protocol-v2.js`:

- On channel open: exchange `syncState` (feed key + seq)
- Offer changes by sending `fileOffer` entries derived from local feed
- Receiver requests files it lacks (`fileRequest`)
- Sender responds with `chunkHashes` then receiver replies with `chunkNeed` indices
- Sender sends `chunkData` for required indices
- Receiver verifies chunk hashes, writes to partial, finalizes, logs to feed, updates sync state

## Early comparison notes (directional)

- SwarmFS today is closer to: “topic-scoped *content addressing + retrieval by hash*” with optional browsing.
- hyper-overlay is closer to: “device-to-device *file sync* with conflict semantics,” with chunking primarily as transfer optimization + dedup.

## Open questions / follow-ups to ground next

SwarmFS:

- How `metadata` is exchanged in practice: confirm schema and whether metadata is derived from `file_chunks` for all roots.
- Serving policy: `docs/ARCHITECTURE.md` claims serving ignores `topic_shares` and serves any local file matching chunk hash; confirm where `_findValidChunkSource` pulls candidates from.
- Private topic security model: confirm topic key derivation and whether it is password-derived.

hyper-overlay:

- Confirm watcher + ignore behavior in implementation (deny list, `.overlayignore`).
- Confirm how it uses Hyperswarm topics (pairing topic vs shared topic) in daemon mode.
