# Sites

A **site** is a space whose pages are a file tree and whose members may upload: one key to share,
read by a browser engine through the library (no CLI commands). `lib/site.js`.

```
site space (not private; public once made so)
├── site record { pages, app }      written by the owner and admins
├── upload records                  by members who may post; each edited by its author only
├── the site's own records          its own types (posts, comments...)
└── sub-space "pages"               written by the owner and admins only
    └── folder / file records       the pages
```

## Making one

`sfs.createSite(name, opts)` makes the space, its `pages` sub-space and the `site` record. Options:

- `invites`: as for a files space ([sharing.md](sharing.md)).
- `types`: the site's own record types, as hypergraph takes them, recorded after SwarmFS's
  (`{ post: { fields: { title: 'string' } } }`). A name SwarmFS uses (`file`, `upload`, `site`...)
  is refused with `INVALID_TYPE`: replacing it would break the site's pages. `site.declareTypes(types)`
  adds more later (owner, admins): new types and new fields at the end only. Members write these
  records through `site.space.put(...)`.
- `app`: the key of another site whose code this one runs (one forum of a forum app). Its own pages
  stay empty; `site.app` gives the key (null for any other site).
- `private: true`: read by its members only (a chat); it can never be made public.

`site.publish(folder)` links a local folder as the pages: its edits are published while
`sfs.sync()` runs. `site.pages` is a plain `Drive` of the pages.

## Visitors

- `site.invite({ role: 'reader' })`: a member who reads only. An `editor` invite (the default) may upload.
- `site.makePublic()`: anyone with `site.publicLink()` reads, nobody lets them in. For good.
- `sfs.visit(link)` enters with either; `sfs.site(key)` opens one already joined. A visit writes
  nothing into the site.

## Reading

`site.read('docs/about.html')` returns a page's verified bytes:

1. from its record, for a file up to 60 KiB: pages and uploads carry their bytes inline (a record
   is at most 64 KiB), and every member checks they hash to the record's content before keeping it;
2. from this device, if it holds the file;
3. otherwise fetched into app storage.

It answers at once from what is here, its publisher offline or not; `timeout` (10 s) bounds only
the wait for a page that isn't here yet. `NOT_FOUND`: no such page; `NOT_AVAILABLE`: no holder online.

## App storage

Site files fetched for reading land in `<instance folder>/app-storage/<root>`, never in the person's
folders. It is a cache under `appStorageMax` (1 GiB by default): over the cap, the least recently
read files go first (files not read since the instance opened: oldest held first). A file being
served on Windows can't be deleted; it goes on the next pass.

While `sync()` runs, the owner's device keeps every upload of the sites it owns in
`app-storage/kept/`, outside eviction, so an upload outlives its poster going offline.

## Installed sites

`site.keep(true)` installs a site on this device: every page and upload fetched into
`app-storage/kept/`, never evicted, served to the site's members, and followed while `sync()` runs
(new and edited files fetched, removed ones dropped). A file already in the cache is moved, not
fetched again. The choice is remembered by a `kept` record of this device; another device of the
person makes its own. `site.keep(false)` hands the files back to the cache. `site.kept()` says
which; `site.held()` counts the site's bytes here (held files, each path once, plus inline ones).

## Uploads

`site.upload(file, { name })` hashes a file where it lies and serves it from there, as
`drive.add` does. An upload is a snapshot: later edits of the local file aren't followed.
`site.uploads()`, `readUpload(id)`, `renameUpload(id, name)` (its author), `removeUpload(id)`
(its author, the owner or an admin).

## Packs

An app can ship sites inside itself as their own signed data, so a new install opens them with
nobody online and still gets later edits from peers.

- **Export** (a build): `SwarmFS.open(ownerDir, { offline: true })` reads the owner's folder as it
  is (no rescan, no name published, never online), then `sfs.exportSites(keys, folder)` writes the
  sites' spaces and pages sub-spaces (hypergraph's `exportSpaces`, in `folder/spaces`) and every
  file too big to be inline (`folder/files/<root>`). Only public sites; every file must be held
  there. No key, identity, personal space or setting is written.
- **Import** (first launch): `sfs.importSites(folder)` hashes every file first (a changed one
  refuses the whole pack), imports the spaces as replicated data (signatures and rules checked),
  then keeps a file only if a record of those sites names its hash. Returns the sites' keys; they
  are then ordinary visits, and `site.keep(true)` installs them. `IMPORT_INVALID`: nothing kept.

## Known limits

- Anyone joining a public site is a member and may upload; the owner's device keeps those uploads.
- Readers can't be invited into a private site (see [sharing.md](sharing.md#known-limits)).
