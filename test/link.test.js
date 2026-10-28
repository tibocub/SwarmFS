// Spec 002 story 4: link a space folder to a local path on another device; unlink.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { device, linkedPair, writeTree, eventually, codeOf, tmpDir } from './helpers.js'
import { contentRef } from '../lib/types.js'

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p).toString() : null)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const names = async (drive, folder) => (await drive.list(folder, { limit: 1000 })).items.map((i) => i.name).sort()

test('linking into a folder that has files: same content held, different content a conflict copy, others added', { timeout: 120000 }, async (t) => {
  const { laptop, drive, docs, pcDocs, laptopDocs, laptopEvents } = await linkedPair(t,
    { 'docs/a.jpg': 'the PC version', 'docs/b.jpg': 'same on both' },
    { laptopFiles: { 'a.jpg': 'the laptop version', 'b.jpg': 'same on both', 'extra.txt': 'only here' } })
  const copy = path.join(laptopDocs, "a (laptop's copy).jpg")
  t.ok(await eventually(() => read(path.join(laptopDocs, 'a.jpg')) === 'the PC version' && read(copy) === 'the laptop version', 20000), 'the space a.jpg in place, the local one kept as a copy')
  t.ok(await eventually(async () => (await names(drive, docs.id)).join() === "a (laptop's copy).jpg,a.jpg,b.jpg,extra.txt", 20000), 'the copy and the extra file are entries, seen on the PC')
  t.ok(await eventually(() => read(path.join(pcDocs, "a (laptop's copy).jpg")) === 'the laptop version', 20000), 'and fetched there')
  const b = (await drive.list(docs.id)).items.find((i) => i.name === 'b.jpg')
  t.ok(await eventually(async () => (await drive.get(b.id)).holders.length === 2, 10000), 'b.jpg held by both')
  t.absent(laptopEvents.some((e) => e.action === 'fetched' && e.path.endsWith('b.jpg')), 'b.jpg not downloaded')
  t.ok(laptopEvents.some((e) => e.action === 'conflict'), 'a conflict event')

  // links() survives a reopen
  const dir = laptop.dir
  await laptop.close()
  const again = await device(t, 'laptop', { dir, minFree: 0 })
  t.alike((await again.links()).map((l) => [l.path, l.folder]), [[laptopDocs, docs.id]], 'links() after a reopen')
})

test('unlink: no more fetching or following; nothing removed; overlaps refused', { timeout: 120000 }, async (t) => {
  const { laptop, drive, ld, docs, pcDocs, laptopDocs } = await linkedPair(t, { 'docs/a.txt': 'aaaa' })
  t.ok(await eventually(() => read(path.join(laptopDocs, 'a.txt')), 15000))

  t.is(await codeOf(ld.link(docs.id, tmpDir(t, 'again'))), 'EXISTS', 'already linked here')
  t.is(await codeOf(ld.link(ld.top, path.join(laptopDocs, 'inside'))), 'EXISTS', 'inside a linked folder')
  t.is(await codeOf(ld.link(ld.top, path.dirname(laptopDocs))), 'EXISTS', 'holding one')
  t.is(await codeOf(laptop.unlink(tmpDir(t, 'never'))), 'NOT_FOUND')

  await laptop.unlink(laptopDocs)
  t.alike(await laptop.links(), [])
  t.absent(fs.existsSync(path.join(laptopDocs, '.swarmfs-trash', '.incoming')), '.incoming removed')
  writeTree(pcDocs, { 'after.txt': 'after unlink' })
  fs.writeFileSync(path.join(laptopDocs, 'local.txt'), 'not followed')
  await sleep(5000)
  t.absent(read(path.join(laptopDocs, 'after.txt')), 'not fetched')
  t.absent((await names(drive, docs.id)).includes('local.txt'), 'not added')
  t.is(read(path.join(laptopDocs, 'a.txt')), 'aaaa', 'files stay')
  t.ok((await names(drive, docs.id)).includes('a.txt'), 'entries stay')
})

test('the top of a space linked; two entries of one name; names differing only by case', { timeout: 120000 }, async (t) => {
  const { pc, laptop, drive, docs, pcDocs } = await linkedPair(t, { 'docs/a.txt': 'aaaa', 'docs/b.txt': 'bbbb' })
  await laptop.unlink((await laptop.links())[0]?.path || '.').catch(() => {})
  const top = tmpDir(t, 'top')
  await laptop.space(drive.key).link(laptop.space(drive.key).top, top)
  t.ok(await eventually(() => read(path.join(top, 'docs', 'b.txt')) === 'bbbb', 20000), 'the whole space under the path')

  const b = (await drive.list(docs.id)).items.find((i) => i.name === 'b.txt')
  await drive.space.put('file', { name: 'a.txt', parent: docs.id, content: contentRef(b.hash, b.size) })
  await drive.space.put('file', { name: 'A.txt', parent: docs.id, content: contentRef(b.hash, b.size) })
  t.ok(await eventually(() => read(path.join(top, 'docs', "a (pc's copy).txt")) === 'bbbb', 20000), 'a second a.txt: placed under a copy name')
  t.is(read(path.join(top, 'docs', 'a.txt')), 'aaaa', 'the first keeps its name')
  if (await caseInsensitive(top)) {
    t.ok(await eventually(() => read(path.join(top, 'docs', "A (pc's copy 2).txt")) === 'bbbb', 20000), 'A.txt on a case-insensitive disk: a copy name too')
  }
  t.ok(pc && pcDocs)
})

async function caseInsensitive (dir) {
  return fs.existsSync(dir.toUpperCase()) && fs.existsSync(dir.toLowerCase())
}
