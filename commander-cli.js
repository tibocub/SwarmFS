#!/usr/bin/env node

/**
 * SwarmFS CLI with Commander
 * Phase 4: P2P Networking
 */

import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { SwarmFS } from './src/swarmfs.js';
import { getDataDir } from './src/config.js';

const program = new Command();

// Get data directory from config
const DATA_DIR = getDataDir();
const swarmfs = new SwarmFS(DATA_DIR);

// Auto-initialize if needed
if (!swarmfs.isInitialized()) {
  console.log('Initializing SwarmFS...');
  swarmfs.init();
  console.log(`✓ Initialized at ${DATA_DIR}\n`);
}

// Utility functions
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

// ============================================================================
// PROGRAM SETUP
// ============================================================================

program
  .name('swarmfs')
  .description('P2P file sharing with content-addressed storage')
  .version('0.4.0');

// ============================================================================
// FILE COMMANDS
// ============================================================================

program
  .command('add [path]')
  .description('Add a file or directory (defaults to current directory)')
  .action(async (targetPath) => {
    const filePath = targetPath || '.';
    const absolutePath = path.resolve(filePath);

    if (!fs.existsSync(absolutePath)) {
      console.error(`Error: Path not found: ${absolutePath}`);
      process.exit(1);
    }

    swarmfs.open();

    try {
      const stats = fs.statSync(absolutePath);

      if (stats.isDirectory()) {
        console.log(`Adding directory: ${absolutePath}\n`);
        const result = await swarmfs.addDirectory(absolutePath);
        
        console.log('\n✓ Directory added successfully');
        console.log(`  Path: ${result.path}`);
        console.log(`  Files: ${result.filesAdded}/${result.totalFiles}`);
        console.log(`  Directories: ${result.directories}`);
        console.log(`  Total Size: ${formatBytes(result.totalSize)}`);
        console.log(`  Merkle Root: ${result.merkleRoot}`);
      } else if (stats.isFile()) {
        console.log(`Adding file: ${absolutePath}`);
        const result = await swarmfs.addFile(absolutePath);
        
        console.log('✓ File added successfully');
        console.log(`  Path: ${result.path}`);
        console.log(`  Size: ${formatBytes(result.size)}`);
        console.log(`  Chunks: ${result.chunks}`);
        console.log(`  Merkle Root: ${result.merkleRoot}`);
      } else {
        console.error('Error: Not a file or directory');
        process.exit(1);
      }
    } catch (error) {
      console.error('✗ Error:', error.message);
      process.exit(1);
    } finally {
      swarmfs.close();
    }
  });

program
  .command('status')
  .description('Show all tracked files and directories')
  .action(async () => {
    swarmfs.open();

    try {
      const files = swarmfs.listFiles();
      
      if (files.length === 0) {
        console.log('No files tracked yet.');
        console.log('Use "swarmfs add <path>" to add files.');
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
  });

program
  .command('verify <path>')
  .description('Verify file or directory integrity')
  .action(async (filePath) => {
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
      console.error('✗ Error:', error.message);
      process.exit(1);
    } finally {
      swarmfs.close();
    }
  });

program
  .command('info <path>')
  .description('Show detailed file or directory information')
  .action(async (filePath) => {
    swarmfs.open();

    try {
      const info = swarmfs.getFileInfo(filePath);

      if (!info) {
        console.log(`File not tracked: ${filePath}`);
        console.log('Use "swarmfs add <path>" to add it.');
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
      
      if (info.chunks && info.chunks.length > 0) {
        console.log(`\n  Chunks:`);
        info.chunks.forEach((chunk, i) => {
          console.log(`    ${i}: ${chunk.chunk_hash.substring(0, 16)}... (${formatBytes(chunk.size)})`);
        });
      }
    } finally {
      swarmfs.close();
    }
  });

program
  .command('stats')
  .description('Show storage statistics')
  .action(async () => {
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
  });

// ============================================================================
// TOPIC COMMANDS (P2P Networking)
// ============================================================================

const topicCmd = program
  .command('topic')
  .description('Manage P2P topics/groups');

topicCmd
  .command('create <name>')
  .description('Create a new topic')
  .option('--no-auto-join', 'Do not auto-join on startup')
  .action(async (name, options) => {
    swarmfs.open();

    try {
      const autoJoin = options.autoJoin !== false;
      const result = await swarmfs.createTopic(name, autoJoin);
      
      console.log('✓ Topic created');
      console.log(`  Name: ${result.name}`);
      console.log(`  Topic Key: ${result.topicKey}`);
      console.log(`  Auto-join: ${result.autoJoin ? 'yes' : 'no'}`);
    } catch (error) {
      console.error('✗ Error:', error.message);
      process.exit(1);
    } finally {
      swarmfs.close();
    }
  });

topicCmd
  .command('list')
  .description('List all topics')
  .action(async () => {
    swarmfs.open();

    try {
      const topics = await swarmfs.listTopics();
      
      if (topics.length === 0) {
        console.log('No topics created yet.');
        console.log('Use "swarmfs topic create <name>" to create a topic.');
        return;
      }

      console.log(`\nTopics (${topics.length}):\n`);
      
      for (const topic of topics) {
        console.log(`  ${topic.name}`);
        console.log(`    Topic Key: ${topic.topic_key.substring(0, 16)}...`);
        console.log(`    Auto-join: ${topic.auto_join ? 'yes' : 'no'}`);
        console.log(`    Created: ${formatDate(topic.created_at)}`);
        if (topic.last_joined_at) {
          console.log(`    Last Joined: ${formatDate(topic.last_joined_at)}`);
        }
        console.log('');
      }
    } finally {
      swarmfs.close();
    }
  });

topicCmd
  .command('join <name>')
  .description('Join a topic and start networking')
  .action(async (name) => {
    swarmfs.open();

    try {
      await swarmfs.joinTopic(name);
      console.log(`✓ Joined topic: ${name}`);
      console.log('  Discovering peers...');
    } catch (error) {
      console.error('✗ Error:', error.message);
      process.exit(1);
    } finally {
      // Note: Don't close swarmfs here - network stays active
      console.log('\nPress Ctrl+C to stop');
    }
  });

topicCmd
  .command('leave <name>')
  .description('Leave a topic')
  .action(async (name) => {
    swarmfs.open();

    try {
      await swarmfs.leaveTopic(name);
      console.log(`✓ Left topic: ${name}`);
    } catch (error) {
      console.error('✗ Error:', error.message);
      process.exit(1);
    } finally {
      swarmfs.close();
    }
  });

topicCmd
  .command('share <topic> <path>')
  .description('Share a file or directory in a topic')
  .action(async (topicName, sharePath) => {
    swarmfs.open();

    try {
      const result = await swarmfs.sharePath(topicName, sharePath);
      
      console.log('✓ Shared successfully');
      console.log(`  Topic: ${topicName}`);
      console.log(`  Path: ${result.path}`);
      console.log(`  Type: ${result.type}`);
      console.log(`  Merkle Root: ${result.merkleRoot}`);
    } catch (error) {
      console.error('✗ Error:', error.message);
      process.exit(1);
    } finally {
      swarmfs.close();
    }
  });

topicCmd
  .command('unshare <topic> <path>')
  .description('Stop sharing a file or directory in a topic')
  .action(async (topicName, sharePath) => {
    swarmfs.open();

    try {
      await swarmfs.unsharePath(topicName, sharePath);
      console.log(`✓ Stopped sharing ${sharePath} in ${topicName}`);
    } catch (error) {
      console.error('✗ Error:', error.message);
      process.exit(1);
    } finally {
      swarmfs.close();
    }
  });

topicCmd
  .command('info <name>')
  .description('Show topic details and shared files')
  .action(async (name) => {
    swarmfs.open();

    try {
      const info = await swarmfs.getTopicInfo(name);
      
      if (!info) {
        console.log(`Topic not found: ${name}`);
        return;
      }

      console.log(`\nTopic: ${info.name}`);
      console.log(`  Topic Key: ${info.topic_key}`);
      console.log(`  Auto-join: ${info.auto_join ? 'yes' : 'no'}`);
      console.log(`  Created: ${formatDate(info.created_at)}`);
      
      if (info.shares && info.shares.length > 0) {
        console.log(`\n  Shared Items (${info.shares.length}):`);
        for (const share of info.shares) {
          console.log(`    ${share.share_path} (${share.share_type})`);
          console.log(`      Merkle Root: ${share.merkle_root.substring(0, 16)}...`);
        }
      } else {
        console.log('\n  No items shared in this topic yet.');
      }
    } finally {
      swarmfs.close();
    }
  });

// ============================================================================
// PARSE AND RUN
// ============================================================================

program.parse();
