import fs from "Promises/fs"


class UploadManager {
  /**
   * Serve chunk using streamx (not Node.js streams!)
   */
  async serveChunk(conn, chunkHash, chunkLocation) {
    try {
      // Read chunk from disk
      const fd = await fs.promises.open(chunkLocation.path, 'r');
      const buffer = Buffer.allocUnsafe(chunkLocation.chunk_size);
      
      try {
        const { bytesRead } = await fd.read(
          buffer,
          0,
          chunkLocation.chunk_size,
          chunkLocation.chunk_offset
        );

        const chunkData = bytesRead < buffer.length 
          ? buffer.subarray(0, bytesRead)
          : buffer;

        // Encode chunk data message
        const message = this.protocol.encodeMessage(MSG_TYPE.CHUNK_DATA, {
          requestId: chunkLocation.requestId,
          chunkHash,
          data: chunkData.toString('base64')
        });

        // Write to streamx connection
        // Hyperswarm/streamx handles backpressure automatically
        const canWrite = conn.write(message);

        if (!canWrite) {
          // Backpressure indicated - streamx will buffer
          // We could implement rate limiting here if needed
          console.warn('⚠️  Upload backpressure');
        }

        console.log(`✓ Served chunk ${chunkHash.substring(0, 16)}... (${chunkData.length} bytes)`);

      } finally {
        await fd.close();
      }

    } catch (error) {
      console.error('Error serving chunk:', error);
      
      // Send error message
      this.protocol.sendError(conn, chunkLocation.requestId, error.message);
    }
  }
}
