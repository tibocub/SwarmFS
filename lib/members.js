// People in a files space (spec 003): names, the invite setting, "shared", shown holdings.
// Invites, roles and removals themselves are hypergraph's.

import { all, mine } from './holdings.js'

// Invitees are `editor`s; `trusted` people invite under "chosen" (research R5); `reader`s only
// read (spec 004).
const SETTINGS = {
  everyone: { editor: ['post', 'invite'], trusted: ['post', 'invite'], reader: [] },
  chosen: { editor: ['post'], trusted: ['post', 'invite'], reader: [] },
  admins: { editor: ['post'], trusted: ['post'], reader: [] }
}
export const INVITE_SETTINGS = Object.keys(SETTINGS)

// Defines (or redefines) the space's two roles for `setting`.
export async function setInvites (space, setting) {
  if (!SETTINGS[setting]) throw new TypeError(`invites: ${INVITE_SETTINGS.join(', ')}`)
  for (const [role, perms] of Object.entries(SETTINGS[setting])) await space.defineRole(role, perms)
}

// 'everyone' | 'chosen' | 'admins', read back from the roles; null: a space made before 003.
export async function invitesOf (space) {
  const roles = new Map((await space.roles()).map((r) => [r.name, r.permissions]))
  if (!roles.has('editor')) return null
  if (roles.get('editor').includes('invite')) return 'everyone'
  return roles.get('trusted')?.includes('invite') ? 'chosen' : 'admins'
}

// Shared: a second identity was ever in it (removed and banned ones count: it never flips back).
const shared = new WeakMap()
export async function isShared (space) {
  if (shared.get(space)) return true
  const yes = (await space.members()).length > 1
  if (yes) shared.set(space, true)
  return yes
}

// identity -> name, from each person's latest `profile`.
export async function namesOf (space) {
  const names = new Map()
  for (const p of (await all(space.query('profile'))).items) if (!names.has(p.author)) names.set(p.author, p.name)
  return names
}

// device -> identity: who wrote a record's current version (its `author` is who put it).
export async function writers (space) {
  const out = new Map()
  for (const m of await space.members()) for (const d of m.devices) out.set(d.device, m.identity)
  return out
}

// The space's `site` record (spec 004), or null; `complete` false while that isn't known yet.
// Its site record from what is here; waits up to `opts.timeout` only if none is (findHere).
export async function siteOf (space, opts) {
  let { items, complete } = await space.query('site').latest(1)
  if (!items.length && !complete && opts?.timeout) ({ items, complete } = await space.query('site').latest(1, opts))
  return { site: items[0] || null, complete }
}

// This person's name into `space`, if set and not there yet. Files spaces only (they are
// private, sites aren't): a visit writes nothing (spec 004 FR-009).
export async function publishName (hg, space) {
  const name = (await hg.settings()).name
  if (!name) return
  await space.ready()
  if (!space.private) return
  const { items } = await space.query('profile').by(hg.identity.publicKey).latest(1)
  if (items[0]?.name !== name) await space.put('profile', { name })
}

// This device's `has` records in `space` made to match what it holds there (shown: on) or
// removed (off). Called after passes, on the setting's change and on the person's command.
export async function syncHas (hg, space) {
  const on = ((await hg.settings())['show-holdings'] || []).includes(space.key)
  const roots = new Set()
  if (on) for (const h of (await all(mine(hg, 'held'))).items) if (h.space === space.key && h.root) roots.add(h.root)
  const mineHas = (await all(space.query('has').fromDevice(hg.device.publicKey))).items
  const have = new Set()
  for (const r of mineHas) {
    if (roots.has(r.root) && !have.has(r.root)) have.add(r.root)
    else await space.del(r.id)
  }
  for (const root of roots) if (!have.has(root)) await space.put('has', { root })
}
