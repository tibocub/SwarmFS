# Data model: SwarmFS 004 — sites (additions to 001–003)

Permanent (hypergraph appends only).

| Type | Fields (new in bold) | Rules | Who writes |
|---|---|---|---|
| `file` | name, parent, content, base, from, binned, **data: bytes** | `swarmfs/inline-v1` | members (sub-space: owner, admins) |
| **`upload`** | name: string, content: ref, data: bytes | `swarmfs/upload-v1`, `swarmfs/inline-v1` | anyone who may post; edits: its author only |
| **`site`** | pages: space | — | `put: { permission: 'decide' }` (owner, admins) |

- `data`: the file's bytes when ≤ 61,440 and the space inlines (a site's pages sub-space; uploads).
  Absent elsewhere. `inline-v1`: absent, or `length === content.size ≤ 61,440` and BLAKE3 root ===
  the content's root.
- `upload-v1`: valid name (as `name-v1`), content a swarmwire ref (as `content-v1`).
- `site`: the latest one names the pages sub-space.

## Roles

| Role | Permissions | Made by |
|---|---|---|
| **`reader`** | none | every invite setting (003's `setInvites`); defined on demand in older spaces |
| `editor` | `post` (+ `invite` under "everyone") | 003 |
| `trusted` | 003 | 003 |

## Space layout of a site

```
site space (closed; public once made so)
├── site record { pages }          put by owner/admins
├── upload records                 by uploaders
├── profile, has                   (003; never written by a visit)
└── sub-space "pages" (writeRoles ['admin']; public with the site)
    └── folder/file records        the site's tree; site.json at its top
```

## App storage (this device, `<instance dir>/app-storage/`)

- `<root>`: a page or upload read here; `held { root, path, size, mtime, space, entry }`; evicted LRU.
- `kept/<root>`: an upload of a site this person owns; never evicted; dropped when no upload has it.
