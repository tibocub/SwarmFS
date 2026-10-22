<!--
Sync Impact Report
Version change: (hypergraph's 1.1.0, copied) → 1.0.0 (SwarmFS's own, first version)
Rationale: new project; principles adapted from hypergraph's constitution for a consumer of
  hypergraph's new core (spec 011) and swarmwire.
Principles: I. The bytes stay where they are; II. Test-first, through the public API;
  III. Node and Bare from the first test; IV. Compose, don't reimplement (feedback loop);
  V. Smallest complete design
Added sections: Documentation & the Repo as Memory, Governance
Removed sections: hypergraph-specific ones (Adoption in an Existing Codebase, API_PROBLEMS.md)
Templates: plan-template.md reads this file at runtime (Constitution Check); no edit needed.
Deferred TODOs: none
-->

# SwarmFS Constitution

## Core Principles

### I. The Bytes Stay Where They Are (NON-NEGOTIABLE)

A file's bytes live in the user's filesystem and nowhere else. SwarmFS serves files in place
(through swarmwire) and MUST NOT copy file content into a store, a core, a cache or a database.
Records in hypergraph hold references (hash, size, name), never content. One hash may have
many local paths; a hash held locally is never downloaded again. SwarmFS MUST NOT delete,
move or overwrite a file on a user's disk because of something a peer wrote; removing an entry
from a space and deleting a local file are different actions.
Rationale: duplicate copies (hyperblobs + the real file) are why this project exists; and a
filesystem tool that loses local files loses all trust.

### II. Test-First, Through the Public API (NON-NEGOTIABLE)

Every user-visible flow has a scenario test (`brittle`) that plays it through SwarmFS's public
API with real hypergraph instances on a local DHT, written before the code. Every bug fix and
behavior change adds or updates a test that fails before and passes after, in the same change.
If a flow is awkward to write as a test, the API is wrong: fix the API.
Rationale: hypergraph's forum scenario tests proved this keeps an API easy and honest.

### III. Node and Bare From the First Test

The library and its whole test suite MUST run on Node and on Bare (Pear's runtime, for mobile
later) from the first test, not when shipping. No Node built-ins imported directly (`fs`,
`path`, `os`… go through the `imports` map to `bare-*`), no `Buffer` (use `b4a`), no `process`
global, no native modules of our own.
Rationale: mobile is a goal; swarmwire and hypergraph already hold this line.

### IV. Compose, Don't Reimplement

SwarmFS composes hypergraph's new core (`hypergraph/next`: spaces, records, devices, roles,
invites, budgets, app protocols) and swarmwire (verified transfer of bytes). It MUST NOT
contain replication, cryptography, networking, permission or transfer-scheduling code of its
own. When hypergraph or swarmwire lacks something SwarmFS needs, or makes it awkward, SwarmFS
does not work around it and does not edit those repos: the need goes into
`specs/requests-to-hypergraph.md` or `specs/requests-to-swarmwire.md`, with why. Dependencies
are proven Holepunch-stack libraries (or already used by hypergraph/swarmwire); no forks.
Rationale: the ecosystem gets better where the gap is, and SwarmFS stays small.

### V. Smallest Complete Design

Build the smallest thing that fully does the job (ponytail): no speculative options, layers or
features. A later story is kept possible by naming it in the spec's outline, not by building
for it. Anything that can't change later (record types: hypergraph only allows appending
fields) is decided carefully and once.
Rationale: one person plus AI sessions must be able to hold the whole project in their head.

## Documentation & the Repo as Memory

Every decision lands in a file — a spec, a plan, `CLAUDE.md`, this constitution — never only
in a conversation. `specs/<feature>/` (spec → plan → tasks) is the source of truth for new
work. Direction across projects lives in hypergraph's `ROADMAP.md` and `ECOSYSTEM.md`.
Docs change in the same change as the behavior they describe.

## Governance

This constitution supersedes ad hoc practice. Amendments go through `/speckit-constitution`
with semantic versioning (MAJOR: a principle removed or redefined; MINOR: one added or
expanded; PATCH: wording). Every `/speckit-plan` passes the Constitution Check against this
file before research and again after design; violations are fixed or justified in the plan's
Complexity Tracking table. Work merges only after a review in the lead conversation.

**Version**: 1.0.0 | **Ratified**: 2026-10-22 | **Last Amended**: 2026-10-22
