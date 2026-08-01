/**
 * Download session state management
 * Tracks session state, in-flight requests, and progress
 */

/**
 * SessionState - Manages download session state machine
 */
export class SessionState {
  constructor(totalChunks, fileSize) {
    // Progress tracking
    this.totalChunks = totalChunks
    this.fileSize = fileSize
    this.chunksVerified = 0
    this.bytesDownloaded = 0
    this.chunksInFlight = 0
    
    // Concurrency control
    this.maxConcurrentRequests = 4  // Start low, increases with peers
    this.requestTimeout = 30000
    
    // Request tracking
    this.activeRequestIds = new Set()
    this.subtreeRequestMap = new Map()    // requestId -> chunkIndices[]
    this.subtreeTimeouts = new Map()      // requestId -> Timeout
    this.requestToChunkIndex = new Map()  // requestId -> chunkIndex
    
    // Subtree proof/data pairing
    this.pendingSubtreeProofs = new Map() // requestId -> proofInfo
    this.pendingSubtreeData = new Map()   // requestId -> dataInfo
    
    // Partial chunk assembly (for streaming writes)
    this.partialChunks = new Map()        // chunkKey -> { data, written, expectedSize }
    
    // Session state
    this.running = false
    this.lastPeerCount = 0
  }

  /**
   * Check if download is complete
   * @returns {boolean}
   */
  isComplete() {
    return this.chunksVerified === this.totalChunks
  }

  /**
   * Check if session can accept more requests
   * @returns {boolean}
   */
  canRequest() {
    return this.chunksInFlight < this.maxConcurrentRequests
  }

  /**
   * Get available request slots
   * @returns {number}
   */
  getAvailableSlots() {
    return Math.max(0, this.maxConcurrentRequests - this.chunksInFlight)
  }

  /**
   * Register a subtree request
   * @param {string} requestId
   * @param {number[]} chunkIndices
   * @param {number} timeoutMs
   * @param {function} onTimeout
   */
  registerSubtreeRequest(requestId, chunkIndices, timeoutMs, onTimeout) {
    this.activeRequestIds.add(requestId)
    this.subtreeRequestMap.set(requestId, chunkIndices)
    this.chunksInFlight++
    
    const timeout = setTimeout(() => onTimeout(requestId), timeoutMs)
    this.subtreeTimeouts.set(requestId, timeout)
  }

  /**
   * Complete a subtree request
   * @param {string} requestId
   */
  completeSubtreeRequest(requestId) {
    this.activeRequestIds.delete(requestId)
    this.subtreeRequestMap.delete(requestId)
    this.pendingSubtreeProofs.delete(requestId)
    this.pendingSubtreeData.delete(requestId)
    
    const timeout = this.subtreeTimeouts.get(requestId)
    if (timeout) {
      clearTimeout(timeout)
      this.subtreeTimeouts.delete(requestId)
    }
    
    this.chunksInFlight = Math.max(0, this.chunksInFlight - 1)
  }

  /**
   * Timeout a subtree request
   * @param {string} requestId
   * @returns {number[]} Chunk indices that were affected
   */
  timeoutSubtreeRequest(requestId) {
    const indices = this.subtreeRequestMap.get(requestId) || []
    this.completeSubtreeRequest(requestId)
    return indices
  }

  /**
   * Update max concurrent requests based on peer count
   * @param {number} peerCount
   * @returns {number} New max value
   */
  updateMaxConcurrentRequests(peerCount) {
    if (peerCount === this.lastPeerCount) {
      return this.maxConcurrentRequests
    }
    this.lastPeerCount = peerCount
    
    // Adaptive formula: min(50, max(4, peerCount * 8))
    this.maxConcurrentRequests = Math.min(50, Math.max(4, peerCount * 8))
    return this.maxConcurrentRequests
  }

  /**
   * Record chunk verified
   * @param {number} chunkSize
   */
  recordChunkVerified(chunkSize) {
    this.chunksVerified = Math.min(this.totalChunks, this.chunksVerified + 1)
    this.bytesDownloaded = Math.min(this.fileSize, this.bytesDownloaded + chunkSize)
  }

  /**
   * Get progress percentage
   * @returns {number}
   */
  getProgress() {
    return (this.chunksVerified / this.totalChunks) * 100
  }

  /**
   * Get progress info for events
   * @returns {object}
   */
  getProgressInfo() {
    return {
      verified: this.chunksVerified,
      total: this.totalChunks,
      bytes: this.bytesDownloaded,
      percentage: this.getProgress()
    }
  }

  /**
   * Clear all timeouts and reset state
   */
  clear() {
    // Clear subtree timeouts
    for (const timeout of this.subtreeTimeouts.values()) {
      clearTimeout(timeout)
    }
    
    // Clear partial chunks
    this.partialChunks.clear()
    
    // Clear tracking maps
    this.activeRequestIds.clear()
    this.subtreeRequestMap.clear()
    this.subtreeTimeouts.clear()
    this.requestToChunkIndex.clear()
    this.pendingSubtreeProofs.clear()
    this.pendingSubtreeData.clear()
    
    this.chunksInFlight = 0
    this.running = false
  }
}
