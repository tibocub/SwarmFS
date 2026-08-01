//! Chunk verification operations

use napi::bindgen_prelude::*;
use rayon::prelude::*;

/// Verify a single chunk against its expected hash
#[napi]
pub fn verify_chunk(data: Buffer, expected_hash: Buffer) -> Result<bool> {
    if expected_hash.len() != 32 {
        return Err(Error::from_reason("Expected hash must be 32 bytes"));
    }
    
    let computed = blake3::hash(data.as_ref());
    let computed_bytes = computed.as_bytes();
    
    let mut expected = [0u8; 32];
    expected.copy_from_slice(expected_hash.as_ref());
    
    Ok(*computed_bytes == expected)
}

/// Verify multiple chunks against their expected hashes in parallel
#[napi]
pub fn verify_chunks_batch(chunks: Vec<Buffer>, hashes: Vec<Buffer>) -> Result<Vec<bool>> {
    if chunks.len() != hashes.len() {
        return Err(Error::from_reason("Chunks and hashes arrays must have same length"));
    }
    
    // Convert to owned data for parallel processing
    let owned_chunks: Vec<Vec<u8>> = chunks.iter().map(|c| c.as_ref().to_vec()).collect();
    let owned_hashes: Vec<Vec<u8>> = hashes.iter().map(|h| h.as_ref().to_vec()).collect();
    
    let results: Vec<bool> = owned_chunks
        .par_iter()
        .zip(owned_hashes.par_iter())
        .map(|(chunk, hash)| {
            if hash.len() != 32 {
                return false;
            }
            
            let computed = blake3::hash(chunk);
            let mut expected = [0u8; 32];
            expected.copy_from_slice(hash);
            
            *computed.as_bytes() == expected
        })
        .collect();
    
    Ok(results)
}

/// Result of batch subtree verification
#[napi(object)]
pub struct SubtreeVerificationResult {
    /// Whether the Merkle proof is valid
    pub proof_valid: bool,
    /// Whether each chunk's hash matches expected (parallel verified)
    pub chunk_results: Vec<bool>,
    /// Computed hashes for each chunk (for caching)
    pub computed_hashes: Vec<Buffer>,
}

/// Proof step for subtree verification
#[napi(object)]
pub struct ProofStepInput {
    pub hash: Buffer,
    pub is_left: bool,
}

/// Verify subtree proof AND all chunk data in one optimized batch call.
/// 
/// This eliminates JS↔Rust boundary overhead by doing everything in one call:
/// 1. Hash all chunks in parallel using Rayon
/// 2. Compare computed hashes to expected hashes (parallel)
/// 3. Verify the subtree proof (single-threaded, trivial)
/// 
/// Returns proof validity and per-chunk verification results.
#[napi]
pub fn verify_subtree_chunks(
    chunk_data: Vec<Buffer>,
    expected_hashes: Vec<Buffer>,
    proof: Vec<ProofStepInput>,
    expected_root: Buffer,
    subtree_node: Buffer,
) -> Result<SubtreeVerificationResult> {
    if chunk_data.len() != expected_hashes.len() {
        return Err(Error::from_reason("chunk_data and expected_hashes must have same length"));
    }
    if expected_root.len() != 32 {
        return Err(Error::from_reason("expected_root must be 32 bytes"));
    }
    if subtree_node.len() != 32 {
        return Err(Error::from_reason("subtree_node must be 32 bytes"));
    }
    
    // Convert to owned data for parallel processing
    let owned_chunks: Vec<Vec<u8>> = chunk_data.iter().map(|c| c.as_ref().to_vec()).collect();
    let owned_hashes: Vec<[u8; 32]> = expected_hashes
        .iter()
        .map(|h| {
            if h.len() != 32 {
                [0u8; 32] // Invalid hash, will fail verification
            } else {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(h.as_ref());
                arr
            }
        })
        .collect();
    
    // Step 1: Hash all chunks in parallel
    let computed_hashes: Vec<[u8; 32]> = owned_chunks
        .par_iter()
        .map(|data| {
            let hash = blake3::hash(data);
            *hash.as_bytes()
        })
        .collect();
    
    // Step 2: Compare to expected hashes in parallel
    let chunk_results: Vec<bool> = computed_hashes
        .par_iter()
        .zip(owned_hashes.par_iter())
        .map(|(computed, expected)| {
            *computed == *expected
        })
        .collect();
    
    // Step 3: Verify subtree proof
    let mut current_hash = [0u8; 32];
    current_hash.copy_from_slice(subtree_node.as_ref());
    
    for step in &proof {
        if step.hash.len() != 32 {
            return Ok(SubtreeVerificationResult {
                proof_valid: false,
                chunk_results,
                computed_hashes: computed_hashes.iter().map(|h| Buffer::from(h.as_slice())).collect(),
            });
        }
        
        let mut sibling = [0u8; 32];
        sibling.copy_from_slice(step.hash.as_ref());
        
        // Combine hashes: if is_left, sibling is on left; otherwise on right
        current_hash = if step.is_left {
            combine_hashes(sibling, current_hash)
        } else {
            combine_hashes(current_hash, sibling)
        };
    }
    
    let mut root = [0u8; 32];
    root.copy_from_slice(expected_root.as_ref());
    
    let proof_valid = current_hash == root;
    
    Ok(SubtreeVerificationResult {
        proof_valid,
        chunk_results,
        computed_hashes: computed_hashes.iter().map(|h| Buffer::from(h.as_slice())).collect(),
    })
}

/// Combine two 32-byte hashes using BLAKE3
fn combine_hashes(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&a);
    hasher.update(&b);
    let hash = hasher.finalize();
    *hash.as_bytes()
}
