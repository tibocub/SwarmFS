# Virtual Filesystem (VFS) Design Documentation

## Overview

SwarmFS's Virtual Filesystem (VFS) is an organizational layer that allows users to arrange tracked files into a hierarchical directory structure **without affecting the actual local filesystem**. It's purely metadata - a way to organize references to content-addressed files.

**Key principle**: VFS provides the *illusion* of a filesystem while maintaining SwarmFS's core content-addressing model.


## Motivation

Without VFS, all tracked files appear as a flat list identified only by their merkle roots. As users track dozens or hundreds of files, this becomes unmanageable. VFS solves this by letting users create familiar directory hierarchies for organization, while preserving all the benefits of content-addressing under the hood.


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
   - Changes when children are added/removed
   - Used for sharing, integrity verification, and content-addressing
   - `NULL` for empty vdirs

**Why both?** UUID provides stability for user operations (rename, move), while merkle root enables content-addressing and sharing.


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

The `files` table remains unchanged:
```sql
files:
  - merkle_root (PRIMARY KEY)
  - local_path
  - size
  - chunk_size
  - chunk_count
  - ... (other metadata)
```

**Key insight**: `vdir_entries` stores merkle roots, `files` table maps those to actual disk locations.


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

Both vdirs store `0xabc...` in their `vdir_entries`. The `files` table has one entry mapping `0xabc...` to the actual file path.



## Sharing Protocol

### Share Structure

When sharing a vdir, transmit:
```json
{
  "merkle_root": "0x7f3a...",
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
        "suggested_name": "vacation"
      }
    ]
  }
}
```


### Receiver Workflow

1. **Receive share** with merkle root and metadata
2. **Verify structure**: Calculate merkle root from children, compare to transmitted root
3. **Browse recursively**: For each child vdir, can request its structure before downloading
4. **Selective download**: Choose which files/subdirs to download
5. **Rename locally**: All names are suggestions - receiver can rename anything
6. **Download**: Request chunks for selected merkle roots (existing download protocol)


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

**Document Version**: 1.0  
**Last Updated**: 2024  
**Status**: Design complete, implementation pending
