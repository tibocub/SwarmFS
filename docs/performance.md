# Performance

Performance is measured the way behaviour is tested: by scenarios that mirror real app flows, run
on Node and Bare, kept commit by commit.

```bash
npm run perf                     # every scenario, Node then Bare (about four minutes), saved
npm run perf -- --node           # one runtime (--bare for the other)
npm run perf -- sync site        # only these scenario files
npm run perf -- --no-save        # print only
npm run perf -- --sizes 1000     # passed to the scenarios
npm run perf:compare             # the last run against the previous one
npm run perf:compare -- --sha <sha>   # against the last run at that commit
```

## Scenarios (`perf/scenarios/`)

Each at two sizes, on a local DHT, built with the tests' own helpers:

- `sync.mjs`: a folder linked and synced to a second device; one edit propagating (the watcher's
  2 s settle reported apart from the work); `held` and `has` records per file.
- `shared.mjs`: a space shared by two people.
- `site.mjs`: a small site's first visit, an app instance's first visit, an install, and a read
  with the publisher offline.

Peers that would be on other machines run in their own processes (`perf/harness.mjs` `child`).
Scenarios run one at a time at below-normal priority. Temp data goes to `PERF_TMP`, else `.tmp/perf`
next to the main checkout when that `.tmp` exists, else the OS temp folder.

## Results

`npm run perf` appends one line per scenario and size to `perf/history.jsonl`, which is committed.
`npm run perf:compare` flags a change only when it is beyond this machine's run-to-run noise, so two
runs of one commit flag nothing:

- the median moved by more than max(25 %, 3 × the samples' half-range relative to the median);
- the minimum moved the same way (a few slow samples move a median, not a minimum);
- and, for times, by more than 0.5 ms.

Scenarios marked flat (their cost must not grow with the size) also show their curve, biggest size
against smallest; past 1.5× they are flagged `NOT FLAT`.

The numbers include the hypergraph and swarmwire checkouts that `node_modules` links to: say which
in a comparison that crosses one of their changes.

## The rule

A change touching a hot path (sync, fetch, rescans, holdings, the shape of records) adds or updates
a perf scenario in the same change and runs `npm run perf` before and after, so the comparison can
be read before merging. Scenarios mirror real app flows, never benchmark-only shapes: an
optimization that makes an app flow harder to write is refused.
