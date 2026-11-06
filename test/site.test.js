// Spec 004 stories 1 and 2: protected pages, uploads by their author only, readers, public sites.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { person, tmpDir, writeTree, eventually, codeOf, snapshot, bytes, aliceSite, PAGES } from './helpers.js'

const pageId = async (site, name) => (await site.pages.list(site.pages.top, { timeout: 5000 })).items.find((i) => i.name === name)?.id

test('pages: only the owner and admins write them; an upload is its author\'s', { timeout: 120000 }, async (t) => {
  const { alice, site, folder } = await aliceSite(t)
  await alice.sync()
  const before = snapshot(folder)
  const bob = await person(t, 'bob')
  const bs = await bob.visit(await site.invite({ role: 'editor' }))
  t.is((await bs.read('index.html')).toString(), '<h1>Hello</h1>', 'Bob reads a page')
  t.is((await bs.read('docs/about.html')).toString(), '<p>About</p>', 'and one in a folder')
  t.is(await codeOf(bs.read('nope.html')), 'NOT_FOUND')

  const index = await pageId(bs, 'index.html')
  const docs = await pageId(bs, 'docs')
  const mine = writeTree(tmpDir(t, 'bob-disk'), { 'evil.html': 'x', 'photo.jpg': bytes(80 * 1024, 7) })
  t.is(await codeOf(bs.pages.add(path.join(mine, 'evil.html'))), 'NOT_ALLOWED', 'adding a page refused')
  t.is(await codeOf(bs.pages.rename(index, 'old.html')), 'NOT_ALLOWED', 'renaming refused')
  t.is(await codeOf(bs.pages.move(index, docs)), 'NOT_ALLOWED', 'moving refused')
  t.is(await codeOf(bs.pages.remove(index)), 'NOT_ALLOWED', 'removing refused')

  const up = await bs.upload(path.join(mine, 'photo.jpg'))
  t.is(up.size, 80 * 1024)
  const seen = await eventually(async () => (await site.uploads()).find((u) => u.id === up.id), 15000)
  t.ok(seen && seen.author === bob.hg.identity.publicKey && seen.name === 'photo.jpg', 'Alice lists Bob\'s upload, by Bob')
  t.is(await codeOf(site.renameUpload(up.id, 'mine.jpg')), 'NOT_ALLOWED', 'Alice can\'t rename it')
  await bs.renameUpload(up.id, 'cat.jpg')
  t.ok(await eventually(async () => (await site.uploads()).find((u) => u.id === up.id)?.name === 'cat.jpg', 15000), 'Bob renames his own')
  t.alike(snapshot(folder), before, 'Alice\'s site folder untouched')

  // an admin writes pages; Alice's linked folder follows
  await site.setRole(bob.hg.identity.publicKey, 'admin')
  t.ok(await eventually(async () => (await codeOf(bs.pages.rename(index, 'home.html'))) === null, 15000), 'as an admin Bob renames a page')
  t.ok(await eventually(() => fs.existsSync(path.join(folder, 'home.html')) && !fs.existsSync(path.join(folder, 'index.html')), 20000), 'Alice\'s folder follows')
  await site.removeUpload(up.id)
  t.ok(await eventually(async () => !(await bs.uploads()).length, 15000), 'the owner removes an upload')
})

test('readers read and never write; a visit writes nothing; no reader invite in a private space', { timeout: 120000 }, async (t) => {
  const { alice, site } = await aliceSite(t)
  const dave = await person(t, 'dave')
  const ds = await dave.visit(await site.invite({ role: 'reader' }))
  t.is((await ds.read('index.html')).toString(), '<h1>Hello</h1>', 'Dave reads')
  t.is((await ds.read('img.jpg')).length, 100 * 1024, 'and a big file')
  const file = path.join(writeTree(tmpDir(t, 'dave-disk'), { 'a.jpg': 'a' }), 'a.jpg')
  t.is(await codeOf(ds.upload(file)), 'NOT_ALLOWED', 'his upload refused')
  t.is(await codeOf(ds.pages.add(file)), 'NOT_ALLOWED', 'and a page')
  for (const type of ['profile', 'has', 'upload', 'file', 'folder']) {
    t.is((await site.space.query(type).latest(10)).items.length, 0, `no ${type} record in the site's space`)
  }
  t.is((await site.pages.space.query('profile').latest(10)).items.length, 0, 'none in its pages')

  const family = await alice.createSpace('Family')
  t.is(await codeOf(family.invite({ role: 'reader' })), 'NOT_SUPPORTED', 'private space: no readers yet (H6)')
})

test('a public site: strangers read it by its link, the owner offline, from another visitor', { timeout: 120000 }, async (t) => {
  const { alice, site } = await aliceSite(t)
  t.is(await codeOf(Promise.resolve().then(() => site.publicLink())), 'NOT_ALLOWED', 'no public link before')
  await site.makePublic()
  t.ok(site.isPublic)
  const link = site.publicLink()
  const dave = await person(t, 'dave')
  const ds = await dave.visit(link)
  t.is((await ds.read('img.jpg')).length, 100 * 1024, 'Dave reads it by the link')
  await alice.close()

  const eve = await person(t, 'eve')
  const es = await eve.visit(link)
  t.is((await es.read('index.html')).toString(), '<h1>Hello</h1>', 'Eve reads a page with Alice offline')
  t.alike(await es.read('img.jpg'), PAGES['site/img.jpg'], 'and the image, from Dave')
  t.is(await codeOf(es.pages.rename(await pageId(es, 'index.html'), 'x.html')), 'NOT_ALLOWED', 'her page change refused')
  t.is((await ds.space.query('profile').latest(10)).items.length, 0, 'no visitor wrote a name')
})
