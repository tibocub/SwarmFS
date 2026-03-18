# SwarmFS Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           CLI (cli.js)                               │
│  Commands: add, share, browse, download, resume, status, verify      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        SwarmFS (swarmfs.js)                          │
│  - File management (add, verify, hash)                               │
│  - Topic management (create, join, share)                            │
│  - Download coordination                                              │
└─────────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│   Database   │    │   Protocol   │    │ DownloadSession  │
│ (database.js)│    │(protocol.js) │    │  (download.js)   │
│              │    │              │    │                  │
│ - files      │    │ - messages   │    │ - downloadLoop   │
│ - chunks     │    │ - handlers   │    │ - chunksInFlight │
│ - topics     │    │ - protomux   │    │ - chunkStates    │
│ - shares     │    │ - network    │    │ - scheduler      │
└──────────────┘    └──────────────┘    └──────────────────┘
         │                    │
         │                    ▼
         │         ┌──────────────────┐
         │         │   Hyperswarm     │
         │         │  (network.js)    │
         │         │                  │
         │         │ - peer discovery │
         │         │ - P2P messaging  │
         │         └──────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          Disk Storage                                │
│  - File data (actual files at their paths)                           │
│  - swarmfs-data/swarmfs.db (SQLite database)                         │
└─────────────────────────────────────────────────────────────────────┘
```

## Content-Addressed File Serving

This is the core principle. When a peer requests a file:

```
Requester                          Responder
    │                                  │
    │  SUBTREE_REQUEST                 │
    │  (merkleRoot, startChunk,        │
    │   chunkCount)                    │
    │ ──────────────────────────────►  │
    │                                  │
    │                          ┌───────┴───────┐
    │                          │ getFilesByMerkleRoot()
    │                          │ returns ALL files
    │                          │ with matching root
    │                          └───────┬───────┘
    │                                  │
    │                          ┌───────┴───────┐
    │                          │ For each file: │
    │                          │ check disk     │
    │                          │ access         │
    │                          └───────┬───────┘
    │                                  │
    │                          ┌───────┴───────┐
    │                          │ First accessible│
    │                          │ file is served │
    │                          │ (sharing ignored)│
    │                          └───────┬───────┘
    │                                  │
    │  SUBTREE_BEGIN + PART + PROOF    │
    │ ◄────────────────────────────── │
    │                                  │
```

## Download Session State Machine

```
                    ┌─────────────┐
                    │   START     │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
          ┌────────│  DOWNLOAD   │◄───────┐
          │        │    LOOP     │        │
          │        └──────┬──────┘        │
          │               │               │
          │    ┌──────────┼──────────┐    │
          │    ▼          ▼          ▼    │
          │ ┌──────┐ ┌──────┐ ┌──────┐    │
          │ │WAIT  │ │REQUEST│ │VERIFY│    │
          │ │SLOT  │ │CHUNK │ │CHUNK │    │
          │ └──┬───┘ └──┬───┘ └──┬───┘    │
          │    │        │        │        │
          │    └────────┴────────┘────────┘
          │               │
          │    chunksInFlight < maxConcurrent?
          │               │
          ▼               ▼
   ┌─────────────┐ ┌─────────────┐
   │   STUCK     │ │  COMPLETE   │
   │  (timeout)  │ │ (all chunks │
   │             │ │  verified)  │
   └─────────────┘ └─────────────┘
```

## Key Data Structures

### chunksInFlight Tracking

```
WRONG (old bug):
  Request subtree with 8 chunks → chunksInFlight += 8
  After 8 subtrees → chunksInFlight = 64
  maxConcurrent = 8
  available = 8 - 64 = -56 → STUCK

CORRECT:
  Request subtree with 8 chunks → chunksInFlight += 1
  After 8 subtrees → chunksInFlight = 8
  maxConcurrent = 8
  available = 8 - 8 = 0 → wait for completion
  On subtree complete → chunksInFlight -= 1 → available = 1 → continue
```

### Chunk States

```javascript
const ChunkState = {
  PENDING: 'pending',     // Not yet requested
  REQUESTED: 'requested', // In-flight to a peer
  RECEIVED: 'received',   // Data received, not verified
  VERIFIED: 'verified',   // Hash confirmed, written to disk
  FAILED: 'failed'        // Timeout or error
};
```

## Protocol Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| BITFIELD_REQUEST | Requester → All peers | "Do you have this file?" |
| BITFIELD | Peer → Requester | "Yes, I have these chunks" |
| SUBTREE_REQUEST | Requester → Peer | "Send chunks X-Y" |
| SUBTREE_BEGIN | Peer → Requester | "Starting stream of N chunks" |
| SUBTREE_PART | Peer → Requester | Chunk data chunk |
| SUBTREE_PROOF | Peer → Requester | Merkle proof for verification |
| SUBTREE_COMPLETE | Requester → Peer | "Received all, thanks" |
| CANCEL | Either → Either | "Abort this request" |
| ERROR | Either → Either | "Something went wrong" |

## Database Tables

```sql
-- Files tracked (both added and downloaded)
files (id, path, merkle_root, size, chunk_size, chunk_count, 
       added_at, file_modified_at)

-- Chunk hashes for each file
file_chunks (file_id, chunk_index, chunk_hash, chunk_offset, chunk_size)

-- Topics (P2P groups)
topics (id, name, topic_key, auto_join)

-- File shares (DISCOVERY ONLY, not for serving)
topic_shares (id, topic_id, share_type, share_path, share_merkle_root)

-- Incomplete downloads (for resume)
downloads (id, topic_name, merkle_root, output_path, created_at, completed_at)
```
