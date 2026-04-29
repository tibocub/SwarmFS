#!/usr/bin/env node

/**
 * SwarmFS REPL - Interactive shell
 * Keeps network connections alive and allows interactive commands
 */

import readline from 'readline';
import terminalKit from 'terminal-kit';
import { SwarmFS } from './src/swarmfs.js';
import { getDataDir, getIdentityDir, getUserdbDir } from './src/config.js';
import * as cmd from './src/commands.js';
import { IdentityManager } from './src/identity/index.js';
import { UserDatabase } from './src/userdb/index.js';

process.env.SWARMFS_REPL = '1';

const term = terminalKit.terminal;
const DATA_DIR = getDataDir();
const swarmfs = new SwarmFS(DATA_DIR);

// Auto-initialize if needed
if (!swarmfs.isInitialized()) {
  console.log('Initializing SwarmFS...');
  swarmfs.init();
  console.log(`✓ Initialized at ${DATA_DIR}\n`);
}

// Helper to prompt for password BEFORE REPL starts (uses terminal-kit)
function promptPassword(promptText) {
  return new Promise((resolve) => {
    term(promptText);
    term.inputField({ echo: false }, (err, input) => {
      term('\n');
      resolve(input || '');
    });
  });
}

// Auto-login if identity exists (runs BEFORE REPL starts)
async function autoLogin() {
  const identityDir = getIdentityDir();
  const userdbPath = getUserdbDir();
  
  const identity = new IdentityManager({ identityDir });
  
  if (!identity.hasUserIdentity()) {
    return false;
  }
  
  console.log('Found existing identity.');
  
  // Try up to 3 times (initial + 2 retries)
  let attempts = 0;
  const maxAttempts = 3;
  
  while (attempts < maxAttempts) {
    const password = await promptPassword(attempts === 0 ? 'Password: ' : `Password (${attempts + 1}/${maxAttempts}): `);
    
    try {
      await identity.initUser(null, password);
      await identity.initDevice();
      
      // Use persisted isIndexer flag from device config
      const isIndexer = identity.isDeviceIndexer();
      console.log(`  Device role: ${isIndexer ? 'INDEXER' : 'NON-INDEXER'}`);
      
      const userdb = new UserDatabase({
        storagePath: userdbPath,
        identity,
        isIndexer
      });
      await userdb.ready();
      
      swarmfs.identity = identity;
      swarmfs.userdb = userdb;
      
      console.log(`✓ Logged in as ${identity.getUserId().slice(0, 16)}...`);
      console.log(`  Device: ${identity.deviceName}`);
      
      // Initialize network for user swarm
      if (!swarmfs.network) {
        const { loadConfig } = await import('./src/config.js');
        const { SwarmNetwork } = await import('./src/network.js');
        swarmfs.network = new SwarmNetwork(loadConfig().network || {});
      }
      
      // Non-indexer: set up listener BEFORE joining topic (event may fire during join)
      if (!isIndexer) {
        swarmfs.network.on('autobase-key-received', async ({ key, peerId }) => {
          console.log(`\n[NETWORK] Received autobase key from indexer`);
          try {
            await userdb.setAutobaseKey(key);
            console.log(`[NETWORK] Autobase created with received key`);
            
            // Join autobase discovery topic for replication
            if (userdb.autobase && userdb.autobase.discoveryKey) {
              await swarmfs.network.joinTopic('autobase-replication', userdb.autobase.discoveryKey);
              console.log(`[NETWORK] Joined autobase replication topic`);
            }
            
            console.log(`[NETWORK] Waiting for indexer to add us as writer...`);
          } catch (err) {
            console.log(`[NETWORK] Failed to create autobase: ${err.message}`);
          }
        });
      }
      
      // Join user topic for replication
      try {
        const topicKey = await swarmfs.network.joinUserTopic(identity, userdb);
        console.log(`  User swarm: ${topicKey.toString('hex').slice(0, 16)}...`);
      } catch (err) {
        console.log(`  User swarm: failed (${err.message})`);
      }
      
      // Indexer: Join autobase discovery topic after autobase is created
      if (isIndexer && userdb.autobase && userdb.autobase.discoveryKey) {
        try {
          await swarmfs.network.joinTopic('autobase-replication', userdb.autobase.discoveryKey);
          console.log(`  Autobase replication topic joined`);
        } catch (err) {
          console.log(`  Autobase topic: failed (${err.message})`);
        }
      }
      
      console.log('');
      return true;
    } catch (err) {
      attempts++;
      if (attempts < maxAttempts) {
        console.log(`✗ Wrong password, try again.\n`);
      } else {
        console.log(`✗ Login failed after ${maxAttempts} attempts.`);
        console.log('  Use "login" command to try again.\n');
        return false;
      }
    }
  }
  
  return false;
}

// Auto-join topics marked with auto_join flag
async function autoJoinTopics() {
  try {
    swarmfs.open();
    const topics = await swarmfs.db.getAutoJoinTopics();
    
    if (topics.length > 0) {
      console.log(`Auto-joining ${topics.length} topic(s)...\n`);
      
      for (const topic of topics) {
        try {
          await cmd.topicJoinCommand(swarmfs, topic.name);
          console.log('');
        } catch (error) {
          console.error(`  Error joining ${topic.name}:`, error.message);
        }
      }
      
      console.log('');
    }
  } catch (error) {
    console.error('Error during auto-join:', error.message);
  }
}

// Run startup sequence BEFORE creating REPL
async function startup() {
  await autoLogin();
  await autoJoinTopics();
  
  // NOW create the readline interface (after password prompts are done)
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'swarmfs> '
  });

  console.log('SwarmFS Interactive Shell');
  console.log('Type "help" for commands, "exit" to quit\n');
  
  // Command history
  const history = [];

  // Parse command line into args
  function parseArgs(line) {
    const args = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"' || char === "'") {
        inQuotes = !inQuotes;
      } else if (char === ' ' && !inQuotes) {
        if (current) {
          args.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
    
    if (current) {
      args.push(current);
    }
    
    return args;
  }

  // Execute command
  async function executeCommand(line) {
    const args = parseArgs(line.trim());
    if (args.length === 0) return;
    
    const [cmdName, ...cmdArgs] = args;
    
    // Built-in commands
    if (cmdName === 'help') {
      console.log('\nAvailable Commands:');
      console.log('\nFile Management:');
      console.log('  add [path]               Add file or directory (default: current dir)');
      console.log('  status                   List tracked files');
      console.log('  verify <path>            Verify file integrity');
      console.log('  info <path>              Show file details');
      console.log('  stats                    Show storage statistics');
      console.log('\nTopic Management:');
      console.log('  topic save <name> [-n --no-auto-join]');
      console.log('  topic list               List all topics');
      console.log('  topic info <topic>       Show topic details');
      console.log('  topic share <topic> <path>');
      console.log('  topic unshare <topic> <path>');
      console.log('  topic join <topic>       Join topic (stays connected)');
      console.log('  topic leave <topic>      Leave topic');
      console.log('\nNetwork:');
      console.log('  request <topic> <chunkHash>');
      console.log('  browse <topic>');
      console.log('  download <topic> <merkleRoot> <outputPath>');
      console.log('  network                  Show network status');
      console.log('\nIdentity:');
      console.log('  login                    Login with identity');
      console.log('  logout                   Logout');
      console.log('  whoami                   Show current identity');
      console.log('  devices                  List registered devices');
      console.log('\nVirtual Filesystem (VFS):');
      console.log('  vdir mkdir <vfsPath>');
      console.log('  vdir ls [vfsPath]');
      console.log('  vdir add <localPath...> <vfsDirPath> [--name]');
      console.log('\nREPL:');
      console.log('  help                     Show this help');
      console.log('  clear                    Clear screen');
      console.log('  exit                     Exit REPL');
      console.log('');
      return;
    }
    
    if (cmdName === 'exit' || cmdName === 'quit') {
      console.log('\nGoodbye!');
      await swarmfs.close();
      process.exit(0);
    }
    
    if (cmdName === 'clear') {
      console.clear();
      return;
    }
    
    // Handle topic subcommands
    let actualCmd = cmdName;
    let actualArgs = cmdArgs;
    
    if (cmdName === 'topic') {
      if (cmdArgs.length === 0) {
        console.error('Error: topic subcommand required (create, list, join, etc.)');
        return;
      }
      actualCmd = `topic.${cmdArgs[0]}`;
      actualArgs = cmdArgs.slice(1);
    }

    if (cmdName === 'vdir') {
      if (cmdArgs.length === 0) {
        console.error('Error: vdir subcommand required (mkdir, ls, add, etc.)');
        return;
      }
      actualCmd = `vdir.${cmdArgs[0]}`;
      actualArgs = cmdArgs.slice(1);
    }
    
    // Execute command from commands registry
    const commandFunc = cmd.getCommand(actualCmd);
    
    if (!commandFunc) {
      console.error(`Command not found: ${cmdName}`);
      console.log('Type "help" for available commands');
      return;
    }
    
    try {
      // Parse options (basic --flag support)
      const options = {};
      const positionalArgs = [];
      
      for (const arg of actualArgs) {
        if (arg.startsWith('--no-')) {
          const flag = arg.substring(5);
          options[flag] = false;
        } else if (arg.startsWith('--')) {
          const flag = arg.substring(2);
          options[flag] = true;
        } else {
          positionalArgs.push(arg);
        }
      }
      
      // Execute command
      await commandFunc(swarmfs, ...positionalArgs, options);
      
    } catch (error) {
      console.error(`Error: ${error.message}`);
      if (process.env.DEBUG) {
        console.error(error.stack);
      }
    }
  }

  // Handle line input
  rl.on('line', async (line) => {
    if (line.trim()) {
      history.push(line);
      try {
        await executeCommand(line);
      } finally {
        try {
          if (process.stdin && process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
            process.stdin.setRawMode(false);
          }
        } catch {
          // ignore
        }
        try {
          process.stdin.resume();
        } catch {
          // ignore
        }
        try {
          rl.resume();
        } catch {
          // ignore
        }
      }
    }
    rl.prompt();
  });

  // Handle Ctrl+C gracefully
  rl.on('SIGINT', () => {
    rl.question('\nAre you sure you want to exit? (y/n) ', (answer) => {
      if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
        console.log('\nShutting down...');
        void (async () => {
          await swarmfs.close();
          process.exit(0);
        })();
      } else {
        rl.prompt();
      }
    });
  });

  // Handle close
  rl.on('close', () => {
    console.log('\nGoodbye!');
    void (async () => {
      await swarmfs.close();
      process.exit(0);
    })();
  });

  // Start the REPL
  rl.prompt();
}

startup();
