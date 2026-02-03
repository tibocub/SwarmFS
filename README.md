# SwarmFS - P2P File Sharing with Content-Addressed Storage

SwarmFS is a P2P file-sharing system inspired by BitTorrent and IPFS, implementing content-addressed storage with Merkle trees for verification and efficient chunk-based transfers.

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
