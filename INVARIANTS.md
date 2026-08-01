# SwarmFS Design Invariants

These are rules that must NEVER be violated. Any code change that breaks these is a regression.

## Content Addressing

- **File lookup is by merkle root ONLY** - Sharing status, topic membership, and file path are irrelevant for serving
- **Multiple copies with same merkle root are equivalent** - Serve the first one accessible on disk
- **Sharing only affects discovery** - The `share` mechanism only advertises files to peers via `browse`, it never affects `subtree_request` or `bitfield_request` handling

## Download Mechanics

- **chunksInFlight counts subtree requests, not chunks** - Each subtree request = 1 in-flight, regardless of how many chunks it contains
- **maxConcurrentRequests limits concurrent subtree requests** - Default is 8, scales with peer count
- **file_modified_at > 0 means complete** - Only files with `file_modified_at > 0` are servable

## Protocol Flow

```
Download Request Flow:
1. Requester sends SUBTREE_REQUEST with merkleRoot
2. Responder looks up ALL files with that merkleRoot (getFilesByMerkleRoot)
3. Responder iterates candidates, checking disk access
4. First accessible file is served
5. Sharing status is NEVER checked during serving
```

## Subtree Structure

- **Subtrees are power-of-two aligned** - chunkCount must be power of 2, startChunk must be aligned
- **Subtree proofs verify chunks** - Each subtree includes merkle proof for verification
- **Streaming uses Protomux channels** - BEGIN message, then PART messages, then PROOF

## Backpressure

- **_activeSubtreeServes limits concurrent serves** - Default 8, prevents memory exhaustion
- **_subtreeServeQueue holds overflow requests** - Dropped with "Server overloaded" if queue full
- **CANCEL must decrement _activeSubtreeServes** - Otherwise slots leak and server appears overloaded

## Database

- **files table tracks all known files** - Both added and downloaded files
- **file_chunks table maps chunks to files** - Multiple files can share same chunk hashes
- **downloads table tracks incomplete downloads** - Used for resume functionality
- **topic_shares table is for discovery only** - Never used for serving decisions
