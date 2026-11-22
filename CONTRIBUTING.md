# Contributing

## Setup

SwarmFS depends on two sibling checkouts, linked as local packages:

```text
P2P/
├── hypergraph/   (its default branch)
├── swarmwire/    (branch main)
└── SwarmFS/
```

```bash
npm install
```

`npm install` links `../hypergraph` and `../swarmwire` into `node_modules`. On Windows these are
junctions; don't replace them with `ln -s`, which copies. Node 20 or later; Bare 1.27 or later and
TypeScript (for `npm run typecheck`) are installed as dev dependencies. Run `npm run types` in
`../hypergraph` and `../swarmwire` once: SwarmFS is checked against their built `dist/types`.

## Tests

```bash
npm run typecheck     # strict TypeScript over lib/, bin/, scripts/ (also run by npm test)
npm test              # every test/*.test.js on Node, one process per file, in parallel
npm run test:bare     # the same on Bare
npm run test:all      # both
npm run test:slow     # test/slow/: a 100 MB fetch, 10,000- and 1,000-file syncs
node scripts/test-runner.js test/watch.test.js   # some files only (--bare, --jobs N)
```

Three levels, from fast to thorough:

| Level | Command | Runs | When |
|-------|---------|------|------|
| quick | `npm run test:quick` | the tests your change affects, on Node | while working |
| merge | `npm run test:merge` | the affected tests on Node and Bare, plus a few whole flows | before a branch is merged |
| full | `npm run test:all` | everything | before pushing, after heavy or risky changes, in CI |

"Affected" comes from `.test-map.json` (not committed): every full Node run (`npm test`) records
which functions of which files each test ran. Your change is what differs from `main`, committed or
not. A test runs if it ran a changed function, loaded a file changed outside any function, or is
itself changed; the typecheck tests run on any source change. A change in `../hypergraph` or
`../swarmwire` (their checkout moved since the map, or has changes of its own) runs every test that
ran any of their files. The runner prints what it picked and why, and runs everything instead
(saying why) when the map is missing or older than the last change to a test helper, when a helper,
`package.json`, the lockfile or the runner changed, or when a source file is new.

A file that fails runs once more, alone, after the others. Passing then, it shows as
`FLAKY (passed alone)` and the summary counts it: a flaky test is a bug to fix, not a pass. Failing
twice is a real failure.

Each test starts its own local DHT and its own instance folders. Tests use the system temp folder; `HG_TEST_TMP` overrides it. When it has under 3 GB free, the
runner uses `HG_TEST_TMP_FALLBACK` if set and prints a line. Each test file gets a folder of its own
there, removed once it is done. The suites mostly wait on that disk (every account open and close
waits for its writes to be synced), so a fast disk matters more than more jobs. `SFS_TEST_JOBS` sets how many files run at once.

Every change runs on both Node and Bare: platform modules come through the `imports` map in
`package.json` (`fs` → `bare-fs` on Bare...).

## Making a change

- Write the test first, through the public API (`index.js`), as a scenario a person or an app goes
  through. Tests in `test/` show the shape; `test/helpers.js` makes devices, pairs and people.
- Keep it small: compose hypergraph and swarmwire, never reimplement them. If one of them is missing
  something, add the need to `specs/requests-to-hypergraph.md` or `specs/requests-to-swarmwire.md`
  with why, rather than working around it.
- Bytes stay where they are: SwarmFS never copies a person's file into a store and never deletes one
  except through `emptyTrash()`.
- Record types are permanent: only append fields, add types and add indexes ([docs/data-model.md](docs/data-model.md)).
- A change touching a hot path (sync, fetch, rescans, holdings, records' shape) adds or updates a
  perf scenario and runs `npm run perf` before and after ([docs/performance.md](docs/performance.md)).
- Public calls get JSDoc (options, defaults, return shape, errors), and `npm run typecheck`
  passes; other comments only say why. Update `docs/` when behaviour changes.

The binding rules are in `.specify/memory/constitution.md`.

## Sending it

Work on a branch, in small commits, each passing `npm run test:all`. Open a pull request with what
changed, why, and the perf comparison if a hot path moved. Nothing merges without review.
