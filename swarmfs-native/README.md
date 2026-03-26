# SwarmFS Native

High-performance Rust addon for SwarmFS performance-critical operations.

## Features

- **BLAKE3 Hashing**: Native BLAKE3 implementation
- **Merkle Tree**: Parallel construction with Rayon
- **BitField Operations**: Popcount-optimized bit manipulation
- **Chunk Verification**: Parallel batch verification

## Prerequisites

1. **Rust**: Install via https://rustup.rs
   ```
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
   On Windows: Download from https://rustup.rs or use `winget install Rustlang.Rustup`

2. **Node.js**: Version 16 or higher

## Build

```bash
npm install
npm run build
```

## Usage

```javascript
const native = require('swarmfs-native');

// Check if native addon is available
if (native.isNativeAvailable()) {
  console.log('Using native implementation');
} else {
  console.log('Using JS fallback');
}

// Hash a buffer
const hash = await native.hashBuffer(data);

// Build merkle tree from file
const tree = await native.buildFileMerkleTree('/path/to/file', 256 * 1024);
console.log('Root:', tree.root.toString('hex'));
console.log('Leaf count:', tree.leafCount);

// BitField operations
const bf = native.bitfieldNew(1000);
const bfSet = native.bitfieldSet(bf, 5);
console.log('Bit 5 set:', native.bitfieldGet(bfSet, 5));
console.log('Total set:', native.bitfieldCount(bfSet));

// Verify chunks in parallel
const results = await native.verifyChunksBatch(chunks, hashes);
```

## API

### Hash Functions

- `hashBuffer(data: Buffer): Buffer` - Hash a single buffer
- `hashBuffers(buffers: Buffer[]): Buffer` - Hash multiple buffers together
- `combineHashes(a: Buffer, b: Buffer): Buffer` - Combine two 32-byte hashes

### Merkle Tree

- `buildMerkleTree(leafHashes: Buffer[]): { root: Buffer, leafCount: number }`
- `getMerkleRoot(leafHashes: Buffer[]): Buffer`
- `generateSubtreeProof(leafHashes: Buffer[], level: number, index: number): SubtreeProof`
- `verifySubtreeProof(node: Buffer, proof: ProofStep[], expectedRoot: Buffer): boolean`
- `buildFileMerkleTree(path: string, chunkSize: number): Promise<{ root: Buffer, leafCount: number }>`

### BitField

- `bitfieldNew(size: number): Buffer`
- `bitfieldGet(buffer: Buffer, index: number): boolean`
- `bitfieldSet(buffer: Buffer, index: number): Buffer`
- `bitfieldClear(buffer: Buffer, index: number): Buffer`
- `bitfieldCount(buffer: Buffer): number`
- `bitfieldGetSetIndices(buffer: Buffer): number[]`
- `bitfieldIsFull(buffer: Buffer, size: number): boolean`
- `bitfieldIsEmpty(buffer: Buffer): boolean`

### Verification

- `verifyChunk(data: Buffer, expectedHash: Buffer): boolean`
- `verifyChunksBatch(chunks: Buffer[], hashes: Buffer[]): boolean[]`

## Fallback

If the native addon fails to load, the module automatically falls back to JavaScript implementations. This ensures SwarmFS works even without Rust installed.
