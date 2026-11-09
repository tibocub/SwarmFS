// Packs (spec 009, HyperBrowser 015): an app ships public sites as their own signed data. A pack opens with
// nobody online, every page; an edit published later arrives from a peer; a changed pack is refused; no
// secret leaves the owner's folder.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { SwarmFS } from '../index.js'
import { person, device, tmpDir, codeOf, eventually, aliceSite, PAGES } from './helpers.js'

async function packed (t) {
  const { alice, site, folder } = await aliceSite(t)
  await site.makePublic()
  const out = tmpDir(t, 'pack')
  await alice.exportSites([site.key], out)
  return { alice, site, folder, out }
}

test('a pack opens with nobody online, every page; an edit made later arrives from a peer', { timeout: 120000 }, async (t) => {
  const { alice, site, folder, out } = await packed(t)
  t.is(fs.readdirSync(path.join(out, 'files')).length, 1, 'the one page too big for a record: img.jpg')
  const dir = alice.dir
  await alice.close()

  const dave = await person(t, 'dave')
  t.alike(await dave.importSites(out), [site.key], 'the same site: same key')
  const ds = await dave.site(site.key, { timeout: 1000 })
  for (const p of ['site.json', 'index.html', 'docs/about.html', 'img.jpg']) {
    t.alike(await ds.read(p, { timeout: 1000 }), Buffer.from(PAGES['site/' + p]), p + ', offline')
  }
  await ds.keep(true, { timeout: 1000 })
  t.ok(await ds.held() >= 100 * 1024, 'installed from the pack: held whole')

  const alice2 = await device(t, 'alice', { dir, minFree: 0 })
  await alice2.sync()
  fs.writeFileSync(path.join(folder, 'index.html'), '<h1>Version 2</h1>')
  t.ok(await eventually(async () => String(await ds.read('index.html').catch(() => '')) === '<h1>Version 2</h1>', 30000), 'the edit arrives')
  t.ok(alice2)
})

test('a changed pack is refused, nothing kept', { timeout: 120000 }, async (t) => {
  const { alice, out } = await packed(t)
  await alice.close()
  const [name] = fs.readdirSync(path.join(out, 'files'))
  const file = path.join(out, 'files', name)
  const bytes = fs.readFileSync(file)
  bytes[10] ^= 1
  fs.writeFileSync(file, bytes)
  const dave = await person(t, 'dave')
  t.is(await codeOf(dave.importSites(out)), 'IMPORT_INVALID', 'a changed file')
  t.is(dave.spaces().length, 0, 'nothing kept')
  fs.rmSync(path.join(out, 'files'), { recursive: true })
  const list = path.join(out, 'spaces', 'spaces.json')
  const meta = JSON.parse(fs.readFileSync(list, 'utf-8'))
  meta.spaces[1].cores[0].length += 1 // the pages' log claims a block the pack doesn't hold
  fs.writeFileSync(list, JSON.stringify(meta))
  t.is(await codeOf(dave.importSites(out, { timeout: 2000 })), 'IMPORT_INVALID', 'blocks missing')
  t.is(dave.spaces().length, 0, 'nothing kept')
})

test('packed from a closed folder: only what a visitor downloads, no secret', { timeout: 120000 }, async (t) => {
  const { alice, site } = await aliceSite(t)
  const closed = await alice.createSite('Members only')
  await site.makePublic()
  const words = Buffer.from([].concat(await alice.hg.recoveryPhrase()).join(' '))
  const deviceKey = alice.hg._identity.device.secretKey.subarray(0, 32) // white-box
  const dir = alice.dir
  await alice.close()
  const owner = await SwarmFS.open(dir, { offline: true }) // as a build does: no scan, never online
  t.teardown(() => owner.close())
  t.is(await codeOf(owner.exportSites([closed.key], tmpDir(t, 'x'))), 'NOT_ALLOWED', "a site that isn't public")
  const out = tmpDir(t, 'pack')
  await owner.exportSites([site.key], out)
  const { spaces } = JSON.parse(fs.readFileSync(path.join(out, 'spaces', 'spaces.json'), 'utf-8'))
  t.alike(spaces.map((s) => s.key), [site.key, site.pages.key], 'the site and its pages, nothing else')
  for (const f of fs.readdirSync(out, { recursive: true })) {
    const file = path.join(out, f)
    if (!fs.statSync(file).isFile()) continue
    const bytes = fs.readFileSync(file)
    t.ok(bytes.indexOf(words) === -1 && bytes.indexOf(deviceKey) === -1, 'no secret in ' + f)
  }
})
