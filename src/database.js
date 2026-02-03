/**
 * Database layer for SwarmFS
 * Uses better-sqlite3 for metadata storage
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const SCHEMA = `
-- Chunks: Content-addressed storage metadata
CREATE TABLE IF NOT EXISTS chunks (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  stored_at INTEGER NOT NULL
);

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
  PRIMARY KEY (file_id, chunk_index),
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (chunk_hash) REFERENCES chunks(hash)
);

-- Directories: For future directory tracking
CREATE TABLE IF NOT EXISTS directories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  merkle_root TEXT NOT NULL,
  added_at INTEGER NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_file_chunks_hash ON file_chunks(chunk_hash);
CREATE INDEX IF NOT EXISTS idx_files_merkle_root ON files(merkle_root);
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
   * Add a chunk to the database
   */
  addChunk(hash, size) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO chunks (hash, size, stored_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(hash, size, Date.now());
  }

  /**
   * Check if a chunk exists
   */
  hasChunk(hash) {
    const stmt = this.db.prepare('SELECT 1 FROM chunks WHERE hash = ?');
    return stmt.get(hash) !== undefined;
  }

  /**
   * Get chunk info
   */
  getChunk(hash) {
    const stmt = this.db.prepare('SELECT * FROM chunks WHERE hash = ?');
    return stmt.get(hash);
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
  addFileChunks(fileId, chunkHashes) {
    const stmt = this.db.prepare(`
      INSERT INTO file_chunks (file_id, chunk_index, chunk_hash)
      VALUES (?, ?, ?)
    `);

    const insertMany = this.db.transaction((chunks) => {
      chunks.forEach((hash, index) => {
        stmt.run(fileId, index, hash);
      });
    });

    insertMany(chunkHashes);
  }

  /**
   * Get chunks for a file
   */
  getFileChunks(fileId) {
    const stmt = this.db.prepare(`
      SELECT chunk_index, chunk_hash, c.size
      FROM file_chunks fc
      JOIN chunks c ON fc.chunk_hash = c.hash
      WHERE file_id = ?
      ORDER BY chunk_index
    `);
    return stmt.all(fileId);
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
    const chunkCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get().count;
    const totalSize = this.db.prepare('SELECT SUM(size) as total FROM files').get().total || 0;
    const chunkSize = this.db.prepare('SELECT SUM(size) as total FROM chunks').get().total || 0;

    return {
      files: fileCount,
      chunks: chunkCount,
      totalFileSize: totalSize,
      totalChunkSize: chunkSize
    };
  }

  /**
   * Close database connection
   */
  close() {
    this.db.close();
  }
}
