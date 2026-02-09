# Networking model and protocol

This document explains how SwarmFS finds peers and moves data between them.

SwarmFS is built around two ideas:

- **Discovery is topic-based** (you join a “swarm” of peers)
- **Data is content-addressed** (you request by Merkle root / chunk hash, then verify)

## Topics and swarms

A **topic** is a 32-byte key used for peer discovery via Hyperswarm.

- A public-ish topic can be derived from a human name (example: `music`).
- A private topic can be a shared secret (example: a random string shared out-of-band).

When you `join` a topic, Hyperswarm connects you to peers who joined the same key.
That group of currently connected peers is the **swarm**.

SwarmFS keeps track of which peer connection is associated with which topic so that:

- you can broadcast requests only to peers in the right community
- you don’t mix file discovery across unrelated topics

## Protocol overview

SwarmFS uses a small message protocol on top of Hyperswarm connections.

### Goals

- Request and download chunks from multiple peers
- Verify data while downloading
- Avoid trusting peer-provided metadata blindly

### Core message types

At a high level:

- `REQUEST`: ask for a chunk by its hash
- `OFFER`: a peer claims it has the chunk (optionally with proof/metadata)
- `DOWNLOAD`: accept an offer and request the actual bytes
- `CHUNK_DATA`: raw bytes of the chunk
- `CANCEL`: stop a request (timeouts, endgame cleanup)
- `ERROR`: explicit error response

There are also discovery/metadata messages:

- `FILE_LIST_REQUEST` / `FILE_LIST_RESPONSE`
- `METADATA_REQUEST` / `METADATA_RESPONSE`
- `HAVE`, `BITFIELD`, `BITFIELD_REQUEST`

## Download lifecycle (conceptual)

1. **You join a topic** and connect to peers.
2. You obtain a **Merkle root** (from browsing/indexing, or from someone sharing it).
3. You request file **metadata** (size, chunk hashes) by Merkle root.
4. You start a download session:
   - decide which chunks are missing
   - schedule chunk requests across peers
5. For each chunk:
   - request / receive bytes
   - verify SHA-256 hash matches the expected chunk hash
   - write to the correct file offset
6. At the end, verify the **final Merkle root**.

SwarmFS can use “endgame” mode near the end: request remaining chunks from multiple peers and cancel duplicates when one arrives.

## Seeding (serving data)

When a peer receives a chunk request:

- it looks up where that chunk exists locally
- reads the bytes from disk
- verifies the bytes hash to the requested chunk hash
- only then serves it

This extra verification is important because local metadata can become stale (files moved/modified). Serving bad bytes wastes everyone’s time.

## Framing and stream handling

Hyperswarm delivers a byte stream. Protocol messages are framed with a header including payload length.
Receivers may need to buffer partial data until a full frame is available.

## Practical implications

- **You can be offline-friendly**: as long as at least one peer has the data.
- **Integrity is end-to-end**: data can be verified without trusting peers.
- **Communities matter**: topics are the main “where do I look?” primitive.
