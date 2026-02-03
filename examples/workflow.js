/**
 * Example: Complete file processing workflow
 * Demonstrates chunking -> hashing -> Merkle tree -> verification
 */

import fs from 'fs';
import { chunkBuffer } from '../src/chunk.js';
import { hashBuffer } from '../src/hash.js';
import { buildMerkleTree, generateMerkleProof, verifyMerkleProof, printMerkleTree } from '../src/merkle.js';

console.log('=== SwarmFS Example: File Processing Workflow ===\n');

// Step 1: Create a sample file
console.log('Step 1: Creating sample file...');
const sampleData = Buffer.from(`
This is a sample document for SwarmFS testing.
It contains multiple lines of text that will be chunked,
hashed, and organized into a Merkle tree for verification.

Lorem ipsum dolor sit amet, consectetur adipiscing elit.
Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
`.repeat(100)); // Repeat to make it larger

console.log(`Created ${sampleData.length} bytes of sample data\n`);

// Step 2: Chunk the file
console.log('Step 2: Chunking file into 256KB chunks...');
const chunks = chunkBuffer(sampleData);
console.log(`Created ${chunks.length} chunks`);
chunks.forEach((chunk, i) => {
  console.log(`  Chunk ${i}: ${chunk.length} bytes`);
});
console.log('');

// Step 3: Hash each chunk
console.log('Step 3: Hashing each chunk...');
const chunkHashes = chunks.map((chunk, i) => {
  const hash = hashBuffer(chunk);
  console.log(`  Chunk ${i}: ${hash.substring(0, 16)}...`);
  return hash;
});
console.log('');

// Step 4: Build Merkle tree
console.log('Step 4: Building Merkle tree...');
const tree = buildMerkleTree(chunkHashes);
console.log(`Tree root: ${tree.root}`);
console.log(`Tree levels: ${tree.levels.length}`);
console.log(`Leaf count: ${tree.leafCount}\n`);

// Step 5: Generate proof for middle chunk
const chunkToVerify = Math.floor(chunks.length / 2);
console.log(`Step 5: Generating proof for chunk ${chunkToVerify}...`);
const proof = generateMerkleProof(chunkHashes, chunkToVerify);
console.log(`Proof contains ${proof.proof.length} sibling hashes:`);
proof.proof.forEach((step, i) => {
  console.log(`  Step ${i}: ${step.hash.substring(0, 16)}... (${step.isLeft ? 'left' : 'right'})`);
});
console.log('');

// Step 6: Verify the proof
console.log('Step 6: Verifying proof...');
const isValid = verifyMerkleProof(proof.leaf, proof.proof, tree.root);
console.log(`Proof is ${isValid ? '✓ VALID' : '✗ INVALID'}\n`);

// Step 7: Simulate chunk corruption
console.log('Step 7: Simulating chunk corruption...');
const corruptedChunk = Buffer.from('CORRUPTED DATA');
const corruptedHash = hashBuffer(corruptedChunk);
const corruptedValid = verifyMerkleProof(corruptedHash, proof.proof, tree.root);
console.log(`Corrupted chunk proof is ${corruptedValid ? '✓ VALID' : '✗ INVALID (as expected)'}\n`);

// Step 8: Show tree structure
console.log('Step 8: Merkle tree structure:');
console.log(printMerkleTree(tree));

console.log('=== Workflow Complete ===');
console.log('\nThis demonstrates the core of SwarmFS:');
console.log('1. Files are chunked into fixed-size pieces');
console.log('2. Each chunk is content-addressed via SHA-256');
console.log('3. Merkle tree enables efficient verification');
console.log('4. Individual chunks can be verified without full file');
console.log('5. Corruption is immediately detectable\n');
