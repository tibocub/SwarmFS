//! BLAKE3 hashing operations for SwarmFS

use blake3::Hasher;
use napi::bindgen_prelude::*;

/// Hash a buffer using BLAKE3
/// Returns a 32-byte hash as Buffer
#[napi]
pub fn hash_buffer(data: Buffer) -> Buffer {
    let hash = blake3::hash(data.as_ref());
    Buffer::from(hash.as_bytes().to_vec())
}

/// Hash multiple buffers together (for Merkle tree nodes)
#[napi]
pub fn hash_buffers(buffers: Vec<Buffer>) -> Buffer {
    let mut hasher = Hasher::new();
    for buf in &buffers {
        hasher.update(buf.as_ref());
    }
    let hash = hasher.finalize();
    Buffer::from(hash.as_bytes().to_vec())
}

/// Combine two 32-byte hashes into one
/// Used for Merkle tree internal nodes
#[napi]
pub fn combine_hashes(a: Buffer, b: Buffer) -> Result<Buffer> {
    if a.len() != 32 || b.len() != 32 {
        return Err(Error::from_reason("Both hashes must be 32 bytes"));
    }
    
    let mut hasher = Hasher::new();
    hasher.update(a.as_ref());
    hasher.update(b.as_ref());
    let hash = hasher.finalize();
    Ok(Buffer::from(hash.as_bytes().to_vec()))
}

/// Hash a file in chunks, returning all chunk hashes
/// This is async to avoid blocking the JS thread
#[napi]
pub async fn hash_file_chunks(path: String, chunk_size: u32) -> Result<Vec<Buffer>> {
    use std::fs::File;
    use std::io::{BufReader, Read};
    
    let file = File::open(&path)
        .map_err(|e| Error::from_reason(format!("Failed to open file: {}", e)))?;
    let file_size = file.metadata()
        .map_err(|e| Error::from_reason(format!("Failed to get file metadata: {}", e)))?
        .len();
    
    let chunk_size = chunk_size as usize;
    let total_chunks = (file_size as usize + chunk_size - 1) / chunk_size;
    
    let mut reader = BufReader::new(file);
    let mut chunk_hashes = Vec::with_capacity(total_chunks);
    let mut chunk_buf = vec![0u8; chunk_size];
    
    loop {
        let bytes_read = reader.read(&mut chunk_buf)
            .map_err(|e| Error::from_reason(format!("Failed to read file: {}", e)))?;
        
        if bytes_read == 0 {
            break;
        }
        
        let hash = blake3::hash(&chunk_buf[..bytes_read]);
        chunk_hashes.push(Buffer::from(hash.as_bytes().to_vec()));
    }
    
    Ok(chunk_hashes)
}
