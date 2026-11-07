// Spec 006: an installed site (site.keep) kept whole under a tight app storage cap, followed and
// remembered; site.held() the bytes it has here (HyperBrowser F4, F5).

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { person, device, tmpDir, writeTree, eventually, bytes, aliceSite } from './helpers.js'

const KB = 1024
const PAGES = { 'site/index.html': '<h1>Hi</h1>', 'site/a.bin': bytes(100 * KB, 1), 'site/b.bin': bytes(100 * KB, 2), 'site/c.bin': bytes(100 * KB, 3) }
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^[0-9a-f]{64}$/.test(n)) : [])
const onDisk = (dir) => files(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0)

test('an installed site survives eviction, follows changes, is remembered; held() is what is on disk', { timeout: 180000 }, async (t) => {
  const { alice, site, folder } = await aliceSite(t, PAGES)
  await alice.sync()
  const cap = { appStorageMax: 150 * KB }
  const dave = await person(t, 'dave', cap)
  await dave.sync()
  const ds = await dave.visit(await site.invite({ role: 'reader' }))
  const cache = path.join(dave.dir, 'app-storage')
  const kept = path.join(cache, 'kept')
  const inline = PAGES['site/index.html'].length

  await ds.read('index.html')
  await ds.read('a.bin')
  t.is(await ds.held(), inline + onDisk(cache), 'a bookmark: held() = the cached file + the inline page')
  t.is(await ds.kept(), false)

  await ds.keep(true)
  t.is(await ds.kept(), true)
  t.is(files(kept).length, 3, 'installed: every big page in kept/')
  t.is(files(cache).length, 0, 'the cached a.bin moved there, not fetched twice')
  t.is(await ds.held(), inline + 300 * KB, 'held(): the whole site')
  t.is(await ds.held(), inline + onDisk(kept), 'and what is on disk')

  // a bookmark next to it: evicted under the cap, the installed site untouched
  const other = await alice.createSite('Other')
  await other.publish(writeTree(tmpDir(t, 'other'), { 'x.bin': bytes(100 * KB, 7), 'y.bin': bytes(100 * KB, 8) }))
  const os = await dave.visit(await other.invite({ role: 'reader' }))
  await os.read('x.bin')
  await os.read('y.bin')
  t.is(files(cache).length, 1, 'the bookmark: over 150 KB, one went')
  t.is(files(kept).length, 3, 'the installed site: whole, 300 KB over a 150 KB cap')
  t.is(await os.held(), onDisk(cache), 'the bookmark\'s held(): its one cached file')

  // remembered after a restart, and followed: a new page arrives without being read
  const dir = dave.dir
  await dave.close()
  const again = await device(t, 'dave', { dir, minFree: 0, ...cap })
  await again.sync()
  const ds2 = await again.site(ds.key)
  t.is(await ds2.kept(), true, 'remembered')
  fs.writeFileSync(path.join(folder, 'd.bin'), bytes(100 * KB, 4))
  t.ok(await eventually(() => files(kept).length === 4, 30000), 'a new page, fetched into kept/')
  fs.rmSync(path.join(folder, 'a.bin'))
  t.ok(await eventually(() => files(kept).length === 3, 30000), 'a removed page, its copy dropped')
  t.is(await ds2.held(), inline + onDisk(kept), 'held() follows')

  await ds2.keep(false)
  t.is(files(kept).length, 0, 'uninstalled: kept/ empty')
  t.ok(onDisk(cache) <= 150 * KB, 'handed back to the cache, under its cap')
  t.is(await ds2.held() + await (await again.site(os.key)).held(), inline + onDisk(cache), 'held() of both: the cache')
})

test('installed, handed back, left, visited again: installed again for real (HyperBrowser 004)', { timeout: 120000 }, async (t) => {
  const { site } = await aliceSite(t, PAGES)
  await site.makePublic()
  const dave = await person(t, 'dave')
  await dave.sync()
  const kept = path.join(dave.dir, 'app-storage', 'kept')
  const ds = await dave.visit('hg:' + site.key)
  await ds.keep(true)
  t.is(files(kept).length, 3, 'installed')
  await ds.keep(false)
  t.is(files(kept).length, 0, 'handed back to the cache')
  await dave.leave(site.key)
  t.absent(dave.spaces().some((s) => s.key === site.key), 'left')

  const again = await dave.visit('hg:' + site.key)
  t.not(again, ds, 'a new handle')
  await again.keep(true)
  t.is(await again.kept(), true)
  t.ok(await eventually(() => files(kept).length === 3, 30000), 'every big page in kept/ again (fetched once a peer is met)')
})
