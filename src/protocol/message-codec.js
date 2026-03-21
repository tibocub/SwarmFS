/**
 * Message codec for SwarmFS protocol
 * Handles encoding and decoding of protocol messages
 */

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

/**
 * Encode a message to binary
 * @param {number} type - Message type from MSG_TYPE
 * @param {object} payload - Message payload
 * @returns {Buffer} Encoded message
 */
export function encodeMessage(type, payload) {
  if (type === MSG_TYPE.CHUNK_DATA) {
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
    message.writeUInt8(type, 1)
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

  if (type === MSG_TYPE.SUBTREE_DATA) {
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
    message.writeUInt8(type, 1)
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

  // Default: JSON-encoded payload
  const payloadJson = JSON.stringify(payload);
  const payloadBuffer = Buffer.from(payloadJson, 'utf8');
  
  // Message format: [version:1][type:1][length:4][payload:n]
  const message = Buffer.allocUnsafe(6 + payloadBuffer.length);
  message.writeUInt8(PROTOCOL_VERSION, 0);
  message.writeUInt8(type, 1);
  message.writeUInt32BE(payloadBuffer.length, 2);
  payloadBuffer.copy(message, 6);
  
  return message;
}

/**
 * Decode a message from binary
 * @param {Buffer} buffer - Raw message buffer
 * @returns {object} Decoded message { version, type, payload }
 */
export function decodeMessage(buffer) {
  if (buffer.length < 6) {
    throw new Error('Message too short');
  }
  
  const version = buffer.readUInt8(0);
  const type = buffer.readUInt8(1);
  const length = buffer.readUInt32BE(2);
  
  if (buffer.length < 6 + length) {
    throw new Error('Incomplete message');
  }
  
  const payloadBuffer = buffer.subarray(6, 6 + length);

  if (type === MSG_TYPE.CHUNK_DATA) {
    // Alpha: CHUNK_DATA is always binary with a magic byte 0x01.
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

  if (type === MSG_TYPE.SUBTREE_DATA) {
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

  // Default: JSON-encoded payload
  const payload = JSON.parse(payloadBuffer.toString('utf8'));
  
  return { version, type, payload };
}
