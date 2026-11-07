// A site whose publisher is offline: what is here answers at once, not after the read's timeout
// (HyperBrowser: 10-20 s per page of an installed site with its owner gone).

import test from 'brittle'
import { person, device, codeOf, aliceSite, PAGES } from './helpers.js'

test('owner offline: sfs.site and site.read answer from what is here, at once', { timeout: 120000 }, async (t) => {
  const { alice, site } = await aliceSite(t)
  const dave = await person(t, 'dave')
  const ds = await dave.visit(await site.invite({ role: 'reader' }))
  await ds.keep(true)
  await alice.close()

  const dir = dave.dir
  await dave.close()
  const again = await device(t, 'dave', { dir, minFree: 0 })
  let at = Date.now()
  const s = await again.site(ds.key, { timeout: 30000 }) // HyperBrowser's site.open
  t.ok(Date.now() - at < 1000, `sfs.site: ${Date.now() - at} ms`)
  for (const p of ['site.json', 'index.html', 'docs/about.html', 'img.jpg']) {
    at = Date.now()
    t.alike(await s.read(p, { timeout: 30000 }), Buffer.from(PAGES['site/' + p]), p)
    t.ok(Date.now() - at < 1000, `read ${p}: ${Date.now() - at} ms`)
  }
  at = Date.now()
  await s.keep(true, { timeout: 30000 }) // HyperBrowser retries its installs at launch
  t.ok(Date.now() - at < 1000, `keep(true): ${Date.now() - at} ms`)
  at = Date.now()
  t.is(await codeOf(s.read('nope.html', { timeout: 500 })), 'NOT_FOUND', 'a missing page: NOT_FOUND')
  t.ok(Date.now() - at < 5000, 'after its timeout at most')
})
