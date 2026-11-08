// HyperBrowser F7 (spec 009): a site that runs another site's code, an app's instance. Its `site` record
// names the app; only who may decide writes that record.

import test from 'brittle'
import { person, eventually, codeOf, aliceSite } from './helpers.js'

const forum = { post: { fields: { title: 'string' } } }

test('createSite(name, { app }): the instance names its app; members can\'t change it', { timeout: 120000 }, async (t) => {
  const { alice, site: app } = await aliceSite(t)
  t.is(app.app, null, 'a site made without app runs its own code')

  const inst = await alice.createSite('Woodworkers', { app: app.key, types: forum })
  t.is(inst.app, app.key, 'the instance names its app')
  t.is(await codeOf(inst.read('index.html', { timeout: 500 })), 'NOT_FOUND', 'it has no pages of its own')
  t.ok(inst.space.types().post, 'the app\'s types')
  t.is(await inst.space.getRole(alice.hg.identity.publicKey), 'owner', 'its creator owns it')

  const bob = await person(t, 'bob')
  const bi = await bob.visit(await inst.invite({ role: 'editor' }))
  t.is(bi.app, app.key, 'a member reads the mark')
  t.is(await codeOf(bi.space.put('site', { pages: bi.pages.key, app: 'someone-else' })), 'NOT_ALLOWED', 'a member can\'t forge it')
  t.ok(await eventually(async () => (await bi.space.query('post').latest(1)).complete, 15000))

  t.is(await codeOf(alice.createSite('Bad', { app: 42 })), 'INVALID_PARAMS', 'app is a key')
})
