# Data model

All types are declared once, when hypergraph opens (`lib/types.js`). They are permanent: hypergraph
lets a later version only append fields, add types and add indexes, so fields are listed in the
order they were added and a new version must keep reading old records (a field an old record lacks
is `null`).

## Records in files spaces and sites

| Type | Fields | Index | Who writes |
|---|---|---|---|
| `folder` | `name`, `parent`, `from`, `binned` | `parent` | any member (`editable: 'members'`) |
| `file` | `name`, `parent`, `content`, `base`, `from`, `binned`, `data` | `parent` | any member; in a site's pages, the owner and admins |
| `profile` | `name` | | each member, one per member |
| `has` | `root` | `root` | each device of a person showing holdings |
| `upload` | `name`, `content`, `data` | | members who may post; edits by the author only |
| `site` | `pages` (a space), `app` | | the owner and admins (`permission: 'decide'`) |

- `parent`: a folder's id, the space key (the top), or `'bin'`.
- `content`: `{ src: ['swarmwire://<root>'], size, type: '', digest: 'blake3:<root>', mutable: false }`.
- `base`: the contents this version replaced, newest first: up to 16 roots separated by spaces.
  It tells a newer version (whose history holds the local one) from a concurrent edit.
- `from`, `binned`: in the bin, where the entry was and when (ms). Restored: `''` and `0`.
- `data`: the bytes, when the file is at most 60 KiB and the space inlines (a site's pages, uploads).

A site's own types sit beside these, in the site's space only.

## Rules (checked by every member before keeping a record)

| Rule id | Says |
|---|---|
| `swarmfs/name-v1` | a folder's or file's name is 1–255 bytes with no `/` or NUL; `parent` non-empty |
| `swarmfs/content-v1` | a file's `content` is a swarmwire ref whose digest matches its root |
| `swarmfs/base-v1` | `base` is absent, or 1–16 hex roots separated by single spaces |
| `swarmfs/bin-v1` | an entry in the bin has a `from` |
| `swarmfs/profile-v1` | a name is 1–64 characters, no control characters |
| `swarmfs/upload-v1` | an upload has a valid name and a swarmwire ref |
| `swarmfs/inline-v1` | inline bytes are exactly the content: the right size, at most 60 KiB, the right BLAKE3 root |

A rule's id is permanent; a stricter or looser rule gets a new id.

## Records in the personal space (this person's devices only)

| Type | Fields | Index | Meaning |
|---|---|---|---|
| `held` | `root`, `path`, `size`, `mtime`, `space`, `entry` | `root` | this device has `root` at `path`, as hashed (`size`, `mtime`), for entry `entry` of `space`. A folder inside a linked folder has one too, with `root: ''`. |
| `added` | `path`, `space`, `folder` | | a linked folder of this device |
| `kept` | `space` | `space` | a site this device keeps whole (installed) |

Each device reads and writes only its own (`fromDevice`), so these reads never wait on another device.

Settings (hypergraph's, the same on every device of the person): `name`, and `show-holdings` (the
keys of the spaces where the person shows holdings).

## Roles defined in each files space and site

| Role | Permissions under `'admins'` / `'chosen'` / `'everyone'` |
|---|---|
| `editor` | `post` / `post` / `post`, `invite` |
| `trusted` | `post` / `post`, `invite` / `post`, `invite` |
| `reader` | none |

A site's `pages` sub-space has `writeRoles: ['admin']`: only the owner and admins write it.

## On disk

```text
<instance>/                          hypergraph's data (records, keys; the recovery phrase sealed)
<instance>/app-storage/<root>        site files read here (a cache under appStorageMax)
<instance>/app-storage/kept/<root>   files of installed sites, and uploads of sites this person owns
<linked>/.swarmfs-trash/<YYYY-MM-DD HH-MM-SS>/<relative path>   what syncing replaced or removed
<linked>/.swarmfs-trash/.incoming/<root>                        downloads not placed yet
<linked>/.swarmfsignore              an ordinary synced file: what this folder doesn't sync
<file>.part                          a drive.fetch() in progress
```

Apart from these, SwarmFS writes no file's bytes anywhere: added files are served from where they lie.
