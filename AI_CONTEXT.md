# SwarmFS AI Context

## What This System Does

SwarmFS is a P2P file-sharing system using content-addressed storage (merkle roots) inspired by BitTorrent and IPFS. Users join topics (P2P groups), share files, and download from peers who have matching merkle roots—regardless of sharing status. The system handles large files via subtree streaming with merkle proof verification.

## Current Primary Goal

<!-- TODO: Update this section at the start of each session -->
- [ ] Current sprint focus: _______________
- [ ] Active bug/feature: _______________

## Rules an AI Must Never Violate

1. **Content-addressed serving**: File lookup is by merkle root ONLY. Sharing status never affects serving decisions.
2. **chunksInFlight counts subtrees**: Each subtree request = 1 in-flight, not per-chunk. Breaking this stalls downloads.
3. **file_modified_at > 0 means complete**: Only files with this set are servable.
4. **CANCEL must decrement counters**: `_activeSubtreeServes` and `chunksInFlight` must be decremented on cancel/timeout.
5. **No REPL/interactive commands for testing**: Use CLI commands that exit cleanly (see AGENTS.md).
6. **Run tests after download logic changes**: `node --test test/core-behaviors.test.js`
7. **Check disk access before serving**: Files in DB may not exist on disk—always verify with `fs.accessSync`.
8. **Protocol message order matters**: SUBTREE_BEGIN → SUBTREE_PART* → SUBTREE_PROOF → completion.

## Directory Map

```
src/           # Core logic (start here for any code change)
├── protocol.js    # P2P message handlers, subtree serving, bitfield exchange
├── download.js    # Download session state machine, chunk tracking
├── database.js    # SQLite layer (SwarmDB class), all persistence
├── swarmfs.js     # Main API surface, file operations, topic management
├── commands.js    # CLI command implementations
├── network.js     # Hyperswarm wrapper, peer discovery
├── merkle.js      # Merkle tree building and verification
├── bitfield.js    # Chunk availability bitmaps
├── peer-manager.js # Peer state, chunk availability tracking
├── chunk-scheduler.js # Download scheduling, endgame mode
├── vfs.js         # Virtual filesystem (optional feature)
├── tui.js         # Terminal UI (avoid for testing)
├── node-runtime.js # Daemon mode, auto-join topics
├── ipc/           # Inter-process communication for daemon
├── hash.js        # Chunk hashing utilities
├── scanner.js     # Directory scanning
├── logger.js      # Session logging
└── memory-monitor.js # Memory backpressure

test/           # Unit tests (run before/after changes)
docs/           # Architecture and design docs
cli.js          # CLI entry point (use for testing)
repl.js         # Interactive shell (AVOID for testing)
```

## Start Here Guide

| Task Type | Read These Files First |
|-----------|------------------------|
| Fix download stall | `download.js` (chunksInFlight), `protocol.js` (handleCancel) |
| Fix "File not found" | `protocol.js` (_serveSubtreeRequest, handleBitfieldRequest), `database.js` (getFilesByMerkleRoot) |
| Fix "Server overloaded" | `protocol.js` (handleSubtreeRequest, _activeSubtreeServes, handleCancel) |
| Add protocol message | `protocol.js` (MSG_TYPE, handleMessage, add send method) |
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
node --test test/core-behaviors.test.js

# Check file status
node cli.js info <path>

# Enable verbose logging
SWARMFS_VERBOSE=1 node cli.js <command>
```
