# Using BLAKE3 as more that just a simple hashing algorithm

BLAKE3 is **much** faster than SHA256, so just by hashing chunks with BLAKE3
instead of SHA256 we already get a huge boost.

Howerer, hashing a file with BLAKE3 already rely on chunking the file and
making a hash-tree of the chunks like we currently do. That means using
BLAKE3 as our hashing algorythm in our current setup would end up chunking,
hashing and building a hash-tree twice for every file,which make it very
tempting to replace our entire chunk/hash/merkle-tree with only BLAKE3.


Apparently, that is not a good idea since BLAKE3's merkle tree is optimized
for very fast hashing while the merkle tree SwarmFS and BitTorrent uses is
optimized for file-sharing. 


## BLAKE3's internal merkle tree:

First of all it uses 1024-byte chunks internally. This is excellent
for CPU cache efficiency and hashing speed, but terrible for P2P
protocols where you typically want 256KB-16MB chunks (or larger) to:

- Minimize overhead from per-chunk metadata and network round trips
- Reduce the number of hash advertisements/exchanges between peers
- Balance granularity with protocol efficiency

Inaccessible intermediate nodes: The BLAKE3 API doesn't expose the
intermediate merkle tree nodes in a way that lets us verify individual
chunks. We get a single 32-byte hash output, we can't ask "give me the
merkle proof for bytes 5MB-6MB" like we can with SwarmFS current tree.


## In SwarmFS we need to:

- Verify a chunk before accepting it from a peer
- Provide merkle proofs to prove we have valid chunks
- Build the tree incrementally as chunks arrive out-of-order


# Options to explore:

## BLAKE3 verified streaming

Bao's intro from its [github repo](https://github.com/oconnor663/bao):

`Bao is an implementation of BLAKE3 verified streaming, as described in
Section 6.4 of the BLAKE3 spec. Tree hashes like BLAKE3 make it possible
to verify part of a file without re-hashing the entire thing, using an
encoding format that stores the bytes of the file together with all the
nodes of its hash tree. Clients can stream this encoding, or do random
seeks into it, while verifying that every byte they read matches the root
hash. For the details of how this works, see the Bao spec.`

Bao provides:
- Streaming verified decoding
- Chunk-level verification with merkle proofs
- Configurable chunk sizes (not limited to 1KB)
- Extract slices with proofs

