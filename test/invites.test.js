// Spec 003 story 5: the creator chooses who may invite.

import test from 'brittle'
import { person, eventually, codeOf } from './helpers.js'

async function space (t, invites) {
  const alice = await person(t, 'alice')
  const bob = await person(t, 'bob')
  const drive = await alice.createSpace('Club', { invites })
  const bd = await bob.join(await drive.invite())
  await eventually(async () => (await bd.members()).length === 2)
  return { alice, bob, drive, bd }
}

test('everyone: a member invites, and who comes in with it may invite too', async (t) => {
  const { bd } = await space(t, 'everyone')
  t.is(await bd.invites(), 'everyone')
  const carol = await person(t, 'carol')
  const cd = await carol.join(await bd.invite())
  t.ok(await cd.invite(), 'Carol invites too')
})

test('owner and admins: a member is refused, saying why; an admin may', async (t) => {
  const { alice, drive, bd } = await space(t, 'admins')
  t.is(await bd.invites(), 'admins')
  t.is(await codeOf(bd.invite()), 'NOT_ALLOWED', 'a member')
  await drive.setRole(bd.sfs.hg.identity.publicKey, 'trusted')
  await eventually(async () => (await bd.members()).find((m) => m.you).role === 'trusted')
  t.is(await codeOf(bd.invite()), 'NOT_ALLOWED', 'a trusted member too')
  await drive.setRole(bd.sfs.hg.identity.publicKey, 'admin')
  t.ok(await eventually(() => bd.invite().catch(() => null), 10000), 'an admin may')
  t.ok(alice)
})

test('switching from everyone: members refused, and so are codes they made before (judged when used)', async (t) => {
  const { drive, bd } = await space(t, 'everyone')
  const before = await bd.invite()
  await drive.setInvites('admins')
  t.ok(await eventually(async () => (await bd.invites()) === 'admins'), 'Bob sees the new setting')
  t.is(await codeOf(bd.invite()), 'NOT_ALLOWED', 'refused now')
  const carol = await person(t, 'carol')
  t.is(await codeOf(carol.join(before)), 'NOT_ALLOWED', 'an earlier code of a member no longer lets in')
  t.ok(await carol.join(await drive.invite()), 'one of the owner still does')
})

test('nobody invites as owner; admins only by the owner', async (t) => {
  const { drive, bd } = await space(t, 'everyone')
  t.is(await codeOf(drive.space.createInvite({ role: 'owner' })), 'NOT_ALLOWED', 'never owner')
  t.is(await codeOf(bd.space.createInvite({ role: 'admin' })), 'NOT_ALLOWED', 'an editor can\'t make admins')
  t.ok(await drive.space.createInvite({ role: 'admin' }), 'the owner can')
})

// blocked: hypergraph H20 (a trusted role may not invite as editor), tasks.md T023 scenario 2
test.todo('chosen people: a trusted member\'s invites let people in as editors', async (t) => {
  const { drive, bd } = await space(t, 'chosen')
  await drive.setRole(bd.sfs.hg.identity.publicKey, 'trusted')
  t.ok(await bd.invite())
})
