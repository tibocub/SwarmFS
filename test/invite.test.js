// Spec 003 story 1: invite someone into a space.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { person, invited, sharedPair, eventually, codeOf } from './helpers.js'

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

// blocked: swarmwire S10 (resolve(root, peer)), tasks.md T009
test.todo('a member gets nothing of another space, even by hash (FR-008, SC-005)', async (t) => {
  const alice = await person(t, 'alice')
  const bob = await person(t, 'bob')
  const family = await alice.createSpace('Family')
  const own = await alice.createSpace('My files')
  await invited(t, family, bob)
  t.ok(own && bob) // filled in when S10 lands (tasks.md T009)
})
