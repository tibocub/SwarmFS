// A small site's first visit (HyperBrowser milestone 0, hypergraph's
// bench/site-storage/first-visit.mjs, its `space` variant): the owner adds a site folder to a
// space and makes an open invite; a cold visitor, its engine open and online, joins and fetches.
// Size = the site's pages (3-12 KB each); with style.css, app.js, site.json and one 100 KB image
// per 4 pages.
//   site.joined   the visitor let in
//   site.entry    site.json, index.html, style.css and app.js on the visitor's disk
//   site.all      every file of the site there

import fs from 'fs'
import path from 'path'
import { context, record, now, eventually, sizes } from '../harness.mjs'
import { person, tmpDir, writeTree, bytes } from '../../test/helpers.js'

const ENTRY = ['site.json', 'index.html', 'style.css', 'app.js']
const REPEATS = 3

function siteFiles (pages) {
  const files = { 'site/site.json': JSON.stringify({ title: 'Test site', entry: 'index.html', permissions: [] }) }
  for (let i = 0; i < pages; i++) files[`site/${i ? `page-${i}` : 'index'}.html`] = `<html><body>${bytes(3000 + (i * 4567) % 9000, i + 1).toString('base64')}</body></html>`
  files['site/style.css'] = bytes(8 * 1024, 99).toString('base64')
  files['site/app.js'] = bytes(30 * 1024, 98).toString('base64')
  for (let i = 0; i < Math.ceil(pages / 4); i++) files[`site/img-${i}.jpg`] = bytes(100 * 1024, 1000 + i)
  return files
}

for (const pages of sizes([20, 60])) {
  const res = { joined: [], entry: [], all: [] }
  for (let r = 0; r < REPEATS; r++) {
    const t = context()
    try {
      const files = siteFiles(pages)
      const owner = await person(t, 'owner')
      const disk = writeTree(tmpDir(t, 'site'), files)
      const drive = await owner.createSpace('Site')
      await drive.add(path.join(disk, 'site'))
      const code = await drive.invite({ uses: 1000 })
      const visitor = await person(t, 'visitor')
      const out = tmpDir(t, 'out')

      const start = now()
      const vd = await visitor.join(code)
      res.joined.push(now() - start)
      const folder = await eventually(async () => (await vd.list(vd.top)).items.find((i) => i.kind === 'folder'), 30000)
      if (!folder) throw new Error('the site folder never arrived')
      const items = await eventually(async () => { const l = await vd.list(folder.id, { limit: 1000 }); return l.complete && l.items.length === Object.keys(files).length && l.items }, 30000)
      if (!items) throw new Error('the site\'s list never completed')
      const fetchAll = (list) => Promise.all(list.map((i) => vd.fetch(i.id, path.join(out, i.name))))
      await fetchAll(items.filter((i) => ENTRY.includes(i.name)))
      res.entry.push(now() - start)
      await fetchAll(items.filter((i) => !ENTRY.includes(i.name)))
      res.all.push(now() - start)
      if (fs.readdirSync(out).length !== Object.keys(files).length) throw new Error('files missing')
    } finally {
      await t.close()
    }
  }
  for (const k of ['joined', 'entry', 'all']) record('site.' + k, pages, 'ms', res[k])
}
