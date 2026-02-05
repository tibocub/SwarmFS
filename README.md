# SwarmFS - P2P File Sharing with Content-Addressed Storage

BitTorrent's raw power, IPFS' content-addressability and Hyperswarm's
simplicity and reliability.

SwarmFS is a P2P file-sharing system inspired by BitTorrent and
IPFS, implementing content-addressed storage with Merkle trees
for verification and efficient chunk-based transfers.
Content discovery also comes build-it

## Understanding the design

#### Topics
A topic is a hash derived from a string provided by the user.
It can be useful to make public groups (for example by looking
for the "music" or "books" you can easily find a lot of peers
to share files with) or to make private groups, by using a
randomly generated 32bit SHA256 hass to give to your friends
for them to join your private topic.

Swarm
A swarm is the group of peers connected to a same topic

In the

You can join or leave


### What SwarmFS steals to others:
BitTorrent
- Read and write directly from/to files
- The chunk system, to allow downloading a single file from multiple
  peers at the same time or allow to seed chunks even while a file
  is not entirely downloaded, also allow to redownload only the
  corrupted part of a file instead of an entire file or resume an
  interrupted download.

IPFS
- Content Addressing (Unlike IPFS, SwarmFS only implement content-
addressing at the topic scope, which mean you will only send requests
to users connected to the same topics as you).

SoulSeek
- The public content indexing. Once again this is topic-based, so
  unlike SoulSeek, a SwarmFS user need to join a topics to access its
  public index and request files to the topic users.


Note: We can only get closer to BitTorrent's speed that IPFS' because
we made the compromise of not going full global content-addressing
like IPFS do. There is of course no geographical restriction and
limiting requests to only some topics make inter-peer communications
a lot faster.

This means we can't implement IPFS global content-addressing by using
topics as groups of interrest and communities or as private-use name-
spaced pools of data on your private server. But as long as you have a
rough idea of where to look, content-addressing will take care of the
rest.

### SwarmFS advantages over:
BitTorrent:
- No port or firewall configuration required
- SwarmFS Don't need trackers, hosting a file is much simpler
  than generating and hosting a torrent


## Project Status

**Phase 1: Core Infrastructure ✓ COMPLETE**
**Phase 2: Storage & CLI ✓ COMPLETE**
**Phase 3: Directory Support ✓ COMPLETE**

All local functionality is implemented and tested:
- ✓ File chunking (fixed 256KB chunks)
- ✓ SHA-256 hashing
- ✓ Binary Merkle tree construction
- ✓ Merkle proof generation and verification
- ✓ Directory Merkle trees
- ✓ Recursive directory scanning
- ✓ SQLite database with file/chunk tracking
- ✓ Content-addressable chunk storage
- ✓ Command-line interface with directory support
- ✓ File verification and corruption detection
- ✓ Auto-initialization
- ✓ Centralized tracking (files from anywhere)
- ✓ 53/53 unit tests + integration tests passing

## Architecture

### Content-Addressed Storage
Files are split into fixed-size chunks (256KB default), each chunk is hashed with SHA-256, and a Merkle tree is built from the chunk hashes. The Merkle root serves as the content identifier for the file.

### Merkle Trees
- **For files**: Binary tree built from chunk hashes
- **For directories** (planned): Tree built from file/subdirectory roots
- Supports proof generation for verifying individual chunks without full file

### Key Features (Planned)
- Concurrent downloads from multiple peers
- Seed while downloading (BitTorrent-style)
- Partial file corruption repair
- Content deduplication
- Topic/group-based P2P discovery (via Hyperswarm)

## Project Structure

```
swarmfs/
├── src/
│   ├── chunk.js          # File chunking utilities
│   ├── hash.js           # SHA-256 hashing functions
│   ├── merkle.js         # Merkle tree implementation
│   ├── database.js       # SQLite database layer
│   ├── storage.js        # Chunk storage (CAS)
│   ├── swarmfs.js        # Main coordinator
│   └── index.js          # Public API exports
├── lib/
│   └── better-sqlite3.js # Mock SQLite (replace with real version)
├── test/
│   ├── test-all.js       # Unit tests (Phase 1)
│   └── test-phase2.sh    # Integration tests (Phase 2)
├── examples/
│   ├── workflow.js       # Basic workflow demo
│   └── advanced.js       # Advanced scenarios
├── cli.js                # Command-line interface
└── package.json
```

## Testing

Run the unit test suite:
```bash
npm test
```

Run the integration test:
```bash
./test-phase2.sh
```

## CLI Usage

SwarmFS provides a command-line interface for managing files and directories:

```bash
# Add current directory (auto-initializes if needed)
node cli.js add
node cli.js add .

# Add specific file or directory
node cli.js add myfile.txt
node cli.js add myproject/

# Check tracked files
node cli.js status

# Verify file integrity
node cli.js verify myfile.txt

# Show detailed information
node cli.js info myfile.txt

# View statistics
node cli.js stats

# Get help
node cli.js help
```

### Key Features

- **Auto-initialization**: No need to run `init` - starts automatically
- **Centralized tracking**: One database tracks files from anywhere on your system
- **Directory support**: Add entire directories recursively
- **Smart defaults**: `swarmfs add` with no args adds current directory
- **Ignore patterns**: Automatically skips node_modules, .git, etc.

## Phase 1 API

### Chunking
```javascript
import { chunkBuffer, calculateChunkCount } from './src/chunking.js';

const chunks = chunkBuffer(fileBuffer, 256 * 1024); // 256KB chunks
const count = calculateChunkCount(fileSize, 256 * 1024);
```

### Hashing
```javascript
import { hashBuffer, combineHashes } from './src/hashing.js';

const hash = hashBuffer(chunk);
const parentHash = combineHashes(leftHash, rightHash);
```

### Merkle Trees
```javascript
import { buildMerkleTree, generateMerkleProof, verifyMerkleProof } from './src/merkle.js';

// Build tree from chunk hashes
const tree = buildMerkleTree(chunkHashes);
console.log('Root:', tree.root);

// Generate proof for chunk
const proof = generateMerkleProof(chunkHashes, chunkIndex);

// Verify proof
const isValid = verifyMerkleProof(proof.leaf, proof.proof, tree.root);
```

## Next Steps (Phase 4)

- [ ] Hyperswarm P2P networking
- [ ] Topic-based content discovery  
- [ ] Chunk transfer protocol
- [ ] Multi-peer concurrent downloads
- [ ] Merkle proof verification over network

## Design Principles

1. **Content-addressing without metadata**: Hash based on content only, not filename
2. **Centralized metadata, decentralized storage**: Single SQLite DB tracks files anywhere on disk
3. **Direct read/write**: No file copying like Git, work with originals
4. **Topic-based P2P**: Compromise between BitTorrent (swarm-per-file) and IPFS (global DHT)

## License

MIT
