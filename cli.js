#!/usr/bin/env node

/**
 * SwarmFS CLI
 * Simple command-line interface
 */

import path from 'path';
import { SwarmFS } from './src/swarmfs.js';

// Data directory in the project root for now
const DATA_DIR = path.join(process.cwd(), 'swarmfs-data');

const swarmfs = new SwarmFS(DATA_DIR);

function showUsage() {
  console.log(`
SwarmFS - P2P File Sharing with Content-Addressed Storage

Usage:
  swarmfs <command> [arguments]

Commands:
  init                     Initialize SwarmFS in current directory
  add <file>              Add a file to SwarmFS
  status                  Show all tracked files
  verify <file>           Verify file integrity
  info <file>             Show detailed file information
  stats                   Show storage statistics
  help                    Show this help message

Examples:
  swarmfs init
  swarmfs add ./myfile.txt
  swarmfs status
  swarmfs verify ./myfile.txt
`);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString();
}

// Command handlers
async function cmdInit() {
  if (swarmfs.isInitialized()) {
    console.log('SwarmFS already initialized at:', DATA_DIR);
    return;
  }

  const result = swarmfs.init();
  console.log('✓ SwarmFS initialized');
  console.log('  Data directory:', result.dataDir);
  console.log('  Database:', result.dbPath);
  console.log('  Chunks:', result.chunksDir);
}

async function cmdAdd(filePath) {
  if (!filePath) {
    console.error('Error: No file specified');
    console.log('Usage: swarmfs add <file>');
    process.exit(1);
  }

  swarmfs.open();

  try {
    console.log(`Adding file: ${filePath}`);
    const result = await swarmfs.addFile(filePath);
    
    console.log('✓ File added successfully');
    console.log(`  Path: ${result.path}`);
    console.log(`  Size: ${formatBytes(result.size)}`);
    console.log(`  Chunks: ${result.chunks}`);
    console.log(`  Merkle Root: ${result.merkleRoot}`);
  } catch (error) {
    console.error('✗ Error adding file:', error.message);
    process.exit(1);
  } finally {
    swarmfs.close();
  }
}

async function cmdStatus() {
  swarmfs.open();

  try {
    const files = swarmfs.listFiles();
    
    if (files.length === 0) {
      console.log('No files tracked yet.');
      console.log('Use "swarmfs add <file>" to add files.');
      return;
    }

    console.log(`\nTracked Files (${files.length}):\n`);
    
    for (const file of files) {
      console.log(`  ${file.path}`);
      console.log(`    Size: ${formatBytes(file.size)}`);
      console.log(`    Chunks: ${file.chunk_count}`);
      console.log(`    Added: ${formatDate(file.added_at)}`);
      console.log(`    Merkle Root: ${file.merkle_root.substring(0, 16)}...`);
      console.log('');
    }
  } finally {
    swarmfs.close();
  }
}

async function cmdVerify(filePath) {
  if (!filePath) {
    console.error('Error: No file specified');
    console.log('Usage: swarmfs verify <file>');
    process.exit(1);
  }

  swarmfs.open();

  try {
    console.log(`Verifying: ${filePath}`);
    const result = await swarmfs.verifyFile(filePath);

    if (result.valid) {
      console.log('✓ File is valid');
      console.log(`  Chunks verified: ${result.chunks}`);
      console.log(`  Merkle Root: ${result.merkleRoot}`);
    } else {
      console.log('✗ File verification failed');
      console.log(`  Error: ${result.error}`);
      
      if (result.corruptedChunks) {
        console.log(`  Corrupted chunks: ${result.corruptedChunks.length}`);
        result.corruptedChunks.forEach(chunk => {
          console.log(`    Chunk ${chunk.index}: hash mismatch`);
        });
      }
    }
  } catch (error) {
    console.error('✗ Error verifying file:', error.message);
    process.exit(1);
  } finally {
    swarmfs.close();
  }
}

async function cmdInfo(filePath) {
  if (!filePath) {
    console.error('Error: No file specified');
    console.log('Usage: swarmfs info <file>');
    process.exit(1);
  }

  swarmfs.open();

  try {
    const info = swarmfs.getFileInfo(filePath);

    if (!info) {
      console.log(`File not tracked: ${filePath}`);
      console.log('Use "swarmfs add <file>" to add it.');
      return;
    }

    console.log(`\nFile Information:`);
    console.log(`  Path: ${info.path}`);
    console.log(`  Size: ${formatBytes(info.size)}`);
    console.log(`  Chunk Size: ${formatBytes(info.chunk_size)}`);
    console.log(`  Chunk Count: ${info.chunk_count}`);
    console.log(`  Merkle Root: ${info.merkle_root}`);
    console.log(`  Added: ${formatDate(info.added_at)}`);
    console.log(`  File Modified: ${formatDate(info.file_modified_at)}`);
    console.log(`\n  Chunks:`);
    
    if (info.chunks && info.chunks.length > 0) {
      info.chunks.forEach((chunk, i) => {
        console.log(`    ${i}: ${chunk.chunk_hash.substring(0, 16)}... (${formatBytes(chunk.size)})`);
      });
    } else {
      console.log(`    (No chunk information available)`);
    }
  } finally {
    swarmfs.close();
  }
}

async function cmdStats() {
  swarmfs.open();

  try {
    const stats = swarmfs.getStats();

    console.log(`\nSwarmFS Statistics:`);
    console.log(`  Data Directory: ${stats.dataDir}`);
    console.log(`  Files Tracked: ${stats.files}`);
    console.log(`  Total File Size: ${formatBytes(stats.totalFileSize)}`);
    console.log(`  Unique Chunks: ${stats.chunks}`);
    console.log(`  Storage Used: ${formatBytes(stats.storageSize)}`);
    
    if (stats.totalFileSize > 0) {
      const ratio = (stats.storageSize / stats.totalFileSize * 100).toFixed(2);
      console.log(`  Storage Ratio: ${ratio}%`);
    }
  } finally {
    swarmfs.close();
  }
}

// Main CLI router
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help') {
    showUsage();
    return;
  }

  try {
    switch (command) {
      case 'init':
        await cmdInit();
        break;
      
      case 'add':
        await cmdAdd(args[1]);
        break;
      
      case 'status':
        await cmdStatus();
        break;
      
      case 'verify':
        await cmdVerify(args[1]);
        break;
      
      case 'info':
        await cmdInfo(args[1]);
        break;
      
      case 'stats':
        await cmdStats();
        break;
      
      default:
        console.error(`Unknown command: ${command}`);
        showUsage();
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
