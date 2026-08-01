// Core behavior tests for SwarmFS
// These tests verify invariants that must NEVER be broken

import test from 'node:test';
import assert from 'node:assert';
import { SwarmDB } from '../src/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Test helpers
function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swarmfs-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createTestFile(dir, name, content) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

// Test: Content-addressed file lookup
test('getFilesByMerkleRoot returns all files with matching merkle root', async () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'test.db');
  
  try {
    const db = new SwarmDB(dbPath);
    
    // Add two files with same merkle root (simulating copies)
    const merkleRoot = 'abcd1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab';
    const file1 = createTestFile(tempDir, 'file1.txt', 'test content');
    const file2 = createTestFile(tempDir, 'file2.txt', 'test content');
    
    const fileId1 = db.addFile(file1, merkleRoot, 12, 1024, 1, Date.now());
    const fileId2 = db.addFile(file2, merkleRoot, 12, 1024, 1, Date.now());
    
    // Query by merkle root
    const files = db.getFilesByMerkleRoot(merkleRoot);
    
    assert.strictEqual(files.length, 2, 'Should find both files with same merkle root');
    assert.ok(files.some(f => f.path === file1), 'Should include file1');
    assert.ok(files.some(f => f.path === file2), 'Should include file2');
    
  } finally {
    cleanupTempDir(tempDir);
  }
});

// Test: File accessibility check
test('getFilesByMerkleRoot only returns complete files (file_modified_at > 0)', async () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'test.db');
  
  try {
    const db = new SwarmDB(dbPath);
    
    const merkleRoot = 'abcd1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab';
    const file1 = createTestFile(tempDir, 'file1.txt', 'test content');
    const file2 = createTestFile(tempDir, 'file2.txt', 'test content');
    
    // Add complete file
    db.addFile(file1, merkleRoot, 12, 1024, 1, Date.now());
    
    // Add incomplete file (file_modified_at = 0)
    db.addFile(file2, merkleRoot, 12, 1024, 1, 0);
    
    const files = db.getFilesByMerkleRoot(merkleRoot);
    
    assert.strictEqual(files.length, 1, 'Should only return complete files');
    assert.strictEqual(files[0].path, file1, 'Should return the complete file');
    
  } finally {
    cleanupTempDir(tempDir);
  }
});

// Test: Multiple merkle roots
test('getFilesByMerkleRoot distinguishes between different merkle roots', async () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'test.db');
  
  try {
    const db = new SwarmDB(dbPath);
    
    const merkleRoot1 = 'aaaa1234567890abcdef1234567890abcdef1234567890abcdef1234567890aa';
    const merkleRoot2 = 'bbbb1234567890abcdef1234567890abcdef1234567890abcdef1234567890bb';
    
    const file1 = createTestFile(tempDir, 'file1.txt', 'content 1');
    const file2 = createTestFile(tempDir, 'file2.txt', 'content 2');
    
    db.addFile(file1, merkleRoot1, 9, 1024, 1, Date.now());
    db.addFile(file2, merkleRoot2, 9, 1024, 1, Date.now());
    
    const files1 = db.getFilesByMerkleRoot(merkleRoot1);
    const files2 = db.getFilesByMerkleRoot(merkleRoot2);
    
    assert.strictEqual(files1.length, 1, 'Should find one file for merkleRoot1');
    assert.strictEqual(files2.length, 1, 'Should find one file for merkleRoot2');
    assert.strictEqual(files1[0].path, file1);
    assert.strictEqual(files2[0].path, file2);
    
  } finally {
    cleanupTempDir(tempDir);
  }
});

// Test: Empty result for unknown merkle root
test('getFilesByMerkleRoot returns empty array for unknown merkle root', async () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'test.db');
  
  try {
    const db = new SwarmDB(dbPath);
    
    const unknownRoot = 'unknown1234567890abcdef1234567890abcdef1234567890abcdef12345678';
    const files = db.getFilesByMerkleRoot(unknownRoot);
    
    assert.strictEqual(files.length, 0, 'Should return empty array for unknown merkle root');
    
  } finally {
    cleanupTempDir(tempDir);
  }
});

console.log('Run with: node --test test/core-behaviors.test.js');
