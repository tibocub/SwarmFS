# CLAUDE.md

SwarmFS: a P2P file system library (Node and Bare) on hypergraph (records, spaces) and swarmwire
(bytes). `lib/` the library, `bin/swarmfs.js` a thin CLI with no logic of its own, `test/` scenario
tests through the public API. ESM; hypergraph is CommonJS, swarmwire ESM.

## Tests

Sibling checkouts `../hypergraph` and `../swarmwire` are linked by `npm install`. In a worktree under
`.claude/worktrees/`, junction `node_modules` to the main checkout's (`mklink /J node_modules
<main>\node_modules`, removed only with `rmdir`) instead of installing; never `ln -s` on Windows.

Put temp data on a disk with room. On this machine C: is nearly full, so set all three to E: for
every run:

```bash
export TMP='E:\Code\P2P\.tmp\tmp' TEMP='E:\Code\P2P\.tmp\tmp' HG_TEST_TMP='E:\Code\P2P\.tmp\tmp'
npm test              # Node
npm run test:bare     # Bare
npm run perf          # when a hot path changes (docs/performance.md)
```

## Types

`npm run typecheck` (tsc strict, `jsconfig.json`; tests excluded) must pass with no error; a test
enforces it, and `test/types-consumer.test.js` checks the built `.d.ts` as a TypeScript user gets
them. JSDoc `@typedef` for every object shape, hypergraph's and swarmwire's types where values come
from them (never copies); `any`, casts and `@ts-expect-error` only with a one-line reason. A cast
starting a line needs care: without semicolons, `(` there continues the line before. Untyped
packages get hand-written types in `types/` (none yet).

## Comments

Keep a comment only when it says why something is done in a way the code can't show (a subtle
bug avoided, a security choice, a platform quirk). No spec numbers, dates or names in code.
Public API: JSDoc on every method (options, defaults, return shape, error codes), kept true to the code.
A known limit of a shortcut: `// shortcut: <the limit>, <when to upgrade>`.

## Where things live

- `docs/`: how it works and every option ([docs/README.md](docs/README.md) is the index).
- `specs/`: feature specs as written, records only; `specs/requests-to-hypergraph.md` and
  `requests-to-swarmwire.md`: what SwarmFS needs from its dependencies. Never edit hypergraph or
  swarmwire from here, and never work around them: file a request there.
- `.specify/memory/constitution.md`: the project's binding rules.
- `CONTRIBUTING.md`: setup, tests, sending a change.

Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
