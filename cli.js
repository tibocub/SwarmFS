#!/usr/bin/env node

/**
 * SwarmFS CLI with Commander
 * Uses extracted command logic from src/commands.js
 */

import { Command } from 'commander';
import { SwarmFS } from './src/swarmfs.js';
import { getDataDir } from './src/config.js';
import * as cmd from './src/commands.js';
import { getIpcEndpoint } from './src/ipc/endpoint.js';
import { NodeRuntime } from './src/node-runtime.js';
import { IpcServer } from './src/ipc/server.js';
import { connectIpc, createRpcClient } from './src/ipc/client.js';

import path from "path";
import { fileURLToPath } from "url";

if (process.versions.bun) {
  // Tell terminal-kit where its runtime files live inside the bundled binary
  process.env.TERMKIT_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "node_modules/terminal-kit/lib"
  );
}

const program = new Command();

// Get data directory from config
const DATA_DIR = getDataDir();
const swarmfs = new SwarmFS(DATA_DIR);

// Auto-initialize if needed
if (!swarmfs.isInitialized()) {
  console.log('Initializing SwarmFS...');
  swarmfs.init();
  console.log(`Initialized at ${DATA_DIR}\n`);
}

// Wrapper to handle errors and cleanup
function wrapCommand(commandFunc, keepAlive = false) {
  return async (...args) => {
    try {
      await commandFunc(swarmfs, ...args);
      
      if (!keepAlive) {
        await swarmfs.close();
      }
    } catch (error) {
      console.error('Error:', error.message);
      if (error && error.stack) {
        console.error(error.stack)
      }
      if (!keepAlive) {
        await swarmfs.close();
      }
      process.exit(1);
    }
  };
}

// Setup Ctrl+C handler for keep-alive commands
function setupGracefulShutdown() {
  process.on('SIGINT', async () => {
    console.log('\n\nShutting down...');
    await swarmfs.close();
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
// DEBUG COMMANDS
// ============================================================================

program
  .command('tree <merkle-root>')
  .description('(Debug) Print the tree of given root hash')
  .action(wrapCommand(cmd.treeCommand));

// ============================================================================
// FILE COMMANDS
// ============================================================================

program
  .command('add [paths...]')
  .description('Add a file or directory (defaults to current directory)')
  .action(wrapCommand(cmd.addCommand));

program
  .command('rm <paths...>')
  .description('Remove file or directory metadata from the database')
  .action(wrapCommand(cmd.rmCommand));

program
  .command('share <topic> <paths...>')
  .description('Share file(s) in a topic')
  .action(async (topic, paths) => {
    try {
      await cmd.shareCommand(swarmfs, topic, paths);
      await swarmfs.close();
      process.exit(0);
    } catch (error) {
      console.error('✗ Error:', error.message);
      await swarmfs.close();
      process.exit(1);
    }
  });

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
  .command('save <name> [password]')
  .description('Save a new topic')
  .option('--no-auto-join', 'Do not auto-join on startup')
  .option('-p, --password [password]', 'Derive topic key from password (prompted if omitted)')
  .action(wrapCommand(cmd.topicSaveCommand));

topicCmd
  .command('create <name> [password]')
  .description('Alias for topic save')
  .option('--no-auto-join', 'Do not auto-join on startup')
  .option('-p, --password [password]', 'Derive topic key from password (prompted if omitted)')
  .action(wrapCommand(cmd.topicSaveCommand));

topicCmd
  .command('list')
  .description('List all topics')
  .action(wrapCommand(cmd.topicListCommand));

topicCmd
  .command('info <name>')
  .description('Show topic details and shared files')
  .action(wrapCommand(cmd.topicInfoCommand));

topicCmd
  .command('rm <name>')
  .description('Remove a topic from the database')
  .action(wrapCommand(cmd.topicRmCommand));

topicCmd
  .command('autojoin [topics...]')
  .description('Enable or disable auto-join for one or more topics')
  .option('-y, --yes', 'Enable auto-join')
  .option('-n, --disable', 'Disable auto-join')
  .action(wrapCommand(cmd.topicAutojoinCommand));

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
      await swarmfs.close();
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
          void (async () => {
            await swarmfs.close();
            process.exit(0);
          })();
        });
        
        swarmfs.protocol.once('chunk:timeout', () => {
          console.log('\n⏱️  Request timed out - no peers responded');
          void (async () => {
            await swarmfs.close();
            process.exit(1);
          })();
        });
        
        swarmfs.protocol.once('chunk:error', (info) => {
          console.error(`\n❌ Error: ${info.error}`);
          void (async () => {
            await swarmfs.close();
            process.exit(1);
          })();
        });
      }
      
      // Keep process alive until download completes or timeout
      process.stdin.resume();
      setupGracefulShutdown();

    } catch (error) {
      console.error('✗ Error:', error.message);
      await swarmfs.close();
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
      await swarmfs.close();
      process.exit(0);
    } catch (error) {
      console.error('✗ Error:', error.message);
      await swarmfs.close();
      process.exit(1);
    }
  });

program
  .command('resume [topic]')
  .description('Resume incomplete downloads')
  .option('-a, --all', 'Resume all incomplete downloads')
  .action(async (topic, options) => {
    try {
      await cmd.resumeCommand(swarmfs, topic, options);
      await swarmfs.close();
      process.exit(0);
    } catch (error) {
      console.error('✗ Error:', error.message);
      await swarmfs.close();
      process.exit(1);
    }
  });

program
  .command('network')
  .description('Show network status')
  .action(wrapCommand(cmd.networkCommand));

// ============================================================================
// DAEMON + IPC
// ============================================================================

const daemonCmd = program
  .command('daemon')
  .description('Run or control the local SwarmFS daemon (IPC)');

daemonCmd
  .command('start')
  .description('Start SwarmFS daemon (foreground)')
  .action(async () => {
    const endpoint = getIpcEndpoint(DATA_DIR);
    const node = new NodeRuntime(swarmfs);
    await node.start();

    const server = new IpcServer({ endpoint, nodeRuntime: node, version: program.version() });

    const originalConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn
    };

    console.log = (...args) => {
      originalConsole.log(...args);
      server.pushLog(args.join(' '), 'info');
    };

    console.warn = (...args) => {
      originalConsole.warn(...args);
      server.pushLog(args.join(' '), 'warn');
    };

    console.error = (...args) => {
      originalConsole.error(...args);
      server.pushLog(args.join(' '), 'error');
    };

    const shutdown = async () => {
      try {
        await server.close();
      } catch {
        // ignore
      }
      try {
        await node.stop();
      } catch {
        // ignore
      }
      process.exit(0);
    };

    server.on('shutdown', () => {
      void shutdown();
    });

    process.on('SIGINT', () => {
      void shutdown();
    });

    process.on('SIGTERM', () => {
      void shutdown();
    });

    try {
      await server.bind();
    } catch (error) {
      originalConsole.error('✗ Error:', error.message);
      await shutdown();
    }

    console.log(`SwarmFS daemon listening on ${endpoint}`);
  });

daemonCmd
  .command('ping')
  .description('Ping daemon')
  .action(async () => {
    const endpoint = getIpcEndpoint(DATA_DIR);
    const sock = await connectIpc(endpoint);
    const client = createRpcClient(sock);
    const res = await client.rpc('daemon.ping', {});
    console.log(JSON.stringify(res, null, 2));
    sock.destroy();
  });

daemonCmd
  .command('status')
  .description('Get daemon status')
  .action(async () => {
    const endpoint = getIpcEndpoint(DATA_DIR);
    const sock = await connectIpc(endpoint);
    const client = createRpcClient(sock);
    const res = await client.rpc('node.status', {});
    console.log(JSON.stringify(res, null, 2));
    sock.destroy();
  });

daemonCmd
  .command('shutdown')
  .description('Shutdown daemon')
  .action(async () => {
    const endpoint = getIpcEndpoint(DATA_DIR);
    const sock = await connectIpc(endpoint);
    const client = createRpcClient(sock);
    const res = await client.rpc('daemon.shutdown', {});
    console.log(JSON.stringify(res, null, 2));
    sock.destroy();
  });

daemonCmd
  .command('logs')
  .description('Show daemon logs (use --follow to stream)')
  .option('-n, --lines <lines>', 'Number of lines to show', '200')
  .option('-f, --follow', 'Follow log stream')
  .action(async (options) => {
    const endpoint = getIpcEndpoint(DATA_DIR);
    const sock = await connectIpc(endpoint);
    const client = createRpcClient(sock);

    const n = parseInt(options.lines, 10);
    const tail = await client.rpc('logs.tail', { lines: Number.isFinite(n) ? n : 200 });
    for (const line of tail) {
      console.log(line.message);
    }

    if (!options.follow) {
      sock.destroy();
      return;
    }

    await client.rpc('events.subscribe', { channels: ['log'] });
    client.onEvent((evt) => {
      if (evt?.event === 'log' && evt?.data?.message) {
        console.log(evt.data.message);
      }
    });
  });

// ============================================================================
// VIRTUAL FILESYSTEM (VFS)
// ============================================================================

const vdirCmd = program
  .command('vdir')
  .description('Manage virtual directories (VFS)');

vdirCmd
  .command('mkdir <vfsPath>')
  .description('Create a VFS directory (absolute path like /photos/vacation)')
  .action(wrapCommand(cmd.vdirMkdirCommand));

vdirCmd
  .command('ls [vfsPath]')
  .description('List entries in a VFS directory (default: /)')
  .action(wrapCommand(cmd.vdirLsCommand));

vdirCmd
  .command('add <paths...>')
  .description('Add local file(s) into a VFS directory (last arg is vfs dir path)')
  .option('--name <name>', 'Suggested display name (does not affect hashing)')
  .action(wrapCommand(cmd.vdirAddCommand));


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
      await swarmfs.close();
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
    void swarmfs.close();
    
    // Import and run REPL
    import('./repl.js');
  });

// ============================================================================
// PARSE AND RUN
// ============================================================================

program.parse();
