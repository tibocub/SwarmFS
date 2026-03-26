//! Merkle tree operations with parallel construction using Rayon

use napi::bindgen_prelude::*;
use rayon::prelude::*;

/// A Merkle tree with all levels stored for proof generation
#[derive(Debug, Clone)]
pub struct MerkleTree {
    pub root: [u8; 32],
    pub levels: Vec<Vec<[u8; 32]>>,
    pub leaf_count: usize,
}

impl MerkleTree {
    /// Build a Merkle tree from leaf hashes
    pub fn build(leaf_hashes: Vec<[u8; 32]>) -> Self {
        if leaf_hashes.is_empty() {
            panic!("Cannot build Merkle tree from empty leaves");
        }

        let leaf_count = leaf_hashes.len();
        let mut levels = vec![leaf_hashes];
        let mut current_level = levels[0].clone();

        // Build tree bottom-up
        while current_level.len() > 1 {
            let next_level: Vec<[u8; 32]> = current_level
                .par_chunks(2)
                .map(|chunk| {
                    let (left, right) = if chunk.len() == 2 {
                        (chunk[0], chunk[1])
                    } else {
                        // Odd node: duplicate it
                        (chunk[0], chunk[0])
                    };
                    combine_hashes_native(left, right)
                })
                .collect();
            
            levels.push(next_level.clone());
            current_level = next_level;
        }

        MerkleTree {
            root: current_level[0],
            levels,
            leaf_count,
        }
    }

    /// Generate a proof for a subtree at given level and index
    pub fn generate_subtree_proof(&self, level: u8, index: u32) -> ([u8; 32], u8, u32, Vec<([u8; 32], bool)>, [u8; 32]) {
        let level_idx = level as usize;
        let node_idx = index as usize;
        
        if level_idx >= self.levels.len() {
            panic!("Level out of bounds");
        }
        let current_level = &self.levels[level_idx];
        if node_idx >= current_level.len() {
            panic!("Index out of bounds");
        }

        let node = current_level[node_idx];
        let mut proof = Vec::new();
        let mut idx = node_idx;

        for l in level_idx..(self.levels.len() - 1) {
            let nodes = &self.levels[l];
            let is_right_node = idx % 2 == 1;
            let sibling_index = if is_right_node { idx - 1 } else { idx + 1 };

            let sibling_hash = if sibling_index < nodes.len() {
                nodes[sibling_index]
            } else {
                // Odd node duplication rule
                nodes[idx]
            };

            proof.push((sibling_hash, is_right_node));

            idx /= 2;
        }

        (node, level, index, proof, self.root)
    }
}

/// Combine two 32-byte hashes using BLAKE3
fn combine_hashes_native(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&a);
    hasher.update(&b);
    let hash = hasher.finalize();
    *hash.as_bytes()
}

/// A proof step in a Merkle proof
#[napi(object)]
pub struct ProofStep {
    pub hash: Buffer,
    pub is_left: bool,
}

/// A subtree proof
#[napi(object)]
pub struct SubtreeProof {
    pub node: Buffer,
    pub level: u8,
    pub index: u32,
    pub proof: Vec<ProofStep>,
    pub root: Buffer,
}

/// Convert [u8; 32] to Buffer
fn array_to_buffer(arr: [u8; 32]) -> Buffer {
    Buffer::from(arr.as_slice())
}

/// Result of building a Merkle tree
#[napi(object)]
pub struct MerkleTreeResult {
    pub root: Buffer,
    pub leaf_count: u32,
}

/// Build a Merkle tree from an array of 32-byte leaf hashes
/// Returns the root hash and leaf count
#[napi]
pub fn build_merkle_tree(leaf_hashes: Vec<Buffer>) -> Result<MerkleTreeResult> {
    // Convert buffers to fixed arrays
    let leaves: Vec<[u8; 32]> = leaf_hashes
        .iter()
        .map(|buf| {
            if buf.len() != 32 {
                return Err(Error::from_reason("All leaf hashes must be 32 bytes"));
            }
            let mut arr = [0u8; 32];
            arr.copy_from_slice(buf.as_ref());
            Ok(arr)
        })
        .collect::<Result<Vec<_>>>()?;

    let tree = MerkleTree::build(leaves);

    Ok(MerkleTreeResult {
        root: array_to_buffer(tree.root),
        leaf_count: tree.leaf_count as u32,
    })
}

/// Get just the Merkle root from leaf hashes
#[napi]
pub fn get_merkle_root(leaf_hashes: Vec<Buffer>) -> Result<Buffer> {
    let leaves: Vec<[u8; 32]> = leaf_hashes
        .iter()
        .map(|buf| {
            if buf.len() != 32 {
                return Err(Error::from_reason("All leaf hashes must be 32 bytes"));
            }
            let mut arr = [0u8; 32];
            arr.copy_from_slice(buf.as_ref());
            Ok(arr)
        })
        .collect::<Result<Vec<_>>>()?;

    let tree = MerkleTree::build(leaves);
    Ok(array_to_buffer(tree.root))
}

/// Generate a subtree proof for a given level and index
/// Takes leaf hashes, level (0 = leaves), and index at that level
#[napi]
pub fn generate_subtree_proof(
    leaf_hashes: Vec<Buffer>,
    level: u8,
    index: u32,
) -> Result<SubtreeProof> {
    let leaves: Vec<[u8; 32]> = leaf_hashes
        .iter()
        .map(|buf| {
            if buf.len() != 32 {
                return Err(Error::from_reason("All leaf hashes must be 32 bytes"));
            }
            let mut arr = [0u8; 32];
            arr.copy_from_slice(buf.as_ref());
            Ok(arr)
        })
        .collect::<Result<Vec<_>>>()?;

    let tree = MerkleTree::build(leaves);
    let (node, level, index, proof, root) = tree.generate_subtree_proof(level, index);

    Ok(SubtreeProof {
        node: array_to_buffer(node),
        level,
        index,
        proof: proof.into_iter().map(|(hash, is_left)| ProofStep {
            hash: array_to_buffer(hash),
            is_left,
        }).collect(),
        root: array_to_buffer(root),
    })
}

/// Verify a subtree proof
#[napi]
pub fn verify_subtree_proof(
    node: Buffer,
    proof: Vec<ProofStep>,
    expected_root: Buffer,
) -> Result<bool> {
    if node.len() != 32 || expected_root.len() != 32 {
        return Err(Error::from_reason("Node and root must be 32 bytes"));
    }

    let mut current_hash = [0u8; 32];
    current_hash.copy_from_slice(node.as_ref());

    for step in proof {
        if step.hash.len() != 32 {
            return Err(Error::from_reason("Proof step hash must be 32 bytes"));
        }
        
        let mut sibling = [0u8; 32];
        sibling.copy_from_slice(step.hash.as_ref());

        current_hash = if step.is_left {
            combine_hashes_native(sibling, current_hash)
        } else {
            combine_hashes_native(current_hash, sibling)
        };
    }

    let mut root = [0u8; 32];
    root.copy_from_slice(expected_root.as_ref());

    Ok(current_hash == root)
}

/// Build a Merkle tree from a file path (parallel chunk hashing)
#[napi]
pub async fn build_file_merkle_tree(
    path: String,
    chunk_size: u32,
) -> Result<MerkleTreeResult> {
    use std::fs::File;
    use std::io::{BufReader, Read};
    
    let file = File::open(&path)
        .map_err(|e| Error::from_reason(format!("Failed to open file: {}", e)))?;
    let file_size = file.metadata()
        .map_err(|e| Error::from_reason(format!("Failed to get file metadata: {}", e)))?
        .len();

    let chunk_size = chunk_size as usize;
    let total_chunks = (file_size as usize + chunk_size - 1) / chunk_size;

    // Read all chunks first
    let mut reader = BufReader::new(file);
    let mut chunks: Vec<Vec<u8>> = Vec::with_capacity(total_chunks);
    let mut chunk_buf = vec![0u8; chunk_size];

    loop {
        let bytes_read = reader.read(&mut chunk_buf)
            .map_err(|e| Error::from_reason(format!("Failed to read file: {}", e)))?;

        if bytes_read == 0 {
            break;
        }

        chunks.push(chunk_buf[..bytes_read].to_vec());
    }

    // Hash all chunks in parallel using Rayon
    let leaf_hashes: Vec<[u8; 32]> = chunks
        .par_iter()
        .map(|chunk| {
            let hash = blake3::hash(chunk);
            *hash.as_bytes()
        })
        .collect();

    let tree = MerkleTree::build(leaf_hashes);

    Ok(MerkleTreeResult {
        root: array_to_buffer(tree.root),
        leaf_count: tree.leaf_count as u32,
    })
}
