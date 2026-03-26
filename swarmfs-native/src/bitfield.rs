//! BitField operations with popcount optimization

use napi::bindgen_prelude::*;

/// Count the number of set bits in a bitfield buffer
/// Uses popcount intrinsic for O(n/8) complexity instead of O(n)
#[napi]
pub fn bitfield_count(buffer: Buffer) -> u32 {
    buffer.as_ref().iter().map(|b| b.count_ones() as u32).sum()
}

/// Get all set bit indices from a bitfield buffer
/// Returns array of indices where bits are set
#[napi]
pub fn bitfield_get_set_indices(buffer: Buffer) -> Vec<u32> {
    let mut indices = Vec::new();
    for (byte_idx, byte) in buffer.as_ref().iter().enumerate() {
        if *byte == 0 {
            continue;
        }
        for bit_idx in 0..8 {
            if byte & (1 << bit_idx) != 0 {
                indices.push((byte_idx * 8 + bit_idx) as u32);
            }
        }
    }
    indices
}

/// Check if a bit is set at the given index
#[napi]
pub fn bitfield_get(buffer: Buffer, index: u32) -> bool {
    let idx = index as usize;
    let byte_idx = idx / 8;
    let bit_idx = idx % 8;
    
    if byte_idx >= buffer.len() {
        return false;
    }
    
    (buffer.as_ref()[byte_idx] & (1 << bit_idx)) != 0
}

/// Set a bit at the given index
/// Returns a new buffer with the bit set
#[napi]
pub fn bitfield_set(mut buffer: Buffer, index: u32) -> Buffer {
    let idx = index as usize;
    let byte_idx = idx / 8;
    let bit_idx = idx % 8;
    
    if byte_idx < buffer.len() {
        buffer.as_mut()[byte_idx] |= 1 << bit_idx;
    }
    
    buffer
}

/// Clear a bit at the given index
/// Returns a new buffer with the bit cleared
#[napi]
pub fn bitfield_clear(mut buffer: Buffer, index: u32) -> Buffer {
    let idx = index as usize;
    let byte_idx = idx / 8;
    let bit_idx = idx % 8;
    
    if byte_idx < buffer.len() {
        buffer.as_mut()[byte_idx] &= !(1 << bit_idx);
    }
    
    buffer
}

/// Create a new bitfield buffer of the given size (in bits)
#[napi]
pub fn bitfield_new(size: u32) -> Buffer {
    let byte_count = (size as usize + 7) / 8;
    Buffer::from(vec![0u8; byte_count])
}

/// Check if all bits are set
#[napi]
pub fn bitfield_is_full(buffer: Buffer, size: u32) -> bool {
    let count = bitfield_count(buffer);
    count == size
}

/// Check if no bits are set
#[napi]
pub fn bitfield_is_empty(buffer: Buffer) -> bool {
    buffer.as_ref().iter().all(|b| *b == 0)
}
