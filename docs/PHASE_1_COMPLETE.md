# Content addressing, chunks, and Merkle verification

SwarmFS identifies files by **what they contain**, not where they live.
That means the same file copied to different computers has the same identifier, and you can verify it after downloading.

This document explains the core primitives SwarmFS uses:

- **Chunking** (split files into pieces)
- **Hashing** (SHA-256 content hashes)
- **Merkle trees** (a single root hash for the whole file)
- **Merkle proofs** (verify a chunk without downloading the entire file first)

## Content identifiers

In SwarmFS, a file is identified by a **Merkle root**.

- **Chunk hash**: `sha256(chunkBytes)`
- **Merkle root**: root of a binary Merkle tree built from the ordered chunk hashes

If two files have the same bytes (and the same chunking parameters), they will produce the same Merkle root.

## Chunking model

Files are split into **fixed-size chunks** (typically ~256 KiB).

- The last chunk may be smaller.
- The order of chunks is part of the identity (chunk index 0, 1, 2, ...).

Why fixed-size chunking?

- It is simple.
- It enables parallel downloads.
- It supports resume and repair by chunk.

## Merkle trees (file verification)

SwarmFS builds a standard binary Merkle tree:

- Leaves are chunk hashes, in chunk index order.
- Internal nodes are hashes of their children.
- If there is an odd number of leaves at a level, the last hash is duplicated to form a pair.

The **Merkle root** is:

- A compact identifier for the whole file.
- A strong integrity check.

## Merkle proofs (chunk verification)

When a peer offers a chunk, it can include a **Merkle proof**.
The proof is a list of sibling hashes along the path from leaf to root.

This lets the downloader check:

- the chunk bytes match the expected chunk hash
- the chunk hash can be proven to belong to the requested Merkle root

This matters because it allows:

- downloading from untrusted peers
- verifying data progressively

## End-to-end verification

SwarmFS verifies data in multiple layers:

- **Chunk hash verification** when chunks arrive
- **Final Merkle root verification** when the file is complete

If final verification fails, SwarmFS can pinpoint the first mismatching chunk (useful for diagnosing ordering/offset issues).

## Why this is useful

- **Resume**: missing chunks can be requested again.
- **Repair**: corrupted chunks can be re-downloaded.
- **Multi-source downloads**: different peers can serve different chunks.
- **No “trust me”**: the receiver can independently verify data.
