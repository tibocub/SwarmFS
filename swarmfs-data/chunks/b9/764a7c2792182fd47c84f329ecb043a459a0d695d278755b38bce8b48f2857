# SwarmFS - P2P File Sharing with Content-Addressed Storage

SwarmFS is a P2P file-sharing system inspired by BitTorrent and IPFS, implementing content-addressed storage with Merkle trees for verification and efficient chunk-based transfers.

## Project Status

**Phase 1: Core Infrastructure ✓ COMPLETE**

All core utilities have been implemented and tested:
- ✓ File chunking (fixed 256KB chunks)
- ✓ SHA-256 hashing
- ✓ Binary Merkle tree construction
- ✓ Merkle proof generation and verification
- ✓ 53/53 tests passing

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
│   ├── chunking.js       # File chunking utilities
│   ├── hashing.js        # SHA-256 hashing functions
│   └── merkle.js         # Merkle tree implementation
├── test/
│   └── test-all.js       # Comprehensive test suite
└── package.json
```

## Testing

Run the test suite:
```bash
npm test
```

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

# Roadmap

## Already implemented
- ✓ File chunking (fixed 256KB chunks)
- ✓ SHA-256 hashing
- ✓ Binary Merkle tree construction
- ✓ Merkle proof generation and verification
- ✓ 53/53 tests passing

### Next Steps (Phase 2)
- [ ] SQLite database schema and storage layer
- [ ] Content-addressable chunk storage (CAS)
- [ ] CLI commands (init, add, status, verify)
- [ ] File metadata tracking

## Design Principles

1. **Content-addressing without metadata**: Hash based on content only, not filename
2. **Centralized metadata, decentralized storage**: Single SQLite DB tracks files anywhere on disk
3. **Direct read/write**: No file copying like Git, work with originals
4. **Topic-based P2P**: Compromise between BitTorrent (swarm-per-file) and IPFS (global DHT)

## License

MIT
