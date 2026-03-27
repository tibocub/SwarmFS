/**
 * Message codec for SwarmFS protocol
 * Uses compact-encoding for efficient binary serialization
 */

import c from 'compact-encoding'

// Protocol version
export const PROTOCOL_VERSION = 1

// Message types
export const MSG_TYPE = {
  REQUEST: 0x01,            // Request a chunk by hash
  OFFER: 0x02,              // Offer to provide chunk (with Merkle proof)
  DOWNLOAD: 0x03,           // Accept offer and start download
  CHUNK_DATA: 0x04,         // Actual chunk bytes
  CANCEL: 0x05,             // Cancel request
  ERROR: 0x06,              // Error response
  FILE_LIST_REQUEST: 0x07,  // Request list of shared files in topic
  FILE_LIST_RESPONSE: 0x08, // Response with shared files
  METADATA_REQUEST: 0x09,   // Request file metadata by merkle root
  METADATA_RESPONSE: 0x0a,  // Response with file metadata
  HAVE: 0x0b,               // Announce single chunk
  BITFIELD: 0x0c,           // Send complete bitfield
  BITFIELD_REQUEST: 0x0d,   // Request peer's bitfield
  SUBTREE_REQUEST: 0x0e,
  SUBTREE_DATA: 0x0f,
  SUBTREE_PROOF: 0x10
}

// ============================================================================
// Compact-encoding schemas
// ============================================================================

// Fixed-size 16-byte hex string (requestId)
const hex16 = {
  preencode(state, val) {
    state.end += 16
  },
  encode(state, val) {
    const buf = Buffer.from(val, 'hex')
    buf.copy(state.buffer, state.start)
    state.start += 16
  },
  decode(state) {
    const hex = state.buffer.subarray(state.start, state.start + 16).toString('hex')
    state.start += 16
    return hex
  }
}

// Fixed-size 32-byte hex string (hash/merkleRoot)
const hex32 = {
  preencode(state, val) {
    state.end += 32
  },
  encode(state, val) {
    const buf = Buffer.from(val, 'hex')
    buf.copy(state.buffer, state.start)
    state.start += 32
  },
  decode(state) {
    const hex = state.buffer.subarray(state.start, state.start + 32).toString('hex')
    state.start += 32
    return hex
  }
}

// 32-byte raw buffer (topicKey)
const raw32 = {
  preencode(state, val) {
    state.end += 32
  },
  encode(state, val) {
    val.copy(state.buffer, state.start)
    state.start += 32
  },
  decode(state) {
    const buf = state.buffer.subarray(state.start, state.start + 32)
    state.start += 32
    return buf
  }
}

// Variable-length string
const string = c.string

// Variable-length buffer
const buffer = c.buffer

// uint32
const uint32 = c.uint32

// uint16
const uint16 = c.uint16

// uint8
const uint8 = c.uint8

// ============================================================================
// Message schemas
// ============================================================================

// REQUEST: requestId, chunkHash
const requestSchema = {
  preencode(state, val) {
    hex16.preencode(state, val.requestId)
    hex32.preencode(state, val.chunkHash)
  },
  encode(state, val) {
    hex16.encode(state, val.requestId)
    hex32.encode(state, val.chunkHash)
  },
  decode(state) {
    return {
      requestId: hex16.decode(state),
      chunkHash: hex32.decode(state)
    }
  }
}

// OFFER: requestId, chunkHash, chunkSize
const offerSchema = {
  preencode(state, val) {
    hex16.preencode(state, val.requestId)
    hex32.preencode(state, val.chunkHash)
    uint32.preencode(state, val.chunkSize)
  },
  encode(state, val) {
    hex16.encode(state, val.requestId)
    hex32.encode(state, val.chunkHash)
    uint32.encode(state, val.chunkSize)
  },
  decode(state) {
    return {
      requestId: hex16.decode(state),
      chunkHash: hex32.decode(state),
      chunkSize: uint32.decode(state)
    }
  }
}

// DOWNLOAD: requestId, chunkHash
const downloadSchema = requestSchema

// CANCEL: requestId
const cancelSchema = {
  preencode(state, val) {
    hex16.preencode(state, val.requestId)
  },
  encode(state, val) {
    hex16.encode(state, val.requestId)
  },
  decode(state) {
    return {
      requestId: hex16.decode(state)
    }
  }
}

// ERROR: requestId, message
const errorSchema = {
  preencode(state, val) {
    hex16.preencode(state, val.requestId)
    string.preencode(state, val.message || '')
  },
  encode(state, val) {
    hex16.encode(state, val.requestId)
    string.encode(state, val.message || '')
  },
  decode(state) {
    return {
      requestId: hex16.decode(state),
      message: string.decode(state)
    }
  }
}

// FILE_LIST_REQUEST: requestId, topicKey (optional)
const fileListRequestSchema = {
  preencode(state, val) {
    hex16.preencode(state, val.requestId)
    uint8.preencode(state, 0) // flag byte
    if (val?.topicKey) raw32.preencode(state, val.topicKey)
  },
  encode(state, val) {
    hex16.encode(state, val.requestId)
    if (val?.topicKey) {
      uint8.encode(state, 1)
      raw32.encode(state, val.topicKey)
    } else {
      uint8.encode(state, 0)
    }
  },
  decode(state) {
    const requestId = hex16.decode(state)
    const hasTopicKey = uint8.decode(state)
    return {
      requestId,
      topicKey: hasTopicKey ? raw32.decode(state) : null
    }
  }
}

// File entry for FILE_LIST_RESPONSE
const fileEntrySchema = {
  preencode(state, val) {
    string.preencode(state, val.name)
    string.preencode(state, val.path)
    hex32.preencode(state, val.merkleRoot)
    uint32.preencode(state, val.size)
    uint32.preencode(state, val.chunks)
  },
  encode(state, val) {
    string.encode(state, val.name)
    string.encode(state, val.path)
    hex32.encode(state, val.merkleRoot)
    uint32.encode(state, val.size)
    uint32.encode(state, val.chunks)
  },
  decode(state) {
    return {
      name: string.decode(state),
      path: string.decode(state),
      merkleRoot: hex32.decode(state),
      size: uint32.decode(state),
      chunks: uint32.decode(state)
    }
  }
}

// FILE_LIST_RESPONSE: requestId, files[]
const fileListResponseSchema = {
  preencode(state, val) {
    hex16.preencode(state, val.requestId)
    uint32.preencode(state, val.files?.length || 0)
    for (const file of (val.files || [])) {
      fileEntrySchema.preencode(state, file)
    }
  },
  encode(state, val) {
    hex16.encode(state, val.requestId)
    uint32.encode(state, val.files?.length || 0)
    for (const file of (val.files || [])) {
      fileEntrySchema.encode(state, file)
    }
  },
  decode(state) {
    const requestId = hex16.decode(state)
    const count = uint32.decode(state)
    const files = []
    for (let i = 0; i < count; i++) {
      files.push(fileEntrySchema.decode(state))
    }
    return { requestId, files }
  }
}

// METADATA_REQUEST: merkleRoot
const metadataRequestSchema = {
  preencode(state, val) {
    hex32.preencode(state, val.merkleRoot)
  },
  encode(state, val) {
    hex32.encode(state, val.merkleRoot)
  },
  decode(state) {
    return {
      merkleRoot: hex32.decode(state)
    }
  }
}

// Vdir child entry schema (for METADATA_RESPONSE children array)
const vdirChildSchema = {
  preencode(state, val) {
    hex32.preencode(state, val.merkleRoot)
    uint8.preencode(state, val.type === 'vdir' ? 1 : 0) // 0=file, 1=vdir
    string.preencode(state, val.suggestedName || '')
    // For files: size (uint32)
    // For vdirs: hasChildren flag (uint8)
    if (val.type === 'vdir') {
      uint8.preencode(state, val.hasChildren ? 1 : 0)
    } else {
      uint32.preencode(state, val.size || 0)
    }
  },
  encode(state, val) {
    hex32.encode(state, val.merkleRoot)
    uint8.encode(state, val.type === 'vdir' ? 1 : 0)
    string.encode(state, val.suggestedName || '')
    if (val.type === 'vdir') {
      uint8.encode(state, val.hasChildren ? 1 : 0)
    } else {
      uint32.encode(state, val.size || 0)
    }
  },
  decode(state) {
    const merkleRoot = hex32.decode(state)
    const typeNum = uint8.decode(state)
    const type = typeNum === 1 ? 'vdir' : 'file'
    const suggestedName = string.decode(state) || null
    
    if (type === 'vdir') {
      const hasChildren = uint8.decode(state) === 1
      return { merkleRoot, type, suggestedName, hasChildren }
    } else {
      const size = uint32.decode(state)
      return { merkleRoot, type, suggestedName, size }
    }
  }
}

// METADATA_RESPONSE: Extended to support both files and vdirs
// Fields:
//   - requestId (required)
//   - merkleRoot (required)
//   - type: 'file' | 'vdir' (default 'file' for backward compat)
//   - suggestedName: string (optional)
//   - For files: size, chunks, chunkSize
//   - For vdirs: children[] (shallow, depth=1)
const metadataResponseSchema = {
  preencode(state, val) {
    hex16.preencode(state, val.requestId)
    hex32.preencode(state, val.merkleRoot)
    uint8.preencode(state, val.type === 'vdir' ? 1 : 0) // type flag
    string.preencode(state, val.suggestedName || '')
    
    if (val.type === 'vdir') {
      // Vdir: children array
      uint32.preencode(state, val.children?.length || 0)
      for (const child of (val.children || [])) {
        vdirChildSchema.preencode(state, child)
      }
    } else {
      // File: size, chunks, chunkSize (existing fields)
      uint32.preencode(state, val.size || 0)
      uint32.preencode(state, val.chunks || 0)
      uint32.preencode(state, val.chunkSize || 0)
    }
  },
  encode(state, val) {
    hex16.encode(state, val.requestId)
    hex32.encode(state, val.merkleRoot)
    uint8.encode(state, val.type === 'vdir' ? 1 : 0)
    string.encode(state, val.suggestedName || '')
    
    if (val.type === 'vdir') {
      uint32.encode(state, val.children?.length || 0)
      for (const child of (val.children || [])) {
        vdirChildSchema.encode(state, child)
      }
    } else {
      uint32.encode(state, val.size || 0)
      uint32.encode(state, val.chunks || 0)
      uint32.encode(state, val.chunkSize || 0)
    }
  },
  decode(state) {
    const requestId = hex16.decode(state)
    const merkleRoot = hex32.decode(state)
    const typeNum = uint8.decode(state)
    const type = typeNum === 1 ? 'vdir' : 'file'
    const suggestedName = string.decode(state) || null
    
    if (type === 'vdir') {
      const childCount = uint32.decode(state)
      const children = []
      for (let i = 0; i < childCount; i++) {
        children.push(vdirChildSchema.decode(state))
      }
      return { requestId, merkleRoot, type, suggestedName, children }
    } else {
      const size = uint32.decode(state)
      const chunks = uint32.decode(state)
      const chunkSize = uint32.decode(state)
      return { requestId, merkleRoot, type: 'file', suggestedName, size, chunks, chunkSize }
    }
  }
}

// HAVE: merkleRoot, chunkIndex
const haveSchema = {
  preencode(state, val) {
    hex32.preencode(state, val.merkleRoot)
    uint32.preencode(state, val.chunkIndex)
  },
  encode(state, val) {
    hex32.encode(state, val.merkleRoot)
    uint32.encode(state, val.chunkIndex)
  },
  decode(state) {
    return {
      merkleRoot: hex32.decode(state),
      chunkIndex: uint32.decode(state)
    }
  }
}

// BITFIELD: merkleRoot, bitfield (buffer)
const bitfieldSchema = {
  preencode(state, val) {
    hex32.preencode(state, val.merkleRoot)
    buffer.preencode(state, val.bitfield)
  },
  encode(state, val) {
    hex32.encode(state, val.merkleRoot)
    buffer.encode(state, val.bitfield)
  },
  decode(state) {
    return {
      merkleRoot: hex32.decode(state),
      bitfield: buffer.decode(state)
    }
  }
}

// BITFIELD_REQUEST: merkleRoot
const bitfieldRequestSchema = metadataRequestSchema

// SUBTREE_REQUEST: requestId, merkleRoot, startChunk, chunkCount, topicKey
const subtreeRequestSchema = {
  preencode(state, val) {
    hex16.preencode(state, val.requestId)
    hex32.preencode(state, val.merkleRoot)
    uint32.preencode(state, val.startChunk)
    uint16.preencode(state, val.chunkCount)
    uint8.preencode(state, 0) // flag byte for topicKey
    if (val.topicKey) raw32.preencode(state, val.topicKey)
  },
  encode(state, val) {
    hex16.encode(state, val.requestId)
    hex32.encode(state, val.merkleRoot)
    uint32.encode(state, val.startChunk)
    uint16.encode(state, val.chunkCount)
    if (val.topicKey) {
      uint8.encode(state, 1)
      raw32.encode(state, val.topicKey)
    } else {
      uint8.encode(state, 0)
    }
  },
  decode(state) {
    const requestId = hex16.decode(state)
    const merkleRoot = hex32.decode(state)
    const startChunk = uint32.decode(state)
    const chunkCount = uint16.decode(state)
    const hasTopicKey = uint8.decode(state)
    return {
      requestId,
      merkleRoot,
      startChunk,
      chunkCount,
      topicKey: hasTopicKey ? raw32.decode(state) : null
    }
  }
}

// SUBTREE_PROOF: requestId, merkleRoot, startChunk, chunkCount, level, index, node, proof[]
// Each proof step is { hash, isLeft }
const subtreeProofSchema = {
  preencode(state, val) {
    hex16.preencode(state, val.requestId)
    hex32.preencode(state, val.merkleRoot)
    uint32.preencode(state, val.startChunk)
    uint16.preencode(state, val.chunkCount)
    uint8.preencode(state, val.level)
    uint32.preencode(state, val.index)
    hex32.preencode(state, val.node)
    uint8.preencode(state, val.proof?.length || 0)
    for (const p of (val.proof || [])) {
      hex32.preencode(state, p.hash || p)
      uint8.preencode(state, p.isLeft ? 1 : 0)
    }
  },
  encode(state, val) {
    hex16.encode(state, val.requestId)
    hex32.encode(state, val.merkleRoot)
    uint32.encode(state, val.startChunk)
    uint16.encode(state, val.chunkCount)
    uint8.encode(state, val.level)
    uint32.encode(state, val.index)
    hex32.encode(state, val.node)
    uint8.encode(state, val.proof?.length || 0)
    for (const p of (val.proof || [])) {
      hex32.encode(state, p.hash || p)
      uint8.encode(state, p.isLeft ? 1 : 0)
    }
  },
  decode(state) {
    const requestId = hex16.decode(state)
    const merkleRoot = hex32.decode(state)
    const startChunk = uint32.decode(state)
    const chunkCount = uint16.decode(state)
    const level = uint8.decode(state)
    const index = uint32.decode(state)
    const node = hex32.decode(state)
    const proofLen = uint8.decode(state)
    const proof = []
    for (let i = 0; i < proofLen; i++) {
      const hash = hex32.decode(state)
      const isLeft = uint8.decode(state) === 1
      proof.push({ hash, isLeft })
    }
    return {
      requestId,
      merkleRoot,
      startChunk,
      chunkCount,
      level,
      index,
      node,
      proof
    }
  }
}

// Schema map by message type
const schemas = {
  [MSG_TYPE.REQUEST]: requestSchema,
  [MSG_TYPE.OFFER]: offerSchema,
  [MSG_TYPE.DOWNLOAD]: downloadSchema,
  [MSG_TYPE.CANCEL]: cancelSchema,
  [MSG_TYPE.ERROR]: errorSchema,
  [MSG_TYPE.FILE_LIST_REQUEST]: fileListRequestSchema,
  [MSG_TYPE.FILE_LIST_RESPONSE]: fileListResponseSchema,
  [MSG_TYPE.METADATA_REQUEST]: metadataRequestSchema,
  [MSG_TYPE.METADATA_RESPONSE]: metadataResponseSchema,
  [MSG_TYPE.HAVE]: haveSchema,
  [MSG_TYPE.BITFIELD]: bitfieldSchema,
  [MSG_TYPE.BITFIELD_REQUEST]: bitfieldRequestSchema,
  [MSG_TYPE.SUBTREE_REQUEST]: subtreeRequestSchema,
  [MSG_TYPE.SUBTREE_PROOF]: subtreeProofSchema
}

// ============================================================================
// Encode/Decode functions
// ============================================================================

/**
 * Encode a message to binary using compact-encoding
 * @param {number} type - Message type from MSG_TYPE
 * @param {object} payload - Message payload
 * @returns {Buffer} Encoded message
 */
export function encodeMessage(type, payload) {
  // CHUNK_DATA and SUBTREE_DATA use custom binary format (already optimized)
  if (type === MSG_TYPE.CHUNK_DATA) {
    return encodeChunkData(payload)
  }
  if (type === MSG_TYPE.SUBTREE_DATA) {
    return encodeSubtreeData(payload)
  }

  const schema = schemas[type]
  if (!schema) {
    // Fallback to JSON for unknown types
    const payloadJson = JSON.stringify(payload)
    const payloadBuffer = Buffer.from(payloadJson, 'utf8')
    const message = Buffer.allocUnsafe(6 + payloadBuffer.length)
    message.writeUInt8(PROTOCOL_VERSION, 0)
    message.writeUInt8(type, 1)
    message.writeUInt32BE(payloadBuffer.length, 2)
    payloadBuffer.copy(message, 6)
    return message
  }

  // Use compact-encoding
  const state = { start: 6, end: 6, buffer: null }
  schema.preencode(state, payload)
  
  state.buffer = Buffer.allocUnsafe(state.end)
  state.buffer.writeUInt8(PROTOCOL_VERSION, 0)
  state.buffer.writeUInt8(type, 1)
  state.buffer.writeUInt32BE(state.end - 6, 2)
  
  schema.encode(state, payload)
  return state.buffer
}

/**
 * Decode a message from binary
 * @param {Buffer} buffer - Raw message buffer
 * @returns {object} Decoded message { version, type, payload }
 */
export function decodeMessage(buffer) {
  if (buffer.length < 6) {
    throw new Error('Message too short')
  }
  
  const version = buffer.readUInt8(0)
  const type = buffer.readUInt8(1)
  const length = buffer.readUInt32BE(2)
  
  if (buffer.length < 6 + length) {
    throw new Error('Incomplete message')
  }

  // CHUNK_DATA and SUBTREE_DATA use custom binary format
  if (type === MSG_TYPE.CHUNK_DATA) {
    return decodeChunkData(buffer, version, type, length)
  }
  if (type === MSG_TYPE.SUBTREE_DATA) {
    return decodeSubtreeData(buffer, version, type, length)
  }

  const schema = schemas[type]
  if (!schema) {
    // Fallback to JSON for unknown types
    const payloadBuffer = buffer.subarray(6, 6 + length)
    const payload = JSON.parse(payloadBuffer.toString('utf8'))
    return { version, type, payload }
  }

  // Use compact-encoding
  const state = { start: 6, end: 6 + length, buffer }
  const payload = schema.decode(state)
  return { version, type, payload }
}

// ============================================================================
// Custom binary encoders for CHUNK_DATA and SUBTREE_DATA
// ============================================================================

function encodeChunkData(payload) {
  const { requestId, chunkHash, chunkData } = payload || {}
  if (typeof requestId !== 'string' || typeof chunkHash !== 'string' || !Buffer.isBuffer(chunkData)) {
    throw new TypeError('CHUNK_DATA payload must be { requestId: string, chunkHash: string, chunkData: Buffer }')
  }

  const requestIdBytes = Buffer.from(requestId, 'hex')
  const chunkHashBytes = Buffer.from(chunkHash, 'hex')
  if (requestIdBytes.length !== 16) {
    throw new Error(`Invalid requestId hex length: expected 16 bytes, got ${requestIdBytes.length}`)
  }
  if (chunkHashBytes.length !== 32) {
    throw new Error(`Invalid chunkHash hex length: expected 32 bytes, got ${chunkHashBytes.length}`)
  }

  const payloadLen = 1 + 16 + 32 + 4 + chunkData.length
  const message = Buffer.allocUnsafe(6 + payloadLen)
  message.writeUInt8(PROTOCOL_VERSION, 0)
  message.writeUInt8(MSG_TYPE.CHUNK_DATA, 1)
  message.writeUInt32BE(payloadLen, 2)

  let off = 6
  message.writeUInt8(0x01, off)
  off += 1
  requestIdBytes.copy(message, off)
  off += 16
  chunkHashBytes.copy(message, off)
  off += 32
  message.writeUInt32BE(chunkData.length, off)
  off += 4
  chunkData.copy(message, off)
  return message
}

function decodeChunkData(buffer, version, type, length) {
  const payloadBuffer = buffer.subarray(6, 6 + length)
  
  if (payloadBuffer.length < 1 + 16 + 32 + 4) {
    throw new Error('Invalid CHUNK_DATA payload (too short)')
  }
  if (payloadBuffer[0] !== 0x01) {
    throw new Error('Invalid CHUNK_DATA payload (missing magic byte)')
  }

  const requestId = payloadBuffer.subarray(1, 17).toString('hex')
  const chunkHash = payloadBuffer.subarray(17, 49).toString('hex')
  const dataLen = payloadBuffer.readUInt32BE(49)
  const expected = 1 + 16 + 32 + 4 + dataLen
  if (payloadBuffer.length !== expected) {
    throw new Error(`Invalid CHUNK_DATA payload length: expected ${expected}, got ${payloadBuffer.length}`)
  }
  const chunkData = payloadBuffer.subarray(53, 53 + dataLen)

  return {
    version,
    type,
    payload: {
      requestId,
      chunkHash,
      chunkData
    }
  }
}

function encodeSubtreeData(payload) {
  const { requestId, merkleRoot, startChunk, chunkCount, data } = payload || {}
  if (typeof requestId !== 'string' || typeof merkleRoot !== 'string' || !Number.isInteger(startChunk) || !Number.isInteger(chunkCount) || !Buffer.isBuffer(data)) {
    throw new TypeError('SUBTREE_DATA payload must be { requestId: string, merkleRoot: string, startChunk: number, chunkCount: number, data: Buffer }')
  }

  const requestIdBytes = Buffer.from(requestId, 'hex')
  const merkleRootBytes = Buffer.from(merkleRoot, 'hex')
  if (requestIdBytes.length !== 16) {
    throw new Error(`Invalid requestId hex length: expected 16 bytes, got ${requestIdBytes.length}`)
  }
  if (merkleRootBytes.length !== 32) {
    throw new Error(`Invalid merkleRoot hex length: expected 32 bytes, got ${merkleRootBytes.length}`)
  }

  const payloadLen = 1 + 16 + 32 + 4 + 2 + 4 + data.length
  const message = Buffer.allocUnsafe(6 + payloadLen)
  message.writeUInt8(PROTOCOL_VERSION, 0)
  message.writeUInt8(MSG_TYPE.SUBTREE_DATA, 1)
  message.writeUInt32BE(payloadLen, 2)

  let off = 6
  message.writeUInt8(0x01, off)
  off += 1
  requestIdBytes.copy(message, off)
  off += 16
  merkleRootBytes.copy(message, off)
  off += 32
  message.writeUInt32BE(startChunk >>> 0, off)
  off += 4
  message.writeUInt16BE(chunkCount & 0xffff, off)
  off += 2
  message.writeUInt32BE(data.length >>> 0, off)
  off += 4
  data.copy(message, off)
  return message
}

function decodeSubtreeData(buffer, version, type, length) {
  const payloadBuffer = buffer.subarray(6, 6 + length)
  
  if (payloadBuffer.length < 1 + 16 + 32 + 4 + 2 + 4) {
    throw new Error('Invalid SUBTREE_DATA payload (too short)')
  }
  if (payloadBuffer[0] !== 0x01) {
    throw new Error('Invalid SUBTREE_DATA payload (missing magic byte)')
  }

  const requestId = payloadBuffer.subarray(1, 17).toString('hex')
  const merkleRoot = payloadBuffer.subarray(17, 49).toString('hex')
  const startChunk = payloadBuffer.readUInt32BE(49)
  const chunkCount = payloadBuffer.readUInt16BE(53)
  const dataLen = payloadBuffer.readUInt32BE(55)
  const expected = 1 + 16 + 32 + 4 + 2 + 4 + dataLen
  if (payloadBuffer.length !== expected) {
    throw new Error(`Invalid SUBTREE_DATA payload length: expected ${expected}, got ${payloadBuffer.length}`)
  }
  const data = payloadBuffer.subarray(59, 59 + dataLen)

  return {
    version,
    type,
    payload: {
      requestId,
      merkleRoot,
      startChunk,
      chunkCount,
      data
    }
  }
}
