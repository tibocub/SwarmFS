/**
 * Mock better-sqlite3 implementation for testing
 * Uses simple in-memory data structures with file persistence
 * Replace with real better-sqlite3 when available
 */

import fs from 'fs';
import path from 'path';

export default class Database {
  constructor(filename) {
    this.filename = filename;
    this.tables = {
      chunks: [],
      files: [],
      file_chunks: [],
      directories: [],
      topics: [],
      topic_shares: []
    };
    this.autoIncrement = {
      files: 1,
      directories: 1,
      topics: 1
    };
    
    // Load existing data if available
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filename)) {
        const data = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
        this.tables = data.tables || this.tables;
        this.autoIncrement = data.autoIncrement || this.autoIncrement;
      }
    } catch (error) {
      // If load fails, start fresh
      console.warn('Warning: Could not load database, starting fresh');
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.filename);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(this.filename, JSON.stringify({
        tables: this.tables,
        autoIncrement: this.autoIncrement
      }, null, 2));
    } catch (error) {
      console.warn('Warning: Could not save database');
    }
  }

  pragma(command) {
    // Ignore pragma commands in mock
    return this;
  }

  exec(sql) {
    // Simple schema initialization - just ignore CREATE TABLE statements
    // In real implementation, better-sqlite3 would handle this
    return this;
  }

  prepare(sql) {
    const normalizedSql = sql.trim().toLowerCase();
    
    return {
      run: (...params) => this._run(sql, params),
      get: (...params) => this._get(sql, params),
      all: (...params) => this._all(sql, params)
    };
  }

  transaction(fn) {
    return (...args) => {
      return fn(...args);
    };
  }

  _run(sql, params) {
    const normalizedSql = sql.trim().toLowerCase();
    
    // INSERT INTO chunks
    if (normalizedSql.includes('insert') && normalizedSql.includes('chunks')) {
      const [hash, size, stored_at] = params;
      const existing = this.tables.chunks.find(c => c.hash === hash);
      if (!existing) {
        this.tables.chunks.push({ hash, size, stored_at });
      }
      this._save();
      return { changes: 1 };
    }
    
    // INSERT INTO files
    if (normalizedSql.includes('insert') && normalizedSql.includes('files')) {
      const [path, merkle_root, size, chunk_size, chunk_count, added_at, file_modified_at] = params;
      
      // Remove existing file with same path
      this.tables.files = this.tables.files.filter(f => f.path !== path);
      
      const id = this.autoIncrement.files++;
      this.tables.files.push({
        id,
        path,
        merkle_root,
        size,
        chunk_size,
        chunk_count,
        added_at,
        file_modified_at
      });
      
      this._save();
      return { lastInsertRowid: id, changes: 1 };
    }
    
    // INSERT INTO file_chunks
    if (normalizedSql.includes('insert') && normalizedSql.includes('file_chunks')) {
      const [file_id, chunk_index, chunk_hash] = params;
      this.tables.file_chunks.push({ file_id, chunk_index, chunk_hash });
      this._save();
      return { changes: 1 };
    }
    
    // DELETE FROM files
    if (normalizedSql.includes('delete') && normalizedSql.includes('files')) {
      const [path] = params;
      const before = this.tables.files.length;
      this.tables.files = this.tables.files.filter(f => f.path !== path);
      
      // Also delete file_chunks for this file
      const fileIds = this.tables.files.filter(f => f.path === path).map(f => f.id);
      this.tables.file_chunks = this.tables.file_chunks.filter(fc => !fileIds.includes(fc.file_id));
      
      this._save();
      return { changes: before - this.tables.files.length };
    }

    // INSERT INTO topics
    if (normalizedSql.includes('insert') && normalizedSql.includes('topics')) {
      const [name, topic_key, auto_join, created_at] = params;
      const id = this.autoIncrement.topics++;
      this.tables.topics.push({ id, name, topic_key, auto_join, created_at, last_joined_at: null });
      this._save();
      return { lastInsertRowid: id, changes: 1 };
    }

    // UPDATE topics SET last_joined_at
    if (normalizedSql.includes('update') && normalizedSql.includes('topics') && normalizedSql.includes('last_joined_at')) {
      const [timestamp, topicId] = params;
      const topic = this.tables.topics.find(t => t.id === topicId);
      if (topic) {
        topic.last_joined_at = timestamp;
        this._save();
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    // DELETE FROM topics
    if (normalizedSql.includes('delete') && normalizedSql.includes('topics')) {
      const [name] = params;
      const before = this.tables.topics.length;
      const topic = this.tables.topics.find(t => t.name === name);
      if (topic) {
        this.tables.topics = this.tables.topics.filter(t => t.name !== name);
        // Also delete topic_shares
        this.tables.topic_shares = this.tables.topic_shares.filter(ts => ts.topic_id !== topic.id);
      }
      this._save();
      return { changes: before - this.tables.topics.length };
    }

    // INSERT INTO topic_shares
    if (normalizedSql.includes('insert') && normalizedSql.includes('topic_shares')) {
      const [topic_id, share_type, share_path, merkle_root, shared_at] = params;
      // Remove existing share with same topic_id and share_path
      this.tables.topic_shares = this.tables.topic_shares.filter(
        ts => !(ts.topic_id === topic_id && ts.share_path === share_path)
      );
      this.tables.topic_shares.push({ topic_id, share_type, share_path, merkle_root, shared_at });
      this._save();
      return { changes: 1 };
    }

    // DELETE FROM topic_shares
    if (normalizedSql.includes('delete') && normalizedSql.includes('topic_shares')) {
      const [topic_id, share_path] = params;
      const before = this.tables.topic_shares.length;
      this.tables.topic_shares = this.tables.topic_shares.filter(
        ts => !(ts.topic_id === topic_id && ts.share_path === share_path)
      );
      this._save();
      return { changes: before - this.tables.topic_shares.length };
    }
    
    return { changes: 0 };
  }

  _get(sql, params) {
    const normalizedSql = sql.trim().toLowerCase();
    
    // SELECT 1 FROM chunks WHERE hash = ?
    if (normalizedSql.includes('select 1') && normalizedSql.includes('chunks')) {
      const [hash] = params;
      const found = this.tables.chunks.find(c => c.hash === hash);
      return found ? { 1: 1 } : undefined;
    }
    
    // SELECT * FROM chunks WHERE hash = ?
    if (normalizedSql.includes('select *') && normalizedSql.includes('chunks') && normalizedSql.includes('where')) {
      const [hash] = params;
      return this.tables.chunks.find(c => c.hash === hash);
    }
    
    // SELECT * FROM files WHERE path = ?
    if (normalizedSql.includes('select *') && normalizedSql.includes('files') && normalizedSql.includes('path')) {
      const [path] = params;
      return this.tables.files.find(f => f.path === path);
    }
    
    // SELECT * FROM files WHERE id = ?
    if (normalizedSql.includes('select *') && normalizedSql.includes('files') && normalizedSql.includes('id')) {
      const [id] = params;
      return this.tables.files.find(f => f.id === id);
    }

    // SELECT * FROM directories WHERE path = ?
    if (normalizedSql.includes('select *') && normalizedSql.includes('directories') && normalizedSql.includes('path')) {
      const [path] = params;
      return this.tables.directories.find(d => d.path === path);
    }

    // SELECT * FROM topics WHERE name = ?
    if (normalizedSql.includes('select *') && normalizedSql.includes('topics') && normalizedSql.includes('name')) {
      const [name] = params;
      return this.tables.topics.find(t => t.name === name);
    }

    // SELECT * FROM topics WHERE id = ?
    if (normalizedSql.includes('select *') && normalizedSql.includes('topics') && normalizedSql.includes('id')) {
      const [id] = params;
      return this.tables.topics.find(t => t.id === id);
    }
    
    // COUNT queries
    if (normalizedSql.includes('count(*)')) {
      if (normalizedSql.includes('files')) {
        return { count: this.tables.files.length };
      }
      if (normalizedSql.includes('chunks')) {
        return { count: this.tables.chunks.length };
      }
    }
    
    // SUM queries
    if (normalizedSql.includes('sum(size)')) {
      if (normalizedSql.includes('files')) {
        const total = this.tables.files.reduce((sum, f) => sum + f.size, 0);
        return { total };
      }
      if (normalizedSql.includes('chunks')) {
        const total = this.tables.chunks.reduce((sum, c) => sum + c.size, 0);
        return { total };
      }
    }
    
    return undefined;
  }

  _all(sql, params) {
    const normalizedSql = sql.trim().toLowerCase();
    
    // SELECT * FROM files ORDER BY added_at DESC
    if (normalizedSql.includes('select *') && normalizedSql.includes('files') && normalizedSql.includes('order by')) {
      return [...this.tables.files].sort((a, b) => b.added_at - a.added_at);
    }

    // SELECT * FROM directories ORDER BY added_at DESC
    if (normalizedSql.includes('select *') && normalizedSql.includes('directories') && normalizedSql.includes('order by')) {
      return [...this.tables.directories].sort((a, b) => b.added_at - a.added_at);
    }

    // SELECT * FROM topics
    if (normalizedSql.includes('select *') && normalizedSql.includes('topics')) {
      if (normalizedSql.includes('auto_join')) {
        return this.tables.topics.filter(t => t.auto_join === 1);
      }
      return [...this.tables.topics].sort((a, b) => b.created_at - a.created_at);
    }

    // SELECT * FROM topic_shares WHERE topic_id = ?
    if (normalizedSql.includes('select *') && normalizedSql.includes('topic_shares') && normalizedSql.includes('topic_id')) {
      const [topic_id] = params;
      return this.tables.topic_shares
        .filter(ts => ts.topic_id === topic_id)
        .sort((a, b) => b.shared_at - a.shared_at);
    }

    // SELECT topics with JOIN on topic_shares
    if (normalizedSql.includes('select t.*') && normalizedSql.includes('topic_shares')) {
      const [share_path] = params;
      const topicIds = this.tables.topic_shares
        .filter(ts => ts.share_path === share_path)
        .map(ts => ts.topic_id);
      return this.tables.topics.filter(t => topicIds.includes(t.id));
    }
    
    // SELECT file_chunks with JOIN
    if (normalizedSql.includes('file_chunks') && normalizedSql.includes('join')) {
      const [file_id] = params;
      const fileChunks = this.tables.file_chunks
        .filter(fc => fc.file_id === file_id)
        .map(fc => {
          const chunk = this.tables.chunks.find(c => c.hash === fc.chunk_hash);
          return {
            chunk_index: fc.chunk_index,
            chunk_hash: fc.chunk_hash,
            size: chunk ? chunk.size : 0
          };
        })
        .sort((a, b) => a.chunk_index - b.chunk_index);
      
      return fileChunks;
    }
    
    // SELECT files with chunk
    if (normalizedSql.includes('distinct') && normalizedSql.includes('file_chunks')) {
      const [chunk_hash] = params;
      const fileIds = this.tables.file_chunks
        .filter(fc => fc.chunk_hash === chunk_hash)
        .map(fc => fc.file_id);
      
      return this.tables.files.filter(f => fileIds.includes(f.id));
    }
    
    return [];
  }

  close() {
    // Nothing to close in mock
  }
}
