/**
 * Subtree server for Protocol layer
 * Handles concurrent subtree serving with backpressure
 */

import fs from 'fs'
import { buildMerkleTree, generateSubtreeProofFromTree } from '../merkle.js'
import { encodeMessage, MSG_TYPE } from './message-codec.js'

const DEFAULT_MAX_CONCURRENT = 8
const DEFAULT_MAX_QUEUE_SIZE = 100
const BACKPRESSURE_THRESHOLD = 4 * 1024 * 1024 // 4MB pending
const CHUNK_SIZE = 1024 * 1024 // 1MB

/**
 * SubtreeServer - manages concurrent subtree serving with backpressure
 */
export class SubtreeServer {
  constructor(db, merkleCache, options = {}) {
    this.db = db
    this.merkleCache = merkleCache
    this.maxConcurrent = options.maxConcurrent || DEFAULT_MAX_CONCURRENT
    this.maxQueueSize = options.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE

    // Backpressure state
    this._activeServes = 0
    this._queue = []
    this._activeRequests = new Map() // requestId -> { cancelled: boolean }
  }

  /**
   * Handle incoming subtree request
   * @param {object} conn - Connection
   * @param {string} peerId - Peer ID
   * @param {object} payload - Request payload
   * @param {object} context - { mux, beginMsg, partMsg, backpressureState, enqueueWrite, sendError }
   * @returns {Promise<void>}
   */
  async handleRequest(conn, peerId, payload, context) {
    const { requestId, merkleRoot, startChunk, chunkCount, topicKey } = payload || {}
    
    if (typeof requestId !== 'string' || typeof merkleRoot !== 'string' || !Number.isInteger(startChunk) || !Number.isInteger(chunkCount)) {
      context.sendError(conn, requestId || '00000000000000000000000000000000', 'Invalid subtree request')
      return
    }

    // Backpressure: queue request if at capacity
    if (this._activeServes >= this.maxConcurrent) {
      if (this._queue.length >= this.maxQueueSize) {
        console.warn(`[SUBTREE] Request dropped - queue full (${this._queue.length}), active=${this._activeServes}/${this.maxConcurrent}`)
        context.sendError(conn, requestId, 'Server overloaded, please retry')
        return
      }
      this._queue.push({ conn, peerId, payload, context })
      return
    }

    this._activeServes++
    this._activeRequests.set(requestId, { cancelled: false })
    
    try {
      await this._serve(conn, peerId, payload, context)
    } finally {
      this._activeServes--
      this._activeRequests.delete(requestId)
      
      // Process next queued request if any
      if (this._queue.length > 0 && this._activeServes < this.maxConcurrent) {
        const next = this._queue.shift()
        this.handleRequest(next.conn, next.peerId, next.payload, next.context).catch(() => {})
      }
    }
  }

  /**
   * Cancel an active subtree request
   * @param {string} requestId
   */
  cancel(requestId) {
    const serveState = this._activeRequests.get(requestId)
    if (serveState) {
      serveState.cancelled = true
    }
    
    // Remove from queue if pending
    const queueIndex = this._queue.findIndex(item => item.payload?.requestId === requestId)
    if (queueIndex !== -1) {
      this._queue.splice(queueIndex, 1)
    }
  }

  /**
   * Serve a subtree request
   * @private
   */
  async _serve(conn, peerId, payload, context) {
    const { requestId, merkleRoot, startChunk, chunkCount, topicKey } = payload || {}
    
    console.log(`[SUBTREE] Request from ${peerId.substring(0, 8)} merkleRoot=${merkleRoot?.substring(0, 16)}...`)
    
    // Find ALL files with this merkle root (content-addressed, sharing doesn't matter)
    const candidates = this.db.getFilesByMerkleRoot(merkleRoot)
    if (!candidates || candidates.length === 0) {
      console.log(`[SUBTREE] No files found with merkle root ${merkleRoot?.substring(0, 16)}...`)
      context.sendError(conn, requestId, 'File not found')
      return
    }
    
    // Find first file that exists on disk
    let file = null
    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate.path, fs.constants.R_OK)
        file = candidate
        console.log(`[SUBTREE] Found available file: ${candidate.path}`)
        break
      } catch {
        console.log(`[SUBTREE] File not accessible, skipping: ${candidate.path}`)
      }
    }
    
    if (!file) {
      console.log(`[SUBTREE] No accessible files found for merkle root ${merkleRoot?.substring(0, 16)}...`)
      context.sendError(conn, requestId, 'File not found')
      return
    }

    const endChunk = Math.min(file.chunk_count - 1, startChunk + chunkCount - 1)
    if (startChunk < 0 || startChunk >= file.chunk_count || endChunk < startChunk) {
      context.sendError(conn, requestId, 'Invalid subtree range')
      return
    }

    // Subtree proofs require aligned power-of-two subtrees.
    const isPowerOfTwo = (n) => n > 0 && (n & (n - 1)) === 0
    if (!isPowerOfTwo(chunkCount) || (startChunk % chunkCount) !== 0) {
      context.sendError(conn, requestId, 'Subtree request must be aligned power-of-two')
      return
    }

    // Fetch only the chunks we need for serving
    const slice = this.db.getFileChunksRange(file.id, startChunk, endChunk)

    let total = 0
    for (const ch of slice) {
      total += ch.chunk_size
    }

    // Send a subtree proof first
    try {
      let tree = this.merkleCache.get(merkleRoot)
      if (!tree) {
        const chunks = this.db.getFileChunks(file.id)
        const leafHashes = chunks.map((ch) => ch.chunk_hash)
        tree = await buildMerkleTree(leafHashes)
        this.merkleCache.set(merkleRoot, tree)
      }

      const level = Math.round(Math.log2(chunkCount))
      const index = Math.floor(startChunk / chunkCount)
      const proofObj = generateSubtreeProofFromTree(tree, level, index)

      const proofMsg = encodeMessage(MSG_TYPE.SUBTREE_PROOF, {
        requestId,
        merkleRoot,
        startChunk,
        chunkCount,
        level: proofObj.level,
        index: proofObj.index,
        node: proofObj.node,
        proof: proofObj.proof
      })

      context.enqueueWrite(conn, proofMsg)
    } catch (err) {
      context.sendError(conn, requestId, `Failed to generate subtree proof: ${err?.message || String(err)}`)
      return
    }

    // Stream chunks via Protomux
    const { beginMsg, partMsg, backpressureState, stream } = context
    if (!beginMsg || !partMsg) {
      context.sendError(conn, requestId, 'Protomux required for streaming')
      return
    }

    const fd = fs.openSync(file.path, 'r')
    console.log(`[SUBTREE] Serving ${slice.length} chunks from ${file.path} for req=${requestId.substring(0, 8)}`)
    
    try {
      console.log(`[SUBTREE] Sending BEGIN for req=${requestId.substring(0, 8)} chunks=${slice.length} totalBytes=${total}`)
      beginMsg.send(JSON.stringify({ requestId, merkleRoot, startChunk, chunkCount: slice.length, totalBytes: total }))

      const requestIdBytes = Buffer.from(requestId, 'hex')
      
      // Zero-copy: reuse a single 1MB buffer for all reads
      const chunkBuf = Buffer.allocUnsafe(16 + CHUNK_SIZE)
      requestIdBytes.copy(chunkBuf, 0)

      for (const ch of slice) {
        // Check if this request was cancelled
        const serveState = this._activeRequests.get(requestId)
        if (serveState?.cancelled) {
          console.log(`[SUBTREE] Request ${requestId.substring(0, 8)} cancelled, stopping stream`)
          break
        }
        
        console.log(`[SUBTREE] Streaming chunk ${ch.chunk_index} size=${ch.chunk_size}`)
        let remaining = ch.chunk_size
        let localOff = 0
        
        while (remaining > 0) {
          // Backpressure check
          if (backpressureState && backpressureState.pendingBytes >= BACKPRESSURE_THRESHOLD && stream?.writable !== false) {
            console.log(`[SUBTREE] Backpressure wait: ${backpressureState.pendingBytes} bytes pending`)
            await new Promise(resolve => { backpressureState.drainCallback = resolve })
          }
          
          const toRead = Math.min(remaining, CHUNK_SIZE)
          const bytesRead = fs.readSync(fd, chunkBuf, 16, toRead, ch.chunk_offset + localOff)
          if (bytesRead <= 0) {
            throw new Error(`Short read: expected=${ch.chunk_size} got=${localOff} chunk_index=${ch.chunk_index}`)
          }
          localOff += bytesRead
          remaining -= bytesRead
          
          // Send immediately - no accumulation
          partMsg.send(chunkBuf.subarray(0, 16 + bytesRead))
          if (backpressureState) backpressureState.pendingBytes += bytesRead
        }
      }
    } catch (err) {
      context.sendError(conn, requestId, `Failed to read subtree data: ${err?.message || String(err)}`)
    } finally {
      fs.closeSync(fd)
    }
  }

  /**
   * Get stats
   * @returns {object}
   */
  getStats() {
    return {
      activeServes: this._activeServes,
      queueLength: this._queue.length,
      maxConcurrent: this.maxConcurrent
    }
  }
}
