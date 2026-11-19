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
junctions; don't replace them with `ln -s`, which copies. Node 20 or later; Bare 1.27 or later is
installed as a dev dependency.

## Tests

```bash
npm test              # every test/*.test.js on Node, one process per file, in parallel
npm run test:bare     # the same on Bare
npm run test:all      # both
npm run test:slow     # test/slow/: a 100 MB fetch, 10,000- and 1,000-file syncs
node scripts/test-runner.js test/watch.test.js   # some files only (--bare, --jobs N)
```

Each test starts its own local DHT and its own instance folders in the temp folder. Point
`HG_TEST_TMP` (and `TMP`, `TEMP`) at a fast disk with a few GB free; a full disk fails tests with
"not enough space", which reads like a bug. `SFS_TEST_JOBS` sets how many files run at once.

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
- Public calls get JSDoc (options, defaults, return shape, errors); other comments only say why.
  Update `docs/` when behaviour changes.

The binding rules are in `.specify/memory/constitution.md`.

## Sending it

Work on a branch, in small commits, each passing `npm run test:all`. Open a pull request with what
changed, why, and the perf comparison if a hot path moved. Nothing merges without review.
