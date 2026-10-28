// Spec 002 story 6: a linked folder that vanishes is paused, never read as deleted; a mass
// delete waits for the person's confirmation.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { device, linkedPair, writeTree, eventually, contents, tmpDir, syncEvents } from './helpers.js'

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p).toString() : null)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const names = async (drive, folder) => (await drive.list(folder, { limit: 2000 })).items.map((i) => i.name).sort()

// An unplugged drive: the folder vanishes (Windows refuses to rename a watched folder, so the
// test takes it away and later puts the same files back, mtimes kept, as a replug does).
function unplug (dir) {
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else files.push({ full, bytes: fs.readFileSync(full), mtime: fs.statSync(full).mtime })
    }
  }
  walk(dir)
  fs.rmSync(dir, { recursive: true })
  return () => {
    for (const f of files) {
      fs.mkdirSync(path.dirname(f.full), { recursive: true })
      fs.writeFileSync(f.full, f.bytes)
      fs.utimesSync(f.full, f.mtime, f.mtime)
    }
  }
}

test('the root gone (an unplug): paused, nothing removed anywhere; back: resumed, caught up', { timeout: 120000 }, async (t) => {
  const { drive, ld, docs, pcDocs, laptopDocs, laptopEvents } = await linkedPair(t, { 'docs/a.txt': 'aaaa', 'docs/b.txt': 'bbbb' })
  t.ok(await eventually(() => read(path.join(laptopDocs, 'b.txt')), 15000))
  const before = await names(drive, docs.id)
  const replug = unplug(laptopDocs)
  const paused = await laptopEvents.wait((e) => e.action === 'paused', 15000)
  t.ok(paused && paused.reason === 'missing', 'paused (missing)')

  writeTree(pcDocs, { 'while-away.txt': 'new on the PC' })
  t.ok(await eventually(async () => (await names(ld, docs.id)).includes('while-away.txt'), 15000), 'the laptop sees the new entry')
  await sleep(3000)
  t.absent(fs.existsSync(laptopDocs), 'nothing written at its path (no folder made)')
  t.alike(await names(drive, docs.id), [...before, 'while-away.txt'].sort(), 'no entry removed on the PC')
  t.alike(await names(ld, docs.id), [...before, 'while-away.txt'].sort(), 'nor on the laptop')
  t.absent(laptopEvents.some((e) => e.action === 'trashed' || e.action === 'removed'), 'nothing trashed or removed')
  t.alike((await ld.sfs.links())[0].paused, 'missing', 'links() says why')

  replug()
  const back = Date.now()
  t.ok(await laptopEvents.wait((e) => e.action === 'resumed', 20000), 'resumed')
  t.comment(`resumed ${Date.now() - back} ms after it was back (SC-007: < 15 s)`)
  t.ok(Date.now() - back < 15000)
  t.ok(await eventually(() => read(path.join(laptopDocs, 'while-away.txt')), 15000), 'caught up')
})

test('sync() started with the root missing: starts paused', { timeout: 90000 }, async (t) => {
  let { laptop, laptopDocs } = await linkedPair(t)
  t.ok(await eventually(() => read(path.join(laptopDocs, 'a.txt')), 15000))
  const dir = laptop.dir
  await laptop.close()
  unplug(laptopDocs)
  laptop = await device(t, 'laptop', { dir, minFree: 0 })
  const events = syncEvents(laptop)
  await laptop.sync()
  t.ok(await events.wait((e) => e.action === 'paused' && e.reason === 'missing', 5000), 'paused')
  t.absent(events.some((e) => e.action === 'removed'), 'nothing removed')
})

test('a mass delete waits for confirm; restored files resume it; small deletes go through', { timeout: 240000 }, async (t) => {
  const files = { 'docs/keep.txt': 'k' }
  for (let i = 0; i < 1000; i++) files[`docs/f/${i}.txt`] = `file ${i}`
  const { pc, drive, ld, docs, pcDocs, laptopDocs, pcEvents } = await linkedPair(t, files)
  const f = (await drive.list(docs.id)).items.find((i) => i.name === 'f')
  t.ok(await eventually(() => fs.existsSync(path.join(laptopDocs, 'f')) && fs.readdirSync(path.join(laptopDocs, 'f')).length === 1000, 120000), 'the laptop has the 1,000 files')

  // 600 of 1,000 deleted at once: nothing removed until confirmed (SC-012)
  const saved = contents(path.join(pcDocs, 'f'))
  for (let i = 0; i < 600; i++) fs.rmSync(path.join(pcDocs, 'f', `${i}.txt`))
  const paused = await pcEvents.wait((e) => e.action === 'paused' && e.reason === 'mass-delete', 20000)
  t.ok(paused, 'paused for a mass delete')
  t.is(paused && paused.count, 600, 'with the count')
  await sleep(3000)
  t.is((await names(drive, f.id)).length, 1000, '0 entries removed on the PC')
  t.is((await names(ld, f.id)).length, 1000, 'nor on the laptop')
  t.is(fs.readdirSync(path.join(laptopDocs, 'f')).length, 1000, 'no file trashed on the laptop')

  // restored: resumes, nothing removed
  for (const [p, hex] of saved) if (!fs.existsSync(p)) fs.writeFileSync(p, Buffer.from(hex, 'hex'))
  t.ok(await pcEvents.wait((e) => e.action === 'resumed', 20000), 'files back: resumed')
  await sleep(3000)
  t.is((await names(drive, f.id)).length, 1000, 'nothing removed')

  // again, then confirmed: removed everywhere
  pcEvents.length = 0
  for (let i = 0; i < 600; i++) fs.rmSync(path.join(pcDocs, 'f', `${i}.txt`))
  t.ok(await pcEvents.wait((e) => e.action === 'paused' && e.reason === 'mass-delete', 20000), 'paused again')
  const confirmed = Date.now()
  await pc.confirm(pcDocs)
  t.ok(await eventually(async () => (await names(ld, f.id)).length === 400, 30000), 'confirmed: 600 removed, seen on the laptop')
  t.ok(await eventually(() => fs.readdirSync(path.join(laptopDocs, 'f')).length === 400, 30000), 'and its files trashed')
  t.comment(`confirm to removed on the other disk: ${Date.now() - confirmed} ms (SC-012: < 15 s)`)

  // 150 of 400: not more than half → applied as usual
  pcEvents.length = 0
  for (let i = 600; i < 750; i++) fs.rmSync(path.join(pcDocs, 'f', `${i}.txt`))
  t.ok(await eventually(async () => (await names(drive, f.id)).length === 250, 20000), '150 of 400 removed without asking')
  t.absent(pcEvents.some((e) => e.action === 'paused'), 'not paused')
})

test('80 of 100 files deleted (not more than 100): removed without asking', { timeout: 120000 }, async (t) => {
  const pc = await device(t, 'pc', { minFree: 0 })
  const files = {}
  for (let i = 0; i < 100; i++) files[`docs/${i}.txt`] = `f${i}`
  const disk = writeTree(tmpDir(t, 'disk'), files)
  const drive = await pc.createSpace('My files')
  const docs = await drive.add(path.join(disk, 'docs'))
  const events = syncEvents(pc)
  await pc.sync()
  for (let i = 0; i < 80; i++) fs.rmSync(path.join(disk, 'docs', `${i}.txt`))
  t.ok(await eventually(async () => (await names(drive, docs.id)).length === 20, 20000), 'removed')
  t.absent(events.some((e) => e.action === 'paused'), 'not paused')
})
