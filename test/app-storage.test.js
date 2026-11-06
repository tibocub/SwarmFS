// Spec 004 story 3: a site's files in the engine's app storage, a cache under a cap; the owner keeps uploads.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { person, tmpDir, writeTree, eventually, bytes, aliceSite } from './helpers.js'

const KB = 1024
const big = { 'site/index.html': 'hi', 'site/a.bin': bytes(100 * KB, 1), 'site/b.bin': bytes(100 * KB, 2), 'site/c.bin': bytes(100 * KB, 3) }
const stored = (sfs) => (fs.existsSync(path.join(sfs.dir, 'app-storage')) ? fs.readdirSync(path.join(sfs.dir, 'app-storage')).filter((n) => /^[0-9a-f]{64}$/.test(n)) : [])

test('reads land in app storage; again, no transfer; over the cap the least recently read go', { timeout: 120000 }, async (t) => {
  const { alice, site } = await aliceSite(t, big)
  const dave = await person(t, 'dave', { appStorageMax: 250 * KB })
  const ds = await dave.visit(await site.invite({ role: 'reader' }))
  const hash = async (name) => (await ds.pages.list()).items.find((i) => i.name === name).hash

  t.alike(await ds.read('a.bin'), big['site/a.bin'], 'a read, verified')
  t.alike(stored(dave), [await hash('a.bin')], 'in app storage, by its hash')
  await ds.read('b.bin')
  await ds.read('a.bin') // a more recent than b
  await ds.read('c.bin')
  t.alike(stored(dave).sort(), [await hash('a.bin'), await hash('c.bin')].sort(), 'over 250 KB: b, read least recently, went')
  await ds.read('b.bin')
  t.alike(stored(dave).sort(), [await hash('b.bin'), await hash('c.bin')].sort(), 'b read again; now a went')

  await alice.close()
  t.alike(await ds.read('c.bin'), big['site/c.bin'], 'held: read with no one online')
})

test('the owner keeps uploads: readable after the poster leaves; removed, the kept copy goes', { timeout: 120000 }, async (t) => {
  const { alice, site } = await aliceSite(t, { 'site/index.html': 'hi' })
  await alice.sync()
  const bob = await person(t, 'bob')
  const bs = await bob.visit(await site.invite({ role: 'editor' }))
  const photo = bytes(200 * KB, 9)
  const disk = writeTree(tmpDir(t, 'bob-disk'), { 'photo.jpg': photo })
  const start = Date.now()
  const up = await bs.upload(path.join(disk, 'photo.jpg'))
  const kept = path.join(alice.dir, 'app-storage', 'kept', up.hash)
  t.ok(await eventually(() => fs.existsSync(kept), 15000), 'Alice\'s app fetched it, kept')
  await bob.close()

  const carol = await person(t, 'carol')
  const cs = await carol.visit(await site.invite({ role: 'reader' }))
  t.alike(await cs.readUpload(up.id), photo, 'Carol reads it with Bob gone')
  t.comment(`upload readable by a third member ${Date.now() - start} ms after it was made (SC-005: < 10 s)`)
  t.ok(fs.existsSync(path.join(disk, 'photo.jpg')), 'Bob\'s own file untouched')

  await site.removeUpload(up.id)
  t.ok(await eventually(() => !fs.existsSync(kept), 15000), 'removed: the kept copy goes')
})
