<!--
Sync Impact Report
Version change: none (new) → 1.0.0
Rationale: initial ratification — MAJOR because this establishes the first *versioned*
governance for the project. Unlike a from-scratch adoption, this project already has an
unusually mature, working AI-collaboration doc set: AGENTS.md (workflow/testing/patterns,
self-declared as a living doc with its own update protocol), AI_CONTEXT.md (session-start
orientation + 8 never-violate rules), INVARIANTS.md (the authoritative, code-identifier-scoped
correctness rules — explicitly cited as authoritative by both other files), and DATAFLOW.md
(entity lifecycles, sync-point hazards). This constitution deliberately does NOT re-derive or
restate their content — it exists to wire spec-kit's own governance (versioning, the
Constitution Check gate, specs/ as the record of new work) around them, and to say precisely
which existing file governs which kind of question.
Modified principles: n/a (initial set)
Added sections: Core Principles (I–III), Documentation & Specification Hygiene, Governance
Removed sections: none
Templates requiring follow-up:
  ✅ plan-template.md — Constitution Check gate reads this file at runtime, no edit needed
  ✅ tasks-template.md / speckit-tasks SKILL.md — "tests optional by default" contradicted
     AGENTS.md's own existing testing workflow (write a unit test, run it, THEN check via CLI/
     Docker); changed default to test-tasks-included
  ✅ AGENTS.md — added a short Spec-Kit pointer section (using the file's own stated
     Self-Improvement protocol) and fixed a real `test/` vs `tests/` path drift found while
     reading it (also present in AI_CONTEXT.md, fixed there too)
  ⚠ TODO: none outstanding
-->

# SwarmFS Constitution

## Core Principles

### I. INVARIANTS.md Is Authoritative and NON-NEGOTIABLE

Every rule in `INVARIANTS.md` — content-addressed serving by merkle root only, `chunksInFlight`
counting subtrees not chunks, `file_modified_at > 0` meaning complete, the exact protocol
message sequence, subtree power-of-two alignment, and the backpressure counters
(`_activeServes`, `_subtreeServeQueue`, CANCEL decrementing) — is a hard constraint, not
guidance. This constitution does not restate them (they're already precise, code-identifier-
scoped, and self-declared as "must never be violated" — restating them here would just create a
second copy to drift out of sync). Any plan or task touching download/protocol/serving logic
MUST check itself against `INVARIANTS.md` directly. If a change needs to add a genuinely new
invariant, follow the process `AGENTS.md` already specifies: add it to `INVARIANTS.md`, add a
test case to `tests/core-behaviors.test.js`, update `AGENTS.md`'s own patterns section.
Rationale: this file already does exactly what a constitution's Core Principles section is for,
written by whoever hit each of these bugs first. Duplicating it would only add a
staleness risk with zero benefit.

### II. Test-First for Download/Protocol Logic (NON-NEGOTIABLE)

Any change to `protocol.js`, `download.js`, or the chunk-scheduling/backpressure logic MUST add
or extend a case in `tests/core-behaviors.test.js` that fails before the change and passes after
— this is `AGENTS.md`'s existing "Testing a New Feature" Step 1, formalized as non-negotiable
because this is exactly the code the Common Issues table (`AGENTS.md`) shows has broken the same
few ways more than once (per-chunk vs per-subtree counting, leaked backpressure slots, sharing
status leaking into serving decisions). Follow the existing 3-step verification `AGENTS.md`
already prescribes (unit test → single-machine CLI test → Docker cross-machine test) for
anything touching real P2P transfer, not just the unit test in isolation.

### III. Respect the Paused-Feature Boundary

Per README.md, SwarmFS development is currently paused pending features from the sibling
`hypergraph` project (multi-writer virtual directories, users/friends, moderated swarms).
Work that depends on those hypergraph features stays scoped/deferred rather than half-built
against an assumption of what hypergraph will eventually provide — check hypergraph's actual
current API (same "verify empirically" discipline as any dependency) before building against it.
The `apps/`/`packages/` workspace scaffolding (currently empty, not wired into
`package.json`'s `workspaces`) is pre-migration structure, not a live package split — don't
half-populate it without actually completing the migration in the same change.
Rationale: recorded here because it's easy for a session without this context to either start
building the paused hypergraph-dependent features prematurely, or add files into the empty
scaffolding dirs without realizing they're not real packages yet.

## Documentation & Specification Hygiene

`specs/<feature>/` (spec → plan → tasks) is the source of truth for anything new or changed,
going forward. The existing doc set keeps its existing roles exactly as `AI_CONTEXT.md` already
ranks them: `INVARIANTS.md` = authoritative rules (Principle I), `docs/ARCHITECTURE.md` /
`DATAFLOW.md` = diagrams and data-flow reference, `AGENTS.md` = testing workflow and common
patterns, `README.md` = user-facing docs. **Doc-sync-on-change** applies to all of them: a change
that affects what one of these files claims → update it in the same change, per the process each
already documents. Known, pre-existing doc staleness found and left as-is (not blocking, but
worth fixing opportunistically): three narrative docs under `docs/` (`Chunks, Hashes and Merkle
Trees.md`, `Database and Local Data.md`, `P2P Networking and File Transfer.md`) describe
SHA-256 hashing, while the actual implementation (and every other doc) uses BLAKE3
(`@webbuf/blake3`, `blake3-bao`) — these three predate that change and were never updated.

## Governance

This constitution supersedes ad hoc practice. Amendments happen via `/speckit-constitution`,
using semantic versioning for this document itself: MAJOR for a principle removed or redefined
incompatibly, MINOR for a principle or section added, PATCH for wording/clarity fixes. Every
`/speckit-plan` MUST pass the Constitution Check gate against the current version of this file
(which in practice means checking the plan against `INVARIANTS.md` directly, per Principle I)
before Phase 0 research begins, and re-check after Phase 1 design; violations are either
resolved or justified in that plan's Complexity Tracking table. Principles I and II are
NON-NEGOTIABLE: a plan cannot justify away a violation of them, only avoid causing one.

**Version**: 1.0.0 | **Ratified**: 2026-09-09 | **Last Amended**: 2026-09-09
