# SwarmFS Data Flow

## Data Entities

| Entity | Definition |
|--------|------------|
| **File** | Local file tracked by merkle root, with chunk metadata stored in DB |
| **Chunk** | 1MB block of file data, identified by blake3 hash |
| **MerkleRoot** | Content address (hash) identifying complete file |
| **Topic** | P2P group identified by name + topic_key |
| **TopicShare** | Discovery record: file advertised in a topic (NOT used for serving) |
| **Download** | In-progress or completed download session state |
| **Bitfield** | Bitmap of which chunks a peer has for a file |
| **SubtreeRequest** | Request for aligned power-of-two chunk range with merkle proof |

## Entity Lifecycles

### File
```
CLI: add <path>
  → swarmfs.addFile() hashes file
  → database.addFile() stores metadata (file_modified_at = mtime)
  → database.addFileChunks() stores chunk hashes
  → EXISTS: file on disk + metadata in DB

CLI: share <topic> <path>
  → database.addTopicShare() creates TopicShare (discovery only)
  → EXISTS: TopicShare record (file serving unaffected)

P2P: SUBTREE_REQUEST with matching merkleRoot
  → database.getFilesByMerkleRoot() finds all candidates
  → fs.accessSync() checks disk existence
  → protocol._serveSubtreeRequest() streams chunks
  → EXIT: SUBTREE_PART messages to requester

CLI: rm <path>
  → database.removeFile() deletes metadata
  → File may still exist on disk (not deleted)
```

### Chunk
```
File add:
  → merkle.js hashes file in 1MB chunks
  → chunk hash = blake3(chunk_data)
  → stored in file_chunks table (hash, offset, size)

Download:
  → SUBTREE_REQUEST requests chunk range
  → SUBTREE_PART contains chunk data
  → download.onSubtreePart() verifies hash
  → fs.writeSync() writes to output file
  → chunkStates updated to VERIFIED

Serving:
  → database.getFileChunksRange() gets chunk metadata
  → fs.readSync() reads from local file
  → SUBTREE_PART sent to requester
```

### Download Session
```
CLI: download <topic> <merkleRoot> <output>
  → swarmfs.downloadFile() creates session
  → database.addFile() with file_modified_at = 0 (incomplete)
  → database.addFileChunks() with expected hashes
  → DownloadSession.start() begins download loop

Download loop:
  → requestChunk() sends SUBTREE_REQUEST
  → chunksInFlight++ (per subtree, NOT per chunk)
  → onSubtreePart() receives data, verifies hash
  → onSubtreeComplete() decrements chunksInFlight
  → repeat until all chunks VERIFIED

Completion:
  → database.updateFileModifiedAt(fileId, Date.now())
  → file now servable (file_modified_at > 0)
  → EXIT: 'complete' event, process exits
```

### Topic
```
CLI: topic save <name>
  → crypto generates topic_key
  → database.addTopic() stores record
  → EXISTS: topic record with auto_join flag

CLI: topic join <name>
  → network.joinTopic() connects to Hyperswarm
  → protocol handlers registered
  → peer discovery begins (async)
  → EXISTS: active P2P connections

P2P: peer discovery
  → network emits 'peer:connected'
  → protocol sends BITFIELD_REQUEST
  → peer responds with BITFIELD
  → peerManager stores peer chunk availability
```

### Bitfield
```
Requester sends BITFIELD_REQUEST:
  → protocol.handleBitfieldRequest()
  → database.getFilesByMerkleRoot() finds all files
  → fs.accessSync() checks disk
  → BitField created with all chunks set
  → EXIT: BITFIELD message to requester

Requester receives BITFIELD:
  → peerManager.updatePeerBitfield()
  → scheduler now knows which peer has which chunks
  → download loop can request from this peer
```

## System Entry Points

| Entry Point | Ingests | Source |
|-------------|---------|--------|
| `cli.js add` | File path from filesystem | CLI args |
| `cli.js share` | Topic name + file path | CLI args |
| `cli.js download` | Topic + merkleRoot + output path | CLI args |
| `cli.js topic join` | Topic name | CLI args |
| `protocol.handleMessage` | P2P messages (SUBTREE_REQUEST, BITFIELD_REQUEST, etc.) | Protomux channel |
| `network.on('peer:connected')` | New peer connection | Hyperswarm discovery |
| `network.on('peer:disconnected')` | Peer disconnection | Hyperswarm |
| `daemon start` | IPC commands | Unix socket |

## System Exit Points

| Exit Point | Emits | Destination |
|------------|-------|-------------|
| `protocol._serveSubtreeRequest` | SUBTREE_PART messages | Requester peer |
| `protocol.handleBitfieldRequest` | BITFIELD message | Requester peer |
| `download.onComplete` | 'complete' event | CLI exit |
| `fs.writeSync` | Chunk data | Output file on disk |
| `protocol.sendError` | ERROR message | Requester peer |
| `console.log` | Log messages | stdout / daemon logs |

## Sync Points (Multiple Storage Locations)

⚠️ **File path in DB vs. disk**:
- `files.path` in database may point to file that no longer exists on disk
- Must always call `fs.accessSync()` before serving
- `file_modified_at > 0` indicates complete, but doesn't guarantee disk existence

⚠️ **Multiple files with same merkle root**:
- `files` table can have multiple rows with same `merkle_root`
- `getFilesByMerkleRoot()` returns all, must iterate to find accessible one
- Deleting one file doesn't affect others with same merkle root

⚠️ **TopicShare vs. File serving**:
- `topic_shares` table is for DISCOVERY ONLY
- Serving uses `getFilesByMerkleRoot()`, ignores sharing status
- A file can be served even if not shared in any topic

## Asynchronous / Eventually Consistent Flows

⚠️ **Peer discovery** (async):
- `topic join` returns immediately, peers discovered over time
- BITFIELD exchange happens asynchronously
- Download may start before all peers discovered

⚠️ **Download completion** (async):
- `download` command exits when 'complete' event fires
- chunksInFlight decremented asynchronously as subtrees complete
- File not servable until `file_modified_at` updated (sync DB write)

⚠️ **Backpressure queue** (async):
- Subtree requests queued when `_activeSubtreeServes >= max`
- Queue processed as active serves complete
- CANCEL must clean up both active serves and queued requests

⚠️ **Protomux streaming** (async):
- SUBTREE_PART messages streamed over Protomux channel
- Backpressure via `_backpressureByConn` WeakMap
- Channel may close mid-stream (peer disconnect)

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ENTRY: CLI Command                           │
│   cli.js add/share/download/topic join                              │
└─────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      SwarmFS API (swarmfs.js)                        │
│  - Hash files, create topics, coordinate downloads                   │
└─────────────────────────────────────────────────────────────────────┘
         │
         ├──────────────────────────────────┐
         ▼                                  ▼
┌──────────────────────┐          ┌──────────────────────┐
│   Database (DB)      │          │   Protocol (P2P)     │
│                      │          │                      │
│ - files              │◄────────►│ - message handlers   │
│ - file_chunks        │          │ - subtree serving    │
│ - topics             │          │ - bitfield exchange  │
│ - topic_shares       │          │ - protomux channels  │
│ - downloads          │          └──────────────────────┘
└──────────────────────┘                    │
         │                                  ▼
         │                        ┌──────────────────────┐
         │                        │   Network            │
         │                        │   (Hyperswarm)       │
         │                        │                      │
         │                        │ - peer discovery     │
         │                        │ - P2P connections    │
         │                        └──────────────────────┘
         │                                  │
         ▼                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         EXIT: Disk / Network                         │
│   - File data written to output path                                 │
│   - SUBTREE_PART/BITFIELD messages sent to peers                     │
│   - 'complete' event triggers CLI exit                               │
└─────────────────────────────────────────────────────────────────────┘
```
