// Spec 003 story 4: remove or ban a member; leave.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { person, sharedPair, invited, eventually, contents, writeTree, syncEvents } from './helpers.js'

const has = (dir, rel) => fs.existsSync(path.join(dir, rel))

// Alice and Bob as sharedPair, plus Carol linking the same folder.
async function trio (t, files) {
  const s = await sharedPair(t, files)
  const carol = await person(t, 'carol')
  const carolEvents = syncEvents(carol)
  const cd = await invited(t, s.drive, carol)
  await carol.sync()
  await eventually(async () => (await cd.get(s.docs.id).catch(() => null)) && (await cd.list(s.docs.id, { timeout: 500 })).complete, 30000)
  const carolDocs = path.join(path.dirname(s.bobDocs), '..', path.basename(path.dirname(s.bobDocs)) + '-carol', 'docs')
  await cd.link(s.docs.id, carolDocs)
  const carolId = carol.hg.identity.publicKey
  return { ...s, carol, cd, carolDocs, carolEvents, carolId }
}

test('Carol removed: her files stay, her folder pauses, nothing new reaches her; Bob keeps her files', { timeout: 120000 }, async (t) => {
  const s = await trio(t, { 'docs/a.txt': 'a' })
  writeTree(s.carolDocs, { 'carol.txt': 'by Carol' })
  t.ok(await eventually(() => has(s.bobDocs, 'carol.txt') && has(s.carolDocs, 'a.txt'), 30000), 'Carol\'s file reached Bob')
  const before = contents(s.carolDocs)

  await s.drive.removeMember(s.carolId)
  t.ok(await s.carolEvents.wait((e) => e.action === 'paused' && e.reason === 'removed', 20000), 'Carol\'s folder paused (removed)')
  t.is((await s.carol.links())[0].paused, 'removed')
  writeTree(s.aliceDocs, { 'after.txt': 'after the removal' })
  t.ok(await eventually(() => has(s.bobDocs, 'after.txt'), 20000), 'Bob gets the new file')
  await new Promise((resolve) => setTimeout(resolve, 3000))
  t.absent(has(s.carolDocs, 'after.txt'), 'Carol never does (SC-006)')
  t.alike(contents(s.carolDocs), before, 'Carol\'s disk unchanged')
  t.ok(has(s.bobDocs, 'carol.txt'), 'Bob keeps Carol\'s file')
  t.ok((await s.drive.members()).find((m) => m.identity === s.carolId).removed, 'listed as removed')
})

test('a ban dropping all: Carol\'s entries gone for everyone, Bob\'s copies in his trash', { timeout: 120000 }, async (t) => {
  const s = await trio(t, { 'docs/a.txt': 'a' })
  writeTree(s.carolDocs, { 'spam.txt': 'spam' })
  t.ok(await eventually(() => has(s.bobDocs, 'spam.txt'), 30000))
  await s.drive.removeMember(s.carolId, { ban: true, dropAll: true })
  t.ok(await eventually(() => !has(s.bobDocs, 'spam.txt'), 20000), 'gone from Bob\'s folder')
  const trashed = [...contents(s.bobDocs)].filter(([p]) => p.includes('.swarmfs-trash') && !p.includes('.incoming'))
  t.ok(trashed.some(([, h]) => Buffer.from(h, 'hex').toString() === 'spam'), 'in Bob\'s trash, not erased')
  t.ok(has(s.carolDocs, 'spam.txt'), 'Carol\'s own copy stays')
})

test('Bob leaves: his linked folder stops, his files stay, Alice keeps everything', { timeout: 120000 }, async (t) => {
  const s = await sharedPair(t, { 'docs/a.txt': 'a' })
  t.ok(await eventually(() => has(s.bobDocs, 'a.txt'), 20000))
  await s.bob.leave(s.drive.key)
  t.alike(await s.bob.links(), [], 'no linked folder')
  t.ok(has(s.bobDocs, 'a.txt'), 'his file stays')
  t.absent(s.bob.spaces().some((x) => x.key === s.drive.key), 'the space is gone here')
  t.is((await s.drive.list(s.docs.id)).items.length, 1, 'Alice keeps everything')
})
