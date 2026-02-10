# Dev notes: content addressing, chunking, and Merkle trees

This document describes how files become:

- a sequence of chunks
- a list of chunk hashes
- a Merkle root (the file identifier)

It also captures a few invariants that other modules rely on.

## Relevant modules

- `src/chunk.js`
  - `DEFAULT_CHUNK_SIZE`
  - `chunkBuffer(buffer, chunkSize)`
  - `calculateChunkCount(fileSize, chunkSize)`
- `src/hash.js`
  - `hashBuffer(buffer)`
  - `combineHashes(left, right)`
- `src/merkle.js`
  - tree construction, root derivation, proof helpers
- `src/swarmfs.js`
  - uses file chunking + hashing to populate DB (`files`, `file_chunks`)

## Identifiers

- **Chunk hash**: SHA-256 of chunk bytes (hex string)
- **Merkle root**: root hash of the file’s chunk hash list (hex string)

SwarmFS treats the Merkle root as the stable identifier for a specific file *content + chunking parameters*.
If the chunk size changes, the leaf set changes, and the Merkle root changes.

## Chunking

Chunking is fixed-size for now.

Key invariants:

- **Chunk order is authoritative**: index `i` corresponds to offset `i * chunkSize`.
- The final chunk is truncated to remaining file size.
- For an empty file, chunking returns a single empty chunk.

## Per-file chunk size

Each tracked file stores its chunk size in DB (`files.chunk_size`).

Implication: files can have different chunk sizes.
Download metadata must be interpreted using the file’s stored `chunk_size`.

SwarmFS recently added an adaptive chunk sizing heuristic in `SwarmFS.addFile()` (when `chunkSize` is omitted).

## Merkle tree construction

SwarmFS uses a standard binary Merkle tree over leaf hashes.

Implementation-level note:

- If a level has an odd number of hashes, the last hash is duplicated to form a pair.

This matters because proof verification and root computation must use the same convention across all peers.

## Proofs

`src/merkle.js` exposes helpers for generating and verifying proofs.

In the network protocol, proofs are serialized in a simplified structure (see `src/protocol.js`).
Whether per-chunk proofs are mandatory is a performance/security tradeoff; current code includes proof generation + validation.

## Verification layers

SwarmFS typically verifies data at two levels:

- **Per chunk**: hash the received bytes and compare to expected chunk hash
- **Final file**: recompute and compare the Merkle root

When final verification fails, it can be debugged by comparing leaf hashes to `file_chunks` entries.
