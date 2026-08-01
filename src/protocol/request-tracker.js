/**
 * Request tracker for Protocol layer
 * Manages active requests, downloads, file list requests, and metadata requests
 */

const DEFAULT_TIMEOUT = 30000
const DEFAULT_FILE_LIST_TIMEOUT = 5000
const DEFAULT_METADATA_TIMEOUT = 10000

/**
 * RequestTracker - encapsulates all active request tracking
 */
export class RequestTracker {
  constructor() {
    // Track active requests
    this.activeRequests = new Map()       // requestId -> { chunkHash, timeout, offers, topicKey, timestamp }
    this.activeDownloads = new Map()      // requestId -> { chunkHash, peerId, expectedSize, receivedSize, startedAt }
    this.activeFileListRequests = new Map() // requestId -> { topicKey, timeout, timestamp }
    this.activeMetadataRequests = new Map() // requestId -> { merkleRoot, topicKey, timeout, timestamp }
  }

  /**
   * Create a new chunk request
   * @param {string} requestId - Unique request ID
   * @param {string} chunkHash - Hash of chunk being requested
   * @param {string} topicKey - Topic key for broadcast
   * @param {number} timeout - Timeout in ms
   * @param {function} onTimeout - Callback when request times out
   * @returns {object} Request object
   */
  createRequest(requestId, chunkHash, topicKey, timeout = DEFAULT_TIMEOUT, onTimeout = null) {
    const request = {
      chunkHash,
      topicKey,
      offers: [],
      timestamp: Date.now(),
      timeout: onTimeout ? setTimeout(() => onTimeout(requestId, chunkHash), timeout) : null
    }
    this.activeRequests.set(requestId, request)
    return request
  }

  /**
   * Get a request by ID
   * @param {string} requestId
   * @returns {object|undefined}
   */
  getRequest(requestId) {
    return this.activeRequests.get(requestId)
  }

  /**
   * Add an offer to a request
   * @param {string} requestId
   * @param {object} offer - { peerId, conn, chunkSize, timestamp }
   */
  addOffer(requestId, offer) {
    const request = this.activeRequests.get(requestId)
    if (request) {
      offer.timestamp = offer.timestamp || Date.now()
      request.offers.push(offer)
    }
  }

  /**
   * Get offers for a request
   * @param {string} requestId
   * @returns {array}
   */
  getOffers(requestId) {
    const request = this.activeRequests.get(requestId)
    return request?.offers || []
  }

  /**
   * Cancel a request
   * @param {string} requestId
   */
  cancelRequest(requestId) {
    const request = this.activeRequests.get(requestId)
    if (request?.timeout) {
      clearTimeout(request.timeout)
    }
    this.activeRequests.delete(requestId)
    this.activeDownloads.delete(requestId)
  }

  /**
   * Create a download entry
   * @param {string} requestId
   * @param {string} chunkHash
   * @param {string} peerId
   * @param {number} expectedSize
   */
  createDownload(requestId, chunkHash, peerId, expectedSize) {
    this.activeDownloads.set(requestId, {
      chunkHash,
      peerId,
      expectedSize,
      receivedSize: 0,
      startedAt: Date.now()
    })
  }

  /**
   * Get a download by ID
   * @param {string} requestId
   * @returns {object|undefined}
   */
  getDownload(requestId) {
    return this.activeDownloads.get(requestId)
  }

  /**
   * Update download progress
   * @param {string} requestId
   * @param {number} receivedSize
   */
  updateDownloadProgress(requestId, receivedSize) {
    const download = this.activeDownloads.get(requestId)
    if (download) {
      download.receivedSize = receivedSize
    }
  }

  /**
   * Complete a download (removes from active)
   * @param {string} requestId
   */
  completeDownload(requestId) {
    const request = this.activeRequests.get(requestId)
    if (request?.timeout) {
      clearTimeout(request.timeout)
    }
    this.activeRequests.delete(requestId)
    this.activeDownloads.delete(requestId)
  }

  /**
   * Create a file list request
   * @param {string} requestId
   * @param {string} topicKey
   * @param {number} timeout
   * @param {function} onTimeout
   */
  createFileListRequest(requestId, topicKey, timeout = DEFAULT_FILE_LIST_TIMEOUT, onTimeout = null) {
    this.activeFileListRequests.set(requestId, {
      topicKey,
      timestamp: Date.now(),
      timeout: onTimeout ? setTimeout(() => onTimeout(requestId), timeout) : null
    })
  }

  /**
   * Get a file list request
   * @param {string} requestId
   * @returns {object|undefined}
   */
  getFileListRequest(requestId) {
    return this.activeFileListRequests.get(requestId)
  }

  /**
   * Complete a file list request
   * @param {string} requestId
   */
  completeFileListRequest(requestId) {
    const request = this.activeFileListRequests.get(requestId)
    if (request?.timeout) {
      clearTimeout(request.timeout)
    }
    this.activeFileListRequests.delete(requestId)
  }

  /**
   * Create a metadata request
   * @param {string} requestId
   * @param {string} merkleRoot
   * @param {string} topicKey
   * @param {number} timeout
   * @param {function} onTimeout
   */
  createMetadataRequest(requestId, merkleRoot, topicKey, timeout = DEFAULT_METADATA_TIMEOUT, onTimeout = null) {
    this.activeMetadataRequests.set(requestId, {
      merkleRoot,
      topicKey,
      timestamp: Date.now(),
      timeout: onTimeout ? setTimeout(() => onTimeout(requestId, merkleRoot), timeout) : null
    })
  }

  /**
   * Get a metadata request
   * @param {string} requestId
   * @returns {object|undefined}
   */
  getMetadataRequest(requestId) {
    return this.activeMetadataRequests.get(requestId)
  }

  /**
   * Complete a metadata request
   * @param {string} requestId
   */
  completeMetadataRequest(requestId) {
    const request = this.activeMetadataRequests.get(requestId)
    if (request?.timeout) {
      clearTimeout(request.timeout)
    }
    this.activeMetadataRequests.delete(requestId)
  }

  /**
   * Cleanup expired requests (called periodically)
   * @param {number} maxAge - Max age in ms
   */
  cleanup(maxAge = 60000) {
    const now = Date.now()

    for (const [requestId, request] of this.activeRequests) {
      if (now - request.timestamp > maxAge) {
        if (request.timeout) clearTimeout(request.timeout)
        this.activeRequests.delete(requestId)
      }
    }

    for (const [requestId, request] of this.activeFileListRequests) {
      if (now - request.timestamp > maxAge) {
        if (request.timeout) clearTimeout(request.timeout)
        this.activeFileListRequests.delete(requestId)
      }
    }

    for (const [requestId, request] of this.activeMetadataRequests) {
      if (now - request.timestamp > maxAge) {
        if (request.timeout) clearTimeout(request.timeout)
        this.activeMetadataRequests.delete(requestId)
      }
    }
  }

  /**
   * Clear all requests (on close)
   */
  clear() {
    for (const [, request] of this.activeRequests) {
      if (request.timeout) clearTimeout(request.timeout)
    }
    for (const [, request] of this.activeFileListRequests) {
      if (request.timeout) clearTimeout(request.timeout)
    }
    for (const [, request] of this.activeMetadataRequests) {
      if (request.timeout) clearTimeout(request.timeout)
    }
    this.activeRequests.clear()
    this.activeDownloads.clear()
    this.activeFileListRequests.clear()
    this.activeMetadataRequests.clear()
  }

  /**
   * Get stats
   * @returns {object}
   */
  getStats() {
    return {
      activeRequests: this.activeRequests.size,
      activeDownloads: this.activeDownloads.size,
      activeFileListRequests: this.activeFileListRequests.size,
      activeMetadataRequests: this.activeMetadataRequests.size
    }
  }
}
