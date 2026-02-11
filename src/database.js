/**
 * Database layer for SwarmFS
 * Uses better-sqlite3 for metadata storage
 */

import { Database } from './sqlite.js';

const SCHEMA = `
-- Files: Tracked files on filesystem

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  merkle_root TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  file_modified_at INTEGER NOT NULL
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
CREATE INDEX IF NOT EXISTS idx_topic_shares_topic ON topic_shares(topic_id);
CREATE INDEX IF NOT EXISTS idx_downloads_completed ON downloads(completed_at);
`;

export class SwarmDB {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL'); // Better concurrency
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(SCHEMA);
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
   */
  addFile(filePath, merkleRoot, fileSize, chunkSize, chunkCount, fileModifiedAt) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO files 
      (path, merkle_root, size, chunk_size, chunk_count, added_at, file_modified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      filePath,
      merkleRoot,
      fileSize,
      chunkSize,
      chunkCount,
      Date.now(),
      fileModifiedAt
    );
    
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
