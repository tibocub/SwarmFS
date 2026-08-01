/**
 * Protocol module index
 * Re-exports all protocol components
 */

export { PROTOCOL_VERSION, MSG_TYPE, encodeMessage, decodeMessage } from './message-codec.js'
export { MerkleTreeCache } from './merkle-cache.js'
export { RequestTracker } from './request-tracker.js'
export { SubtreeServer } from './subtree-server.js'
