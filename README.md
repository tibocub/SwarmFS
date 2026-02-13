## ! Software still in ALPHA - breaking changes expected !

# SwarmFS

SwarmFS is a P2P file-sharing protocol that aims to be faster
than IPFS and easier to setup and use than BitTorrent.

At its core:

- **Content addressing** (IPFS-style but topic-based)
- **Chunked transfers** (BitTorrent-style but 100% server-less)
- **Topic-scoped peer discovery** via Hyperswarm
- A small protocol for **browsing**, **metadata exchange**, and **chunk transfer** (topic-based public content-discovery will be reimplemented with Autobase later at the same time as the implementation of the links and virtual filesystem)



## Project goals

- Plug-n-play and easy to use
- Cryptographically-verified downloads
- Resume/repair files at the chunk level
- Multi-peer downloads and endgame mode
- Topic-scoped content discovery (browse what peers in a topic share)

Non-goals (for now):

- Global IPFS-like DHT content routing
- A polished end-user UX (we're currently just making the terminal interface to test features during development)



## Security concerns

Still in ALPHA. SwarmFS should be used with a lot of precaution.

- Private topics current implementation isn't safe. Passwords are just meant to keep private topics names simple without making it's address too easy to brute-force.
  A secure implementation would probably require single-uses temporary invitations, but it's probably better to take care of that when a user ID system is implemented (not a priority)

- Local DB is not encrypted yet (so tracked files and pritave topics are not safe yet)

- Content discovery in public topics is dangerous if a user ins't conscious that SwarmFS is only 100% safe if downloading files from a hash we trust.
  Content-discovery was made for private topics peers that trust each others to easily share files, but it totally can be used to provide malicious files over public topics.
  (Maybe make content discovery only in private topics ? Would be safer but I like to let the freedom of choice to the users)

- From my current understanding of Hyperswarm, connected peers have access to each other's IP addresses.
  It's very common in P2P file-sharing but nowadays we might be able to do better (maybe something like onion-routing that forces traffic through relays).
  However it's not a priority and users can just use a VPN.



## Example use-cases and workflows

SwarmFS can be used as:

- Community-maintained archives (like wikipedia and archives.org takes advantage of IPFS)

- A google drive alternative 100% free and without size limits (makes use of content-addressing to improve data availability without servers)


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

node cli.js topic create <name>
node cli.js topic join <name>
node cli.js topic share <topic> <path>
node cli.js browse <topic>
node cli.js download <topic> <merkleRoot> <outputPath>
```

Interactive modes (keeps the P2P networking alive while running):

```bash
node cli.js shell
node cli.js tui
```



## Architecture (high level)

Data flow for a typical download:

1. Join topic (Hyperswarm)
2. Browse topic → aggregate file list (Merkle roots)
3. Request metadata by Merkle root (chunk list)
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

### Fundamentals

Fundamentals done ! Can tracke local files to answer requests, share files over a topic to publicly display them and peer's files can be downloaded by hash or by browsing the topic's publicly shared content.

- [x] Adaptative-size chunking, hashing and merkle tree
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

### Final tweaks to make sure the alpha is usable (now)

- [ ] Multi-file bundles (download directories in single requests)
- [ ] Selective downloads (select and rename files when downloading a directory)
- [ ] Improve TUI UX (don't force users to use the REPL anymore, provide keys-based controls, basic mouse support and tabs to switch views between browse, downloads, topics, local files, etc)
- [ ] Improve browsing UX (search, filters, danger warning in public topics)
- [ ] Better sharing controls (per-topic files allowlist/denylist and/or per-file topics allowlist/denylist, share entire virtual directories)

### Planned

- [ ] Smarter peer selection and rate limiting
- [ ] Local DB simple password encryption
- [ ] Virtual directories (manage your tracked files, links and virtual directories in the SwarmFS virtual file-system) 
- [ ] Basic GUI for terminal-allergic early users and maybe to start the base of our latter mobile UI (in pear with html/js or electron if vanilla html isn't enought)

### Ideas

- [ ] Maybe we can start implementing some features without proper user ID and just persist a random keypair on each device used as a hyperswarm peer ID.

- [ ] Multi-writer virtual directories with Autobase (needs ID system)

- [ ] Refactor current browsing system (request every user's shared files and aggregate localy) with Autobase

- [ ] IPNS-like topic-based domains (permanent addresses with editable endpoints) with Autobase

- [ ] Make a separate P2P user ID and friends system I could use for all my other P2P projects (would keep ID and registered friends across different P2P apps)

- [ ] Implement a SwarmFS daemon and IPC for 24/7 swarming and to easily make apps for SwarmFS in any language

- [ ] Treat public topics as public gateways
  
    Disable file sharing in public topics and only use public topics as a common interrest with untrusted peers to share content-addressed requests
    


### Known issues / drawbacks

- Hyperswarm holepunching is one of the greatest but isn’t perfect; some networks may reduce connectivity
- Content discovery is still evolving (topic-scoped browsing protocol is temporary and donwloading unknown shared files public topics is dangerous)
- Performance is bad but right now we're focussing on making things work as reliably as possible


### Performance TODOs (ideas to evaluate)

- [x] **Adaptive chunk size per file**
    - Keep a small default for small files.
    - Increase chunk size for very large files to reduce message/CPU overhead.
    - Requires keeping chunk size in metadata (already supported).
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
- [ ] **Compression of protocol metadata**
    - Compact encodings, hash dedup in proofs, optional compression for proof blocks.



## License

MIT
