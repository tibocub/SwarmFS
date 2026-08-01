# Virtual Filesystem (VFS) Design Documentation

## Overview

SwarmFS's Virtual Filesystem (VFS) is an organizational layer that allows users to arrange tracked files into a hierarchical directory structure **independently from their actual file paths on the local filesystem**. It's purely metadata - a way to organize references to content-addressed files.

**Key principle**: VFS provides the *illusion* of a filesystem while maintaining SwarmFS's core content-addressing model.


## Motivation

### The Flat List Problem

Without VFS, all tracked files appear as a flat list identified only by their merkle roots. For users who track dozens or hundreds of files, this becomes unmanageable. VFS solves this by letting users create familiar directory hierarchies for organization, while preserving all the benefits of content-addressing under the hood.

### The Metadata Protocol Gap

SwarmFS's existing metadata protocol allows peers to request file information by merkle root. However, this creates a UX problem: users must know and share specific merkle roots to download files. There's no way to browse available content or discover what's being shared.

VFS bridges this gap by:
1. **Grouping files into hierarchies** - Users can share a single vdir merkle root instead of N individual file roots
2. **Enabling browse-before-download** - Recipients can explore the directory structure before choosing what to download
3. **Providing human-readable names** - `suggested_name` fields give context to content-addressed data

This transforms the sharing UX from "here's a list of 47 hex strings" to "here's my /photos/vacation/ folder, pick what you want."


## Core Concepts

### What VFS Is NOT

- Not a replacement for the local filesystem
- Not a storage layer (files still live on disk at their original paths)
- Not a new way to track files (existing file tracking remains unchanged)
- Not a modification to how files are chunked, hashed, or served

### What VFS IS

- An organizational metadata layer on top of tracked files
- A DAG (Directed Acyclic Graph) of virtual directories referencing merkle roots
- A way to group and browse content-addressed files hierarchically
- A shareable structure (like BitTorrent's multi-file torrents)



## Architecture

### Dual Identity System

Every virtual directory (vdir) has **two identifiers**:

1. **UUID** (Universally Unique Identifier)
   - Stable across renames and content changes
   - Used for local organization and database references
   - User never sees this directly

2. **Merkle Root** (Content Hash)
   - Calculated from vdir's contents
   - Changes when children are added/modified/removed
   - Used for sharing, integrity verification, and content-addressing
   - `NULL` for empty vdirs

UUID provides stability for user operations (rename, move), while merkle root enables content-addressing and sharing.


### Data Flow
```
User's View:              Database Layer:              Content Layer:
                                                      
/photos/                  vdir UUID: abc-123          merkle_root: 0x7f3a...
  ├─ beach.jpg           → file ref: 0x4e2b...       → actual file: /home/user/pics/beach.jpg
  └─ vacation/            vdir UUID: def-456          merkle_root: 0x9c1d...
      └─ day1.jpg        → file ref: 0x8a5f...       → actual file: /home/user/DCIM/IMG001.jpg
```

**Flow for serving chunks:**
1. Peer requests chunks for merkle root `0x8a5f...`
2. Lookup in `files` table: `0x8a5f...` → `/home/user/DCIM/IMG001.jpg`
3. Read chunks from actual file on disk
4. Serve with merkle proofs

**VFS is never involved in serving** - it's purely organizational.



## Merkle Root Calculation for Vdirs

### Algorithm

To ensure deterministic, name-independent hashing:
```
1. Collect all direct children (files and sub-vdirs)
2. Sort children by merkle_root (lexicographic on bytes)
3. For each child:
   - Concatenate: merkle_root + type_flag
     - type_flag = 0x00 for file
     - type_flag = 0x01 for vdir
4. Hash the full concatenation = vdir's merkle_root
```

### Properties

- **Deterministic**: Same contents → same hash, always
- **Name-independent**: Renaming children doesn't change hash
- **Order-independent**: Sorted by merkle root, not insertion order
- **Type-aware**: Distinguishes files from subdirs in the hash
- **Collision-resistant**: Inherits properties of underlying hash function


### Example
```
vdir /music/ contains:
  - song1.mp3 (merkle: 0xabc...)
  - song2.mp3 (merkle: 0x123...)
  - album/    (merkle: 0x7ef...)

Sorted by merkle root:
  1. 0x123... (file, type_flag=0x00)
  2. 0x7ef... (vdir, type_flag=0x01)
  3. 0xabc... (file, type_flag=0x00)

Concatenate:
  0x123...00 + 0x7ef...01 + 0xabc...00

Hash this = vdir merkle root
```

### Empty Vdirs

- Merkle root = `NULL` in database
- Cannot be shared or downloaded
- Exist only for UI convenience (create folder, then populate it)
- Get a merkle root as soon as first child is added



## Database Schema

### Tables

#### `virtual_directories`

| Column | Type | Description |
|--------|------|-------------|
| `uuid` | TEXT PRIMARY KEY | Stable identifier (UUID v4) |
| `name` | TEXT NOT NULL | User-visible name |
| `parent_uuid` | TEXT NULL | Parent vdir UUID (NULL for root-level) |
| `merkle_root` | BLOB NULL | Content hash (NULL if empty) |
| `created_at` | INTEGER | Unix timestamp |
| `modified_at` | INTEGER | Unix timestamp |

**Foreign key**: `parent_uuid` references `virtual_directories(uuid)` ON DELETE CASCADE

#### `vdir_entries`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | Auto-increment |
| `parent_uuid` | TEXT NOT NULL | Vdir containing this entry |
| `child_merkle_root` | BLOB NOT NULL | Child's merkle root |
| `child_type` | INTEGER NOT NULL | 0=file, 1=vdir |
| `display_order` | INTEGER | For UI sorting (not used in hash) |

**Foreign key**: `parent_uuid` references `virtual_directories(uuid)` ON DELETE CASCADE

**Index**: `(parent_uuid, child_merkle_root)` for fast lookups


### Relationship to Existing `files` Table

**Current schema limitation**: The existing `files` table has `path TEXT UNIQUE NOT NULL`, which prevents the same content from having multiple local paths. This needs to change.

**Required schema change**:
```sql
-- BEFORE (current)
CREATE TABLE files (
  path TEXT UNIQUE NOT NULL,  -- Problem: one path per content
  merkle_root TEXT NOT NULL,
  ...
);

-- AFTER (required)
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merkle_root TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  file_modified_at INTEGER NOT NULL,
  UNIQUE(merkle_root, path)  -- Allow multiple paths per merkle_root
);

CREATE INDEX idx_files_merkle_root ON files(merkle_root);
```

**Why this matters**:
- Same content can be downloaded to different local paths
- Built-in deduplication detection (same merkle_root = same content)
- Efficient lookup by merkle_root (already implemented: `getFilesByMerkleRoot()`)
- Receiver can choose arbitrary download locations without conflict

**Key insight**: `vdir_entries` stores merkle roots, `files` table maps those to actual disk locations. Multiple paths per merkle_root is essential for VFS to work correctly.


### Example Data
```
virtual_directories:
uuid         | name      | parent_uuid | merkle_root
-------------|-----------|-------------|------------
abc-123      | photos    | NULL        | 0x7f3a...
def-456      | vacation  | abc-123     | 0x9c1d...

vdir_entries:
parent_uuid | child_merkle_root | child_type
------------|-------------------|------------
abc-123     | 0x4e2b...         | 0  (file: beach.jpg)
abc-123     | 0x9c1d...         | 1  (vdir: vacation/)
def-456     | 0x8a5f...         | 0  (file: day1.jpg)

files:
merkle_root | local_path
------------|---------------------------
0x4e2b...   | /home/user/pics/beach.jpg
0x8a5f...   | /home/user/DCIM/IMG001.jpg
```



## DAG Properties

### Why a DAG?

- **Directed**: Parent → child relationships (vdirs contain files/subdirs)
- **Acyclic**: No cycles possible (prevents infinite recursion)
- **Graph**: Not a tree - same file can appear in multiple vdirs


### Cycle Prevention

Cycles are **structurally impossible**:
```
To create cycle A → B → A:
  - A's merkle root depends on B's merkle root
  - B's merkle root depends on A's merkle root
  - Chicken-and-egg problem - cannot resolve
```

Content-addressing inherently prevents cycles. No runtime checks needed.


### Multiple References

The same file can appear in multiple vdirs:
```
/work/report.pdf     → merkle: 0xabc...
/archive/2024/report.pdf → merkle: 0xabc...
```

Both vdirs store `0xabc...` in their `vdir_entries`. The `files` table can have multiple entries mapping `0xabc...` to different local paths (after schema fix).



## Sharing Protocol

### Protocol Extension: VDIR_METADATA

VFS extends the existing `METADATA_REQUEST/RESPONSE` protocol. When a peer requests metadata for a merkle root:

1. **Check if it's a file** - Query `files` table, return existing file metadata
2. **Check if it's a vdir** - Query `virtual_directories` table, return vdir metadata
3. **Return error** - If neither found

This allows a single `METADATA_REQUEST` to handle both files and vdirs transparently.

### Share Structure (Shallow, Depth=1)

When sharing a vdir, transmit **one level of children** (not the full tree):
```json
{
  "merkle_root": "0x7f3a...",
  "type": "vdir",
  "metadata": {
    "suggested_name": "My Photos",
    "children": [
      {
        "merkle_root": "0x4e2b...",
        "type": "file",
        "suggested_name": "beach.jpg",
        "size": 2048576
      },
      {
        "merkle_root": "0x9c1d...",
        "type": "vdir",
        "suggested_name": "vacation",
        "has_children": true
      }
    ]
  }
}
```

**Why shallow instead of full tree?**
- Large directories (1000+ files) would create huge messages
- Progressive browsing matches user mental model (don't load entire tree upfront)
- Reduces unnecessary data transfer for uninterested branches
- Client requests deeper levels on-demand with additional `METADATA_REQUEST`s

**Note**: `has_children` flag indicates whether a vdir child has content, allowing UI to show expand arrows without fetching.


### Receiver Workflow

1. **Receive share** with merkle root and shallow metadata (one level)
2. **Verify structure**: Calculate merkle root from children, compare to transmitted root
3. **Display to user**: Show directory contents with suggested names
4. **Browse deeper (optional)**: For vdir children, user can request deeper levels via additional `METADATA_REQUEST`
5. **Select for download**: User chooses which files/subdirs to download
6. **Choose local paths**: Receiver maps each selected item to a local filesystem path
7. **Download**: Request chunks for selected merkle roots (existing download protocol)

### Receiver-Side Path Mapping

When a receiver downloads files from a vdir, they need to store the mapping between vdir entries and their chosen local paths:

**Option A: Extend `files` table** (recommended)
```
files table stores: (merkle_root, path, ...)
- Same merkle_root can have multiple path entries
- Download creates new entry with receiver's chosen path
- No new table needed, leverages existing dedup infrastructure
```

**Option B: Separate mapping table** (more complex)
```sql
CREATE TABLE vdir_download_mappings (
  vdir_uuid TEXT NOT NULL,
  child_merkle_root TEXT NOT NULL,
  local_path TEXT NOT NULL,
  downloaded_at INTEGER
);
```

**Recommendation**: Use Option A (extend files table). It's simpler, enables dedup detection, and aligns with the content-addressed model.


### BitTorrent-Style Semantics

- Share entire directory trees
- Browse before downloading (like .torrent file metadata)
- Select specific files/folders
- Resume interrupted downloads
- Rename without affecting content integrity



## Operations

### Create Vdir
```
1. Generate UUID
2. Set name, parent_uuid
3. Set merkle_root = NULL (empty)
4. Insert into virtual_directories
```


### Add File to Vdir
```
1. Get file's merkle_root from files table
2. Insert (parent_uuid, child_merkle_root, type=0) into vdir_entries
3. Recalculate parent's merkle_root
4. Recursively update ancestor merkle_roots
```


### Add Subdir to Vdir
```
1. Create new vdir (or use existing UUID)
2. Set parent_uuid to parent
3. Insert (parent_uuid, child.merkle_root, type=1) into vdir_entries
4. Recalculate parent's merkle_root
5. Recursively update ancestors
```


### Rename Vdir
```
1. Update name in virtual_directories
2. UUID stays same
3. Merkle_root stays same (content unchanged)
4. Parent's merkle_root stays same
```

**Zero impact on content-addressing.**


### Move File/Vdir
```
1. Remove entry from old parent's vdir_entries
2. Add entry to new parent's vdir_entries
3. Recalculate both parents' merkle_roots
4. Recursively update ancestors
```


### Delete Vdir
```
1. CASCADE delete (removes all children if vdir is deleted)
2. Remove entry from parent's vdir_entries
3. Recalculate parent's merkle_root
4. Files still exist in files table (VFS is non-destructive)
```

**Important**: Deleting from VFS never deletes actual files.


### Calculate Merkle Root
```python
def calculate_vdir_merkle_root(vdir_uuid):
    # Get all children
    children = db.query("SELECT child_merkle_root, child_type 
                         FROM vdir_entries 
                         WHERE parent_uuid = ?", vdir_uuid)
    
    if len(children) == 0:
        return NULL  # Empty vdir
    
    # Sort by merkle_root (lexicographic)
    children.sort(key=lambda c: c.merkle_root)
    
    # Concatenate: merkle_root + type_flag
    concatenated = b""
    for child in children:
        concatenated += child.merkle_root
        concatenated += bytes([child.child_type])  # 0x00 or 0x01
    
    # Hash
    return hash_function(concatenated)
```

### Recursive Merkle Update

When a vdir's content changes, **ancestors must be updated**:
```
/photos/vacation/day1/morning/sunrise.jpg added

Updates needed:
1. /photos/vacation/day1/morning/  (direct parent)
2. /photos/vacation/day1/          (grandparent)
3. /photos/vacation/               (great-grandparent)
4. /photos/                        (great-great-grandparent)
```

Traverse up the tree, recalculating at each level.

### Performance Consideration: Lazy Updates

For deep trees (10+ levels), eager updates could be slow. Future optimization:

**Current approach**: Eager update (simple, always consistent)

**Future optimization**: Mark vdirs as "dirty", recalculate on:
- Next share operation
- Next read operation
- Periodic background batch

**Tradeoff**: Lazy updates add complexity but improve performance for frequent small changes. Start with eager, optimize if needed.



## Design Decisions & Rationale

### Why UUID + Merkle Root (not just one)?

**UUID alone**: Can't share vdirs content-addressed way, can't verify integrity

**Merkle root alone**: Changes on every add/remove/rename, breaks user references

**Both**: UUID for stability, merkle root for content-addressing


### Why sort by merkle root (not alphabetically by name)?

**Name sorting**: Renaming a file changes parent's merkle root (defeats purpose)

**Merkle root sorting**: Deterministic, name-independent, enables true content-addressing


### Why store merkle roots in vdir_entries (not file UUIDs)?

**File UUIDs**: Would need indirection layer, breaks content-addressing

**Merkle roots**: Direct reference to content, enables sharing, maintains SwarmFS philosophy


### Why allow files in multiple vdirs?

**User flexibility**: Same content, different organizational contexts (work + archive)

**No duplication**: Same merkle root, same file on disk, minimal storage overhead

**DAG benefits**: Natural graph structure vs. forced tree


### Why NULL for empty vdirs (not hash of empty string)?

**Simplicity**: Clear signal that vdir is empty

**Share prevention**: Can't accidentally share structure with no content

**Lazy calculation**: Only compute hashes when needed


### Why single hash (not Merkle tree) for vdir root?

**Directories are small**: A vdir with 1000 children is ~33KB of metadata (32 bytes × 1000 + type flags). Hashing this is trivial.

**No partial proofs needed**: You need the entire directory to verify integrity. Partial verification doesn't make sense for directory metadata.

**Consistency with file model**: Files use Merkle trees because chunks can be verified independently. Vdirs don't have "chunks" - they have children that are already content-addressed.

**Alternative considered**: Build a Merkle tree from child entries. Rejected as over-engineering for small metadata structures.


### Why shallow metadata (not full tree)?

**Network efficiency**: Large directories shouldn't require huge messages

**Progressive UX**: Users browse incrementally, not all-at-once

**On-demand fetching**: Client requests deeper levels only if user expands that branch

**Matches file browser paradigm**: No file browser loads the entire tree on open



## Implementation Status

### Current Code (Proof of Concept)

The existing `src/vfs.js` and database tables are an early prototype with several gaps:

| Feature | Doc Design | Current Code | Gap |
|---------|------------|--------------|-----|
| Column naming | `uuid`, `parent_uuid` | `id`, `parent_id` | Minor rename needed |
| Child reference | `child_merkle_root` only | `child_merkle_root` + `child_vdir_id` | Remove `child_vdir_id` |
| Files table | Multiple paths per merkle_root | Single path (UNIQUE constraint) | Schema change required |
| Merkle calculation | Single hash of sorted children | Not implemented | Core feature missing |
| Recursive update | Eager, propagate to ancestors | Not implemented | Core feature missing |
| Protocol extension | METADATA_REQUEST handles vdirs | Not implemented | Protocol change needed |

### Implementation Order

1. **Schema migration**: Fix `files` table, remove `child_vdir_id`, rename columns
2. **Merkle calculation**: Implement `calculateVdirMerkleRoot()`
3. **Recursive updates**: Implement ancestor propagation on add/remove/move
4. **Protocol extension**: Extend `handleMetadataRequest()` for vdirs
5. **Receiver workflow**: Implement vdir browsing and selective download
6. **CLI commands**: `vdir create`, `vdir add`, `vdir ls`, `vdir share`



## Integration with Existing SwarmFS

### Backward Compatibility

- All existing tracked files continue to work
- VFS is opt-in - files can exist without being in any vdir
- Seeding/downloading unchanged - VFS is transparent to protocol


### No Changes to Core Protocol

- File chunking: unchanged
- Merkle tree construction: unchanged (reused for vdirs)
- Chunk requests: unchanged (still by merkle root)
- Verification: unchanged
- Seeding: unchanged


### What Changes

- **Database**: New tables for VFS
- **CLI**: New commands (`vdir create`, `vdir add`, etc.)
- **Sharing**: Extended to support vdir structures
- **UI**: Hierarchical view instead of flat list



## Future Considerations

### Multi-Writer Vdirs (Autobase)

With Autobase (planned), multiple users could collaboratively edit shared vdirs:

- Each peer has local UUID-based vdir
- Merkle roots sync via Autobase log
- Conflicts resolved by CRDTs
- Enables collaborative folder structures


### IPNS-Like Mutable Pointers

Currently, sharing a vdir means sharing its merkle root (immutable). Future:

- Topic-based mutable pointers to vdirs
- Update pointer without changing topic key
- Enables "living folders" that update over time


### Symbolic Links / Shortcuts

Currently, files can appear in multiple vdirs by duplicating entries. Future:

- Special "link" type in vdir_entries
- Points to another vdir or file by UUID
- Enables more complex organizational structures


### Permissions & Access Control

Currently, VFS is single-user. Future:

- Per-vdir sharing permissions
- Read-only vs. read-write vdirs
- Integration with user ID system



## Glossary

- **VFS**: Virtual Filesystem - the organizational layer
- **Vdir**: Virtual directory - a node in the VFS DAG
- **Merkle root**: Content-addressed hash of a file or vdir
- **UUID**: Stable identifier for a vdir (persists across changes)
- **Content-addressing**: Identifying data by its cryptographic hash
- **DAG**: Directed Acyclic Graph - the structure of VFS
- **Type flag**: Byte indicating whether a child is a file (0x00) or vdir (0x01)



## References

- UnixFS (IPFS): Inspired our deterministic directory hashing
- Git tree objects: Similar merkle-based directory representation
- BitTorrent multi-file torrents: Inspired our sharing semantics
- Hypercore/Autobase: Future plans for multi-writer vdirs

---

**Document Version**: 2.0  
**Last Updated**: 2025  
**Status**: Design refined, implementation plan defined
