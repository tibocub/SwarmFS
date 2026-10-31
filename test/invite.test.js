// Spec 003 story 1: invite someone into a space.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { person, invited, sharedPair, eventually, codeOf, tmpDir, writeTree, bytes } from './helpers.js'

test('Bob joins with a code, sees the tree and the members; his linked folder fills', async (t) => {
  const { alice, bd, drive, docs, bobDocs } = await sharedPair(t, { 'docs/a.txt': 'aaaa', 'docs/sub/b.txt': 'bb' })

  const { items } = await bd.list(docs.id)
  t.alike(items.map((i) => i.name), ['sub', 'a.txt'], 'the same tree')
  const people = await eventually(async () => {
    const m = await drive.members()
    return m.length === 2 && m.every((p) => p.name) && m
  })
  t.alike(people && people.map((p) => [p.name, p.role]), [['Alice', 'owner'], ['Bob', 'editor']], 'members with names and roles')
  t.ok(people.find((p) => p.name === 'Alice').you, 'you')

  const filled = await eventually(() => fs.existsSync(path.join(bobDocs, 'sub', 'b.txt')) && fs.existsSync(path.join(bobDocs, 'a.txt')) && fs.readFileSync(path.join(bobDocs, 'a.txt'), 'utf8') === 'aaaa', 20000)
  t.ok(filled, 'Bob\'s folder filled from Alice\'s PC')
  t.ok(alice.spaces().some((s) => s.name === 'Family'))
})

test('a code is refused once used up, expired or revoked; members stay', async (t) => {
  const alice = await person(t, 'alice')
  const bob = await person(t, 'bob')
  const carol = await person(t, 'carol')
  const dave = await person(t, 'dave')
  const drive = await alice.createSpace('Family')

  const once = await drive.invite()
  await bob.join(once)
  t.is(await codeOf(carol.join(once)), 'INVITE_USED_UP', 'one use, used')

  t.is(await codeOf(carol.join(await drive.invite({ expires: Date.now() - 1 }))), 'INVITE_EXPIRED', 'expired')

  const twice = await drive.invite({ uses: 2 })
  await carol.join(twice)
  await dave.join(twice)
  const eve = await person(t, 'eve')
  t.is(await codeOf(eve.join(twice)), 'INVITE_USED_UP', 'two uses, used')

  const revoked = await drive.invite()
  await drive.revokeInvite(revoked)
  t.is(await codeOf(eve.join(revoked)), 'INVITE_REVOKED', 'revoked')
  t.is((await drive.members()).filter((m) => m.role).length, 4, 'everyone let in stays')
})

// Bob asks Alice's PC for `e`'s bytes by hash alone, as any peer could: true if they arrive.
async function ask (t, sfs, e) {
  const out = path.join(tmpDir(t, 'ask'), 'x')
  let got = 0
  const download = sfs.transfer.download({ root: e.hash, size: e.size }, out, { announce: false })
  download.on('progress', () => { got++ })
  download.on('stalled', () => download.stop())
  const timer = setTimeout(() => download.stop(), 8000)
  await download.catch(() => {})
  clearTimeout(timer)
  return { arrived: fs.existsSync(out), progress: got }
}

test('a member gets nothing of another space, even by hash (FR-008, SC-005)', { timeout: 120000 }, async (t) => {
  const alice = await person(t, 'alice')
  const bob = await person(t, 'bob')
  const family = await alice.createSpace('Family')
  const own = await alice.createSpace('My files')
  await invited(t, family, bob)
  const disk = writeTree(tmpDir(t, 'alice-disk'), { 'private.txt': 'only mine', 'shared.txt': 'for the family' })
  const secret = await own.add(path.join(disk, 'private.txt'))
  const shared = await family.add(path.join(disk, 'shared.txt'))
  t.ok(await eventually(() => bob.transfer.peerCount > 0, 20000), 'Bob connected to Alice')

  t.ok((await ask(t, bob, shared)).arrived, 'a file of their space arrives')
  const asked = await ask(t, bob, secret)
  t.absent(asked.arrived, 'a file of another space: nothing')
  t.is(asked.progress, 0, '0 bytes')
})

test('a download in progress is served only to members of its space', { timeout: 120000 }, async (t) => {
  const alice = await person(t, 'alice')
  const bob = await person(t, 'bob')
  const carol = await person(t, 'carol')
  await invited(t, await alice.createSpace('Family'), bob)
  const work = await carol.createSpace('Work')
  const aw = await invited(t, work, alice)
  const big = path.join(writeTree(tmpDir(t, 'carol-disk'), {}), 'big.bin')
  fs.writeFileSync(big, bytes(32 << 20))
  const e = await work.add(big)
  t.ok(await eventually(() => aw.get(e.id).catch(() => null), 20000), 'Alice sees the file')
  t.ok(await eventually(() => bob.transfer.peerCount > 0, 20000), 'Bob connected to Alice (only)')

  const into = path.join(tmpDir(t, 'alice-out'), 'big.bin')
  const fetching = aw.fetch(e.id, into)
  t.ok(await eventually(() => fs.existsSync(into + '.part') && fs.statSync(into + '.part').size > 0, 20000, 5), 'Alice\'s download under way')
  const asked = await ask(t, bob, e)
  t.absent(asked.arrived, 'Bob gets nothing of it')
  t.is(asked.progress, 0, '0 bytes while Alice downloads')
  await fetching
})
