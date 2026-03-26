//! SwarmFS Native - High-performance Rust addon for SwarmFS
//! 
//! Provides optimized implementations for:
//! - BLAKE3 hashing
//! - Merkle tree construction (parallel with Rayon)
//! - BitField operations
//! - Chunk verification

mod hash;
mod merkle;
mod bitfield;
mod verify;

// Re-export all functions from modules
pub use hash::*;
pub use merkle::*;
pub use bitfield::*;
pub use verify::*;

// Required for napi-rs
#[macro_use]
extern crate napi_derive;
