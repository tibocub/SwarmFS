# SwarmFS docs

Start with the [README](../README.md) for the big picture. These pages say how things really work.

| Page | What it covers |
|---|---|
| [api.md](api.md) | Every call, option, event and error code of the library, on one page |
| [files.md](files.md) | Spaces and entries, adding in place, `held` records, fetching, rescans, who serves whom |
| [sync.md](sync.md) | Linked folders: the local and remote passes, moves, conflict copies, the trash, pauses, the mass-delete guard, ignore rules, the free-space floor, `sync` events |
| [sharing.md](sharing.md) | People in a space: names, roles, invites and who may send them, the bin, removal and bans, shown holdings |
| [sites.md](sites.md) | Sites: pages and uploads, readers and public sites, app storage, small files inline, installed sites, a site's own types, app instances, private sites, packs |
| [data-model.md](data-model.md) | Every record type, field and rule, and what SwarmFS writes on disk |
| [cli.md](cli.md) | The `swarmfs` shell and one-shot commands |
| [performance.md](performance.md) | `npm run perf`, how runs are compared, and the rule for hot-path changes |

The JSDoc in `lib/swarmfs.js`, `lib/drive.js` and `lib/site.js` is the authority on each call;
these pages give the why and how the pieces fit.

Records kept as they were written (not docs): `specs/NNN-*/` (each feature's spec, plan, research
and tasks) and `specs/requests-to-hypergraph.md`, `specs/requests-to-swarmwire.md` (what SwarmFS
asked of its dependencies, and why).
