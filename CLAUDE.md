# CLAUDE.md

This project's primary agent-instruction file is **`AGENTS.md`** — read that first, it already
covers testing workflow, critical invariants, common patterns, and debugging. This file exists
only to point at spec-kit, which is layered on top, not a replacement.

**`.specify/memory/constitution.md` is the project's binding governance document** — it
deliberately defers to `INVARIANTS.md` (authoritative rules, NON-NEGOTIABLE), `AGENTS.md`
(workflow), and `DATAFLOW.md` (data-flow reference) rather than restating them, and adds only
spec-kit's own governance on top.

## Spec-kit workflow

Every `/speckit-*` skill has `disable-model-invocation: false` — I can invoke these directly via
the Skill tool, without you typing the slash command. Decide myself whether a request needs the
full pipeline (new/ambiguous features, real design decisions) or just a direct fix with a test
(a small, already-understood bug).

`/speckit-specify` → (optional `/speckit-clarify`) → `/speckit-plan` → `/speckit-tasks` →
(optional `/speckit-analyze`, `/speckit-checklist`) → `/speckit-implement` → `/speckit-converge`
for periodic backlog sweeps. `specs/<NNN-feature>/` is the source of truth for new work.

Development is currently **paused** pending sibling-project (`hypergraph`) features — see
constitution Principle III before starting anything that depends on hypergraph capabilities
that don't exist yet.

## Wider ecosystem

SwarmFS is one of five sibling P2P projects under `E:\Code\P2P\`. **Canonical map:
[`E:\Code\P2P\hypergraph\ECOSYSTEM.md`](../hypergraph/ECOSYSTEM.md).**

- **hypergraph** (`E:\Code\P2P\hypergraph`) — P2P graph database. The hub. SwarmFS is **paused
  waiting on it** (multi-writer virtual directories, users/friends, moderated swarms). It is NOT
  currently a dependency here — no entry in `package.json`, nothing in `node_modules`. When
  constitution Principle III says to check hypergraph's actual current API before building against
  it, read that checkout directly; you cannot do it from inside this repo.
- **HyperBBS**, **HyperMD**, **hyperDNS** — browser, document format, naming. Unrelated to SwarmFS
  today.

⚠ `E:\Code\P2P\` also contains `SwarmFS-main\`, `SwarmFS-copy\`, `SwarmFS.old\`, and
`SwarmFS-0.1\`. **This directory is the live one**; those are not. Confirm your path before editing.

The main branch here is **`main`** (not `master`). `dev` was merged into it on 2026-09-13; work from
`main` with a branch per feature, as described below.

## Tooling

Spec-kit's own `/speckit-*` skills shell out to `.specify/scripts/python/*.py` (stdlib-only) —
`python3` must resolve on PATH. If a skill's `python3 ...` call fails with "command not found,"
retry as `python .specify/scripts/...` (some Windows setups only expose `python`).

## Git convention: branch per feature

No spec-kit git extension is installed, so branch creation isn't automatic. After
`/speckit-specify` creates `specs/<NNN-name>/`, run `git checkout -b <NNN-name>` (same name as
the spec directory). Merge back to `main` once that feature's `/speckit-implement` is done and
its tests pass.
