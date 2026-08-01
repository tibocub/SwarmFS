/**
 * Chunk state management for download sessions
 * Defines chunk states and metadata tracking
 */

/**
 * Chunk state enum - represents the lifecycle of a chunk
 */
export const ChunkState = {
  MISSING: 'missing',     // Not yet requested
  REQUESTED: 'requested', // Request sent, waiting for response
  RECEIVED: 'received',   // Data received, pending verification
  VERIFIED: 'verified',   // Hash verified, written to disk
  FAILED: 'failed'        // Failed verification or timeout
}

/**
 * ChunkMeta - Tracks metadata and state for a single chunk
 */
export class ChunkMeta {
  constructor(index, hash, offset, size) {
    // Immutable chunk properties
    this.index = index
    this.hash = hash
    this.offset = offset
    this.size = size
    
    // State tracking
    this.state = ChunkState.MISSING
    this.requestedFrom = null
    this.requestedAt = null
    this.requestId = null
    this.retryCount = 0
    this.data = null
    this.timeout = null
    
    // Endgame mode tracking
    this.endgameRequests = null     // Map<peerId, requestId>
    this.endgameTimeouts = null     // Map<requestId, timeout>
  }

  /**
   * Check if chunk is available for request
   * @returns {boolean}
   */
  isRequestable() {
    return this.state === ChunkState.MISSING || this.state === ChunkState.FAILED
  }

  /**
   * Check if chunk is already verified
   * @returns {boolean}
   */
  isVerified() {
    return this.state === ChunkState.VERIFIED
  }

  /**
   * Check if chunk is currently in flight
   * @returns {boolean}
   */
  isInFlight() {
    return this.state === ChunkState.REQUESTED || this.state === ChunkState.RECEIVED
  }

  /**
   * Mark chunk as requested
   * @param {string} peerId
   * @param {string} requestId
   */
  markRequested(peerId, requestId) {
    this.state = ChunkState.REQUESTED
    this.requestedFrom = peerId
    this.requestedAt = Date.now()
    this.requestId = requestId
  }

  /**
   * Mark chunk as received
   * @param {Buffer} data
   */
  markReceived(data) {
    this.state = ChunkState.RECEIVED
    this.data = Buffer.isBuffer(data)
      ? data
      : (typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data))
  }

  /**
   * Mark chunk as verified
   */
  markVerified() {
    this.state = ChunkState.VERIFIED
    this.data = null
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = null
    }
  }

  /**
   * Mark chunk as failed
   */
  markFailed() {
    this.state = ChunkState.FAILED
    this.data = null
    this.retryCount++
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = null
    }
  }

  /**
   * Clear all timeouts
   */
  clearTimeouts() {
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = null
    }
    if (this.endgameTimeouts && this.endgameTimeouts.size > 0) {
      for (const timeout of this.endgameTimeouts.values()) {
        clearTimeout(timeout)
      }
      this.endgameTimeouts.clear()
    }
  }

  /**
   * Add endgame request
   * @param {string} peerId
   * @param {string} requestId
   * @param {function} onTimeout
   * @param {number} timeoutMs
   */
  addEndgameRequest(peerId, requestId, onTimeout, timeoutMs) {
    if (!this.endgameRequests) {
      this.endgameRequests = new Map()
      this.endgameTimeouts = new Map()
    }
    this.endgameRequests.set(peerId, requestId)
    const timeout = setTimeout(() => onTimeout(requestId, peerId), timeoutMs)
    this.endgameTimeouts.set(requestId, timeout)
  }

  /**
   * Cancel all endgame requests except the successful one
   * @param {string} successfulRequestId
   * @param {function} cancelFn - Function to cancel a request by requestId
   */
  cancelOtherEndgameRequests(successfulRequestId, cancelFn) {
    if (!this.endgameRequests) return
    
    for (const [otherPeerId, otherRequestId] of this.endgameRequests) {
      if (otherRequestId !== successfulRequestId) {
        cancelFn(otherRequestId)
        const timeout = this.endgameTimeouts?.get(otherRequestId)
        if (timeout) {
          clearTimeout(timeout)
        }
      }
    }
    this.endgameRequests.clear()
    this.endgameTimeouts?.clear()
  }
}
