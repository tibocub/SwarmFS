# CLAUDE.md

Read before doing anything here.

## What this is

SwarmFS: folders and files as records in hypergraph spaces (`require('hypergraph/next')`),
bytes through swarmwire. A library first (plus a thin CLI to try it). The rewrite started
2026-10-22; `E:\Code\P2P\SwarmFS-old` is the previous code, reference only, never edited.

State (2026-10-28): spec 001 (v1, personal sync) built, stories 1–5; `lib/` the library,
`bin/swarmfs.js` the CLI (no logic of its own), `test/` scenario tests on Node and Bare
(`npm run test:all`). Open requests: `specs/requests-to-*.md`. After the lead review of 2026-10-28:
reopen with 1,000 held files and the other device offline ~0.5 s (SC-009); the CLI is one
long-running shell (`swarmfs`), `serve` gone; `init`/`join` seal the recovery phrase with a
password (`SWARMFS_PASSWORD` for scripts and tests).

## Governing documents

- `.specify/memory/constitution.md` — binding. Bytes stay where they are; test-first through
  the public API; Node and Bare from the first test; compose hypergraph and swarmwire, never
  reimplement them; smallest complete design.
- Direction and decisions across projects: `E:\Code\P2P\hypergraph\ROADMAP.md` and
  `ECOSYSTEM.md`. hypergraph's API: its `docs/next/` and `specs/011-spaces-core/contracts/api.md`.
- swarmwire's rules: `E:\Code\P2P\swarmwire\AGENTS.md`, `docs/format.md`.

## How sessions work here

- A **lead conversation** (Tibo + Claude, in the hypergraph repo) decides direction and reviews.
  **Worker sessions** do one job each (a spec, a phase of tasks), on a branch, commit locally,
  don't push (Tibo pushes), and stop with a short report. Nothing merges without review.
- Spec-kit flow: `/speckit-specify` → `/speckit-clarify` (only for Tibo's own choices) →
  `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`. Specs in `specs/NNN-name/`.
- `/ponytail` (full) for everything written here.
- **Feedback loop**: never edit `hypergraph` or `swarmwire` from here, and never work around
  them. A missing or awkward piece goes into `specs/requests-to-hypergraph.md` or
  `specs/requests-to-swarmwire.md`, with why. The lead conversation reviews these first.
- The repo is the memory: decisions land in files, not only in chat.
- Tibo wants reports in bullets and fragments, no long sentences.

## Dependencies

Sibling repos as local paths (`"hypergraph": "file:../hypergraph"`, `"swarmwire-lib":
"file:../swarmwire"`, swarmwire's branch `main`; its app contract is `docs/contract.md`):
`npm install` makes junctions. Never `ln -s` on Windows (it copies);
see ECOSYSTEM.md. In a worktree under `.claude/worktrees/`, junction `node_modules` to the main
checkout's (`mklink /J node_modules <main>\node_modules`) instead of installing. hypergraph is CommonJS, swarmwire is ESM; SwarmFS is ESM.

## Commits

Small steps on the feature branch. Messages end with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
