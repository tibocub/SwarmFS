/**
 * Command implementations for SwarmFS
 * These can be called from CLI or REPL
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import terminalKit from 'terminal-kit'
import readline from 'readline'
import { VFS } from './vfs.js'
import { IdentityManager } from './identity/index.js'
import { UserDatabase } from './userdb/index.js'
import { SwarmNetwork } from './network.js'
import { getIdentityDir, getUserdbDir } from './config.js'

const term = terminalKit.terminal;

function restoreTerminal() {
  try {
    if (typeof term.grabInput === 'function') {
      term.grabInput(false);
    }
  } catch {
    // ignore
  }

  try {
    if (typeof term.styleReset === 'function') {
      term.styleReset();
    }
  } catch {
    // ignore
  }

  try {
    if (process.stdin?.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false);
    }
  } catch {
    // ignore
  }

  try {
    if (process.stdin && typeof process.stdin.pause === 'function') {
      process.stdin.pause();
    }
  } catch {
    // ignore
  }
}

function nowNs() {
  return process.hrtime.bigint()
}

function getVfs(swarmfs) {
  if (!swarmfs?.db) {
    swarmfs.open();
  }
  return new VFS(swarmfs.db);
}

function isInteractivePromptAvailable() {
  return !!(process.stdin?.isTTY && process.stdout?.isTTY && typeof term.inputField === 'function');
}

/**
 * Prompt for password - uses readline in REPL mode, terminal-kit in CLI mode
 * This avoids terminal-kit escape code issues when running in the REPL
 */
async function promptPassword(promptText) {
  if (process.env.SWARMFS_REPL === '1') {
    // In REPL mode, we need to work with the existing readline
    // The REPL's readline interface is controlling stdin, so we need to pause it
    return new Promise((resolve) => {
      process.stdout.write(promptText);
      
      // Store current raw mode state
      const wasRaw = process.stdin.isRaw;
      
      // Pause any existing readline to release stdin
      process.stdin.pause();
      
      // Enable raw mode for hidden input
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      
      let input = '';
      
      const onData = (char) => {
        const c = char.toString('utf8');
        if (c === '\n' || c === '\r' || c === '\u0004') {
          // Done - restore state
          process.stdin.off('data', onData);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(wasRaw || false);
          }
          process.stdout.write('\n');
          process.stdin.resume();
          resolve(input);
        } else if (c === '\u0003') {
          // Ctrl-C
          process.stdin.off('data', onData);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(wasRaw || false);
          }
          process.stdout.write('\n');
          process.exit();
        } else if (c === '\u007f' || c === '\b') {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (c.charCodeAt(0) >= 32) {
          // Printable characters only
          input += c;
          process.stdout.write('*');
        }
      };
      
      process.stdin.on('data', onData);
      process.stdin.resume();
    });
  } else {
    // Use terminal-kit in CLI mode
    return new Promise((resolve) => {
      term(promptText);
      term.inputField({ echo: false }, (err, input) => {
        term('\n');
        restoreTerminal();
        resolve(input || '');
      });
    });
  }
}

async function promptTrackMissingFile(localPath) {
  if (!isInteractivePromptAvailable()) {
    throw new Error(`Local file not tracked: ${localPath}`);
  }

  const promptText = `${localPath} is not tracked. Track it? [Y] Yes  [A] Yes to All  [N] No  [L] No to All `;
  try {
    const choice = await new Promise((resolve) => {
      term(promptText);
      term.inputField({ echo: true, maxLength: 1 }, (err, input) => {
        term('\n');
        if (err) {
          resolve('n');
          return;
        }
        resolve(String(input || '').trim().toLowerCase());
      });
    });

    if (choice === 'y' || choice === 'a' || choice === 'n' || choice === 'l') {
      return choice;
    }
    return 'n';
  } finally {
    restoreTerminal();
  }
}

export async function vdirMkdirCommand(swarmfs, vfsPath) {
  const vfs = getVfs(swarmfs);
  const dir = vfs.mkdir(vfsPath);
  console.log(dir?.name === '/' ? '/' : (String(vfsPath || '').startsWith('/') ? vfsPath : `/${vfsPath}`));
  return dir;
}

export async function vdirLsCommand(swarmfs, vfsPath = '/') {
  const vfs = getVfs(swarmfs);
  const effectivePath = typeof vfsPath === 'string' && vfsPath.length > 0 ? vfsPath : '/';
  const { dirs, entries } = vfs.ls(effectivePath);

  const hasDirs = Array.isArray(dirs) && dirs.length > 0;
  const hasEntries = Array.isArray(entries) && entries.length > 0;
  if (!hasDirs && !hasEntries) {
    console.log('');
    return { dirs: dirs ?? [], entries: entries ?? [] };
  }

  if (hasDirs) {
    for (const d of dirs) {
      if (d?.is_root === 1) continue;
      console.log(`${d.name}/`);
    }
  }

  if (hasEntries) {
    for (const e of entries) {
      const name = typeof e.suggested_name === 'string' && e.suggested_name.length > 0
        ? e.suggested_name
        : (typeof e.child_merkle_root === 'string' ? e.child_merkle_root : '');
      console.log(name);
    }
  }
  return { dirs, entries };
}

export async function vdirAddCommand(swarmfs, ...args) {
  swarmfs.open();

  // Commander passes (pathsArray, options)
  // REPL passes (arg1, arg2, ..., options)
  let options = {};
  let raw = args;

  // Commander also passes the Command object as the last argument.
  // It has methods like .opts() and properties like .commands.
  if (
    raw.length > 0
    && raw[raw.length - 1]
    && typeof raw[raw.length - 1] === 'object'
    && typeof raw[raw.length - 1].opts === 'function'
  ) {
    raw = raw.slice(0, -1);
  }

  if (
    raw.length > 0
    && raw[raw.length - 1]
    && typeof raw[raw.length - 1] === 'object'
    && !Array.isArray(raw[raw.length - 1])
  ) {
    options = raw[raw.length - 1];
    raw = raw.slice(0, -1);
  }

  // Commander: first arg is an array of all <paths...> including the vfs dir path as last element.
  // REPL: args is already flat.
  const flat = raw.length === 1 && Array.isArray(raw[0]) ? raw[0] : raw;
  const filtered = flat.filter((v) => typeof v === 'string' && v.length > 0);

  if (filtered.length < 2) {
    throw new Error('Usage: vdir add <localPath...> <vfsDirPath>')
  }

  const vfsDirPath = filtered[filtered.length - 1];
  const localPaths = filtered.slice(0, -1);

  const vfs = getVfs(swarmfs);
  const results = [];

  let trackAll = null; // null = ask, true = yes to all, false = no to all
  for (const localPath of localPaths) {
    const absoluteLocal = path.resolve(localPath);
    const suggestedName = typeof options.name === 'string' && options.name.length > 0
      ? options.name
      : path.basename(absoluteLocal);

    let fileInfo = swarmfs.db.getFile(absoluteLocal);
    if (!fileInfo) {
      let shouldTrack = false;
      if (trackAll === true) {
        shouldTrack = true;
      } else if (trackAll === false) {
        shouldTrack = false;
      } else {
        const choice = await promptTrackMissingFile(absoluteLocal);
        if (choice === 'a') {
          trackAll = true;
          shouldTrack = true;
        } else if (choice === 'l') {
          trackAll = false;
          shouldTrack = false;
        } else {
          shouldTrack = choice === 'y';
        }
      }

      if (shouldTrack) {
        await addOnePath(swarmfs, absoluteLocal);
        fileInfo = swarmfs.db.getFile(absoluteLocal);
      }
    }

    if (!fileInfo) {
      results.push({ skipped: true, reason: 'not_tracked', localPath: absoluteLocal });
      continue;
    }

    const result = await vfs.addFile(vfsDirPath, absoluteLocal, suggestedName);
    if (result?.file?.merkle_root) {
      console.log(result.file.merkle_root);
    }
    results.push(result);
  }

  return results.length === 1 ? results[0] : results;
}

/**
 * Share a vdir in a topic - outputs the merkle root for sharing
 */
export async function vdirShareCommand(swarmfs, topicName, vfsPath) {
  swarmfs.open();
  const vfs = getVfs(swarmfs);
  
  // Check topic exists
  const topic = swarmfs.db.getTopic(topicName);
  if (!topic) {
    throw new Error(`Topic "${topicName}" not found. Create it first with "topic create ${topicName}"`);
  }
  
  const vdir = vfs.resolvePath(vfsPath || '/');
  if (!vdir) {
    throw new Error(`Vdir not found: ${vfsPath}`);
  }

  // Ensure merkle root is calculated
  if (!vdir.merkle_root) {
    await vfs.updateVdirMerkleRoot(vdir.id);
    // Re-fetch to get updated merkle_root
    const updated = vfs.db.getVdirById(vdir.id);
    if (updated) {
      vdir.merkle_root = updated.merkle_root;
    }
  }

  if (!vdir.merkle_root) {
    throw new Error('Vdir is empty - add files before sharing');
  }

  // Add to topic_shares
  swarmfs.db.addTopicShare(topic.id, 'vdir', vdir.id, vdir.merkle_root);

  console.log('✓ Vdir shared successfully');
  console.log(`  Topic: ${topicName}`);
  console.log(`  VFS Path: ${vfsPath || '/'}`);
  console.log(`  Merkle Root: ${vdir.merkle_root}`);
  
  return vdir;
}

/**
 * Show vdir info including merkle root and children
 */
export async function vdirInfoCommand(swarmfs, vfsPath) {
  swarmfs.open();
  const vfs = getVfs(swarmfs);
  
  const vdir = vfs.resolvePath(vfsPath || '/');
  if (!vdir) {
    throw new Error(`Vdir not found: ${vfsPath}`);
  }

  // Ensure merkle root is calculated
  if (!vdir.merkle_root) {
    await vfs.updateVdirMerkleRoot(vdir.id);
    const updated = vfs.db.getVdirById(vdir.id);
    if (updated) {
      vdir.merkle_root = updated.merkle_root;
    }
  }

  console.log(`Name: ${vdir.name}`);
  console.log(`UUID: ${vdir.id}`);
  console.log(`Merkle Root: ${vdir.merkle_root || '(empty)'}`);
  console.log(`Parent: ${vdir.parent_id || '(root)'}`);
  
  const { dirs, entries } = vfs.ls(vfsPath || '/');
  console.log(`Subdirectories: ${dirs?.length || 0}`);
  console.log(`Files: ${entries?.length || 0}`);

  return vdir;
}

/**
 * Repair vdir entries for existing vdirs created before the fix
 */
export async function vdirRepairCommand(swarmfs) {
  swarmfs.open();
  const vfs = getVfs(swarmfs);
  
  const repaired = vfs.repairVdirEntries();
  
  if (repaired > 0) {
    console.log(`Repaired ${repaired} missing vdir entries.`);
    console.log('Run "vdir share" again to calculate merkle roots.');
  } else {
    console.log('No repairs needed - all vdir entries are correct.');
  }
  
  return repaired;
}


export async function resumeCommand(swarmfs, topicName, options = {}) {
  swarmfs.open();

  const all = !!options.all;
  const downloads = all
    ? swarmfs.db.getIncompleteDownloads()
    : swarmfs.db.getIncompleteDownloads(topicName);

  if (!downloads || downloads.length === 0) {
    console.log('No incomplete downloads found.');
    return [];
  }

  const enableProgressBar = process.stdout.isTTY && process.env.SWARMFS_REPL !== '1';

  const results = [];
  for (const d of downloads) {
    const t = d.topic_name;
    const root = d.merkle_root;
    const out = d.output_path;

    console.log(`\nResuming download from topic "${t}"...`);
    console.log(`Merkle Root: ${root}`);
    console.log(`Output: ${out}\n`);

    if (!swarmfs.network || !swarmfs.protocol) {
      console.log(`Joining topic "${t}"...`);
      await swarmfs.joinTopic(t);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    let progressBar = null;
    let totalChunks = 0;
    let downloadedChunks = 0;
    let initializedItems = false;
    let lastDownloadedChunks = 0;

    if (enableProgressBar) {
      progressBar = term.progressBar({
        title: 'File download',
        width: Math.min(60, (term.width || 80) - 20),
        percent: true,
        eta: true
      });
      progressBar.update(0);
    }

    const start = nowNs();
    try {
      const result = await swarmfs.downloadFile(t, root, out, {
        onProgress: (info) => {
          if (!progressBar) {
            return;
          }

          if (typeof info.totalChunks === 'number') {
            totalChunks = info.totalChunks;
          }
          if (typeof info.downloadedChunks === 'number') {
            downloadedChunks = info.downloadedChunks;
          }

          if (!initializedItems && totalChunks > 0) {
            initializedItems = true;
            progressBar.update({ items: totalChunks, progress: 0 });
          }

          if (initializedItems) {
            progressBar.update({
              progress: totalChunks > 0 ? Math.min(1, downloadedChunks / totalChunks) : 0,
              items: totalChunks
            });

            const delta = downloadedChunks - lastDownloadedChunks;
            if (delta > 0) {
              for (let i = 0; i < delta; i++) {
                progressBar.itemDone();
              }
              lastDownloadedChunks = downloadedChunks;
            }
          } else {
            const pct = totalChunks > 0 ? Math.min(1, downloadedChunks / totalChunks) : 0;
            progressBar.update(pct);
          }
        }
      });

      const ms = elapsedMs(start);

      if (progressBar) {
        progressBar.update(1);
        if (typeof progressBar.stop === 'function') {
          progressBar.stop();
        }
        term('\n');
      }

      const mbps = formatMbps(result.size, ms);
      console.log(`\n✅ File downloaded successfully!`);
      console.log(`  Path: ${result.path}`);
      console.log(`  Size: ${formatBytes(result.size)}`);
      console.log(`  Chunks: ${result.totalChunks}`);
      console.log(`  Time: ${formatSeconds(ms)}s${mbps ? ` (${mbps} MiB/s)` : ''}`);

      results.push(result);
    } catch (err) {
      if (progressBar) {
        if (typeof progressBar.stop === 'function') {
          progressBar.stop();
        }
        term('\n');
      }
      console.error(`\n❌ Resume failed: ${err.message}`);
      throw err;
    }
  }

  return results;
}

function elapsedMs(startNs) {
  return Number(nowNs() - startNs) / 1e6
}

function formatSeconds(ms) {
  return (ms / 1000).toFixed(3)
}

function formatMbps(bytes, ms) {
  if (!Number.isFinite(bytes) || !Number.isFinite(ms) || ms <= 0) {
    return null
  }
  const mb = bytes / (1024 * 1024)
  const sec = ms / 1000
  return (mb / sec).toFixed(2)
}


// Utility functions
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Browse shared files and vdirs in a topic
 */
export async function browseCommand(swarmfs, topicName, options = {}) {
  swarmfs.open();

  if (!swarmfs.network || !swarmfs.protocol) {
    console.log(`Joining topic "${topicName}"...`);
    await swarmfs.joinTopic(topicName);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`\nBrowsing topic "${topicName}"...`);
  const items = await swarmfs.browseTopic(topicName, options.timeout || 5000);

  if (items.length === 0) {
    console.log('No shared content found.');
    return items;
  }

  // Separate by type
  const files = items.filter(i => i.type === 'file');
  const vdirs = items.filter(i => i.type === 'vdir');
  const dirs = items.filter(i => i.type === 'directory');

  if (vdirs.length > 0) {
    console.log(`\nVirtual Directories (${vdirs.length}):\n`);
    vdirs.forEach((vdir) => {
      console.log(`  ${vdir.name}/`);
      console.log(`    Merkle Root: ${vdir.merkleRoot}`);
      console.log(`    Children: ${vdir.childCount}`);
      console.log('');
    });
  }

  if (dirs.length > 0) {
    console.log(`\nDirectories (${dirs.length}):\n`);
    dirs.forEach((dir) => {
      console.log(`  ${dir.name}/`);
      console.log(`    Merkle Root: ${dir.merkleRoot}`);
      console.log(`    Size: ${formatBytes(dir.size)}`);
      console.log('');
    });
  }

  if (files.length > 0) {
    console.log(`\nFiles (${files.length}):\n`);
    files.forEach((file) => {
      console.log(`  ${file.name}`);
      console.log(`    Size: ${formatBytes(file.size)}`);
      console.log(`    Merkle Root: ${file.merkleRoot}`);
      console.log('');
    });
  }

  return items;
}

export function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString();
}

// ============================================================================
// FILE COMMANDS
// ============================================================================

function normalizeManyArgs(first, rest) {
  if (Array.isArray(first)) {
    return rest.length > 0 ? [...first, ...rest] : first;
  }
  if (typeof first === 'string' && first.length > 0) {
    return [first, ...rest];
  }
  return rest;
}

async function addOnePath(swarmfs, absolutePath) {
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Path not found: ${absolutePath}`);
  }

  const stats = fs.statSync(absolutePath);

  if (stats.isDirectory()) {
    console.log(`Adding directory: ${absolutePath}\n`);
    const start = nowNs();
    const result = await swarmfs.addDirectory(absolutePath);
    const ms = elapsedMs(start);

    console.log('\n✓ Directory added successfully');
    console.log(`  Path: ${result.path}`);
    console.log(`  Files: ${result.filesAdded}/${result.totalFiles}`);
    console.log(`  Directories: ${result.directories}`);
    console.log(`  Total Size: ${formatBytes(result.totalSize)}`);
    console.log(`  Merkle Root: ${result.merkleRoot}`);

    const mbps = formatMbps(result.totalSize, ms);
    console.log(`  Time: ${formatSeconds(ms)}s${mbps ? ` (${mbps} MiB/s)` : ''}`);

    return result;
  }

  if (stats.isFile()) {
    console.log(`Adding file: ${absolutePath}`);
    const start = nowNs();
    const result = await swarmfs.addFile(absolutePath);
    const ms = elapsedMs(start);

    console.log('✓ File added successfully');
    console.log(`  Path: ${result.path}`);
    console.log(`  Size: ${formatBytes(result.size)}`);
    console.log(`  Chunks: ${result.chunks}`);
    console.log(`  Merkle Root: ${result.merkleRoot}`);

    const mbps = formatMbps(result.size, ms);
    console.log(`  Time: ${formatSeconds(ms)}s${mbps ? ` (${mbps} MiB/s)` : ''}`);

    return result;
  }

  throw new Error('Not a file or directory');
}

export async function addCommand(swarmfs, targetPath, ...rest) {
  const raw = normalizeManyArgs(targetPath, rest);
  const paths = raw.filter((v) => typeof v === 'string' && v.length > 0);
  const effectivePaths = paths.length > 0 ? paths : ['.'];

  swarmfs.open();

  const results = [];
  for (const p of effectivePaths) {
    const absolutePath = path.resolve(p);
    results.push(await addOnePath(swarmfs, absolutePath));
  }
  return results.length === 1 ? results[0] : results;
}

export async function rmCommand(swarmfs, targetPath, ...rest) {
  const raw = normalizeManyArgs(targetPath, rest);
  const paths = raw.filter((v) => typeof v === 'string' && v.length > 0);
  if (!paths || paths.length === 0) {
    throw new Error('No paths provided');
  }

  swarmfs.open();

  const results = [];
  for (const p of paths) {
    const absolutePath = path.resolve(p);
    const file = swarmfs.db.getFile(absolutePath);
    const directory = swarmfs.db.getDirectory(absolutePath);

    if (!file && !directory) {
      console.log(`Not tracked: ${absolutePath}`);
      results.push({ path: absolutePath, removed: false, reason: 'not_tracked' });
      continue;
    }

    swarmfs.db.removeTopicSharesByPath(absolutePath);
    if (file) {
      swarmfs.removeFile(absolutePath);
      console.log(`✓ Removed file metadata: ${absolutePath}`);
    } else {
      swarmfs.removeDirectory(absolutePath);
      console.log(`✓ Removed directory metadata: ${absolutePath}`);
    }

    results.push({ path: absolutePath, removed: true, type: file ? 'file' : 'directory' });
  }

  return results;
}

export async function statusCommand(swarmfs) {
  swarmfs.open();

  const files = swarmfs.listFiles();
  
  if (files.length === 0) {
    console.log('No files tracked yet.');
    console.log('Use "add <path>" to add files.');
    return;
  }

  // Group files by merkle_root
  const byMerkleRoot = new Map();
  for (const file of files) {
    const root = file.merkle_root;
    if (!byMerkleRoot.has(root)) {
      byMerkleRoot.set(root, []);
    }
    byMerkleRoot.get(root).push(file);
  }

  const uniqueContent = byMerkleRoot.size;
  console.log(`\nTracked Content (${uniqueContent} unique, ${files.length} paths):\n`);
  
  // Sort by first added date of each group
  const sortedRoots = [...byMerkleRoot.entries()].sort((a, b) => {
    const aFirst = Math.min(...a[1].map(f => f.added_at));
    const bFirst = Math.min(...b[1].map(f => f.added_at));
    return bFirst - aFirst;
  });
  
  for (const [merkleRoot, paths] of sortedRoots) {
    const representative = paths[0];
    console.log(`  Merkle Root: ${merkleRoot.substring(0, 16)}...`);
    console.log(`    Size: ${formatBytes(representative.size)}`);
    console.log(`    Chunks: ${representative.chunk_count}`);
    
    if (paths.length === 1) {
      console.log(`    Path: ${paths[0].path}`);
    } else {
      console.log(`    Paths (${paths.length}):`);
      for (const p of paths) {
        console.log(`      - ${p.path}`);
      }
    }
    console.log('');
  }
}

export async function verifyCommand(swarmfs, filePath) {
  swarmfs.open();

  console.log(`Verifying: ${filePath}`);
  const result = await swarmfs.verifyFile(filePath, { useParallel: false });

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
  
  return result;
}

export async function topicSaveCommand(swarmfs, name, passwordArg, optionsArg) {
  swarmfs.open();

  // Commander action signature for: command('save <name> [password]')
  // is typically: (name, password, options, command)
  const positionalPassword = typeof passwordArg === 'string' && passwordArg.length > 0
    ? passwordArg
    : null;

  const opts = (typeof optionsArg === 'object' && optionsArg !== null)
    ? optionsArg
    : (typeof passwordArg === 'object' && passwordArg !== null ? passwordArg : {});

  const autoJoin = opts.autoJoin !== false;
  const flagPassword = opts.password;

  let password = null;
  if (typeof positionalPassword === 'string' && positionalPassword.length > 0) {
    if (typeof flagPassword !== 'undefined') {
      throw new Error('Provide either a positional password or --password, not both')
    }
    password = positionalPassword;
  } else if (typeof flagPassword === 'string' && flagPassword.length > 0) {
    password = flagPassword;
  } else if (flagPassword === true) {
    const canPrompt = process.stdin?.isTTY && process.stdout?.isTTY && typeof term.inputField === 'function';
    if (!canPrompt) {
      throw new Error('Cannot prompt for password in non-interactive mode. Provide it as --password <password>.')
    }

    try {
      password = await new Promise((resolve, reject) => {
        term('Password: ');
        term.inputField({ echo: false }, (err, input) => {
          term('\n');
          if (err) {
            reject(err);
            return;
          }
          resolve(String(input || ''));
        });
      });
    } finally {
      restoreTerminal();
    }

    if (!password) {
      throw new Error('Password cannot be empty')
    }
  }

  const result = await swarmfs.createTopic(name, autoJoin, password);

  console.log('✓ Topic saved');
  console.log(`  Name: ${result.name}`);
  console.log(`  Topic Key: ${result.topicKey}`);
  console.log(`  Auto-join: ${result.autoJoin ? 'yes' : 'no'}`);

  return result;
}

export async function infoCommand(swarmfs, filePath) {
  swarmfs.open();

  const info = swarmfs.getFileInfo(filePath);

  if (!info) {
    console.log(`File not tracked: ${filePath}`);
    console.log('Use "add <path>" to add it.');
    return null;
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
      console.log(`    ${i}: ${chunk.chunk_hash.substring(0, 16)}... (${formatBytes(chunk.chunk_size)})`);
    });
  }
  
  return info;
}

export async function statsCommand(swarmfs) {
  swarmfs.open();

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
  
  return stats;
}

// ============================================================================
// TOPIC COMMANDS
// ============================================================================

export async function topicCreateCommand(swarmfs, name, options = {}) {
  swarmfs.open();

  const autoJoin = options.autoJoin !== false;
  const result = await swarmfs.createTopic(name, autoJoin);
  
  console.log('✓ Topic created');
  console.log(`  Name: ${result.name}`);
  console.log(`  Topic Key: ${result.topicKey}`);
  console.log(`  Auto-join: ${result.autoJoin ? 'yes' : 'no'}`);
  
  return result;
}

export async function topicListCommand(swarmfs) {
  swarmfs.open();

  const topics = await swarmfs.listTopics();
  
  if (topics.length === 0) {
    console.log('No topics created yet.');
    console.log('Use "topic save <name>" to save a topic.');
    return [];
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
  
  return topics;
}

export async function topicInfoCommand(swarmfs, name) {
  swarmfs.open();

  const info = await swarmfs.getTopicInfo(name);
  
  if (!info) {
    console.log(`Topic not found: ${name}`);
    return null;
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
  
  return info;
}

export async function topicShareCommand(swarmfs, topicName, sharePath) {
  swarmfs.open();

  const result = await swarmfs.sharePath(topicName, sharePath);
  
  console.log('✓ Shared successfully');
  console.log(`  Topic: ${topicName}`);
  console.log(`  Path: ${result.path}`);
  console.log(`  Type: ${result.type}`);
  console.log(`  Merkle Root: ${result.merkleRoot}`);
  
  return result;
}

export async function topicUnshareCommand(swarmfs, topicName, sharePath) {
  swarmfs.open();

  await swarmfs.unsharePath(topicName, sharePath);
  console.log(`✓ Stopped sharing ${sharePath} in ${topicName}`);
}

export async function topicJoinCommand(swarmfs, name, options = {}) {
  swarmfs.open();

  await swarmfs.joinTopic(name);
  console.log(`✓ Joined topic: ${name}`);
  console.log('  Discovering peers...');
  
  // Return network stats if available
  if (swarmfs.network) {
    return swarmfs.network.getStats();
  }
}

export async function topicLeaveCommand(swarmfs, name) {
  swarmfs.open();

  await swarmfs.leaveTopic(name);
  console.log(`✓ Left topic: ${name}`);
}

export async function topicRmCommand(swarmfs, name) {
  swarmfs.open();

  const topic = swarmfs.db.getTopic(name);
  if (!topic) {
    console.log(`Topic not found: ${name}`);
    return { removed: false };
  }

  const result = await swarmfs.deleteTopic(name);
  if (result && result.changes > 0) {
    console.log(`✓ Removed topic: ${name}`);
    return { removed: true };
  }

  console.log(`Topic not removed: ${name}`);
  return { removed: false };
}

export async function topicAutojoinCommand(swarmfs, topicName, ...rest) {
  const raw = normalizeManyArgs(topicName, rest);
  const names = raw.filter((v) => typeof v === 'string' && v.length > 0);
  const options = raw.find((v) => v && typeof v === 'object' && !Array.isArray(v) && (
    v.y === true || v.yes === true || v.n === true || v.no === true || v.disable === true
  )) || {};
  if (!names || names.length === 0) {
    throw new Error('No topics provided');
  }

  const enable = options.y === true || options.yes === true;
  const disable = options.n === true || options.no === true || options.disable === true;

  if ((enable && disable) || (!enable && !disable)) {
    throw new Error('Specify exactly one of -y or -n');
  }

  swarmfs.open();

  await swarmfs.setTopicsAutoJoin(names, enable);
  console.log(`✓ Updated auto-join (${enable ? 'enabled' : 'disabled'}): ${names.join(', ')}`);
  return { names, autoJoin: enable };
}

export async function shareCommand(swarmfs, topicName, paths, options = {}) {
  const files = Array.isArray(paths) ? paths : normalizeManyArgs(paths, []);
  const fileArgs = files.filter((v) => typeof v === 'string' && v.length > 0);

  if (typeof topicName !== 'string' || topicName.length === 0) {
    throw new Error('Usage: share <topic> <file1> [file2...]');
  }
  if (fileArgs.length === 0) {
    throw new Error('Usage: share <topic> <file1> [file2...]');
  }

  swarmfs.open();

  const missing = [];
  for (const f of fileArgs) {
    const absolutePath = path.resolve(f);
    const trackedFile = swarmfs.db.getFile(absolutePath);
    const trackedDir = swarmfs.db.getDirectory(absolutePath);
    if (!trackedFile && !trackedDir) {
      missing.push(f);
    }
  }

  if (missing.length > 0) {
    const promptText = `${missing.join(', ')} not added yet to SwarmFS. Add files and proceed sharing ${missing.join(', ')} ? [Y/n] `;

    const shouldPrompt = process.stdin?.isTTY && process.stdout?.isTTY && typeof term.yesOrNo === 'function';
    let proceed = false;

    if (shouldPrompt) {
      proceed = await new Promise((resolve) => {
        term(promptText);
        term.yesOrNo({ yes: ['y', 'ENTER'], no: ['n'] }, (err, result) => {
          if (err) {
            resolve(false);
            return;
          }
          resolve(!!result);
        });
      });
      term('\n');
    }

    if (!proceed) {
      throw new Error(`${missing.join(', ')} not added yet to SwarmFS`);
    }

    for (const f of missing) {
      const absolutePath = path.resolve(f);
      await addOnePath(swarmfs, absolutePath);
    }
  }

  const results = [];
  for (const f of fileArgs) {
    try {
      const result = await swarmfs.sharePath(topicName, f);
      console.log('✓ Shared successfully');
      console.log(`  Topic: ${topicName}`);
      console.log(`  Path: ${result.path}`);
      results.push({ topic: topicName, path: result.path, merkleRoot: result.merkleRoot });
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (msg.includes('Path not tracked:')) {
        throw new Error(msg);
      }
      throw e;
    }
  }

  return results;
}

// ============================================================================
// NETWORK COMMANDS
// ============================================================================

export async function requestCommand(swarmfs, topicName, chunkHash, options = {}) {
  // Validate hash format
  if (!/^[0-9a-f]{64}$/i.test(chunkHash)) {
    throw new Error('Invalid chunk hash (must be 64 hex characters)');
  }

  swarmfs.open();

  // Auto-join topic if not connected
  if (!swarmfs.network || !swarmfs.protocol) {
    console.log(`Joining topic "${topicName}"...`);
    await swarmfs.joinTopic(topicName);
    // Give it a moment to connect
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`\nRequesting chunk from topic "${topicName}"...`);
  console.log(`Chunk hash: ${chunkHash}\n`);

  const requestId = await swarmfs.requestChunk(topicName, chunkHash);
  console.log(`Request ID: ${requestId.substring(0, 16)}...`);
  console.log('\nWaiting for offers...\n');

  if (!process.stdout.isTTY || !swarmfs.protocol) {
    return { requestId };
  }

  const enableProgressBar = process.stdout.isTTY && process.env.SWARMFS_REPL !== '1';
  let progressBar = null;
  let lastPct = -1;

  if (enableProgressBar) {
    progressBar = term.progressBar({
      title: 'Chunk download',
      width: Math.min(60, (term.width || 80) - 20),
      percent: true
    });
    progressBar.update(0);
  }

  const cleanup = () => {
    swarmfs.protocol.off('chunk:download-started', onStart);
    swarmfs.protocol.off('chunk:progress', onProgress);
    swarmfs.protocol.off('chunk:downloaded', onDone);
    swarmfs.protocol.off('chunk:timeout', onTimeout);
    swarmfs.protocol.off('chunk:error', onError);
  };

  const onStart = (info) => {
    if (!progressBar || info.requestId !== requestId) {
      return;
    }
    progressBar.update(0);
  };

  const onProgress = (info) => {
    if (info.requestId !== requestId) {
      return;
    }
    if (!progressBar) {
      return;
    }
    const pct = info.total > 0 ? Math.min(1, info.current / info.total) : 0;
    const pctInt = Math.floor(pct * 100);
    if (pctInt !== lastPct) {
      lastPct = pctInt;
      progressBar.update(pct);
    }
  };

  const stopProgressBar = () => {
    if (!progressBar) {
      return;
    }
    progressBar.update(1);
    if (typeof progressBar.stop === 'function') {
      progressBar.stop();
    }
    term('\n');
  };

  const onDone = (info) => {
    if (info.requestId !== requestId) {
      return;
    }
    stopProgressBar();
    cleanup();
  };

  const onTimeout = (info) => {
    if (info.requestId !== requestId) {
      return;
    }
    stopProgressBar();
    cleanup();
  };

  const onError = (info) => {
    if (info.requestId !== requestId) {
      return;
    }
    stopProgressBar();
    cleanup();
  };

  swarmfs.protocol.on('chunk:download-started', onStart);
  swarmfs.protocol.on('chunk:progress', onProgress);
  swarmfs.protocol.on('chunk:downloaded', onDone);
  swarmfs.protocol.on('chunk:timeout', onTimeout);
  swarmfs.protocol.on('chunk:error', onError);

  return { requestId };
}

/**
 * Download a file or vdir by merkle root
 */
export async function downloadCommand(swarmfs, topicName, merkleRoot, outputPath, options = {}) {
  swarmfs.open();

  // Auto-join topic if not connected
  if (!swarmfs.network || !swarmfs.protocol) {
    console.log(`Joining topic "${topicName}"...`);
    await swarmfs.joinTopic(topicName);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`\nDownloading from topic "${topicName}"...`);
  console.log(`Merkle Root: ${merkleRoot}`);
  console.log(`Output: ${outputPath}\n`);

  // First, request metadata to determine type
  const metadata = await swarmfs.requestMetadata(topicName, merkleRoot);

  if (metadata.type === 'vdir') {
    // Download vdir recursively
    console.log(`Type: Virtual Directory (${metadata.children?.length || 0} children)\n`);

    const result = await swarmfs.downloadVdir(topicName, merkleRoot, outputPath, {
      onItemStart: (info) => {
        if (info.type === 'file') {
          console.log(`  Downloading: ${info.name} (${formatBytes(info.size)})`);
        } else {
          console.log(`\n📁 ${info.name}/`);
        }
      },
      onItemComplete: (info) => {
        if (info.type === 'file') {
          console.log(`  ✓ ${info.name} (${formatBytes(info.size)})`);
        }
      }
    });

    console.log(`\n✅ Vdir downloaded successfully!`);
    console.log(`  Path: ${result.path}`);
    console.log(`  Files: ${result.files}`);
    console.log(`  Subdirectories: ${result.vdirs}`);
    console.log(`  Total Size: ${formatBytes(result.totalSize)}`);
    console.log(`  Total Chunks: ${result.totalChunks}`);

    return result;
  }

  // Download single file
  console.log(`Type: File\n`);

  const enableProgressBar = process.stdout.isTTY && process.env.SWARMFS_REPL !== '1';
  let progressBar = null;
  let totalChunks = 0;
  let downloadedChunks = 0;
  let initializedItems = false;
  let lastDownloadedChunks = 0;

  if (enableProgressBar) {
    progressBar = term.progressBar({
      title: 'File download',
      width: Math.min(60, (term.width || 80) - 20),
      percent: true,
      eta: true
    });
    progressBar.update(0);
  }

  try {
    const start = nowNs()
    const result = await swarmfs.downloadFile(topicName, merkleRoot, outputPath, {
      onProgress: (info) => {
        if (!progressBar) {
          if (typeof info.totalChunks === 'number' && typeof info.downloadedChunks === 'number') {
            if (info.totalChunks > 0 && (info.downloadedChunks === info.totalChunks || info.downloadedChunks % 50 === 0)) {
              console.log(`Progress: ${info.downloadedChunks}/${info.totalChunks}`);
            }
          }
          return;
        }

        if (typeof info.totalChunks === 'number') {
          totalChunks = info.totalChunks;
        }
        if (typeof info.downloadedChunks === 'number') {
          downloadedChunks = info.downloadedChunks;
        }

        if (!initializedItems && totalChunks > 0) {
          initializedItems = true;
          progressBar.update({ items: totalChunks, progress: 0 });
        }

        if (initializedItems) {
          progressBar.update({
            progress: totalChunks > 0 ? Math.min(1, downloadedChunks / totalChunks) : 0,
            items: totalChunks
          });

          const delta = downloadedChunks - lastDownloadedChunks;
          if (delta > 0) {
            for (let i = 0; i < delta; i++) {
              progressBar.itemDone();
            }
            lastDownloadedChunks = downloadedChunks;
          }
        } else {
          const pct = totalChunks > 0 ? Math.min(1, downloadedChunks / totalChunks) : 0;
          progressBar.update(pct);
        }
      }
    });

    const ms = elapsedMs(start)

    if (progressBar) {
      progressBar.update(1);
      if (typeof progressBar.stop === 'function') {
        progressBar.stop();
      }
      term('\n');
    }

    console.log(`\n✅ File downloaded successfully!`);
    console.log(`  Path: ${result.path}`);
    console.log(`  Size: ${formatBytes(result.size)}`);
    console.log(`  Chunks: ${result.totalChunks}`);
    console.log(`  Downloaded: ${result.chunksDownloaded}`);
    console.log(`  Already had: ${result.chunksAlreadyHad}`);

    const mbps = formatMbps(result.size, ms)
    console.log(`  Time: ${formatSeconds(ms)}s${mbps ? ` (${mbps} MiB/s)` : ''}`)

    return result;
  } catch (error) {
    if (progressBar) {
      if (typeof progressBar.stop === 'function') {
        progressBar.stop();
      }
      term('\n');
    }

    console.error(`\n❌ Download failed: ${error.message}`);
    throw error;
  }
}

export async function networkCommand(swarmfs) {
  swarmfs.open();

  if (!swarmfs.network) {
    console.log('Network not active. Join a topic first.');
    return null;
  }

  const stats = swarmfs.network.getStats();

  const topicsDetails = Array.isArray(stats?.topicsDetails)
    ? stats.topicsDetails
    : (Array.isArray(stats?.activeTopics) ? stats.activeTopics.map((name) => ({ name, peers: 0 })) : []);

  const totalConnections = typeof stats?.connections === 'number'
    ? stats.connections
    : topicsDetails.reduce((acc, t) => acc + (t?.peers || 0), 0);

  console.log('');
  console.log('Topics joined:');
  if (topicsDetails.length === 0) {
    console.log('None');
  } else {
    for (const topic of topicsDetails) {
      const name = topic?.name ?? '';
      const peers = typeof topic?.peers === 'number' ? topic.peers : 0;
      console.log(`${name}: ${peers}`);
    }
  }

  console.log('');
  console.log(`Total: ${totalConnections} connections.`);
  console.log('');

  return stats;
}

// ============================================================================
// IDENTITY COMMANDS
// ============================================================================

/**
 * Login command - Initialize or load user identity
 * @param {Object} swarmfs - SwarmFS instance
 * @param {string|null} mnemonic - Optional mnemonic for existing user
 * @param {string|null} deviceName - Optional device name
 */
export async function loginCommand(swarmfs, mnemonic = null, deviceName = null) {
  // In REPL mode, login is handled at startup
  if (process.env.SWARMFS_REPL === '1') {
    if (swarmfs.identity && swarmfs.identity.hasUserIdentity()) {
      console.log('Already logged in.');
      console.log(`  User ID: ${swarmfs.identity.getUserId()}`);
      console.log(`  Device: ${swarmfs.identity.deviceName}`);
      return swarmfs.identity;
    }
    console.log('No identity loaded. Restart the REPL to login.');
    return null;
  }
  
  const identityDir = getIdentityDir();
  const userdbPath = getUserdbDir();
  
  // Check if already logged in
  if (swarmfs.identity && swarmfs.identity.hasUserIdentity()) {
    console.log('Already logged in.');
    console.log(`  User ID: ${swarmfs.identity.getUserId()}`);
    console.log(`  Device: ${swarmfs.identity.deviceName}`);
    return swarmfs.identity;
  }

  // Create identity manager
  const identity = new IdentityManager({ identityDir });

  // Check for existing identity
  const hasExisting = identity.hasUserIdentity();

  if (hasExisting && !mnemonic) {
    // Need password to decrypt existing identity
    console.log('Existing identity found.');
    
    const password = await promptPassword('Enter password: ');

    try {
      await identity.initUser(null, password);
    } catch (err) {
      console.error('Failed to decrypt identity. Wrong password?');
      restoreTerminal();
      throw err;
    }
  } else if (mnemonic) {
    // Login with mnemonic
    console.log('Logging in with mnemonic...');
    
    const password = await promptPassword('Create password for this device: ');

    await identity.initUser(mnemonic, password);
  } else {
    // Create new identity
    console.log('Creating new identity...');
    
    let password, passwordConfirm;
    do {
      password = await promptPassword('Create password: ');
      passwordConfirm = await promptPassword('Confirm password: ');

      if (password !== passwordConfirm) {
        console.log('Passwords do not match. Try again.');
      }
    } while (password !== passwordConfirm);

    await identity.initUser(null, password);
    
    console.log('\n⚠️  Save this mnemonic to recover your identity:');
    console.log(`    ${identity.mnemonic}\n`);
  }

  // Initialize device
  const deviceInfo = await identity.initDevice(deviceName);
  console.log(`Device: ${deviceInfo.deviceName} ${deviceInfo.isNew ? '(new)' : '(existing)'}`);

  // Initialize user database (ReadyResource pattern)
  const userdb = new UserDatabase({
    storagePath: userdbPath,
    identity
  });
  await userdb.ready();

  // Only print key if autobase exists (new devices wait for key from network)
  if (userdb.key) {
    console.log(`Database key: ${userdb.key.toString('hex').substring(0, 16)}...`);
  } else {
    console.log(`No saved autobase key, will wait for one from network...`);
  }

  // Join user topic for device replication
  // Both REPL and non-REPL modes need to connect to receive key
  if (userdb._pendingAutobase) {
    try {
      // Initialize network if needed
      if (!swarmfs.network) {
        swarmfs.network = new SwarmNetwork(swarmfs.config);
        await swarmfs.network.ready();
      }
      
      // Join discovery topic to receive key
      await swarmfs.network.joinUserTopic(identity, userdb);
      console.log(`Joined discovery topic, waiting for indexer...`);
      
      // Handle receiving autobase key from indexer
      const keyReceived = new Promise((resolve) => {
        swarmfs.network.once('user:autobase-key-received', async ({ key, peerId }) => {
          console.log(`\nReceived autobase key from indexer`);
          try {
            await userdb.createWithReceivedKey(key);
            console.log(`Created autobase with received key`);
            
            // Join autobase replication topic
            const autobaseDiscoveryKey = userdb.autobase.discoveryKey;
            if (autobaseDiscoveryKey) {
              await swarmfs.network.joinTopic('autobase-replication', autobaseDiscoveryKey);
              console.log(`Joined autobase replication topic`);
            }
            resolve(true);
          } catch (err) {
            console.log(`Failed to create autobase: ${err.message}`);
            resolve(false);
          }
        });
      });
      
      // Wait up to 10 seconds for key
      const timeout = new Promise(r => setTimeout(r, 10000));
      const result = await Promise.race([keyReceived, timeout]);
      
      if (!userdb.autobase) {
        console.log(`No key received - creating new autobase as first device`);
        await userdb._createAutobase(null);
        
        // Join autobase replication topic
        const autobaseDiscoveryKey = userdb.autobase.discoveryKey;
        if (autobaseDiscoveryKey) {
          await swarmfs.network.joinTopic('autobase-replication', autobaseDiscoveryKey);
        }
      }
      
      // Handle writer requests (for when we become indexer)
      swarmfs.network.on('user:writer-request', async ({ key, peerId }) => {
        console.log(`\nNew device requesting to join: ${key.toString('hex').slice(0, 16)}...`);
        try {
          await userdb.addWriter(key);
          console.log(`Added writer: ${key.toString('hex').slice(0, 16)}...`);
        } catch (err) {
          console.log(`Failed to add writer: ${err.message}`);
        }
      });
      
    } catch (err) {
      console.warn(`Could not join user swarm: ${err.message}`);
      // Fallback: create new autobase
      if (!userdb.autobase) {
        console.log(`Creating new autobase as fallback`);
        await userdb._createAutobase(null);
      }
    }
  } else if (process.env.SWARMFS_REPL === '1' && userdb.autobase) {
    // Already have autobase, just join the topics
    try {
      await swarmfs.network.joinUserTopic(identity, userdb);
      console.log(`User swarm topic joined - other devices can sync`);
      
      // Handle writer requests
      swarmfs.network.on('user:writer-request', async ({ key, peerId }) => {
        console.log(`\nNew device requesting to join: ${key.toString('hex').slice(0, 16)}...`);
        try {
          await userdb.addWriter(key);
          console.log(`Added writer: ${key.toString('hex').slice(0, 16)}...`);
        } catch (err) {
          console.log(`Failed to add writer: ${err.message}`);
        }
      });
    } catch (err) {
      console.warn(`Could not join user swarm: ${err.message}`);
    }
  }

  // Store on swarmfs instance
  swarmfs.identity = identity;
  swarmfs.userdb = userdb;

  restoreTerminal();

  console.log('\n✅ Logged in successfully!');
  console.log(`  User ID: ${identity.getUserId()}`);
  console.log(`  Device ID: ${identity.getDeviceId()}`);

  return identity;
}

/**
 * Logout command - Clear identity from memory
 * @param {Object} swarmfs - SwarmFS instance
 */
export async function logoutCommand(swarmfs) {
  if (!swarmfs.identity) {
    console.log('Not logged in.');
    return;
  }

  // Clear sensitive data
  swarmfs.identity.clear();

  // Close user database
  if (swarmfs.userdb) {
    await swarmfs.userdb.close();
  }

  swarmfs.identity = null;
  swarmfs.userdb = null;

  console.log('Logged out.');
}

/**
 * Helper to auto-load identity if it exists on disk
 * Used by commands that need identity but may not have it in memory
 */
async function autoLoadIdentity(swarmfs) {
  if (swarmfs.identity && swarmfs.identity.hasUserIdentity()) {
    return true
  }

  const identityDir = getIdentityDir()
  const userdbPath = getUserdbDir()
  
  // Check if identity exists on disk
  const identity = new IdentityManager({ identityDir })
  if (!identity.hasUserIdentity()) {
    return false
  }

  // Need password to decrypt
  console.log('Existing identity found. Enter password to continue.')
  const password = await promptPassword('Enter password: ')

  try {
    await identity.initUser(null, password)
    const deviceInfo = await identity.initDevice()
    
    // Initialize user database
    const userdb = new UserDatabase({
      storagePath: userdbPath,
      identity
    })
    await userdb.ready()

    // Join user topic for replication (only in REPL/shell mode)
    if (process.env.SWARMFS_REPL === '1') {
      try {
        // Check if this is a new device waiting for key
        const pendingAutobase = userdb._pendingAutobase
        
        // Join discovery topic first (to receive key if needed)
        await swarmfs.network.joinUserTopic(identity, userdb)
        
        // Handle writer requests from new devices (indexer adds them automatically)
        swarmfs.network.on('user:writer-request', async ({ key, peerId }) => {
          console.log(`\n[NETWORK] New device requesting to join: ${key.toString('hex').slice(0, 16)}...`)
          try {
            await userdb.addWriter(key)
            console.log(`[NETWORK] ✓ Added writer: ${key.toString('hex').slice(0, 16)}...`)
          } catch (err) {
            console.log(`[NETWORK] ✗ Failed to add writer: ${err.message}`)
          }
        })
        
        // Handle receiving autobase key from indexer (new device creates autobase)
        swarmfs.network.on('user:autobase-key-received', async ({ key, peerId }) => {
          console.log(`\n[NETWORK] Received autobase key from indexer`)
          try {
            // Create autobase with received key
            await userdb.createWithReceivedKey(key)
            console.log(`[NETWORK] ✓ Created autobase with received key`)
            
            // Now join the autobase discovery topic for replication
            const autobaseDiscoveryKey = userdb.autobase.discoveryKey
            if (autobaseDiscoveryKey) {
              await swarmfs.network.joinTopic('autobase-replication', autobaseDiscoveryKey)
              console.log(`[NETWORK] ✓ Joined autobase replication topic`)
            }
          } catch (err) {
            console.log(`[NETWORK] ✗ Failed to create autobase: ${err.message}`)
          }
        })
        
        // If we were waiting for a key, wait a bit for it to arrive
        if (pendingAutobase) {
          console.log('[NETWORK] Waiting for autobase key from indexer...')
          // Wait up to 10 seconds for the key
          const timeout = new Promise(r => setTimeout(r, 10000))
          await Promise.race([userdb._autobaseReady, timeout])
          
          if (!userdb.autobase) {
            console.log('[NETWORK] No key received - creating new autobase as first device')
            // No key received, create new autobase as first device
            await userdb._createAutobase(null)
            // Join the autobase discovery topic
            const autobaseDiscoveryKey = userdb.autobase.discoveryKey
            if (autobaseDiscoveryKey) {
              await swarmfs.network.joinTopic('autobase-replication', autobaseDiscoveryKey)
            }
          }
        }
      } catch (err) {
        console.warn('Could not join user swarm:', err.message)
      }
    }

    swarmfs.identity = identity
    swarmfs.userdb = userdb
    return true
  } catch (err) {
    console.error('Failed to decrypt identity:', err.message)
    return false
  }
}

/**
 * Devices command - List registered devices
 * @param {Object} swarmfs - SwarmFS instance
 */
export async function devicesCommand(swarmfs) {
  const loaded = await autoLoadIdentity(swarmfs)
  if (!loaded) {
    console.log('Not logged in. Use "login" first.')
    return []
  }

  console.log('\n📱 Registered Devices:\n');

  const devices = await swarmfs.userdb.getAllDevices();

  if (devices.length === 0) {
    console.log('  No devices registered yet.');
    return [];
  }

  const currentDeviceId = swarmfs.identity.getDeviceId();

  for (const device of devices) {
    const isCurrent = device.deviceId === currentDeviceId;
    const marker = isCurrent ? ' ← current' : '';
    const lastSeen = device.lastSeen ? new Date(device.lastSeen).toLocaleString() : 'never';
    
    console.log(`  ${device.name}${marker}`);
    console.log(`    ID: ${device.deviceId}`);
    console.log(`    Last seen: ${lastSeen}`);
    console.log('');
  }

  console.log(`Total: ${devices.length} device(s)`);

  return devices;
}

/**
 * Whoami command - Show current identity info
 * @param {Object} swarmfs - SwarmFS instance
 */
export async function whoamiCommand(swarmfs) {
  const loaded = await autoLoadIdentity(swarmfs)
  if (!loaded) {
    console.log('Not logged in. Use "login" first.')
    return null
  }

  const status = swarmfs.identity.getStatus();

  console.log('\n👤 Current Identity:\n');
  console.log(`  User ID:    ${status.userId}`);
  console.log(`  Device:     ${status.deviceName}`);
  console.log(`  Device ID:  ${status.deviceId}`);

  if (swarmfs.userdb) {
    const dbStatus = swarmfs.userdb.getStatus();
    console.log(`  DB Key:     ${dbStatus.key?.substring(0, 16)}...`);
    console.log(`  Is Indexer: ${dbStatus.isIndexer}`);
  }

  return status;
}

// ============================================================================
// DEVICE MANAGEMENT COMMANDS
// ============================================================================

/**
 * Add a writer to the autobase
 * This authorizes a new device to write to the shared database
 * @param {Object} swarmfs - SwarmFS instance
 * @param {string} writerKeyHex - Public key of the new writer (hex string)
 */
export async function addWriterCommand(swarmfs, writerKeyHex) {
  if (!swarmfs.userdb) {
    console.log('Not logged in. Run "login" first.');
    return;
  }

  if (!writerKeyHex) {
    console.log('Usage: add-writer <writer-public-key>');
    console.log('The new device will show its public key when it tries to login.');
    return;
  }

  const writerKey = Buffer.from(writerKeyHex, 'hex');
  
  try {
    await swarmfs.userdb.addWriter(writerKey);
    console.log(`✓ Added writer: ${writerKeyHex.slice(0, 16)}...`);
    console.log('  The new device can now write to the database.');
  } catch (err) {
    console.log(`✗ Failed to add writer: ${err.message}`);
  }
}

// ============================================================================
// COMMAND REGISTRY
// ============================================================================

export const commands = {
  // Identity commands
  login: loginCommand,
  logout: logoutCommand,
  devices: devicesCommand,
  whoami: whoamiCommand,
  
  // File commands
  add: addCommand,
  rm: rmCommand,
  status: statusCommand,
  verify: verifyCommand,
  info: infoCommand,
  stats: statsCommand,
  
  // Topic commands (with namespace)
  'topic.create': topicCreateCommand,
  'topic.save': topicSaveCommand,
  'topic.list': topicListCommand,
  'topic.info': topicInfoCommand,
  'topic.share': topicShareCommand,
  'topic.unshare': topicUnshareCommand,
  'topic.join': topicJoinCommand,
  'topic.leave': topicLeaveCommand,
  'topic.rm': topicRmCommand,
  'topic.autojoin': topicAutojoinCommand,
  
  // Network commands
  request: requestCommand,
  download: downloadCommand,
  resume: resumeCommand,
  browse: browseCommand,
  network: networkCommand,

  // VFS commands
  'vdir.mkdir': vdirMkdirCommand,
  'vdir.ls': vdirLsCommand,
  'vdir.add': vdirAddCommand,
  'vdir.share': vdirShareCommand,
  'vdir.info': vdirInfoCommand,
  'vdir.repair': vdirRepairCommand,

  // Top-level share
  share: shareCommand,

  // Device management
  'add-writer': addWriterCommand
};

// Helper to get command by name (handles aliases)
export function getCommand(name) {
  return commands[name];
}

// Helper to list all commands
export function listCommands() {
  return Object.keys(commands);
}
