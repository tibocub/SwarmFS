# Contract: SwarmFS 004 public API (additions to 001–003)

New error codes: `NOT_SUPPORTED` (a reader invite in a private space, H6). `NOT_ALLOWED`,
`RULE_REJECTED` from hypergraph as they are.

```js
const sfs = await SwarmFS.open(dir, { appStorageMax })  // bytes; default 1 GiB

// Owner
const site = await sfs.createSite(name, { invites, types })   // closed space + pages sub-space; invites as 003
                                      // types (spec 005): the site's own record types, after SwarmFS's
await site.declareTypes(types)        // spec 005: adds types to the site (owner, admins; additions only)
await site.publish(localFolder)       // its files become the pages (a linked folder here: edits published while syncing)
await site.invite({ role, uses, expires })    // role: 'reader' | 'editor' (default; may upload)
await site.makePublic()               // for good; owner or admin
site.publicLink()                     // anyone reads with it; NOT_ALLOWED before public
site.isPublic
site.pages                            // a Drive of the pages (list, get, rename… owner/admins only)

// Visitors
const site = await sfs.visit(link, { timeout })   // an invite or the public link → the Site; writes nothing
const same = await sfs.site(key, { timeout })     // a site already joined; NOT_FOUND if not a site (waits only if its site record isn't here)
const bytes = await site.read('docs/index.html', { timeout })   // verified bytes: inline, held, or fetched into app storage
                                                                 // NOT_FOUND (no such file), NOT_AVAILABLE (no holder online)
                                      // from what is here at once (publisher offline too); waits up to
                                      // `timeout` only for a page not here while the site's list is incomplete
await site.keep(true | false, { timeout })   // spec 006: install (every file kept in app-storage/kept/, served,
                                      // followed while syncing, remembered here) | back to the cache
await site.kept()                     // → whether this device keeps it
await site.held()                     // spec 006: bytes of the site here: held files + inline ones

// Packs (spec 009): public sites shipped inside an app
await sfs.exportSites(keys, folder)   // what a visitor downloads: folder/spaces (hypergraph pack), folder/files/<root>
const owner = await SwarmFS.open(dir, { offline: true })   // a folder read as it is: no scan, no name published, never online
await sfs.importSites(folder, { timeout })   // → site keys; checked as replicated data, files by their signed hash;
                                      // IMPORT_INVALID (changed, missing blocks, not public): nothing kept

// Uploads (role editor)
const up = await site.upload(localFile, { name })  // → { id, name, size, hash, author }; served from where it lies
await site.uploads()                  // [{ id, name, size, hash, author }], latest first
await site.readUpload(id)             // bytes, as read()
await site.renameUpload(id, name)     // its author only
await site.removeUpload(id)           // its author, the owner or an admin

// Drive (all spaces)
await drive.invite({ role: 'reader' })   // NOT_SUPPORTED in a private space (H6)
```

- While `sfs.sync()` runs, the owner's app keeps every upload of the sites it owns (app storage, kept).
- Site extends Drive (members, roles, removal, invites as 003) on the site's space.
