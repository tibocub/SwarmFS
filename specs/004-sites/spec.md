# Feature Specification: SwarmFS 004 — sites: read-only visitors, protected pages, app storage, small files inline

**Feature Branch**: `claude/site-prereqs-be3a52`

**Created**: 2026-11-06

**Status**: Draft

**Input**: "the 4 prerequisites HyperBrowser milestone 1 needs before it can serve sites from SwarmFS
spaces" (hypergraph `ROADMAP.md` "Before milestone 1"; `specs/research/hyperbrowser-milestone-1.md`;
`specs/research/site-storage.md` Q1, Q3). Tibo's choices are marked *(Tibo)*; the rest are defaults
listed under Assumptions, for the lead's review.

Words used below (specs 001–003's words still hold: space, entry, held, linked folder, member):
- **Site**: a space holding a website: its **pages** (HTML, JS, CSS, `site.json`, images the owner
  put) and its **uploads** (files members add, e.g. a picture in a forum post). **One site is one
  space, one key** *(Tibo)*: a forum's pages and its posts live in the same space.
- **Visitor**: someone reading a site. A **reader** reads only; an **uploader** (role `editor`) also
  uploads and writes the site's own records (forum posts).
- **Public site**: a site anyone may read with its public link, no one letting them in.
- **App storage**: a folder inside the engine's own data folder (not the person's folders) where a
  site's files land when read; a cache with a size cap, emptied least recently used first.
- **Inline file**: a small file (up to 60 KB) whose bytes are inside its record.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Protected pages, open uploads (Priority: P1)

Alice makes a site and publishes her site folder. Her pages can be changed only by her and the
site's admins. Bob, invited as an uploader, adds a picture; only he can rename or replace it.

**Why this priority**: today every invitee is an `editor` who can rename or bin the site's pages, and
Alice's disk follows (research Q3). Nothing else is safe to build before this.

**Independent Test**: Alice creates a site, publishes a folder, invites Bob; Bob reads the pages,
his changes to a page are refused, his upload is listed for Alice, Alice can't edit it.

**Acceptance Scenarios**:

1. **Given** Alice's site with her folder published, **When** Bob (uploader) tries to add, rename,
   move, replace or remove a page, **Then** each is refused (`NOT_ALLOWED`), and Alice's folder on her
   disk is untouched.
2. **Given** Alice makes Carol an admin, **When** Carol changes a page, **Then** it works, and
   Alice's linked site folder follows (spec 002).
3. **Given** Bob uploads `photo.jpg`, **When** Alice lists the uploads, **Then** she sees it with its
   name, size and author; **When** Alice (or Carol) tries to rename or replace it, **Then** refused;
   Bob can rename or remove his own upload; the owner and admins may remove it (moderation).
4. **Given** the site's one key, **When** anyone in it opens it, **Then** the pages and the uploads are
   both reached from that key; nothing else to join.
5. **Given** Alice edits a page in her site folder while syncing, **Then** visitors read the new
   version (spec 002's linked folder, nothing new).

---

### User Story 2 - Read-only visitors and public sites (Priority: P1)

Alice invites Dave as a reader: he reads every page and upload but can't upload or write. Alice makes
her site public: Eve opens it with its public link, with Alice offline, and reads it; no one let her
in and nothing about her is written to the site.

**Why this priority**: most visitors of a site only read (research Q3 "read-only visitors").

**Independent Test**: a reader invite; a public link with the owner offline and the site held by
another visitor.

**Acceptance Scenarios**:

1. **Given** a reader invite, **When** Dave joins with it, **Then** he reads pages and uploads; his
   upload or any write is refused (`NOT_ALLOWED`).
2. **Given** Alice makes the site public, **When** Eve opens its public link, **Then** she reads
   the pages, and her page changes are refused; once public a site stays public (hypergraph).
3. **Given** a public site whose owner is offline but held by another visitor, **When** Eve opens it,
   **Then** she reads the pages from that visitor.
4. **Given** someone visits a site (reader or public), **Then** SwarmFS writes nothing into the site
   for them (no name, no holdings shown), so visits cost the owner nothing.
5. **Given** a private files space (spec 003), **When** someone asks for a reader invite there,
   **Then** refused (`NOT_SUPPORTED`): hypergraph gives a reader no key to a private space today
   (request H6, confirmed by this spec).

---

### User Story 3 - App storage: a site's files in the engine's folder (Priority: P1)

Dave visits Alice's site. The pages he reads land in the engine's app storage, never in his own
folders; they are served to other visitors while held; past the cap, the least recently read files
go. Alice's app keeps every member's upload, so a picture outlives its poster going offline.

**Why this priority**: an engine visiting many sites must not fill the person's folders or disk
(ROADMAP: "a site's files in the engine's folder, evicted like a cache").

**Independent Test**: read a site's pages; check they are in app storage and nowhere else; read more
than the cap; the oldest are gone and can be read again; Bob uploads and goes offline, Carol reads the
upload from Alice.

**Acceptance Scenarios**:

1. **Given** Dave reads `index.html` by its path, **Then** he gets its bytes, verified; the file (if
   not inline) is in app storage, and nothing is written in his folders or linked folders.
2. **Given** Dave reads it again, **Then** no transfer happens (held in app storage).
3. **Given** app storage over its cap, **Then** the files read least recently are removed until it is
   under it; a removed file is read again on demand.
4. **Given** Carol visits after Dave, with Alice offline, **When** she reads a page Dave holds in app
   storage, **Then** she gets it from Dave.
5. **Given** Alice's app syncing, **When** Bob uploads, **Then** Alice's app fetches the upload into
   app storage, kept (never evicted); **When** Bob goes offline, **Then** Carol still reads it.
6. **Given** an upload removed, **Then** Alice's kept copy goes at her app's next pass.

---

### User Story 4 - Small files inside their record (Priority: P2)

Pages, scripts and styles up to 60 KB travel inside their record: a visitor has them as soon as the
site's records arrive, with no file transfer.

**Why this priority**: measured, halves a first visit (research Q1: entry page 0.29 → 0.13 s).

**Independent Test**: publish a site with small and big files; a visitor reads the small ones with
no holder online (only the records arrived), the big ones through a transfer.

**Acceptance Scenarios**:

1. **Given** a site published with a 4 KB page and a 200 KB image, **Then** the page's record carries
   its bytes, the image's doesn't.
2. **Given** a visitor with the site's records and no holder online, **When** reading the page,
   **Then** it gets the bytes (checked against the record's hash); the image is `NOT_AVAILABLE`.
3. **Given** the owner edits the page (still small, or grown past 60 KB), **Then** its record follows
   (bytes updated, or dropped and the file transferred instead).
4. **Given** a record whose bytes don't match its hash (a modified app), **Then** every member
   refuses it (never kept, shown or returned); this app refuses to write one (`RULE_REJECTED`).
5. **Given** a personal or shared files space (specs 001–003), **Then** nothing is inlined: those
   files stay where they are (constitution I).

### Edge Cases

- A path that doesn't exist, or a folder: `NOT_FOUND`.
- A page read while the site's records are still arriving: waits up to a timeout, then `NOT_FOUND`.
- A file bigger than the whole cap: read, returned, then the next pass evicts it (it is never kept
  over the cap for long).
- A cached file deleted by hand: read again on demand (the record of it is ignored, then dropped).
- Two reads of one file at once: one transfer.
- A space that isn't a site opened as a site: `NOT_FOUND` ("not a site").
- A public site's anyone may upload (a public joiner is a `member` in hypergraph): the owner's app
  keeps their uploads too. Floods: bans and write limits (hypergraph's). Assumption 6.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A person MUST be able to create a site with a name; it is one space with one key, in
  which the pages are writable only by the owner and admins *(Tibo)*.
- **FR-002**: The owner MUST be able to publish a local folder as the site's pages; it is a linked
  folder on the owner's device (spec 002), so later edits there are published while syncing.
- **FR-003**: Only the owner and admins MUST be able to add, rename, move, replace or remove pages;
  everyone else's attempt is refused (`NOT_ALLOWED`).
- **FR-004**: Uploaders MUST be able to upload a file (from where it lies: not copied, constitution I),
  rename it and remove it; nobody else may rename or replace it; the owner and admins may remove it.
- **FR-005**: Anyone in the site MUST be able to list uploads with name, size, hash and author.
- **FR-006**: An invite MUST say the role: reader (reads only) or uploader (`editor`); a reader's
  writes are refused.
- **FR-007**: A reader invite in a private space MUST be refused with `NOT_SUPPORTED` until
  hypergraph gives readers a private space's key (H6).
- **FR-008**: The owner or an admin MUST be able to make a site public, for good; the site then has
  one public link that lets anyone read it, with no one online to let them in.
- **FR-009**: Opening a site (by invite or public link) MUST write nothing into the site for the
  visitor: no name, no shown holdings.
- **FR-010**: Reading a page by its path, or an upload by its id, MUST return its bytes, verified
  against the record's hash: inline bytes from the record, else a file already held on this device,
  else fetched from an online member into app storage.
- **FR-011**: App storage MUST be a folder in the engine's data folder; files read there are held and
  served to the site's members like any held file; nothing of a site is written outside it.
- **FR-012**: App storage MUST keep under a cap (default 1 GB, an option at open), removing the least
  recently read files first; kept uploads don't count toward it and are never removed by it.
- **FR-013**: While syncing, the owner's app MUST fetch every upload of each site it owns into app
  storage as kept, and drop kept copies of uploads no longer in the site.
- **FR-014**: In a site, files up to 60 KB (61,440 bytes) MUST be stored inside their record (pages
  and uploads), and kept so when edited; bigger ones MUST NOT. Other spaces inline nothing.
- **FR-015**: A record whose inline bytes don't match its hash MUST be refused by every member (an
  app rule): never kept, shown or returned.
- **FR-016**: Everything works on Node and Bare, through the public API (constitution II, III).

### Key Entities

- **Site**: one space (not private), its pages sub-space and a `site` record naming it, put by the
  owner or an admin only.
- **Page**: a `file` or `folder` entry in the pages sub-space (spec 001's types); a small `file`
  carries its bytes.
- **Upload**: an `upload` record in the site's space: name, content (hash, size), bytes if small;
  editable by its author only.
- **Roles**: `reader` (no permissions), `editor` (writes, uploads), plus hypergraph's `admin`, `owner`.
- **App storage entry**: a `held` record (spec 001) whose path is in app storage.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A visitor reads a 20-page site's entry page (site.json, index.html, style.css, app.js)
  in about half the time of spec 003's flow on the same machine (perf `site` scenario, loopback).
- **SC-002**: No visitor action (reader or uploader) can change a page: every attempt in the tests
  is refused, and the owner's site folder is byte-identical after them.
- **SC-003**: After reading more than the cap, app storage is at most the cap (plus kept uploads) on
  the next read.
- **SC-004**: A visit writes 0 records into the site.
- **SC-005**: An upload is still readable by a third member after its poster goes offline, within
  10 s of its upload, when the owner's app is syncing.

## Assumptions

1. A site's space is **closed, not private** (anyone holding its key reads; only members write).
   A site is published to be read, and a private space can't be made public (hypergraph). Readers in
   private spaces: H6.
2. Pages live in one **sub-space** of the site's space (hypergraph's `writeRoles`), reached from the
   site's key: the site stays one key *(Tibo)*. A public site makes its pages sub-space public too, so
   public visitors get it (H22).
3. Uploads are a new record type, editable by their author only (a `file` record's `editable` can't
   change: hypergraph only appends). They have no folders.
4. "Uploader" is spec 003's `editor` role (writes: uploads and the site's own records).
5. The cap default is 1 GB; the owner keeps uploads with no cap (a later setting, as spec 002's floor).
6. Public sites accept uploads from anyone (hypergraph gives public joiners `member`); the owner
   keeps them. A static site that wants none: a hypergraph question, listed, not built.
7. Last read times are known while the engine runs; after a restart, files count as read when they
   were stored. Precise enough for a cache.
8. Constitution I is amended (1.2.0, MINOR): app storage and inline bytes are allowed **for sites
   only**; the person's own files keep the strict rule.

## Out of scope (named for later)

- Video: range-first downloads (swarmwire), byte ranges to the web view.
- A site's own record types and rules (spec 015, one engine): SwarmFS's types only here.
- Per-site caps, pinning a site's files offline, eviction by site.
- A cap on what the owner keeps; cleanup of uploads by moderators' take-downs beyond removal.
- The CLI: no new shell commands (HyperBrowser's engine calls the library).
