/**
 * Command implementations for SwarmFS
 * These can be called from CLI or REPL
 */

import fs from 'fs'
import path from 'path'
import terminalKit from 'terminal-kit'

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
 * Browse shared files in a topic
 */
export async function browseCommand(swarmfs, topicName, options = {}) {
  swarmfs.open();

  if (!swarmfs.network || !swarmfs.protocol) {
    console.log(`Joining topic "${topicName}"...`);
    await swarmfs.joinTopic(topicName);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`\nBrowsing topic "${topicName}"...`);
  const files = await swarmfs.browseTopic(topicName, options.timeout || 5000);

  if (files.length === 0) {
    console.log('No shared files found.');
    return files;
  }

  console.log(`\nShared Files (${files.length}):\n`);
  files.forEach((file) => {
    console.log(`  ${file.name}`);
    console.log(`    Size: ${formatBytes(file.size)}`);
    console.log(`    Merkle Root: ${file.merkleRoot}`);
    console.log('');
  });

  return files;
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

  console.log(`\nTracked Files (${files.length}):\n`);
  
  for (const file of files) {
    console.log(`  ${file.path}`);
    console.log(`    Size: ${formatBytes(file.size)}`);
    console.log(`    Chunks: ${file.chunk_count}`);
    console.log(`    Added: ${formatDate(file.added_at)}`);
    console.log(`    Merkle Root: ${file.merkle_root.substring(0, 16)}...`);
    console.log('');
  }
}

export async function verifyCommand(swarmfs, filePath) {
  swarmfs.open();

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
 * Download a complete file by requesting all chunks
 */
export async function downloadCommand(swarmfs, topicName, merkleRoot, outputPath, options = {}) {
  swarmfs.open();

  // Auto-join topic if not connected
  if (!swarmfs.network || !swarmfs.protocol) {
    console.log(`Joining topic "${topicName}"...`);
    await swarmfs.joinTopic(topicName);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`\nDownloading file from topic "${topicName}"...`);
  console.log(`Merkle Root: ${merkleRoot}`);
  console.log(`Output: ${outputPath}\n`);

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
  console.log(`\nNetwork Status:`);
  if (typeof stats.peerCount === 'number') {
    console.log(`  Peers: ${stats.peerCount}`);
  }
  if (typeof stats.topics === 'number') {
    console.log(`  Topics: ${stats.topics}`);
  }
  if (stats.topicsDetails) {
    console.log(`  Topic Details:`);
    for (const topic of stats.topicsDetails) {
      console.log(`    ${topic.name}: ${topic.peers} peer(s)`);
    }
  }
  return stats;
}

// ============================================================================
// COMMAND REGISTRY
// ============================================================================

export const commands = {
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

  // Top-level share
  share: shareCommand
};

// Helper to get command by name (handles aliases)
export function getCommand(name) {
  return commands[name];
}

// Helper to list all commands
export function listCommands() {
  return Object.keys(commands);
}
