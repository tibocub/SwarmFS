// Probe (spec 004 research): what hypergraph gives a site today. Readers in a private and a closed
// space, a sub-space with writeRoles, a public space's joiners, a 60 KB bytes field.
// Run: npx brittle-node specs/repro-h22-site-roles.mjs (prints what it found; research.md R1-R4)

import test from 'brittle'
import testing from 'hypergraph/testing'

const { open, eventually, codeOf } = testing
const types = {
  file: { fields: { name: 'string', data: 'bytes' }, editable: 'members' },
  upload: { fields: { name: 'string' } },
  site: { fields: { title: 'string' }, put: { permission: 'decide' } }
}
const count = async (s, type = 'file') => (await s.query(type).latest(100)).items.length

for (const priv of [true, false]) {
  test(`a reader (no permissions) in a ${priv ? 'private' : 'closed'} space`, { timeout: 60000 }, async (t) => {
    const alice = await open(t, { types })
    const dave = await open(t, { types })
    const space = await alice.createSpace({ name: 'S', private: priv })
    await space.defineRole('reader', [])
    await space.put('file', { name: 'a', data: Buffer.alloc(10) })
    const ds = await dave.redeemInvite(await space.createInvite({ role: 'reader' }))
    await space.put('file', { name: 'b', data: Buffer.alloc(10) })
    const read = await eventually(async () => (await count(ds)) === 2, 15000)
    t.comment(`reads both: ${!!read}; status ${JSON.stringify(ds.status().access)}`)
    t.comment(`alice sees dave connected: ${space.memberConnections().some((m) => m.identity === dave.identity.publicKey)}`)
    t.comment(`dave put: ${await codeOf(ds.put('file', { name: 'x' }))}`)
    t.pass()
  })
}

test('a sub-space with writeRoles [admin]; a type put by deciders only; 60 KB bytes', { timeout: 60000 }, async (t) => {
  const alice = await open(t, { types })
  const bob = await open(t, { types })
  const space = await alice.createSpace({ name: 'Site' })
  await space.defineRole('editor', ['post'])
  const pages = await space.createSubspace({ name: 'pages', writeRoles: ['admin'] })
  const page = await pages.put('file', { name: 'index.html', data: Buffer.alloc(60 * 1024) })
  t.comment(`61,440-byte bytes field put: ok; 63 KB: ${await codeOf(space.put('file', { name: 'big', data: Buffer.alloc(63 * 1024 + 900) }))}`)
  await space.put('site', { title: 'x' })
  const bs = await bob.redeemInvite(await space.createInvite({ role: 'editor' }))
  const bp = await eventually(() => { try { return bob.space(pages.key) } catch { return null } }, 15000)
  t.ok(bp, 'bob has the sub-space')
  t.ok(await eventually(async () => (await count(bp)) === 1, 15000), 'bob reads the page')
  t.comment(`bob put in pages: ${await codeOf(bp.put('file', { name: 'mine' }))}`)
  t.comment(`bob edits alice's page: ${await codeOf(bp.edit(page.id, { name: 'renamed' }))}`)
  t.comment(`bob puts a site record: ${await codeOf(bs.put('site', { title: 'y' }))}`)
  const up = await bs.put('upload', { name: 'photo' })
  const as = space
  await eventually(async () => (await count(as, 'upload')) === 1, 15000)
  t.comment(`alice edits bob's upload: ${await codeOf(as.edit(up.id, { name: 'x' }))}`)
  t.comment(`alice deletes bob's upload: ${await codeOf(as.del(up.id))}`)
  t.pass()
})

test('a public space: a joiner by the public link', { timeout: 60000 }, async (t) => {
  const alice = await open(t, { types })
  const eve = await open(t, { types })
  const space = await alice.createSpace({ name: 'Site' })
  const pages = await space.createSubspace({ name: 'pages', writeRoles: ['admin'] })
  await pages.put('file', { name: 'index.html' })
  await space.put('file', { name: 'top.html' })
  await space.makePublic()
  const es = await eve.redeemInvite(space.publicLink())
  const ep = await eventually(() => { try { return eve.space(pages.key) } catch { return null } }, 15000)
  t.comment(`eve reads the top: ${!!(await eventually(async () => (await count(es)) === 1, 15000))}`)
  t.comment(`eve has the sub-space: ${!!ep}; listed: ${JSON.stringify(es.subspaces())}; spaces ${JSON.stringify(eve.spaces())}`)
  t.comment(`eve reads the pages: ${!!(ep && await eventually(async () => (await count(ep)) === 1, 15000))}; ${ep && JSON.stringify(ep.status())}`)
  t.comment(`eve's role: ${await es.getRole(eve.identity.publicKey)}; alice sees her: ${!!(await eventually(() => space.memberConnections().some((m) => m.identity === eve.identity.publicKey), 5000))}`)
  t.comment(`eve uploads: ${await codeOf(es.put('upload', { name: 'spam' }))}`)
  t.comment(`members on alice: ${(await space.members()).length}`)
  t.pass()
})

test('a public space whose pages sub-space is public too', { timeout: 60000 }, async (t) => {
  const alice = await open(t, { types })
  const eve = await open(t, { types })
  const space = await alice.createSpace({ name: 'Site' })
  const pages = await space.createSubspace({ name: 'pages', writeRoles: ['admin'] })
  await pages.put('file', { name: 'index.html' })
  await space.makePublic()
  t.comment(`pages.makePublic: ${await codeOf(pages.makePublic())}`)
  await eve.redeemInvite(space.publicLink())
  const ep = await eventually(() => { try { return eve.space(pages.key) } catch { return null } }, 10000)
  t.comment(`eve has the sub-space by the top's link: ${!!ep}`)
  const ep2 = ep || await eve.redeemInvite(pages.publicLink()).catch((e) => e.code)
  t.comment(`by its own link: ${typeof ep2 === 'string' ? ep2 : 'ok'}`)
  if (typeof ep2 !== 'string') {
    t.comment(`reads: ${!!(await eventually(async () => (await count(ep2)) === 1, 10000))}; puts: ${await codeOf(ep2.put('file', { name: 'x' }))}`)
  }
  t.pass()
})
