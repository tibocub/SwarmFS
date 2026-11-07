// Spec 005: a dynamic site's own record types (HyperBrowser F1), and close() right after sync() (F3).

import test from 'brittle'
import { person, eventually, codeOf } from './helpers.js'

const forum = { post: { fields: { title: 'string' } }, comment: { fields: { on: 'link', text: 'text' }, links: { on: ['post', 'upload'] } } }

test('createSite(name, { types }): the site\'s types next to SwarmFS\'s; declareTypes adds more; a visitor writes them', { timeout: 120000 }, async (t) => {
  const alice = await person(t, 'alice')
  const site = await alice.createSite('Forum', { types: forum })
  const names = Object.keys(site.space.types())
  t.ok(['post', 'comment', 'file', 'upload', 'site'].every((n) => names.includes(n)), 'SwarmFS\'s types and the site\'s')
  const p = await site.space.put('post', { title: 'Welcome' })

  const bob = await person(t, 'bob')
  const bs = await bob.visit(await site.invite({ role: 'editor' }))
  t.ok(await eventually(async () => (await bs.space.query('post').latest(5)).items.some((r) => r.title === 'Welcome'), 15000), 'Bob reads the post')
  await bs.space.put('comment', { on: p.id, text: 'hi' })
  t.ok(await eventually(async () => (await site.space.linked(p.id, 'comment')).items.length === 1, 15000), 'Alice sees Bob\'s comment')

  t.is(await codeOf(bs.declareTypes({ vote: { fields: { on: 'link' } } })), 'NOT_ALLOWED', 'a visitor doesn\'t add types')
  await site.declareTypes({ vote: { fields: { on: 'link', value: 'int' }, links: { on: ['post'] }, onePerMember: true } })
  t.ok(await eventually(() => !!bs.space.types().vote, 15000), 'Bob gets the new type')
  await bs.space.put('vote', { on: p.id, value: 1 })
  t.ok(await eventually(async () => (await site.space.sum('vote', 'value', { on: p.id })).value === 1, 15000), 'Bob\'s vote counts')

  t.is(await codeOf(site.declareTypes({ post: { fields: { title: 'text' } } })), 'INCOMPATIBLE_TYPES', 'a breaking change refused')
  t.is(await codeOf(alice.createSite('Bad', { types: { file: { fields: { x: 'string' } } } })), 'INVALID_TYPE', 'a site can\'t redeclare SwarmFS\'s types')
  t.is(await codeOf(site.declareTypes({ upload: { fields: { name: 'string' } } })), 'INVALID_TYPE', 'nor later')
})

test('close() right after sync() leaves no timer (F3)', async (t) => {
  const alice = await person(t, 'alice')
  const syncing = alice.sync()
  await alice.close()
  await syncing.catch(() => {})
  t.absent(alice._timer, 'sync() set no interval after close()')
})
