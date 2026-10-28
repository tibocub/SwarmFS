// Spec 002 story 3: changes made on the PC reach the laptop's disk; what is replaced or
// removed goes to the trash, never destroyed.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { device, linkedPair, writeTree, eventually, contents, assertNothingLost, tmpDir } from './helpers.js'

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p).toString() : null)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// counts the laptop's downloads (0 bytes transferred: none started)
function countDownloads (sfs) {
  const counter = { n: 0 }
  const download = sfs.transfer.download.bind(sfs.transfer)
  sfs.transfer.download = (...args) => { counter.n++; return download(...args) }
  return counter
}

test('renames and moves on the PC: renamed and moved on the laptop, nothing downloaded', { timeout: 120000 }, async (t) => {
  const files = { 'docs/a.txt': 'aaaa', 'docs/sub/keep.txt': 'k' }
  const album = {}
  for (let i = 0; i < 100; i++) album[`album/p${i}.jpg`] = `photo ${i}`
  for (const [k, v] of Object.entries(album)) files['docs/' + k] = v
  // the laptop has the album already (copied by hand): the PC never serves it, so on Windows the
  // PC can rename the folder (swarmwire keeps served files open: request S9)
  const { laptop, pcDocs, laptopDocs } = await linkedPair(t, files, { laptopFiles: album })
  t.ok(await eventually(() => read(path.join(laptopDocs, 'a.txt')) && read(path.join(laptopDocs, 'sub', 'keep.txt')), 30000), 'the laptop has everything')
  const held = await eventually(async () => (await laptop.hg.personal.query('held').fromDevice(laptop.device).latest(200)).items.length >= 103 || null, 30000)
  t.ok(held, 'the album copied by hand counts as held (FR-003)')
  await sleep(1000)
  const downloads = countDownloads(laptop)

  let started = Date.now()
  fs.renameSync(path.join(pcDocs, 'a.txt'), path.join(pcDocs, 'b.txt'))
  t.ok(await eventually(() => read(path.join(laptopDocs, 'b.txt')) === 'aaaa' && !read(path.join(laptopDocs, 'a.txt')), 15000), 'renamed')
  t.comment(`rename on the other disk in ${Date.now() - started} ms (SC-003: < 10 s)`)
  fs.renameSync(path.join(pcDocs, 'b.txt'), path.join(pcDocs, 'sub', 'b.txt'))
  t.ok(await eventually(() => read(path.join(laptopDocs, 'sub', 'b.txt')) === 'aaaa', 15000), 'moved')

  started = Date.now()
  fs.renameSync(path.join(pcDocs, 'album'), path.join(pcDocs, 'holiday'))
  t.ok(await eventually(() => read(path.join(laptopDocs, 'holiday', 'p0.jpg')) === 'photo 0' && !fs.existsSync(path.join(laptopDocs, 'album')), 15000), 'a folder of 100 files renamed')
  const took = Date.now() - started
  t.comment(`folder of 100 files renamed on the other disk in ${took} ms (SC-003: < 10 s)`)
  t.ok(took < 10000, 'within 10 s')
  t.is(fs.readdirSync(path.join(laptopDocs, 'holiday')).length, 100)
  t.is(downloads.n, 0, '0 bytes transferred')
})

test('an edit replaces the file, the old version to the trash; deletes go to the trash; trash listed and emptied', { timeout: 120000 }, async (t) => {
  const { laptop, pcDocs, laptopDocs, laptopEvents } = await linkedPair(t, { 'docs/a.txt': 'version 1', 'docs/old/x.txt': 'x', 'docs/old/y.txt': 'y', 'docs/z.txt': 'z' })
  t.ok(await eventually(() => read(path.join(laptopDocs, 'z.txt')) && read(path.join(laptopDocs, 'old', 'y.txt')), 15000))
  const before = contents(laptopDocs)

  fs.writeFileSync(path.join(pcDocs, 'a.txt'), 'version 2!')
  t.ok(await eventually(() => read(path.join(laptopDocs, 'a.txt')) === 'version 2!', 15000), 'the new version in place')
  fs.rmSync(path.join(pcDocs, 'z.txt'))
  fs.rmSync(path.join(pcDocs, 'old'), { recursive: true })
  t.ok(await eventually(() => !fs.existsSync(path.join(laptopDocs, 'z.txt')) && !fs.existsSync(path.join(laptopDocs, 'old')), 15000), 'a file and a folder removed')
  assertNothingLost(t, before, laptopDocs)
  t.ok(laptopEvents.some((e) => e.action === 'trashed'), 'trashed events')

  const items = await laptop.trash()
  t.alike(items.map((i) => i.path).sort(), ['a.txt', path.join('old', 'x.txt'), path.join('old', 'y.txt'), 'z.txt'], 'the trash: version 1, the folder, the file')
  t.ok(items.every((i) => i.folder === laptopDocs && i.size > 0 && i.trashed > 0))
  const v1 = items.find((i) => i.path === 'a.txt')
  t.is(v1.size, 9, 'the old version, whole')
  const held = await laptop.hg.personal.query('held').fromDevice(laptop.device).latest(100)
  t.absent(held.items.some((h) => h.path.includes('.swarmfs-trash')), 'nothing in the trash is held (served)')

  // moved back out of the trash: a new file of the folder
  const trashed = path.join(laptopDocs, '.swarmfs-trash', fs.readdirSync(path.join(laptopDocs, '.swarmfs-trash')).find((d) => d !== '.incoming' && fs.existsSync(path.join(laptopDocs, '.swarmfs-trash', d, 'z.txt'))), 'z.txt')
  fs.renameSync(trashed, path.join(laptopDocs, 'z.txt'))
  t.ok(await eventually(() => read(path.join(pcDocs, 'z.txt')) === 'z', 20000), 'restored by hand: back on the PC too')

  const emptied = await laptop.emptyTrash()
  t.is(emptied.files, 3, 'emptied: the files still in it')
  t.alike(await laptop.trash(), [])
})

test('an entry moved to a folder not linked here: the file to the trash', { timeout: 90000 }, async (t) => {
  const { drive, docs, laptopDocs } = await linkedPair(t, { 'docs/a.txt': 'aaaa' })
  t.ok(await eventually(() => read(path.join(laptopDocs, 'a.txt')), 15000))
  const a = (await drive.list(docs.id)).items[0]
  await drive.move(a.id, drive.top)
  t.ok(await eventually(() => !fs.existsSync(path.join(laptopDocs, 'a.txt')), 15000), 'gone from the laptop folder')
  const trash = path.join(laptopDocs, '.swarmfs-trash')
  t.ok(fs.readdirSync(trash).some((d) => fs.existsSync(path.join(trash, d, 'a.txt'))), 'in its trash')
})

test('the laptop reopened while the PC is off: nothing removed or trashed', { timeout: 90000 }, async (t) => {
  let { pc, laptop, laptopDocs, laptopEvents } = await linkedPair(t, { 'docs/a.txt': 'aaaa', 'docs/b.txt': 'bbbb' })
  t.ok(await eventually(() => read(path.join(laptopDocs, 'b.txt')), 15000))
  const before = contents(laptopDocs)
  const laptopDir = laptop.dir
  await pc.close()
  await laptop.close()
  laptop = await device(t, 'laptop', { dir: laptopDir, minFree: 0 })
  const events = []
  laptop.on('sync', (e) => events.push(e))
  await laptop.sync()
  await sleep(3000)
  t.alike(contents(laptopDocs), before, 'every file where it was')
  t.absent(events.some((e) => e.action === 'trashed' || e.action === 'removed'), 'nothing trashed or removed')
  t.ok(laptopEvents)
})

test('a file added on its own (outside linked folders): changes from the PC never touch it', { timeout: 90000 }, async (t) => {
  const { drive, ld, docs, laptopDocs } = await linkedPair(t, { 'docs/a.txt': 'aaaa' })
  t.ok(await eventually(() => read(path.join(laptopDocs, 'a.txt')), 15000))
  const elsewhere = path.join(writeTree(tmpDir(t, 'elsewhere'), { 'one.txt': 'mine' }), 'one.txt')
  const one = await ld.add(elsewhere)
  t.ok(await eventually(async () => (await drive.get(one.id).catch(() => null)), 15000), 'the PC sees it')
  await drive.rename(one.id, 'renamed.txt')
  await drive.move(one.id, docs.id)
  await sleep(3000)
  t.is(read(elsewhere), 'mine', 'not renamed, moved or changed on the laptop')
})
