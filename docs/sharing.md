# People in a space

Invites, roles and removals are hypergraph's; SwarmFS chooses the roles of a files space, the
names, the bin and shown holdings (`lib/members.js`, `lib/drive.js`).

## Names

`sfs.setName(name)` stores the person's name as a setting (the same on all their devices) and
publishes it in each files space as a `profile` record (one per member). Sites get no `profile`:
a visit writes nothing into a site. A newcomer's name arrives a moment after they do; the
`members` event waits up to 10 s for it.

## Roles and invites

| Role | May |
|---|---|
| `owner` | everything; made the space |
| `admin` | everything but the owner's own powers (hypergraph's rules) |
| `trusted` | write; invite when the setting is `'chosen'` or `'everyone'` |
| `editor` | write (what an invite gives by default); invite when the setting is `'everyone'` |
| `reader` | read only |

The **invite setting** says who may invite: `'admins'` (default), `'chosen'` (also trusted
members), `'everyone'`. It is set at `createSpace(name, { invites })` and changed with
`drive.setInvites(setting)`; a code is judged when used, so its maker must still be allowed then.
SwarmFS stores it as the permissions of the `editor` and `trusted` roles and reads it back from them.

`drive.invite({ role, uses, expires })` makes a code: `role` `'editor'` or `'reader'`, `uses` 1 by
default, `expires` a ms timestamp (0: never). The other person redeems it with `sfs.join(code)`
(a files space) or `sfs.visit(code)` (a site). `drive.revokeInvite(code)` stops it.

## Removal, bans, leaving

`drive.removeMember(identity)` takes someone out; `{ ban: true }` keeps them out; `{ dropAll: true }`
also drops everything they added. On their devices, linked folders of that space pause (`removed`)
and resume if they are let back in. `sfs.leave(key)` leaves a space on this device: its linked
folders are unlinked, files stay.

## The bin

A space is **shared** once a second person was ever in it (removed and banned people count, so it
never flips back). In a shared space `drive.remove(id)` moves the entry, with all under it, to the
bin instead of deleting it (`parent: 'bin'`, `from`: where it was, `binned`: when). Linked folders
move the local copies to their trash; those copies stay held, so a restore finds the bytes.

- `drive.bin()`: what is there, latest first, with who removed it.
- `drive.restore(id)`: back to `from`, or to the top if that folder is gone.
- `drive.emptyBin()`: an owner or admin deletes everything; anyone else only what they added,
  with all under it. Returns `{ removed, kept }`.

## Shown holdings

By default other people see a file's entry but not which of your devices hold it.
`drive.showHoldings(true)` lists the space in the person's `show-holdings` setting; each of their
devices then writes a `has` record per hash it holds there (never a path), kept in step after each
pass, and removes them when turned off. Holders from `has` records show with the person's name.

Fetching doesn't depend on it: a device asks any connected device of another person, whose
holdings may be private.

## Known limits

- A `trusted` member can't yet invite people as `editor` under the `'chosen'` setting (hypergraph
  ranks custom roles alike); owners and admins can.
- A private space has no readers yet: `invite({ role: 'reader' })` is refused with `NOT_SUPPORTED`.
