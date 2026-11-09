# Spec 009: packs (HyperBrowser 015)

**Created**: 2026-11-09 · **Status**: done · **Uses**: hypergraph spec 020 (`exportSpaces`, `importSpaces`)

HyperBrowser ships its official apps inside the app as their own signed data, so a new install opens them
with nobody online and still updates them from peers (copies of their files were rejected: they drift).

## Requirements

- **FR-001** `sfs.exportSites(keys, folder)`: for each
  public site, its space and pages sub-space (hypergraph pack in `folder/spaces`) and every non-inline page and
  upload held here (`folder/files/<root>`). NOT_FOUND for a space that isn't a site or a file not held here;
  NOT_ALLOWED (hypergraph) for a site that isn't public. `SwarmFS.open(dir, { offline: true })`: no rescan,
  no names published, no swarm (a build never publishes edits made in the owner's linked folders since).
- **FR-002** `sfs.importSites(folder, { timeout })`: every file hashed first (a changed one refuses the pack
  before anything is kept); then hypergraph's import (signatures, rules, public only); then each file named
  by a record of the imported sites goes to app storage with its held record (files no record names are
  ignored). `site.keep(true)` then moves them to kept/ as any cached file. → the sites' keys.
- **FR-003** Nothing private: no key pair, identity, personal space, setting (tested).

## Tests

`test/pack.test.js` (Node, Bare): every page read offline from a pack, installed whole, an edit published
later arrives from the owner; a changed file and missing blocks refused with nothing kept; a closed folder's
export holds the site and its pages only, no secret; a site that isn't public is refused.

No perf scenario: an import runs once per install, not on a hot path.
