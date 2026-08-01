/**
 * Database layer for SwarmFS
 * Uses better-sqlite3 for metadata storage
 */

import { Database } from './sqlite.js';

const SCHEMA_VERSION = 2;

const SCHEMA = `
-- Schema version marker
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

-- Files: Tracked files on filesystem
-- Note: merkle_root + path must be unique (allows same content at multiple paths)

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merkle_root TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  file_modified_at INTEGER NOT NULL,
  UNIQUE(merkle_root, path)
);

-- File chunks: Maps files to their chunks in order

CREATE TABLE IF NOT EXISTS file_chunks (
  file_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_hash TEXT NOT NULL,
  chunk_offset INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  PRIMARY KEY (file_id, chunk_index),
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

-- Directories: For directory tracking

CREATE TABLE IF NOT EXISTS directories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  merkle_root TEXT NOT NULL,
  added_at INTEGER NOT NULL
);

-- Topics: P2P topics/groups

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  topic_key TEXT NOT NULL,
  auto_join INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_joined_at INTEGER
);

-- Topic shares: Files/directories shared in topics

CREATE TABLE IF NOT EXISTS topic_shares (
  topic_id INTEGER NOT NULL,
  share_type TEXT NOT NULL,
  share_path TEXT NOT NULL,
  merkle_root TEXT NOT NULL,
  shared_at INTEGER NOT NULL,
  PRIMARY KEY (topic_id, share_path),
  FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_name TEXT NOT NULL,
  merkle_root TEXT NOT NULL,
  output_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (topic_name, merkle_root, output_path)
);

-- Indexes for performance

CREATE INDEX IF NOT EXISTS idx_file_chunks_hash ON file_chunks(chunk_hash);
CREATE INDEX IF NOT EXISTS idx_files_merkle_root ON files(merkle_root);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_topic_shares_topic ON topic_shares(topic_id);
CREATE INDEX IF NOT EXISTS idx_downloads_completed ON downloads(completed_at);

-- Virtual filesystem (VFS)

CREATE TABLE IF NOT EXISTS virtual_directories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT NULL,
  merkle_root TEXT NULL,
  is_root INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES virtual_directories(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_virtual_directories_root
  ON virtual_directories(is_root)
  WHERE is_root = 1;

CREATE INDEX IF NOT EXISTS idx_virtual_directories_parent
  ON virtual_directories(parent_id);

CREATE INDEX IF NOT EXISTS idx_virtual_directories_merkle_root
  ON virtual_directories(merkle_root);

CREATE TABLE IF NOT EXISTS vdir_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_vdir_id TEXT NOT NULL,
  child_type INTEGER NOT NULL,
  child_merkle_root TEXT NOT NULL,
  suggested_name TEXT NULL,
  added_at INTEGER NOT NULL,
  FOREIGN KEY (parent_vdir_id) REFERENCES virtual_directories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vdir_entries_parent
  ON vdir_entries(parent_vdir_id);

CREATE INDEX IF NOT EXISTS idx_vdir_entries_child_root
  ON vdir_entries(child_merkle_root);
`;

export class SwarmDB {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL'); // Better concurrency
    this._initSchema();
    this._migrateIfNeeded();
  }

  _initSchema() {
    this.db.exec(SCHEMA);
  }

  /**
   * Handle schema migrations
   */
  _migrateIfNeeded() {
    // Get current schema version
    const row = this.db.prepare('SELECT version FROM schema_version').get();
    const currentVersion = row?.version || 0;

    if (currentVersion < 2) {
      this._migrateV1toV2();
    }

    // Update schema version
    this.db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  }

  /**
   * Migrate from V1 (path UNIQUE) to V2 (merkle_root, path UNIQUE)
   * Also removes child_vdir_id from vdir_entries
   */
  _migrateV1toV2() {
    console.log('Migrating database schema from V1 to V2...');

    // Check if files table has old schema (path UNIQUE)
    const filesInfo = this.db.prepare("PRAGMA table_info(files)").all();
    const hasOldFilesSchema = filesInfo.some(
      col => col.name === 'path' && col.pk === 1 // In old schema, path was unique (marked as pk-like)
    );

    // Actually check by looking at the unique constraint
    const filesIndexes = this.db.prepare("PRAGMA index_list(files)").all();
    const hasPathUnique = filesIndexes.some(idx => idx.unique === 1 && idx.name.includes('path'));

    if (hasPathUnique || hasOldFilesSchema) {
      console.log('Migrating files table to allow multiple paths per merkle_root...');

      // SQLite doesn't support ALTER TABLE to change constraints
      // Must recreate table
      this.db.exec(`
        -- Backup existing data
        CREATE TABLE files_backup AS SELECT * FROM files;

        -- Drop old table and its indexes
        DROP TABLE files;
        DROP INDEX IF EXISTS idx_files_merkle_root;

        -- Create new table with correct schema
        CREATE TABLE files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          merkle_root TEXT NOT NULL,
          path TEXT NOT NULL,
          size INTEGER NOT NULL,
          chunk_size INTEGER NOT NULL,
          chunk_count INTEGER NOT NULL,
          added_at INTEGER NOT NULL,
          file_modified_at INTEGER NOT NULL,
          UNIQUE(merkle_root, path)
        );

        -- Restore data (id will be re-generated, but that's ok)
        INSERT INTO files (merkle_root, path, size, chunk_size, chunk_count, added_at, file_modified_at)
        SELECT merkle_root, path, size, chunk_size, chunk_count, added_at, file_modified_at
        FROM files_backup;

        -- Recreate indexes
        CREATE INDEX idx_files_merkle_root ON files(merkle_root);
        CREATE INDEX idx_files_path ON files(path);

        -- Drop backup
        DROP TABLE files_backup;
      `);

      console.log('Files table migration complete.');
    }

    // Migrate vdir_entries: remove child_vdir_id column
    const vdirEntriesInfo = this.db.prepare("PRAGMA table_info(vdir_entries)").all();
    const hasChildVdirId = vdirEntriesInfo.some(col => col.name === 'child_vdir_id');

    if (hasChildVdirId) {
      console.log('Migrating vdir_entries table to remove child_vdir_id...');

      this.db.exec(`
        -- Backup existing data
        CREATE TABLE vdir_entries_backup AS SELECT * FROM vdir_entries;

        -- Drop old table
        DROP TABLE vdir_entries;

        -- Create new table without child_vdir_id
        CREATE TABLE vdir_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_vdir_id TEXT NOT NULL,
          child_type INTEGER NOT NULL,
          child_merkle_root TEXT NOT NULL,
          suggested_name TEXT NULL,
          added_at INTEGER NOT NULL,
          FOREIGN KEY (parent_vdir_id) REFERENCES virtual_directories(id) ON DELETE CASCADE
        );

        -- Restore data
        INSERT INTO vdir_entries (id, parent_vdir_id, child_type, child_merkle_root, suggested_name, added_at)
        SELECT id, parent_vdir_id, child_type, child_merkle_root, suggested_name, added_at
        FROM vdir_entries_backup;

        -- Recreate indexes
        CREATE INDEX idx_vdir_entries_parent ON vdir_entries(parent_vdir_id);
        CREATE INDEX idx_vdir_entries_child_root ON vdir_entries(child_merkle_root);

        -- Drop backup
        DROP TABLE vdir_entries_backup;
      `);

      console.log('vdir_entries table migration complete.');
    }

    console.log('Database migration V1 -> V2 complete.');
  }

  ensureVfsRoot(rootId) {
    const existing = this.db.prepare('SELECT id FROM virtual_directories WHERE is_root = 1').get();
    if (existing?.id) {
      return existing.id;
    }

    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO virtual_directories (id, name, parent_id, merkle_root, is_root, created_at, updated_at)
      VALUES (?, ?, NULL, NULL, 1, ?, ?)
    `);
    stmt.run(rootId, '/', now, now);
    return rootId;
  }

  getVfsRoot() {
    return this.db.prepare('SELECT * FROM virtual_directories WHERE is_root = 1').get();
  }

  getVdirById(id) {
    return this.db.prepare('SELECT * FROM virtual_directories WHERE id = ?').get(id);
  }

  getVdirByNameAndParent(name, parentId) {
    return this.db.prepare('SELECT * FROM virtual_directories WHERE name = ? AND parent_id IS ?').get(name, parentId ?? null);
  }

  addVdir(id, name, parentId = null) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO virtual_directories (id, name, parent_id, merkle_root, is_root, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 0, ?, ?)
    `);
    stmt.run(id, name, parentId, now, now);
    return id;
  }

  listVdirsByParent(parentId = null) {
    const stmt = this.db.prepare(`
      SELECT *
      FROM virtual_directories
      WHERE parent_id IS ?
      ORDER BY name ASC
    `);
    return stmt.all(parentId ?? null);
  }

  listVdirEntries(parentVdirId) {
    const stmt = this.db.prepare(`
      SELECT *
      FROM vdir_entries
      WHERE parent_vdir_id = ?
      ORDER BY added_at ASC, id ASC
    `);
    return stmt.all(parentVdirId);
  }

  addVdirEntry(parentVdirId, childType, childMerkleRoot, suggestedName = null) {
    const stmt = this.db.prepare(`
      INSERT INTO vdir_entries (parent_vdir_id, child_type, child_merkle_root, suggested_name, added_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const res = stmt.run(parentVdirId, childType, childMerkleRoot, suggestedName, Date.now());
    return res.lastInsertRowid;
  }

  /**
   * Remove an entry from a vdir
   */
  removeVdirEntry(parentVdirId, childMerkleRoot) {
    const stmt = this.db.prepare(`
      DELETE FROM vdir_entries 
      WHERE parent_vdir_id = ? AND child_merkle_root = ?
    `);
    return stmt.run(parentVdirId, childMerkleRoot);
  }

  /**
   * Update a vdir entry's child_merkle_root (used when child vdir gets its merkle root)
   * @param {string} parentVdirId - Parent vdir UUID
   * @param {string} oldRoot - Old value (UUID placeholder or old merkle root)
   * @param {string} newRoot - New merkle root
   */
  updateVdirEntryMerkleRoot(parentVdirId, oldRoot, newRoot) {
    const stmt = this.db.prepare(`
      UPDATE vdir_entries 
      SET child_merkle_root = ?
      WHERE parent_vdir_id = ? AND child_merkle_root = ?
    `);
    return stmt.run(newRoot, parentVdirId, oldRoot);
  }

  /**
   * Find all vdir_entries that reference a vdir by its UUID (as child_merkle_root placeholder)
   * @param {string} vdirId - The vdir UUID to find references to
   * @returns {Array} - Array of entries with parent_vdir_id
   */
  findVdirEntriesByChildId(vdirId) {
    const stmt = this.db.prepare(`
      SELECT * FROM vdir_entries WHERE child_merkle_root = ?
    `);
    return stmt.all(vdirId);
  }

  /**
   * Update a vdir's merkle root
   */
  updateVdirMerkleRoot(vdirId, merkleRoot) {
    const stmt = this.db.prepare(`
      UPDATE virtual_directories 
      SET merkle_root = ?, updated_at = ?
      WHERE id = ?
    `);
    return stmt.run(merkleRoot, Date.now(), vdirId);
  }

  /**
   * Get a vdir by its merkle root (for protocol lookup)
   */
  getVdirByMerkleRoot(merkleRoot) {
    return this.db.prepare(
      'SELECT * FROM virtual_directories WHERE merkle_root = ?'
    ).get(merkleRoot);
  }

  /**
   * Get enriched children data for protocol response
   * Returns array with merkleRoot, type, suggestedName, size (for files), hasChildren (for vdirs)
   */
  getVdirChildren(vdirId) {
    const entries = this.listVdirEntries(vdirId);
    
    return entries.map(e => {
      const child = {
        merkleRoot: e.child_merkle_root,
        type: e.child_type === 0 ? 'file' : 'vdir',
        suggestedName: e.suggested_name
      };

      if (e.child_type === 0) {
        // File: lookup size
        const file = this.getFileByMerkleRoot(e.child_merkle_root);
        child.size = file?.size || 0;
      } else {
        // Vdir: check if has children
        const childVdir = this.getVdirById(e.child_merkle_root);
        if (childVdir) {
          const childEntries = this.listVdirEntries(childVdir.id);
          child.hasChildren = childEntries.length > 0;
        } else {
          // child_merkle_root is a UUID (empty vdir case)
          const vdir = this.getVdirById(e.child_merkle_root);
          if (vdir) {
            const childEntries = this.listVdirEntries(vdir.id);
            child.hasChildren = childEntries.length > 0;
          } else {
            child.hasChildren = false;
          }
        }
      }

      return child;
    });
  }

  /**
   * Check if a chunk exists in any tracked file
   */
  hasChunk(hash) {
    const stmt = this.db.prepare(`
      SELECT 1
      FROM file_chunks fc
      JOIN files f ON f.id = fc.file_id
      WHERE fc.chunk_hash = ? AND f.file_modified_at > 0
      LIMIT 1
    `);
    return stmt.get(hash) !== undefined;
  }

  /**
   * Add a file to the database
   * Note: Uses INSERT OR IGNORE to handle duplicate (merkle_root, path) pairs
   */
  addFile(filePath, merkleRoot, fileSize, chunkSize, chunkCount, fileModifiedAt) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO files 
      (merkle_root, path, size, chunk_size, chunk_count, added_at, file_modified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      merkleRoot,
      filePath,
      fileSize,
      chunkSize,
      chunkCount,
      Date.now(),
      fileModifiedAt
    );
    
    // If no rows inserted, the (merkle_root, path) pair already exists
    // Return the existing file's id
    if (result.changes === 0) {
      const existing = this.db.prepare(
        'SELECT id FROM files WHERE merkle_root = ? AND path = ?'
      ).get(merkleRoot, filePath);
      return existing?.id;
    }
    
    return result.lastInsertRowid;
  }

  /**
   * Get file by path
   */
  getFile(filePath) {
    const stmt = this.db.prepare('SELECT * FROM files WHERE path = ?');
    return stmt.get(filePath);
  }

  /**
   * Get file by merkle root
   */
  getFileByMerkleRoot(merkleRoot) {
    const stmt = this.db.prepare('SELECT * FROM files WHERE merkle_root = ?');
    return stmt.get(merkleRoot);
  }

  /**
   * Get all files by merkle root (for finding any available copy)
   */
  getFilesByMerkleRoot(merkleRoot) {
    const stmt = this.db.prepare('SELECT * FROM files WHERE merkle_root = ? AND file_modified_at > 0 ORDER BY added_at DESC');
    return stmt.all(merkleRoot);
  }

  /**
   * Get file by ID
   */
  getFileById(id) {
    const stmt = this.db.prepare('SELECT * FROM files WHERE id = ?');
    return stmt.get(id);
  }

  /**
   * Get all tracked files
   */
  getAllFiles() {
    const stmt = this.db.prepare('SELECT * FROM files ORDER BY added_at DESC');
    return stmt.all();
  }

  /**
   * Remove file from database
   */
  removeFile(filePath) {
    const stmt = this.db.prepare('DELETE FROM files WHERE path = ?');
    return stmt.run(filePath);
  }

  removeDirectory(dirPath) {
    const stmt = this.db.prepare('DELETE FROM directories WHERE path = ?');
    return stmt.run(dirPath);
  }

  /**
   * Add file chunks mapping
   */
  addFileChunks(fileId, chunks) {
    const stmt = this.db.prepare(`
      INSERT INTO file_chunks (file_id, chunk_index, chunk_hash, chunk_offset, chunk_size)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((entries) => {
      entries.forEach((chunk, index) => {
        stmt.run(fileId, index, chunk.hash, chunk.offset, chunk.size);
      });
    });

    insertMany(chunks);
  }

  /**
   * Get chunks for a file
   */
  getFileChunks(fileId) {
    const stmt = this.db.prepare(`
      SELECT chunk_index, chunk_hash, chunk_offset, chunk_size
      FROM file_chunks
      WHERE file_id = ?
      ORDER BY chunk_index
    `);
    return stmt.all(fileId);
  }

  /**
   * Get chunks for a file within a range (for efficient subtree serving)
   * @param {number} fileId - File ID
   * @param {number} startIndex - Start chunk index (inclusive)
   * @param {number} endIndex - End chunk index (inclusive)
   */
  getFileChunksRange(fileId, startIndex, endIndex) {
    const stmt = this.db.prepare(`
      SELECT chunk_index, chunk_hash, chunk_offset, chunk_size
      FROM file_chunks
      WHERE file_id = ? AND chunk_index >= ? AND chunk_index <= ?
      ORDER BY chunk_index
    `);
    return stmt.all(fileId, startIndex, endIndex);
  }

  /**
   * Get chunk location (file path + offset/size) by hash
   */
  getChunkLocation(chunkHash) {
    const stmt = this.db.prepare(`
      SELECT f.id AS file_id, f.path, f.merkle_root, f.file_modified_at, fc.chunk_index, fc.chunk_offset, fc.chunk_size
      FROM file_chunks fc
      JOIN files f ON f.id = fc.file_id
      WHERE fc.chunk_hash = ? AND f.file_modified_at > 0
      ORDER BY f.added_at DESC
      LIMIT 1
    `);
    return stmt.get(chunkHash);
  }

  getChunkLocations(chunkHash, limit = 10) {
    const stmt = this.db.prepare(`
      SELECT f.id AS file_id, f.path, f.merkle_root, f.file_modified_at, fc.chunk_index, fc.chunk_offset, fc.chunk_size
      FROM file_chunks fc
      JOIN files f ON f.id = fc.file_id
      WHERE fc.chunk_hash = ? AND f.file_modified_at > 0
      ORDER BY f.added_at DESC
      LIMIT ?
    `);
    return stmt.all(chunkHash, limit);
  }

  /**
   * Get chunk location for writes (includes incomplete downloads)
   */
  getChunkWriteLocation(chunkHash) {
    const stmt = this.db.prepare(`
      SELECT f.id AS file_id, f.path, f.merkle_root, f.file_modified_at, fc.chunk_index, fc.chunk_offset, fc.chunk_size
      FROM file_chunks fc
      JOIN files f ON f.id = fc.file_id
      WHERE fc.chunk_hash = ?
      ORDER BY f.added_at DESC
      LIMIT 1
    `);
    return stmt.get(chunkHash);
  }

  /**
   * Get files that contain a specific chunk
   */
  getFilesWithChunk(chunkHash) {
    const stmt = this.db.prepare(`
      SELECT DISTINCT f.*
      FROM files f
      JOIN file_chunks fc ON f.id = fc.file_id
      WHERE fc.chunk_hash = ?
    `);
    return stmt.all(chunkHash);
  }

  /**
   * Get database statistics
   */
  getStats() {
    const fileCount = this.db.prepare('SELECT COUNT(*) as count FROM files').get().count;
    const chunkCount = this.db.prepare('SELECT COUNT(*) as count FROM file_chunks').get().count;
    const totalSize = this.db.prepare('SELECT SUM(size) as total FROM files').get().total || 0;
    const chunkSize = this.db.prepare('SELECT SUM(chunk_size) as total FROM file_chunks').get().total || 0;

    return {
      files: fileCount,
      chunks: chunkCount,
      totalFileSize: totalSize,
      totalChunkSize: chunkSize
    };
  }

  /**
   * Add a directory to the database
   */
  addDirectory(dirPath, merkleRoot) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO directories (path, merkle_root, added_at)
      VALUES (?, ?, ?)
    `);
    
    const result = stmt.run(dirPath, merkleRoot, Date.now());
    return result.lastInsertRowid;
  }

  /**
   * Get directory by path
   */
  getDirectory(dirPath) {
    const stmt = this.db.prepare('SELECT * FROM directories WHERE path = ?');
    return stmt.get(dirPath);
  }

  /**
   * Get all tracked directories
   */
  getAllDirectories() {
    const stmt = this.db.prepare('SELECT * FROM directories ORDER BY added_at DESC');
    return stmt.all();
  }

  /**
   * Add a topic
   */
  addTopic(name, topicKey, autoJoin = true) {
    const stmt = this.db.prepare(`
      INSERT INTO topics (name, topic_key, auto_join, created_at)
      VALUES (?, ?, ?, ?)
    `);
    
    const result = stmt.run(name, topicKey, autoJoin ? 1 : 0, Date.now());
    return result.lastInsertRowid;
  }

  /**
   * Get topic by name
   */
  getTopic(name) {
    const stmt = this.db.prepare('SELECT * FROM topics WHERE name = ?');
    return stmt.get(name);
  }

  /**
   * Get topic by key
   */
  getTopicByKey(topicKey) {
    const stmt = this.db.prepare('SELECT * FROM topics WHERE topic_key = ?');
    return stmt.get(topicKey);
  }

  /**
   * Get topic by ID
   */
  getTopicById(id) {
    const stmt = this.db.prepare('SELECT * FROM topics WHERE id = ?');
    return stmt.get(id);
  }

  /**
   * Get all topics
   */
  getAllTopics() {
    const stmt = this.db.prepare('SELECT * FROM topics ORDER BY created_at DESC');
    return stmt.all();
  }

  /**
   * Get topics with auto_join enabled
   */
  getAutoJoinTopics() {
    const stmt = this.db.prepare('SELECT * FROM topics WHERE auto_join = 1');
    return stmt.all();
  }

  /**
   * Update topic last_joined_at
   */
  updateTopicJoinTime(topicId) {
    const stmt = this.db.prepare('UPDATE topics SET last_joined_at = ? WHERE id = ?');
    stmt.run(Date.now(), topicId);
  }

  /**
   * Update topic auto_join flag
   */
  setTopicAutoJoin(name, autoJoin) {
    const stmt = this.db.prepare('UPDATE topics SET auto_join = ? WHERE name = ?');
    return stmt.run(autoJoin ? 1 : 0, name);
  }

  setTopicsAutoJoin(names, autoJoin) {
    const stmt = this.db.prepare('UPDATE topics SET auto_join = ? WHERE name = ?');
    const tx = this.db.transaction((topicNames) => {
      for (const n of topicNames) {
        stmt.run(autoJoin ? 1 : 0, n);
      }
    });
    tx(names);
  }

  /**
   * Update file modified time (used to mark downloads complete)
   */
  updateFileModifiedAt(fileId, fileModifiedAt) {
    const stmt = this.db.prepare('UPDATE files SET file_modified_at = ? WHERE id = ?');
    stmt.run(fileModifiedAt, fileId);
  }

  addDownload(topicName, merkleRoot, outputPath) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO downloads (topic_name, merkle_root, output_path, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(topicName, merkleRoot, outputPath, Date.now());
    return result.lastInsertRowid;
  }

  markDownloadComplete(topicName, merkleRoot, outputPath) {
    const stmt = this.db.prepare(`
      UPDATE downloads
      SET completed_at = ?
      WHERE topic_name = ? AND merkle_root = ? AND output_path = ?
    `);
    stmt.run(Date.now(), topicName, merkleRoot, outputPath);
  }

  getIncompleteDownloads(topicName = null) {
    if (typeof topicName === 'string' && topicName.length > 0) {
      const stmt = this.db.prepare(`
        SELECT *
        FROM downloads
        WHERE completed_at IS NULL AND topic_name = ?
        ORDER BY created_at ASC
      `);
      return stmt.all(topicName);
    }

    const stmt = this.db.prepare(`
      SELECT *
      FROM downloads
      WHERE completed_at IS NULL
      ORDER BY created_at ASC
    `);
    return stmt.all();
  }

  getAllDownloads() {
    const stmt = this.db.prepare(`
      SELECT *
      FROM downloads
      ORDER BY created_at DESC
    `);
    return stmt.all();
  }

  deleteDownloads(ids) {
    const xs = Array.isArray(ids) ? ids.filter((x) => Number.isFinite(x)) : [];
    if (xs.length === 0) {
      return { ok: true, deleted: 0 };
    }

    const stmt = this.db.prepare('DELETE FROM downloads WHERE id = ?');
    const tx = this.db.transaction((items) => {
      let deleted = 0;
      for (const id of items) {
        const res = stmt.run(id);
        deleted += Number(res?.changes || 0);
      }
      return deleted;
    });

    const deleted = tx(xs);
    return { ok: true, deleted };
  }

  /**
   * Delete a topic
   */
  deleteTopic(name) {
    const stmt = this.db.prepare('DELETE FROM topics WHERE name = ?');
    return stmt.run(name);
  }

  /**
   * Add a share to a topic
   */
  addTopicShare(topicId, shareType, sharePath, merkleRoot) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO topic_shares (topic_id, share_type, share_path, merkle_root, shared_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    stmt.run(topicId, shareType, sharePath, merkleRoot, Date.now());
  }

  /**
   * Remove a share from a topic
   */
  removeTopicShare(topicId, sharePath) {
    const stmt = this.db.prepare('DELETE FROM topic_shares WHERE topic_id = ? AND share_path = ?');
    return stmt.run(topicId, sharePath);
  }

  removeTopicSharesByPath(sharePath) {
    const stmt = this.db.prepare('DELETE FROM topic_shares WHERE share_path = ?');
    return stmt.run(sharePath);
  }

  /**
   * Get all shares for a topic
   */
  getTopicShares(topicId) {
    const stmt = this.db.prepare('SELECT * FROM topic_shares WHERE topic_id = ? ORDER BY shared_at DESC');
    return stmt.all(topicId);
  }

  /**
   * Get a share by merkle root within a topic
   */
  getTopicShareByMerkleRoot(topicId, merkleRoot) {
    const stmt = this.db.prepare(
      'SELECT * FROM topic_shares WHERE topic_id = ? AND merkle_root = ?'
    );
    return stmt.get(topicId, merkleRoot);
  }

  /**
   * Get all topics sharing a specific path
   */
  getTopicsForPath(sharePath) {
    const stmt = this.db.prepare(`
      SELECT t.* FROM topics t
      JOIN topic_shares ts ON t.id = ts.topic_id
      WHERE ts.share_path = ?
    `);
    return stmt.all(sharePath);
  }

  /**
   * Close database connection
   */
  close() {
    this.db.close();
  }
}
