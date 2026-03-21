# SwarmFS Agent Guidelines

This file helps LLMs work effectively with the SwarmFS codebase. Reference this file at the start of any session.

## Quick Start for Testing

### Commands That Exit Cleanly (Use These)

```bash
# File operations
node cli.js add <path>              # Add file/directory to tracking
node cli.js status                  # List tracked files
node cli.js info <path>             # Show file details + merkle root
node cli.js verify <path>           # Verify file integrity

# Topic operations
node cli.js topic list              # List topics
node cli.js topic save <name>       # Create topic
node cli.js topic info <name>       # Show topic details

# Network operations (exit when done)
node cli.js browse <topic>          # List shared files in topic
node cli.js download <topic> <merkleRoot> <outputPath>  # Download file, exits on completion
node cli.js resume <topic>          # Resume incomplete downloads

# Daemon (for background operations)
node cli.js daemon start            # Start daemon (foreground)
node cli.js daemon status           # Check daemon status
node cli.js daemon shutdown         # Stop daemon
```

### Commands That Keep Running (Avoid or Use Carefully)

```bash
node cli.js topic join <name>       # Joins topic, keeps running - use Ctrl+C
node cli.js shell                   # Interactive REPL - AVOID
node cli.js tui                     # Terminal UI - AVOID
```

**For testing downloads**: Use `node cli.js download ...` which exits automatically when complete.

## Critical Invariants (NEVER Break These)

See `INVARIANTS.md` for full details. Key points:

1. **Content-addressed serving**: File lookup is by merkle root ONLY. Sharing status never affects serving.
2. **chunksInFlight counts subtrees**: Each subtree request = 1 in-flight, not 8 for 8 chunks.
3. **file_modified_at > 0 means complete**: Only these files are servable.
4. **CANCEL must decrement _activeSubtreeServes**: Otherwise slots leak.

## Testing a New Feature

### Step 1: Write Unit Tests
```bash
# Run existing tests
node --test test/core-behaviors.test.js
```

### Step 2: Test with CLI (Single Machine)

```bash
# Terminal 1: Create topic and share a file
node cli.js topic save test-topic
node cli.js add test-file.mp4
node cli.js share test-topic test-file.mp4
node cli.js topic join test-topic &
PEER1_PID=$!

# Terminal 2: Download from peer 1
node cli.js topic join test-topic &
sleep 2  # Wait for peer discovery
node cli.js download test-topic <merkle-root> downloaded.mp4
```

### Step 3: Test Across Machines (Docker)

```bash
# Build image
docker build -t swarmfs .

# Run sharing peer
docker run -it -v swarmfs-data:/data --network host swarmfs sh -c "
  node cli.js topic save test-topic &&
  node cli.js add /data/test.mp4 &&
  node cli.js share test-topic /data/test.mp4 &&
  node cli.js topic join test-topic
"

# Run downloading peer (different machine)
docker run -it -v swarmfs-data:/data --network host swarmfs sh -c "
  node cli.js topic join test-topic &&
  sleep 5 &&
  node cli.js download test-topic <merkle-root> /data/downloaded.mp4
"
```

## Common Patterns

### Adding a New Protocol Message Type

1. Add to `MSG_TYPE` enum in `protocol.js`
2. Add handler in `handleMessage()` switch
3. Add send method (e.g., `sendFoo()`)
4. Add event emission in handler
5. Add listener setup in `DownloadSession` or elsewhere

### Modifying Download Logic

1. Check `chunksInFlight` usage - must be per-subtree
2. Check `onSubtreeComplete` and `onSubtreeTimeout` - must decrement
3. Check `handleCancel` - must decrement and clean up
4. Run `node --test test/core-behaviors.test.js`

### Adding Database Fields

1. Add column to schema in `database.js` SCHEMA string
2. Add getter/setter methods
3. Update `addFile()` or relevant methods
4. Consider migration for existing databases

## Debugging

### Enable Verbose Logging

```bash
SWARMFS_VERBOSE=1 node cli.js <command>
```

### Check Logs

```bash
# If daemon running
node cli.js daemon logs -f

# Or check log directory
ls /tmp/swarmfs-logs/
cat /tmp/swarmfs-logs/<session-id>.log
```

### Common Issues

| Issue                         | Cause                                             | Fix                                      |
|-------------------------------|---------------------------------------------------|------------------------------------------|
| Download stalls at 8 subtrees | chunksInFlight counted per-chunk                  | Count per-subtree                        |
| "Server overloaded" errors    | _activeSubtreeServes not decremented on cancel    | Fix handleCancel                         |
| "File not found" from peer with file | Sharing lookup used instead of merkle root | Use getFilesByMerkleRoot                 |
| Post-completion streaming     | CANCEL not stopping in-progress serves            | Add cancelled flag check                 |

## File Structure

```
src/
├── protocol.js      # P2P protocol handlers (INVARIANT comments at key functions)
├── download.js      # Download session state machine
├── database.js      # SQLite abstraction (SwarmDB class)
├── swarmfs.js       # Main API surface
├── commands.js      # CLI command implementations
├── network.js       # Hyperswarm wrapper
├── merkle.js        # Merkle tree utilities
└── bitfield.js      # Chunk availability tracking

test/
└── core-behaviors.test.js  # Tests for invariants

docs/
└── ARCHITECTURE.md  # System diagrams and flows

INVARIANTS.md        # Rules that must never be broken
AGENTS.md            # This file
```

## Self-Improvement

If you discover a new invariant, testing pattern, or common mistake:
1. Add it to `INVARIANTS.md`
2. Add test case to `test/core-behaviors.test.js`
3. Update this file with the pattern

This file is meant to evolve with the project.
