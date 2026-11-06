// Spec 004 story 4: a site's files up to 60 KB travel inside their record.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { person, tmpDir, writeTree, eventually, codeOf, bytes, aliceSite } from './helpers.js'
import b4a from 'b4a'
import { contentRef } from '../lib/types.js'

const KB = 1024
const records = async (space) => Object.fromEntries((await space.query('file').latest(100)).items.map((r) => [r.name, r]))

test('small pages carry their bytes: read with no holder online; big files need one', { timeout: 120000 }, async (t) => {
  const files = { 'site/index.html': bytes(4 * KB, 1), 'site/edge.js': bytes(60 * KB, 2), 'site/img.jpg': bytes(200 * KB, 3) }
  const { alice, site } = await aliceSite(t, files)
  const recs = await records(site.pages.space)
  t.is(recs['index.html'].data?.length, 4 * KB, 'a 4 KB page inside its record')
  t.is(recs['edge.js'].data?.length, 60 * KB, '60 KB still inside')
  t.absent(recs['img.jpg'].data, 'a 200 KB image not')

  const dave = await person(t, 'dave')
  const ds = await dave.visit(await site.invite({ role: 'reader' }))
  t.ok(await eventually(async () => (await ds.pages.list()).items.length === 3, 15000))
  await alice.close()
  t.alike(await ds.read('index.html'), files['site/index.html'], 'read from the record, no one online')
  t.alike(await ds.read('edge.js'), files['site/edge.js'])
  t.is(await codeOf(ds.read('img.jpg')), 'NOT_AVAILABLE', 'the image needs a holder')
  t.is(fs.existsSync(path.join(dave.dir, 'app-storage')) ? fs.readdirSync(path.join(dave.dir, 'app-storage')).length : 0, 0, 'nothing written for inline reads')
})

test('an edit follows: past 60 KB the bytes leave the record, small again they come back', { timeout: 120000 }, async (t) => {
  const { alice, site, folder } = await aliceSite(t, { 'site/index.html': 'small' })
  await alice.sync()
  const dave = await person(t, 'dave')
  const ds = await dave.visit(await site.invite({ role: 'reader' }))
  t.is((await ds.read('index.html')).toString(), 'small')
  const grown = bytes(70 * KB, 5)
  fs.writeFileSync(path.join(folder, 'index.html'), grown)
  t.ok(await eventually(async () => { const r = (await records(site.pages.space))['index.html']; return r.content.size === 70 * KB && !r.data }, 20000), 'grown: no bytes in the record')
  t.alike(await eventually(async () => { const b = await ds.read('index.html').catch(() => null); return b && b.length === 70 * KB && b }, 15000), grown, 'Dave reads it through a transfer')
  fs.writeFileSync(path.join(folder, 'index.html'), 'small again')
  t.ok(await eventually(async () => (await records(site.pages.space))['index.html'].data?.toString() === 'small again', 20000), 'small again: inside')
})

test('wrong bytes are refused; files spaces inline nothing', { timeout: 60000 }, async (t) => {
  const { alice, site } = await aliceSite(t, { 'site/index.html': 'x' })
  const real = (await records(site.pages.space))['index.html']
  const forged = { name: 'forged.html', parent: site.pages.top, content: real.content, data: b4a.from('y') }
  t.is(await codeOf(site.pages.space.put('file', forged)), 'RULE_REJECTED', 'bytes not matching the hash')
  t.is(await codeOf(site.pages.space.put('file', { ...forged, content: contentRef(real.content.src[0].slice(12), 2), data: b4a.from('xy') })), 'RULE_REJECTED', 'nor another hash')

  const mine = await alice.createSpace('Mine')
  const disk = writeTree(tmpDir(t, 'disk'), { 'note.txt': 'tiny' })
  await mine.add(path.join(disk, 'note.txt'))
  t.absent((await records(mine.space))['note.txt'].data, 'a files space keeps references only')
})
