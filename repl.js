#!/usr/bin/env node

/**
 * SwarmFS REPL - Interactive shell
 * Keeps network connections alive and allows interactive commands
 */

import readline from 'readline';
import { SwarmFS } from './src/swarmfs.js';
import { getDataDir } from './src/config.js';
import * as cmd from './src/commands.js';

const DATA_DIR = getDataDir();
const swarmfs = new SwarmFS(DATA_DIR);

// Auto-initialize if needed
if (!swarmfs.isInitialized()) {
  console.log('Initializing SwarmFS...');
  swarmfs.init();
  console.log(`✓ Initialized at ${DATA_DIR}\n`);
}

// Create readline interface
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
    console.log('  add [path]              Add file or directory (default: current dir)');
    console.log('  status                  List tracked files');
    console.log('  verify <path>           Verify file integrity');
    console.log('  info <path>             Show file details');
    console.log('  stats                   Show storage statistics');
    console.log('\nTopic Management:');
    console.log('  topic create <n> [--no-auto-join]');
    console.log('  topic list              List all topics');
    console.log('  topic info <n>        Show topic details');
    console.log('  topic share <topic> <path>');
    console.log('  topic unshare <topic> <path>');
    console.log('  topic join <n>        Join topic (stays connected)');
    console.log('  topic leave <n>       Leave topic');
    console.log('\nNetwork:');
    console.log('  request <topic> <chunkHash>');
    console.log('  network                 Show network status');
    console.log('\nREPL:');
    console.log('  help                    Show this help');
    console.log('  clear                   Clear screen');
    console.log('  exit                    Exit REPL');
    console.log('');
    return;
  }
  
  if (cmdName === 'exit' || cmdName === 'quit') {
    console.log('\nGoodbye!');
    swarmfs.close();
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
    await executeCommand(line);
  }
  rl.prompt();
});

// Handle Ctrl+C gracefully
rl.on('SIGINT', () => {
  rl.question('\nAre you sure you want to exit? (y/n) ', (answer) => {
    if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
      console.log('\nShutting down...');
      swarmfs.close();
      process.exit(0);
    } else {
      rl.prompt();
    }
  });
});

// Handle close
rl.on('close', () => {
  console.log('\nGoodbye!');
  swarmfs.close();
  process.exit(0);
});

// Start the REPL
rl.prompt();
