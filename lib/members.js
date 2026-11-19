import { all, mine } from './holdings.js'

// Invitees are `editor`s; `trusted` people invite under "chosen"; `reader`s only read.
const SETTINGS = {
  everyone: { editor: ['post', 'invite'], trusted: ['post', 'invite'], reader: [] },
  chosen: { editor: ['post'], trusted: ['post', 'invite'], reader: [] },
  admins: { editor: ['post'], trusted: ['post'], reader: [] }
}
export const INVITE_SETTINGS = Object.keys(SETTINGS)

export async function setInvites (space, setting) {
  if (!SETTINGS[setting]) throw new TypeError(`invites: ${INVITE_SETTINGS.join(', ')}`)
  for (const [role, perms] of Object.entries(SETTINGS[setting])) await space.defineRole(role, perms)
}

// Read back from the roles; null for a space made before invite settings.
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

export async function namesOf (space) {
  const names = new Map()
  for (const p of (await all(space.query('profile'))).items) if (!names.has(p.author)) names.set(p.author, p.name)
  return names
}

// device -> identity: who wrote a record's current version (`author` is who first put it).
export async function writers (space) {
  const out = new Map()
  for (const m of await space.members()) for (const d of m.devices) out.set(d.device, m.identity)
  return out
}

// Waits up to `opts.timeout` only if no site record is here yet.
export async function siteOf (space, opts) {
  let { items, complete } = await space.query('site').latest(1)
  if (!items.length && !complete && opts?.timeout) ({ items, complete } = await space.query('site').latest(1, opts))
  return { site: items[0] || null, complete }
}

// Files spaces only (private): a visit to a site writes nothing.
export async function publishName (hg, space) {
  const name = (await hg.settings()).name
  if (!name) return
  await space.ready()
  if (!space.private) return
  const { items } = await space.query('profile').by(hg.identity.publicKey).latest(1)
  if (items[0]?.name !== name) await space.put('profile', { name })
}

// `has` records follow what this device holds in `space` while shown, none otherwise.
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
