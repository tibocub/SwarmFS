# Local storage, metadata, and sharing semantics

SwarmFS is “serverless” in the sense that it doesn’t require a central service.
But each peer still keeps local state so it can:

- remember tracked files and their hashes
- remember saved topics
- answer requests quickly
- advertise what you choose to share in which communities

This document describes what lives locally and how sharing works.

## What is stored locally

SwarmFS keeps a local database that contains:
- tracked files and directories
- per-file chunk lists (hashes, offsets, sizes)
- topics you created/joined
- per-topic share rules (“this path is shared in this topic”)

SwarmFS does not need to copy file contents into its own storage to function.
It can read from the original files directly when seeding.

## Tracked vs shared

SwarmFS distinguishes between:

- **Tracked**: you computed hashes/metadata locally (so the file has a Merkle root).
- **Shared**: you allow peers in a topic to learn about and request that content.

That separation allows workflows like:

- track your whole disk, but only share a small subset
- share different subsets into different topics

## Topics

Topics are the “where do I look?” layer.

- You create topics locally.
- You join topics to connect to peers.
- Sharing is defined per topic.

## Sharing model (high level)

When you share a path in a topic, you are effectively saying:

- “in this community, I am willing to serve content identified by this Merkle root”

Peers can then:

- browse what is shared in that topic
- request metadata by Merkle root
- request chunks by chunk hash

## Content discovery

SwarmFS supports topic-scoped browsing.
Conceptually:

- you ask peers in a topic for their shared file list
- you aggregate results locally

Because the system is content-addressed:

- names are user-friendly labels
- the Merkle root is the true identifier

## Direct read/write implications

SwarmFS reads and writes directly to the destination files:

- download writes chunks at the correct offsets
- seeding reads bytes from disk for requested chunk hashes

This is BitTorrent-like behavior and has two important consequences:

- downloads can be resumed/continued
- seeding remains possible as long as the local file still matches the recorded hashes

## Stale metadata and verification

Local metadata can become stale if files are modified or deleted.
To avoid serving bad data:

- SwarmFS verifies the chunk bytes hash to the requested chunk hash before serving.
- If it does not match, the mapping is treated as stale.

This protects the network from silent corruption.
