#!/usr/bin/env node

/**
 * SwarmFS CLI with Commander
 * Uses extracted command logic from src/commands.js
 */

import { Command } from 'commander';
import { SwarmFS } from './src/swarmfs.js';
import { getDataDir } from './src/config.js';
import * as cmd from './src/commands.js';

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

// Wrapper to handle errors and cleanup
function wrapCommand(commandFunc, keepAlive = false) {
  return async (...args) => {
    try {
      await commandFunc(swarmfs, ...args);
      
      if (!keepAlive) {
        swarmfs.close();
      }
    } catch (error) {
      console.error('✗ Error:', error.message);
      if (!keepAlive) {
        swarmfs.close();
      }
      process.exit(1);
    }
  };
}

// Setup Ctrl+C handler for keep-alive commands
function setupGracefulShutdown() {
  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    swarmfs.close();
    process.exit(0);
  });
}

// ============================================================================
// PROGRAM SETUP
// ============================================================================

program
  .name('swarmfs')
  .description('P2P file sharing with content-addressed storage')
  .version('0.4.3');

// ============================================================================
// FILE COMMANDS
// ============================================================================

program
  .command('add [path]')
  .description('Add a file or directory (defaults to current directory)')
  .action(wrapCommand(cmd.addCommand));

program
  .command('status')
  .description('Show all tracked files and directories')
  .action(wrapCommand(cmd.statusCommand));

program
  .command('verify <path>')
  .description('Verify file or directory integrity')
  .action(wrapCommand(cmd.verifyCommand));

program
  .command('info <path>')
  .description('Show detailed file or directory information')
  .action(wrapCommand(cmd.infoCommand));

program
  .command('stats')
  .description('Show storage statistics')
  .action(wrapCommand(cmd.statsCommand));

// ============================================================================
// TOPIC COMMANDS
// ============================================================================

const topicCmd = program
  .command('topic')
  .description('Manage P2P topics/groups');

topicCmd
  .command('create <name>')
  .description('Create a new topic')
  .option('--no-auto-join', 'Do not auto-join on startup')
  .action(wrapCommand(cmd.topicCreateCommand));

topicCmd
  .command('list')
  .description('List all topics')
  .action(wrapCommand(cmd.topicListCommand));

topicCmd
  .command('info <name>')
  .description('Show topic details and shared files')
  .action(wrapCommand(cmd.topicInfoCommand));

topicCmd
  .command('share <topic> <path>')
  .description('Share a file or directory in a topic')
  .action(wrapCommand(cmd.topicShareCommand));

topicCmd
  .command('unshare <topic> <path>')
  .description('Stop sharing a file or directory in a topic')
  .action(wrapCommand(cmd.topicUnshareCommand));

topicCmd
  .command('join <name>')
  .description('Join a topic and start networking')
  .action(async (name) => {
    try {
      await cmd.topicJoinCommand(swarmfs, name);
      
      console.log('\n✓ Network active');
      console.log('Press Ctrl+C to stop\n');
      
      // Keep process alive
      process.stdin.resume();
      setupGracefulShutdown();

    } catch (error) {
      console.error('✗ Error:', error.message);
      swarmfs.close();
      process.exit(1);
    }
  });

topicCmd
  .command('leave <name>')
  .description('Leave a topic')
  .action(wrapCommand(cmd.topicLeaveCommand));

// ============================================================================
// NETWORK COMMANDS
// ============================================================================

program
  .command('request <topic> <chunkHash>')
  .description('Request a chunk from a topic')
  .action(async (topic, chunkHash) => {
    try {
      await cmd.requestCommand(swarmfs, topic, chunkHash);
      
      console.log('Waiting for chunk download...');
      console.log('Press Ctrl+C to cancel\n');
      
      // Setup download complete handler
      let downloadComplete = false;
      
      if (swarmfs.protocol) {
        swarmfs.protocol.once('chunk:downloaded', () => {
          downloadComplete = true;
          console.log('\n✓ Download complete!');
          swarmfs.close();
          process.exit(0);
        });
        
        swarmfs.protocol.once('chunk:timeout', () => {
          console.log('\n⏱️  Request timed out - no peers responded');
          swarmfs.close();
          process.exit(1);
        });
        
        swarmfs.protocol.once('chunk:error', (info) => {
          console.error(`\n❌ Error: ${info.error}`);
          swarmfs.close();
          process.exit(1);
        });
      }
      
      // Keep process alive until download completes or timeout
      process.stdin.resume();
      setupGracefulShutdown();

    } catch (error) {
      console.error('✗ Error:', error.message);
      swarmfs.close();
      process.exit(1);
    }
  });

program
  .command('browse <topic>')
  .description('List shared files in a topic')
  .action(wrapCommand(cmd.browseCommand));

program
  .command('download <topic> <merkleRoot> <outputPath>')
  .description('Download a complete file from a topic')
  .action(async (topic, merkleRoot, outputPath) => {
    try {
      await cmd.downloadCommand(swarmfs, topic, merkleRoot, outputPath);
      swarmfs.close();
      process.exit(0);
    } catch (error) {
      console.error('✗ Error:', error.message);
      swarmfs.close();
      process.exit(1);
    }
  });

program
  .command('network')
  .description('Show network status')
  .action(wrapCommand(cmd.networkCommand));

// ============================================================================
// TUI
// ============================================================================

program
  .command('tui')
  .description('Start terminal UI (keeps connections alive)')
  .option('-v, --verbose', 'Enable verbose debug output')
  .action(async (options) => {
    try {
      if (options?.verbose) {
        process.env.SWARMFS_VERBOSE = '1';
      }
      const { startTui } = await import('./src/tui.js');
      process.stdin.resume();
      setupGracefulShutdown();
      await startTui(swarmfs);
    } catch (error) {
      console.error('✗ Error:', error.message);
      swarmfs.close();
      process.exit(1);
    }
  });

// ============================================================================
// REPL
// ============================================================================

program
  .command('shell')
  .alias('repl')
  .description('Start interactive shell (keeps connections alive)')
  .option('-v, --verbose', 'Enable verbose debug output')
  .action((options) => {
    console.log('\nStarting REPL mode...');
    console.log('Use "exit" to quit, "help" for commands\n');
    if (options?.verbose) {
      process.env.SWARMFS_VERBOSE = '1';
    }
    swarmfs.close();
    
    // Import and run REPL
    import('./repl.js');
  });

// ============================================================================
// PARSE AND RUN
// ============================================================================

program.parse();
