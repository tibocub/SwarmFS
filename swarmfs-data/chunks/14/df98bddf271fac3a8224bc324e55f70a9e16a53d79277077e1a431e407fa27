/**
 * Directory Scanner for SwarmFS
 * Recursively scans directories and builds file trees
 */

import fs from 'fs';
import path from 'path';
import { getIgnorePatterns } from './config.js';

/**
 * Check if a path should be ignored
 */
function shouldIgnore(name, ignorePatterns) {
  for (const pattern of ignorePatterns) {
    if (pattern.startsWith('*.')) {
      // Wildcard pattern like "*.tmp"
      const ext = pattern.substring(1);
      if (name.endsWith(ext)) return true;
    } else if (name === pattern) {
      // Exact match like "node_modules"
      return true;
    }
  }
  return false;
}

/**
 * Scan a directory recursively and return file tree
 * @param {string} dirPath - Directory path to scan
 * @param {object} options - Scan options
 * @returns {object} Directory tree with files and subdirectories
 */
export function scanDirectory(dirPath, options = {}) {
  const {
    ignorePatterns = getIgnorePatterns(),
    includeHidden = false
  } = options;

  const absolutePath = path.resolve(dirPath);
  
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Directory not found: ${absolutePath}`);
  }

  const stats = fs.statSync(absolutePath);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${absolutePath}`);
  }

  const result = {
    path: absolutePath,
    name: path.basename(absolutePath),
    type: 'directory',
    files: [],
    directories: []
  };

  const entries = fs.readdirSync(absolutePath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(absolutePath, entry.name);
    
    // Skip hidden files/directories unless requested
    if (!includeHidden && entry.name.startsWith('.')) {
      continue;
    }

    // Skip ignored patterns
    if (shouldIgnore(entry.name, ignorePatterns)) {
      continue;
    }

    if (entry.isDirectory()) {
      // Recursively scan subdirectory
      const subdir = scanDirectory(entryPath, options);
      result.directories.push(subdir);
    } else if (entry.isFile()) {
      const fileStats = fs.statSync(entryPath);
      result.files.push({
        path: entryPath,
        name: entry.name,
        size: fileStats.size,
        modified: Math.floor(fileStats.mtimeMs)
      });
    }
    // Skip symlinks, special files, etc.
  }

  // Sort for deterministic ordering
  result.files.sort((a, b) => a.name.localeCompare(b.name));
  result.directories.sort((a, b) => a.name.localeCompare(b.name));

  return result;
}

/**
 * Get all files in a directory tree (flattened)
 * @param {object} tree - Directory tree from scanDirectory
 * @returns {array} Array of file paths
 */
export function getAllFiles(tree) {
  const files = [...tree.files.map(f => f.path)];

  for (const subdir of tree.directories) {
    files.push(...getAllFiles(subdir));
  }

  return files;
}

/**
 * Count total files and directories in a tree
 */
export function countItems(tree) {
  let fileCount = tree.files.length;
  let dirCount = tree.directories.length;

  for (const subdir of tree.directories) {
    const subdirCounts = countItems(subdir);
    fileCount += subdirCounts.files;
    dirCount += subdirCounts.directories;
  }

  return { files: fileCount, directories: dirCount };
}

/**
 * Calculate total size of all files in tree
 */
export function calculateTotalSize(tree) {
  let totalSize = tree.files.reduce((sum, file) => sum + file.size, 0);

  for (const subdir of tree.directories) {
    totalSize += calculateTotalSize(subdir);
  }

  return totalSize;
}

/**
 * Print directory tree (for debugging)
 */
export function printTree(tree, indent = '') {
  console.log(`${indent}${tree.name}/`);
  
  for (const file of tree.files) {
    console.log(`${indent}  ${file.name} (${file.size} bytes)`);
  }

  for (const subdir of tree.directories) {
    printTree(subdir, indent + '  ');
  }
}
