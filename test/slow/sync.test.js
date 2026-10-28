// Spec 002 at real sizes: SC-001 (a 10,000-file linked folder starts syncing in < 10 s) and
// SC-004 (1,000 new files on the other device in < 60 s). npm run test:slow.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { device, linkedPair, tmpDir, writeTree, eventually, syncEvents } from '../helpers.js'

test('SC-001: a linked folder of 10,000 held, unchanged files starts syncing in < 10 s', { timeout: 900000 }, async (t) => {
  const files = {}
  for (let i = 0; i < 10000; i++) files[`docs/d${i % 100}/f${i}.txt`] = `file ${i}`
  const disk = writeTree(tmpDir(t, 'disk'), files)
  let pc = await device(t, 'pc', { minFree: 0 })
  const drive = await pc.createSpace('My files')
  let started = Date.now()
  const docs = await drive.add(path.join(disk, 'docs'))
  t.comment(`added 10,000 files in ${Date.now() - started} ms`)
  const dir = pc.dir
  await pc.close()

  started = Date.now()
  pc = await device(t, 'pc', { dir, minFree: 0 })
  const opened = Date.now() - started
  const events = syncEvents(pc)
  started = Date.now()
  await pc.sync()
  const synced = Date.now() - started
  t.comment(`open (with its rescan) ${opened} ms; sync() first pass + watching ${synced} ms`)
  t.ok(synced < 10000, 'sync() started in < 10 s')
  t.absent(events.some((e) => e.action !== 'resumed'), 'nothing changed')

  started = Date.now()
  fs.writeFileSync(path.join(disk, 'docs', 'd0', 'new.txt'), 'new')
  const d0 = (await pc.space(drive.key).list(docs.id, { limit: 200 })).items.find((i) => i.name === 'd0')
  const seen = await eventually(async () => (await pc.space(drive.key).list(d0.id, { limit: 200 })).items.some((i) => i.name === 'new.txt'), 30000)
  t.ok(seen, 'a new file in it is added')
  t.comment(`a new file recorded ${Date.now() - started} ms after it was written (2 s settle; a pass re-reads 10,000 entries: H14)`)
})

test('SC-004: 1,000 new files copied into a linked folder are on the other device in < 60 s', { timeout: 300000 }, async (t) => {
  const { pcDocs, laptopDocs, pcEvents } = await linkedPair(t, { 'docs/a.txt': 'aaaa' })
  t.ok(await eventually(() => fs.existsSync(path.join(laptopDocs, 'a.txt')), 15000))
  const batch = {}
  for (let i = 0; i < 1000; i++) batch[`batch/${i}.txt`] = 'x'.repeat(1024 - String(i).length) + i
  const started = Date.now()
  writeTree(pcDocs, batch)
  eventually(() => pcEvents.filter((e) => e.action === 'added').length >= 1001, 120000, 200)
    .then(() => t.comment(`the PC recorded them in ${Date.now() - started} ms`))
  const count = () => (fs.existsSync(path.join(laptopDocs, 'batch')) ? fs.readdirSync(path.join(laptopDocs, 'batch')).length : 0)
  const all = await eventually(() => count() === 1000, 120000, 500)
  const took = Date.now() - started
  t.comment(`1,000 files of 1 KB on the other disk in ${took} ms (${count()} there)`)
  t.ok(all, 'all there')
  t.ok(took < 60000, 'in < 60 s')
})
