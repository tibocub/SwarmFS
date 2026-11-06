# Research: SwarmFS 004 — sites

Probe: `specs/repro-h22-site-roles.mjs` (hypergraph master `eaca1ab`, 2026-11-06), Node.

## R1. A site's space: closed, not private

- Probe: a `reader` role (no permissions) in a **private** space: `access: 'waiting'` for 15 s, reads
  nothing (the research note's Q3 Part C, now proven). In a **closed** space: reads at once (`full`).
  Both: the reader's `put` is `NOT_ALLOWED`; the owner sees the reader in `memberConnections()`.
- A private space can't be made public (hypergraph). A site exists to be read.
- Decision: sites are closed. A reader invite in a private (files) space is refused `NOT_SUPPORTED`
  (FR-007); H6 updated with the probe.

## R2. Protected pages: a sub-space with `writeRoles: ['admin']`

- Probe: Bob (`editor`) gets the sub-space, reads its pages; his `put` there and his `edit` of
  Alice's `file` record (`editable: 'members'`): `NOT_ALLOWED`. The owner and admins always write.
- Alternatives: new page types in the top space with `put`/`editable: { permission: 'decide' }`:
  doubles every folder/file code path (list, sync, fetch) for no gain. Sub-space: spec 001–003's code as is.
- "One space, one key" *(Tibo)*: the sub-space is reached from the site's key (members of the parent
  have it); a `site` record `{ pages }` with `put: { permission: 'decide' }` says which sub-space (probe:
  Bob's `put('site')` refused). A name lookup in `subspaces()` would also work; the record also tells
  "this space is a site" with one read.

## R3. Uploads: a type editable by its author

- `file` is `editable: 'members'` and can't change (hypergraph appends only). Probe: an `upload` type
  (default `editable: 'author'`): Alice can't edit Bob's upload; she may delete it (owner).
- No folders for uploads: a forum post links an upload record by id.
- Uploaded from where it lies (a `held` record), as `add` (constitution I). Edits of the local file
  after uploading are not followed (an upload is a snapshot; the owner keeps its bytes).

## R4. Public sites

- Probe: `makePublic()` on the site's space only: Eve (public link) reads the top space, sees `pages`
  in `subspaces()`, but `hg.space(pages)` throws for 15 s: she never gets the closed sub-space (an
  invited editor does). With `pages.makePublic()` too: she has it at once by the top's link, reads it,
  her `put` there is `NOT_ALLOWED` (`writeRoles`). Filed **H22** (docs say members of the parent have
  a sub-space at once; a public joiner is a member). Making the pages public is right anyway: a
  public site's pages are public.
- Public joiners are `member` and may `put` in the top space (probe: Eve's upload accepted). A static
  site can't refuse them: **H23** (a public space's default role). The write limit and bans apply.

## R5. Inline: `data` appended to `file`; sites only

- Record limit 64 KiB (hypergraph `MAX_RECORD`); probe: a 60 KiB `bytes` field puts fine. Inline when
  size ≤ 61,440 bytes.
- Only in sites: elsewhere the bytes would be copied into logs (constitution I) and older apps
  writing to a pre-004 space would hit `INCOMPATIBLE_TYPES` for a field the space lacks; sites are
  new spaces with the new types.
- Which spaces inline: a sub-space (only sites make them in SwarmFS) and uploads. `space.parent` is
  sync and known without opening.
- Rule `swarmfs/inline-v1`: `data` absent, or its length equals `content.size` (≤ 61,440) and its
  BLAKE3 root (swarmwire's `MemorySource`, the same tree as `hashFile`) equals the content's. Every
  member checks it before keeping: a record with wrong bytes is never stored or shown (FR-015).
- The bytes are read once and their root compared with the hashed one: a file changed meanwhile isn't
  inlined (the next rescan updates it).

## R6. App storage

- `<instance dir>/app-storage/<root>` for read pages and uploads; `kept/<root>` for the owner's kept
  uploads. Held as any file (`held` record with the page's space and entry), so served to that space's
  members (003's scoping).
- Cap: `appStorageMax` at open (default 1 GiB). After each fetch into it: least recently read first
  (in memory; after a restart, by `held` record order), skipping kept files and files the OS won't let
  go (Windows, served right now: tried again next time).
- Excluded from `rescanSingles` and the singles watcher (they are not the person's files).
- A cached file deleted by hand: `localPath` ignores its stale `held` record; the next fetch drops it.

## R7. Visits write nothing

- `publishName` runs on every `'spaces'` event: in a site it would write a `profile` per visit. It
  now skips sub-spaces and spaces with a `site` record, and writes only once a read of `site` is
  complete (a just-joined site's record may not be there yet).
- `visit(link)` redeems the invite and returns the Site, waiting for the `site` record and the pages
  sub-space (up to `timeout`).
