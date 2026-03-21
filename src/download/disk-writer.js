/**
 * Disk writer for download sessions
 * Handles file operations, chunk writing, and verification
 */

import fs from 'fs'
import { hashBuffer } from '../hash.js'

/**
 * DiskWriter - Manages file handle and chunk writes
 */
export class DiskWriter {
  constructor(outputPath, fileSize, chunkSize, totalChunks) {
    this.outputPath = outputPath
    this.fileSize = fileSize
    this.chunkSize = chunkSize
    this.totalChunks = totalChunks
    this.outputFd = null
  }

  /**
   * Initialize the output file (create/truncate)
   */
  async initializeFile() {
    if (fs.existsSync(this.outputPath)) {
      const stats = fs.statSync(this.outputPath)
      if (stats.size === this.fileSize) {
        return false // File exists with correct size
      }
    }
    
    const fd = fs.openSync(this.outputPath, 'w')
    try {
      fs.ftruncateSync(fd, this.fileSize)
    } finally {
      fs.closeSync(fd)
    }
    
    return true // File was created
  }

  /**
   * Open the output file for writing
   */
  async open() {
    if (this.outputFd) {
      return
    }
    this.outputFd = await fs.promises.open(this.outputPath, 'r+')
  }

  /**
   * Close the output file
   */
  async close() {
    if (!this.outputFd) {
      return
    }
    try {
      await this.outputFd.datasync()
    } catch {
      // ignore
    }
    try {
      await this.outputFd.close()
    } finally {
      this.outputFd = null
    }
  }

  /**
   * Write a chunk to disk
   * @param {Buffer} data - Chunk data
   * @param {number} offset - File offset
   * @returns {number} Bytes written
   */
  async writeChunk(data, offset) {
    if (!this.outputFd) {
      await this.open()
    }
    
    const writeLen = data.length
    if (offset + writeLen > this.fileSize) {
      throw new Error(`Write would exceed file bounds: offset=${offset} len=${writeLen} fileSize=${this.fileSize}`)
    }
    
    const { bytesWritten } = await this.outputFd.write(data, 0, writeLen, offset)
    if (bytesWritten !== writeLen) {
      throw new Error(`Short write: expected=${writeLen} got=${bytesWritten}`)
    }
    
    return bytesWritten
  }

  /**
   * Verify a chunk's hash
   * @param {Buffer} data - Chunk data
   * @param {string} expectedHash - Expected hash
   * @returns {Promise<boolean>}
   */
  async verifyChunk(data, expectedHash) {
    const actualHash = await hashBuffer(data)
    return actualHash === expectedHash
  }

  /**
   * Verify and write a chunk
   * @param {Buffer} data - Chunk data
   * @param {object} chunkMeta - Chunk metadata { hash, offset, size }
   * @returns {Promise<{ success: boolean, error?: Error }>}
   */
  async verifyAndWriteChunk(data, chunkMeta) {
    try {
      // Verify hash
      const actualHash = await hashBuffer(data)
      if (actualHash !== chunkMeta.hash) {
        return { success: false, error: new Error('Hash mismatch') }
      }
      
      // Write to disk
      await this.writeChunk(data, chunkMeta.offset)
      
      return { success: true }
    } catch (error) {
      return { success: false, error }
    }
  }

  /**
   * Read existing chunks and verify them
   * @param {Map} chunkStates - Map of chunkIndex -> ChunkMeta
   * @param {function} onVerified - Callback(chunkIndex, chunkSize) when verified
   * @returns {Promise<number>} Number of verified chunks
   */
  async verifyExistingChunks(chunkStates, onVerified) {
    const fd = await fs.promises.open(this.outputPath, 'r')
    let verified = 0
    
    try {
      for (const [index, chunk] of chunkStates) {
        try {
          const buffer = Buffer.allocUnsafe(chunk.size)
          await fd.read(buffer, 0, chunk.size, chunk.offset)
          
          const hash = await hashBuffer(buffer)
          
          if (hash === chunk.hash) {
            if (onVerified) {
              onVerified(index, chunk.size)
            }
            verified++
          }
        } catch {
          // Chunk verification failed, skip
        }
      }
    } finally {
      await fd.close()
    }
    
    return verified
  }

  /**
   * Verify the entire file's merkle root
   * @param {string} expectedRoot - Expected merkle root
   * @param {Array} chunkHashes - Array of expected chunk hashes
   * @param {function} getMerkleRootFn - Function to compute merkle root from hashes
   * @returns {Promise<{ valid: boolean, computed?: string, error?: Error }>}
   */
  async verifyFileMerkleRoot(expectedRoot, chunkHashes, getMerkleRootFn) {
    const fd = await fs.promises.open(this.outputPath, 'r')
    try {
      const leafHashes = []
      for (let i = 0; i < this.totalChunks; i++) {
        const offset = i * this.chunkSize
        const len = Math.min(this.chunkSize, Math.max(0, this.fileSize - offset))
        const buf = Buffer.allocUnsafe(len)
        const { bytesRead } = await fd.read(buf, 0, len, offset)
        const actualBuf = bytesRead < len ? buf.subarray(0, bytesRead) : buf
        const leafHash = await hashBuffer(actualBuf)
        leafHashes.push(leafHash)
      }
      
      const computed = await getMerkleRootFn(leafHashes)
      return { valid: computed === expectedRoot, computed }
    } catch (error) {
      return { valid: false, error }
    } finally {
      await fd.close()
    }
  }

  /**
   * Find first chunk that doesn't match expected hash
   * @param {Map} chunkStates - Map of chunkIndex -> ChunkMeta
   * @returns {Promise<{ index: number, expected: string, actual: string, offset: number, len: number } | null>}
   */
  async findFirstChunkMismatch(chunkStates) {
    const fd = await fs.promises.open(this.outputPath, 'r')
    try {
      for (const [i, chunk] of chunkStates) {
        const offset = i * this.chunkSize
        const len = Math.min(this.chunkSize, Math.max(0, this.fileSize - offset))
        const buf = Buffer.allocUnsafe(len)
        const { bytesRead } = await fd.read(buf, 0, len, offset)
        const actualBuf = bytesRead < len ? buf.subarray(0, bytesRead) : buf
        const actual = await hashBuffer(actualBuf)
        
        if (actual !== chunk.hash) {
          return { index: i, expected: chunk.hash, actual, offset, len: actualBuf.length }
        }
      }
      return null
    } finally {
      await fd.close()
    }
  }
}
