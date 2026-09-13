# SwarmFS AI Context

## What This System Does

SwarmFS is a P2P file-sharing system using content-addressed storage (merkle roots) inspired by BitTorrent and IPFS. Users join topics (P2P groups), share files, and download from peers who have matching merkle roots—regardless of sharing status. The system handles large files via subtree streaming with merkle proof verification.

## Current Primary Goal

**Development is PAUSED.** SwarmFS is waiting on sibling project `hypergraph`
(`E:\Code\P2P\hypergraph`) to provide multi-writer virtual directories, users/friends, and
moderated swarms — rather than duplicating that work here. See `README.md`'s top note and
constitution Principle III before starting anything that depends on those.

Main branch is **`main`** (not `master`). `dev` was merged into it on 2026-09-13; new work starts
from `main` on its own feature branch.

While paused, the useful work is correctness/documentation upkeep, not new features. If you pick
the project back up, replace this section with the actual current focus — a blank template here
is worse than nothing, because it promises current state and delivers none.

## Rules an AI Must Never Violate

1. **Content-addressed serving**: File lookup is by merkle root ONLY. Sharing status never affects serving decisions.
2. **chunksInFlight counts subtrees**: Each subtree request = 1 in-flight, not per-chunk. Breaking this stalls downloads.
3. **file_modified_at > 0 means complete**: Only files with this set are servable.
4. **CANCEL must decrement counters**: `_activeServes` (in `SubtreeServer`, `src/protocol/subtree-server.js`) and `chunksInFlight` must be decremented on cancel/timeout.
5. **No REPL/interactive commands for testing**: Use CLI commands that exit cleanly (see AGENTS.md).
6. **Run tests after download logic changes**: `node --test tests/core-behaviors.test.js`
7. **Check disk access before serving**: Files in DB may not exist on disk—always verify with `fs.accessSync`.
8. **Protocol message order matters**: SUBTREE_BEGIN → SUBTREE_PART* → SUBTREE_PROOF → completion.

## Directory Map

**`protocol.js` and `protocol/` both exist, and so do `download.js` and `download/` — this is NOT
the shadowed-dead-copy hazard described in AGENTS.md.** Verified: `protocol.js` is a live facade
that imports the real implementations from `protocol/` and re-exports them; `download.js` does the
same for `download/`. Edit the submodule, not the facade. (`protocol/index.js` and
`download/index.js` are unused barrel re-exports — nothing imports them.)

```
src/           # Core logic (start here for any code change)
├── protocol.js       # Facade: message handlers (handleMessage, handleSubtreeRequest,
│                     #   handleCancel, handleBitfieldRequest), re-exports protocol/
├── protocol/
│   ├── subtree-server.js  # SubtreeServer — _activeServes backpressure, subtree streaming
│   ├── message-codec.js   # PROTOCOL_VERSION, MSG_TYPE, encodeMessage/decodeMessage
│   ├── merkle-cache.js    # MerkleTreeCache
│   ├── request-tracker.js # RequestTracker
│   └── index.js           # (unused barrel)
├── download.js       # Facade: download session state machine, re-exports download/
├── download/
│   ├── session-state.js   # SessionState — chunksInFlight lives here
│   ├── chunk-state.js     # ChunkState, ChunkMeta
│   ├── disk-writer.js     # DiskWriter
│   └── index.js           # (unused barrel)
├── database.js    # SQLite layer (SwarmDB class), all persistence
├── sqlite.js      # SQLite driver binding
├── swarmfs.js     # Main API surface, file operations, topic management
├── commands.js    # CLI command implementations
├── network.js     # Hyperswarm wrapper, peer discovery
├── merkle.js      # Merkle tree building and verification
├── bitfield.js    # Chunk availability bitmaps
├── peer-manager.js # Peer state, chunk availability tracking
├── chunk-scheduler.js # Download scheduling, endgame mode
├── chunk.js       # Chunk primitives
├── upload.js      # Upload path
├── config.js      # PROTOCOL_CONFIG and other tunables (e.g.
│                  #   MAX_CONCURRENT_SUBTREE_SERVES)
├── validation.js  # Input validation
├── errors.js      # Error types
├── identity/      # Multi-device identity (crypto.js, identity.js, index.js)
├── userdb/        # Per-user DB (userdb.js, build.js, build-dispatch.js, index.js)
├── vfs.js         # Virtual filesystem (optional feature)
├── tui.js         # Terminal UI (avoid for testing)
├── node-runtime.js # Daemon mode, auto-join topics
├── ipc/           # Inter-process communication for daemon
├── hash.js        # Chunk hashing utilities (BLAKE3 — some docs/ narratives still say SHA-256)
├── scanner.js     # Directory scanning
├── logger.js      # Session logging
├── memory-monitor.js # Memory backpressure
└── index.js       # Package entry

tests/          # Unit tests (run before/after changes) — note: `tests/`, not `test/`
docs/           # Architecture and design docs
cli.js          # CLI entry point (use for testing)
repl.js         # Interactive shell (AVOID for testing)
```

## Start Here Guide

| Task Type | Read These Files First |
|-----------|------------------------|
| Fix download stall | `download/session-state.js` (chunksInFlight), `protocol.js` (handleCancel) |
| Fix "File not found" | `protocol/subtree-server.js` (subtree serving), `protocol.js` (handleBitfieldRequest), `database.js` (getFilesByMerkleRoot) |
| Fix "Server overloaded" | `protocol/subtree-server.js` (`_activeServes`, `_subtreeServeQueue`), `protocol.js` (handleSubtreeRequest, handleCancel), `config.js` (MAX_CONCURRENT_SUBTREE_SERVES) |
| Add protocol message | `protocol/message-codec.js` (MSG_TYPE), `protocol.js` (handleMessage, add send method) |
| Modify DB schema | `database.js` (SCHEMA, add methods, consider migration) |
| Add CLI command | `commands.js` (add function), `cli.js` (register command) |
| Fix peer discovery | `network.js`, `protocol.js` (onPeerConnected) |
| Add file operation | `swarmfs.js` (main API), `commands.js` (CLI wrapper) |

## Documentation Links

- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** - System diagrams, data flow, protocol messages
- **[INVARIANTS.md](INVARIANTS.md)** - Rules that must never be broken (authoritative)
- **[AGENTS.md](AGENTS.md)** - Testing workflows, CLI commands, debugging guide
- **[README.md](README.md)** - User-facing documentation, installation

## Quick Reference

```bash
# Test a download (exits cleanly)
node cli.js download <topic> <merkleRoot> <outputPath>

# Run unit tests
node --test tests/core-behaviors.test.js

# Check file status
node cli.js info <path>

# Enable verbose logging
SWARMFS_VERBOSE=1 node cli.js <command>
```
