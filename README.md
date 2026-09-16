## ! Software still in ALPHA - breaking changes expected !

## ! SwarmFS developement paused !
The basic file-transfer demo kinda works but incoming features (user/friends, multi-writer virtual directories, moderated swarms, etc) will depend on [hypergraph](https://github.com/tibocub/hypergraph), so my time is focused on hypergraph for now.
Instead of being a standalone app with a TUI and a daemon, SwarmFS should be refactored as only a hypergraph-powered decentralized filesystem. It's TUI, daemon and other interfaces should be splitted into their own repos to keep this repo
focused on the filesystem and its protocols. The TUI and daemon might also get abandonned to focus on embedding SwarmFS in [HyperBBS](https://github.com/tibocub/HyperBBS).

# SwarmFS

SwarmFS is a P2P file-transfer protocol that can also be considered a decentralized file-system. You can think of it as an attempt to recreate google drive or a ftp server without servers.

It aims to be faster to resolve than IPFS (because of context-scoped resolution) and easier to setup and use than BitTorrent (thanks to hyperswarm's efficient NAT transversal and holepunching techniques).

At its core:

- **Content addressing** (IPFS-style but topic-based)
- **Chunked transfers** (BitTorrent-style but no need for trackers)
- **Topic-scoped peer discovery** via Hyperswarm
- A small protocol for **browsing**, **metadata exchange**, and **chunk transfer** (topic-based public content-discovery will be reimplemented with Autobase later at the same time as the implementation of the links and virtual filesystem)



## Project goals

- Plug-n-play, easy to use
- Cryptographically-verified downloads (you can only get what you asked for)
- Resume downloads and repair files at chunk level
- Multi-peer downloads
- Topic-scoped content discovery (browse what peers in a topic share publicly)

## Non-goals

- Global IPFS-like DHT content routing



## Security concerns

Still in ALPHA. SwarmFS should be used with precaution.

- Private topics current implementation isn't safe. Passwords are just meant to keep private topics names simple without making it's address too easy to brute-force.
  A secure implementation would probably require single-uses temporary invitations ((autopass ?)), but it's probably better to take care of that when a user ID system is implemented

- Local DB is not encrypted yet (so tracked files and pritave topics are not safe yet)

- Content discovery in public topics is dangerous if a user ins't conscious that SwarmFS is only 100% safe if downloading files from a hash we trust.
  Content-discovery was made for private topics peers that trust each others to easily share files, but it totally can be used to provide malicious files over public topics.
  (Maybe make content discovery only in private topics ? Would be safer but I like to let the freedom of choice to the users)

- From my current understanding of Hyperswarm, connected peers have access to each other's IPv6 addresses.
  It's very common in P2P apps but nowadays we might be able to do better built-in privacy (maybe something like onion-routing that forces traffic through relays and refuse direct connections).
  However it's not a priority and users can just use a VPN if someone want to obfuscate his IP.



## Example use-cases and workflows

SwarmFS can be used as:

- Community-hosted archives (like wikipedia and archives.org takes advantage of IPFS)

- A google drive alternative 100% free and without size limits (makes use of content-addressing to improve data availability without centralized servers)


## Running the project

### Requirements

- Node.js and a node package manager (npm, pnpm...)
- or Bun

### Install (also compatible with Bun)

```bash
npm install
```

### CLI (main entrypoint)

```bash
node cli.js help

node cli.js add [path]
node cli.js status
node cli.js verify <path>
node cli.js info <path>
node cli.js stats

node cli.js topic save <name>
node cli.js topic share <topic> <path>
node cli.js browse <topic>
node cli.js download <topic> <merkleRoot> <outputPath>
```

Interactive modes (keeps the P2P networking alive while running):

```bash
node cli.js shell
node cli.js tui
```



## Architecture

Currently we're exploring th


Data flow for a typical download:

1. Join topic (Hyperswarm)
2. Browse topic → aggregate file list (Merkle roots)
3. Request a file by Merkle root
4. Schedule chunk requests across peers
5. Receive chunks → verify hash → write at correct offsets
6. Verify final Merkle root

### Concepts

- **Topic**: 32-byte key used for Hyperswarm discovery. Stored in DB as hex.
- **Merkle root**: file identifier.
- **Chunk hash**: leaf hash in the file Merkle tree.
- **Chunk size**: stored per file (`file.chunk_size`). Files may have different chunk sizes.


## Developer documentation

Checkout the /docs directory



## Roadmap

Fundamental features done ! SwamrFS can track local files to answer requests, share files over a topic to publicly display them and peer's files can be downloaded by hash or by browsing a topic's publicly shared files.

- [x] Adaptative-size chunking, hashing and merkle tree → **Replaced with fixed 1MB chunks (temporarily?) to focus on efficient streaming**
- [x] Merkle tree construction + per-chunk verification
- [x] File metadata persisted (compatible with `better-sqlite3` on Node and Bun's built-in SQLite)
- [x] Topic-based peer discovery (Hyperswarm)
- [x] Chunk transfer protocol (request/offer/download/chunk_data) // reworked
- [x] Multi-peer downloads and endgame mode
- [x] Final file verification and corruption diagnostics
- [x] Directory tracking and deterministic directory hashing
- [x] Basic CLI, REPL and TUI
- [x] Partial file download (ranges / selective chunks)
- [x] Grouped chunk transfer/verification (group by chunks by subtrees transfer multiple chunks in a single stream and verify with less computing)
- [x] Resumable downloads (survive lost connections, program crashes, partial file corruption...)
- [x] Multi-file bundles (download entire directories in a single request using VFS)
- [ ] Selective downloads (select and rename files when downloading a directory)
- [x] Improve TUI UX (don't force users to use the REPL anymore, provide keys-based controls, basic mouse support and tabs to switch views between browse, downloads, topics, local files, etc)
- [WIP] Improve browsing UX (search, filters, danger warning in public topics)
- [ ] Better sharing controls (per-topic files allowlist/denylist and/or per-file topics allowlist/denylist, share entire virtual directories)
- [ ] Find how to get availble seeders per file/chunk
- [x] Minimal ID system (required to develop other features such as multi-user directories, actually secure private topics, etc)
- [x] Multi-device ID system (Mnemonic login, replicate user data from other devices)

### Planned

- [ ] Refactor to use hypergraph as main DB
- [ ] Rewrite the vfs with hypergraph (wire hypergraph's user ID and moderation systems in SwarmFS)
- [ ] Split the project in more scoped sub-modules (user interfaces, transfer protocol, vfs, dns)
- [ ] Use Localwatch to detect local file changes and automatically update the DB and virtual file system
- [ ] Deeper analysis of the bittorrent protocol to improve SwarmFS efficiency and reliability
- [ ] Smarter peer selection and rate limiting
- [ ] Server mode (unlike client mode, focused on improving the network health and maintaining 24/7 availability of either specific files/dirs or an entire topic)
- [ ] Config system to tweak settings, allow limited space to specific topics/directories or system-wide (user config in ~/.config/swarmfs.conf and per-topic/directory as metadata), etc.
- [ ] Per-topic/per-directory keep-available auto replication (maybe we could cache data in hyperblobs to leverable holepunch's blind-peer to avoid writing our own replication strategy)
- [ ] Proper file/dir metadata to implement advanced features (could have an 'availability' or 'health' score and an 'keep-available' value which would let clients and servers individually choose when to replicate to keep the file available. I.e: when 'keep-available' = 0: don't keep available, when 1: servers help keep availability at 100%, when 2: everyone try to keep it available 24/7)
- [ ] Deeper analysis of decentralized file systems such as the google file system to improve data availability
- [ ] IPNS-like domain name system (HyperDNS ?) for mutable data
- [ ] Private topics (autopass-based secure invites)
- [ ] Virtual directories (manage your tracked files, links and virtual directories in the SwarmFS virtual file-system) 
- [ ] Basic GUI for terminal-allergic early users and maybe to start the base of our latter mobile UI (pear + electron)


### Known issues / drawbacks

- Hyperswarm holepunching is awesome but not fail-proof; some network configurations may reduce connectivity
- Content discovery is still evolving (topic-scoped browsing protocol is temporary and donwloading unknown shared files public topics is dangerous)
- Performance is miles away from optimal, but right now SwarmFS is a proof of concept. At the current stage of development we're focussing on reliability before speed.


### Performance TODOs (ideas to evaluate)

- [x] **Fixed 1MB chunk size** (replaced adaptive chunking)
    - Simplifies streaming architecture.
    - Ensures constant memory usage regardless of file size.
    - Predictable memory footprint for large files (1TB+).
- [x] **True chunk streaming with Protomux**
    - Zero-copy serving: read from disk → send immediately (no buffering).
    - Direct-to-disk receiving: write each chunk as it arrives.
- [x] **Batch transfers / grouped chunks**
    - Allow requesting/serving a contiguous range of chunks in one response.
    - Receiver verifies and writes a group as a unit.
- [x] **Merkle multi-proofs / subtree proofs**
    - Instead of per-chunk proofs, request/serve proofs for a whole range/subtree.
    - Align chunk groups to power-of-two subtrees to make proofs compact.
- [x] **Pipelined hashing + verification**
    - Keep downloads flowing while verification happens in parallel batches.
- [ ] **Adaptive download strategy**
    - Many peers: rarest-first / parallel chunking.
    - Few peers: larger sequential ranges.
    - One peer: sequential streaming (torrent-style).
- [ ] **Proof caching / reuse**
    - Cache proof fragments per file to avoid recomputing siblings repeatedly.
- [x] **Compact encodings for protocol metadata**
    - Replace JSON with compact encodings for smaller wire format.
    - Hash dedup in proofs, optional compression for proof blocks.



## License

MIT
