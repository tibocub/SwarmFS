# Contract: SwarmFS 003 public API (additions to specs 001 and 002)

Specs 001/002's contracts stay. Error codes: `NOT_ALLOWED` (new, from hypergraph, with its reason),
`INVITE_EXPIRED`, `INVITE_USED_UP`, `INVITE_REVOKED`, `INVITE_INVALID` (hypergraph's, passed on).

```js
await sfs.setName('Alice')                  // the person's name, every device, every files space
await sfs.name()                            // 'Alice' | null

await sfs.createSpace(name, { invites })    // invites: 'everyone' | 'chosen' | 'admins' (default 'admins')
const drive = await sfs.join(code)          // redeem an invite → the Drive; hypergraph's invite errors

await drive.invite({ uses = 1, expires })   // → code; NOT_ALLOWED if the setting doesn't let this person
await drive.revokeInvite(code)
await drive.invites()                       // setting: 'everyone' | 'chosen' | 'admins'
await drive.setInvites(setting)             // owner (admins: hypergraph's rule)
await drive.members()                       // [{ identity, name, role, you, removed, banned, online }]
await drive.setRole(identity, role)         // 'admin' | 'trusted' | 'editor'
await drive.removeMember(identity, { ban = false, dropAll = false })
await sfs.leave(spaceKey)                   // unlink its folders here, leave; files stay

await drive.remove(id)                      // shared space: to the bin; else as 002
await drive.bin()                           // [{ id, kind, name, from, binned, by: { identity, name } }]
await drive.restore(id)                     // back to `from`, or the top if gone
await drive.emptyBin()                      // → { removed, kept }: kept = entries this person may not delete

await drive.showHoldings(on)                // this person, this space; default off
drive.list() / drive.get()                  // holders: own devices as before, plus
                                            //   { identity, name, online } of people showing holdings

await sfs.links()                           // paused adds 'removed' | 'in-bin'
sfs.on('sync', e)                           // actions add 'binned' | 'restored' (local path)
sfs.on('members', ({ space, joined, left })) // identities, with names
```

## CLI (story 7)

```text
name <name>                          set your name
create <name> [--invites everyone|chosen|admins]
invite <space> [--uses N] [--days N] → code
accept <code>                        join a space
invites <space> [everyone|chosen|admins]   show or change the setting
revoke <space> <code>
members <space>                      name, role, online, short key
role <space> <member> admin|trusted|editor
remove <space> <member> [--ban] [--drop-all]
leave <space>
bin <space>                          deleted entries: name, by, when, from
restore <space> <id>
bin empty <space>                    asks "delete N entries for good? (yes/no)"
show-holdings <space> on|off
```

`<member>`: a name (unique in the space) or a key prefix. Shell lines: `joined <space>: Bob`,
`left <space>: Carol`, `paused <folder> (removed from <space>)`, `paused <folder> (in the bin)`,
`binned <path>`, `restored <path>`.
