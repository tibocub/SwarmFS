/**
 * Test suite for SwarmFS Phase 1: Core Infrastructure
 * Tests chunking, hashing, and Merkle tree utilities
 */

import { chunkBuffer, calculateChunkCount, DEFAULT_CHUNK_SIZE } from '../src/chunk.js';
import { hashBuffer, combineHashes } from '../src/hash.js';
import { buildMerkleTree, getMerkleRoot, generateMerkleProof, verifyMerkleProof, printMerkleTree } from '../src/merkle.js';

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    testsPassed++;
    console.log(`✓ ${message}`);
  } else {
    testsFailed++;
    console.log(`✗ ${message}`);
  }
}

function assertEquals(actual, expected, message) {
  assert(actual === expected, `${message} (expected: ${expected}, got: ${actual})`);
}

console.log('=== SwarmFS Phase 1 Tests ===\n');

// Test 1: Chunking
console.log('--- Chunking Tests ---');

// Test 1.1: Basic chunking
const smallData = Buffer.from('Hello, SwarmFS!');
const smallChunks = chunkBuffer(smallData, 5);
assertEquals(smallChunks.length, 3, 'Small buffer should create 3 chunks with 5-byte size');
assertEquals(smallChunks[0].toString(), 'Hello', 'First chunk should be "Hello"');
assertEquals(smallChunks[1].toString(), ', Swa', 'Second chunk should be ", Swa"');
assertEquals(smallChunks[2].toString(), 'rmFS!', 'Third chunk should be "rmFS!"');

// Test 1.2: Empty buffer
const emptyChunks = chunkBuffer(Buffer.alloc(0), 1024);
assertEquals(emptyChunks.length, 1, 'Empty buffer should create 1 empty chunk');
assertEquals(emptyChunks[0].length, 0, 'Empty chunk should have length 0');

// Test 1.3: Single chunk (data smaller than chunk size)
const tinyData = Buffer.from('tiny');
const tinyChunks = chunkBuffer(tinyData, 1024);
assertEquals(tinyChunks.length, 1, 'Data smaller than chunk size should create 1 chunk');
assertEquals(tinyChunks[0].toString(), 'tiny', 'Single chunk should contain all data');

// Test 1.4: Exact multiple of chunk size
const exactData = Buffer.alloc(1024 * 3);
const exactChunks = chunkBuffer(exactData, 1024);
assertEquals(exactChunks.length, 3, 'Data exactly 3x chunk size should create 3 chunks');
assertEquals(exactChunks[0].length, 1024, 'Each chunk should be exactly 1024 bytes');

// Test 1.5: Calculate chunk count
assertEquals(calculateChunkCount(0), 1, 'Empty file should have 1 chunk');
assertEquals(calculateChunkCount(256 * 1024), 1, 'File exactly 256KB should have 1 chunk');
assertEquals(calculateChunkCount(256 * 1024 + 1), 2, 'File 256KB+1 should have 2 chunks');
assertEquals(calculateChunkCount(512 * 1024), 2, 'File 512KB should have 2 chunks');

console.log('');

// Test 2: Hashing
console.log('--- Hashing Tests ---');

// Test 2.1: Deterministic hashing
const data1 = Buffer.from('test data');
const hash1a = hashBuffer(data1);
const hash1b = hashBuffer(data1);
assertEquals(hash1a, hash1b, 'Same data should produce same hash');

// Test 2.2: Different data produces different hashes
const data2 = Buffer.from('different data');
const hash2 = hashBuffer(data2);
assert(hash1a !== hash2, 'Different data should produce different hashes');

// Test 2.3: Hash format (SHA-256 = 64 hex characters)
assertEquals(hash1a.length, 64, 'SHA-256 hash should be 64 hex characters');
assert(/^[0-9a-f]{64}$/.test(hash1a), 'Hash should be valid hex');

// Test 2.4: Combine hashes
const hashA = hashBuffer(Buffer.from('A'));
const hashB = hashBuffer(Buffer.from('B'));
const combinedAB = combineHashes(hashA, hashB);
const combinedBA = combineHashes(hashB, hashA);
assert(combinedAB !== combinedBA, 'Hash order should matter (not commutative)');
assertEquals(combinedAB.length, 64, 'Combined hash should also be 64 characters');

console.log('');

// Test 3: Merkle Trees
console.log('--- Merkle Tree Tests ---');

// Test 3.1: Single leaf
const singleLeaf = [hashBuffer(Buffer.from('single'))];
const singleTree = buildMerkleTree(singleLeaf);
assertEquals(singleTree.root, singleLeaf[0], 'Single leaf tree root should be the leaf itself');
assertEquals(singleTree.leafCount, 1, 'Single leaf tree should have leafCount 1');

// Test 3.2: Two leaves
const leaf1 = hashBuffer(Buffer.from('leaf1'));
const leaf2 = hashBuffer(Buffer.from('leaf2'));
const twoLeaves = [leaf1, leaf2];
const twoTree = buildMerkleTree(twoLeaves);
const expectedRoot = combineHashes(leaf1, leaf2);
assertEquals(twoTree.root, expectedRoot, 'Two leaf tree root should be combined hash');
assertEquals(twoTree.levels.length, 2, 'Two leaf tree should have 2 levels');

// Test 3.3: Four leaves (perfect binary tree)
const fourLeaves = [
  hashBuffer(Buffer.from('chunk0')),
  hashBuffer(Buffer.from('chunk1')),
  hashBuffer(Buffer.from('chunk2')),
  hashBuffer(Buffer.from('chunk3'))
];
const fourTree = buildMerkleTree(fourLeaves);
assertEquals(fourTree.levels.length, 3, 'Four leaf tree should have 3 levels (leaves + 2 + root)');
assertEquals(fourTree.levels[0].length, 4, 'Level 0 should have 4 leaves');
assertEquals(fourTree.levels[1].length, 2, 'Level 1 should have 2 nodes');
assertEquals(fourTree.levels[2].length, 1, 'Level 2 should have 1 root');

// Test 3.4: Odd number of leaves (should duplicate last)
const threeLeaves = [
  hashBuffer(Buffer.from('chunk0')),
  hashBuffer(Buffer.from('chunk1')),
  hashBuffer(Buffer.from('chunk2'))
];
const threeTree = buildMerkleTree(threeLeaves);
assertEquals(threeTree.leafCount, 3, 'Three leaf tree should have leafCount 3');
assert(threeTree.root.length === 64, 'Odd leaf tree should still produce valid root');

// Test 3.5: getMerkleRoot convenience function
const root = getMerkleRoot(fourLeaves);
assertEquals(root, fourTree.root, 'getMerkleRoot should return same root as buildMerkleTree');

console.log('');

// Test 4: Merkle Proofs
console.log('--- Merkle Proof Tests ---');

// Test 4.1: Generate proof for each leaf in 4-leaf tree
for (let i = 0; i < fourLeaves.length; i++) {
  const proof = generateMerkleProof(fourLeaves, i);
  assertEquals(proof.leaf, fourLeaves[i], `Proof for leaf ${i} should include correct leaf hash`);
  assertEquals(proof.root, fourTree.root, `Proof for leaf ${i} should include correct root`);
  assert(proof.proof.length > 0, `Proof for leaf ${i} should have sibling hashes`);
}

// Test 4.2: Verify valid proofs
for (let i = 0; i < fourLeaves.length; i++) {
  const proof = generateMerkleProof(fourLeaves, i);
  const isValid = verifyMerkleProof(proof.leaf, proof.proof, proof.root);
  assert(isValid, `Proof for leaf ${i} should verify as valid`);
}

// Test 4.3: Invalid proof (wrong root)
const validProof = generateMerkleProof(fourLeaves, 0);
const wrongRoot = hashBuffer(Buffer.from('wrong'));
const isInvalid = verifyMerkleProof(validProof.leaf, validProof.proof, wrongRoot);
assert(!isInvalid, 'Proof should fail with wrong root');

// Test 4.4: Invalid proof (tampered leaf)
const tamperedLeaf = hashBuffer(Buffer.from('tampered'));
const isInvalid2 = verifyMerkleProof(tamperedLeaf, validProof.proof, validProof.root);
assert(!isInvalid2, 'Proof should fail with tampered leaf');

console.log('');

// Test 5: Realistic file simulation
console.log('--- Realistic File Simulation ---');

// Simulate a 1MB file
const fileSize = 1024 * 1024; // 1MB
const fileData = Buffer.alloc(fileSize);
// Fill with some pattern so chunks are different
for (let i = 0; i < fileSize; i++) {
  fileData[i] = i % 256;
}

// Chunk the file
const chunks = chunkBuffer(fileData, DEFAULT_CHUNK_SIZE);
const expectedChunks = Math.ceil(fileSize / DEFAULT_CHUNK_SIZE);
assertEquals(chunks.length, expectedChunks, `1MB file should create ${expectedChunks} chunks of 256KB`);

// Hash each chunk
const chunkHashes = chunks.map(chunk => hashBuffer(chunk));
assertEquals(chunkHashes.length, chunks.length, 'Should have one hash per chunk');

// Build Merkle tree
const fileTree = buildMerkleTree(chunkHashes);
assert(fileTree.root.length === 64, 'File Merkle tree should have valid root hash');

// Verify we can prove any chunk
const randomChunkIndex = Math.floor(Math.random() * chunkHashes.length);
const chunkProof = generateMerkleProof(chunkHashes, randomChunkIndex);
const proofValid = verifyMerkleProof(chunkProof.leaf, chunkProof.proof, fileTree.root);
assert(proofValid, `Should be able to verify proof for chunk ${randomChunkIndex}`);

console.log(`\nSimulated 1MB file: ${chunks.length} chunks, root hash: ${fileTree.root.substring(0, 16)}...`);

console.log('');

// Test 6: Print tree (visual test)
console.log('--- Visual Tree Test ---');
const visualLeaves = [
  hashBuffer(Buffer.from('A')),
  hashBuffer(Buffer.from('B')),
  hashBuffer(Buffer.from('C'))
];
const visualTree = buildMerkleTree(visualLeaves);
console.log(printMerkleTree(visualTree));

// Summary
console.log('=== Test Summary ===');
console.log(`Passed: ${testsPassed}`);
console.log(`Failed: ${testsFailed}`);
console.log(`Total: ${testsPassed + testsFailed}`);

if (testsFailed === 0) {
  console.log('\n✓ All tests passed! Phase 1 implementation is working correctly.');
  process.exit(0);
} else {
  console.log(`\n✗ ${testsFailed} test(s) failed.`);
  process.exit(1);
}
