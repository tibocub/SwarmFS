// Spec 002 story 2: missing files arrive by themselves in a linked folder.

import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { device, linkedPair, writeTree, eventually, bytes, syncEvents } from './helpers.js'
import { contentRef } from '../lib/types.js'

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null)

test('a file added on the PC is on the laptop disk, verified, held by both', { timeout: 90000 }, async (t) => {
  const { drive, docs, ld, pcDocs, laptopDocs } = await linkedPair(t)
  t.ok(await eventually(() => read(path.join(laptopDocs, 'a.txt'))?.toString() === 'aaaa', 15000), 'the existing file arrives at link')

  const mb = bytes(1024 * 1024, 7)
  writeTree(pcDocs, { 'trip/c.jpg': mb })
  const started = Date.now()
  const there = path.join(laptopDocs, 'trip', 'c.jpg')
  t.ok(await eventually(() => read(there)?.equals(mb), 20000), 'byte-identical')
  t.comment(`1 MB on the other disk ${Date.now() - started} ms after it was written (SC-002: < 10 s with the 2 s settle)`)
  t.ok(Date.now() - started < 10000, 'within 10 s')
  const trip = (await ld.list(docs.id)).items.find((i) => i.name === 'trip')
  const c = (await ld.list(trip.id)).items[0]
  t.ok(await eventually(async () => (await drive.get(c.id)).holders.length === 2, 10000), 'held by both')
})

test('holder offline: fetched once it is back; held elsewhere here: copied, no holder needed', { timeout: 120000 }, async (t) => {
  let { pc, laptop, pcDocs, laptopDocs, drive, docs } = await linkedPair(t)
  t.ok(await eventually(() => read(path.join(laptopDocs, 'a.txt')), 15000))
  const pcDir = pc.dir
  const laptopDir = laptop.dir
  // the laptop learns the new entries without fetching (a floor above any disk), then the PC goes
  await laptop.close()
  laptop = await device(t, 'laptop', { dir: laptopDir, minFree: 1e18 })
  await laptop.sync()
  writeTree(pcDocs, { 'late.txt': 'written while the laptop was off', 'copy-of-a.txt': 'aaaa' })
  const ld = laptop.space(drive.key)
  t.ok(await eventually(async () => (await ld.list(docs.id)).items.length === 3, 15000), 'the laptop sees the entries')
  await pc.close()
  await laptop.close()

  laptop = await device(t, 'laptop', { dir: laptopDir, minFree: 0 })
  let downloads = 0
  const download = laptop.transfer.download.bind(laptop.transfer)
  laptop.transfer.download = (...args) => { downloads++; return download(...args) }
  await laptop.sync()
  t.ok(await eventually(() => read(path.join(laptopDocs, 'copy-of-a.txt'))?.toString() === 'aaaa', 15000), 'same content held here: copied, with the PC off')
  t.is(downloads, 0, '0 bytes transferred')
  t.absent(read(path.join(laptopDocs, 'late.txt')), 'no holder online: not there')

  pc = await device(t, 'pc', { dir: pcDir, minFree: 0 })
  await pc.sync()
  t.ok(await eventually(() => read(path.join(laptopDocs, 'late.txt')), 30000), 'fetched once the PC is back, no command')
})

test('below the free-space floor nothing is fetched, and it says so; resumes with room', { timeout: 120000 }, async (t) => {
  let { pc, laptop, pcDocs, laptopDocs } = await linkedPair(t)
  t.ok(await eventually(() => read(path.join(laptopDocs, 'a.txt')), 15000))
  const laptopDir = laptop.dir
  await laptop.close()
  writeTree(pcDocs, { 'big.bin': bytes(100000, 3) })
  await pc.rescan()

  laptop = await device(t, 'laptop', { dir: laptopDir, minFree: 1e18 })
  const events = syncEvents(laptop)
  await laptop.sync()
  const low = await events.wait((e) => e.action === 'low-space', 15000)
  t.ok(low && low.free > 0 && low.floor === 1e18, 'low-space, with free space and the floor')
  t.absent(read(path.join(laptopDocs, 'big.bin')), 'not fetched')
  t.absent(fs.existsSync(path.join(laptopDocs, 'big.bin.part')), 'nothing half-written at its place')
  await laptop.close()

  laptop = await device(t, 'laptop', { dir: laptopDir, minFree: 0 })
  const started = Date.now()
  await laptop.sync()
  t.ok(await eventually(() => read(path.join(laptopDocs, 'big.bin')), 15000), 'with room: fetched')
  t.comment(`resumed in ${Date.now() - started} ms (SC-008: < 15 s)`)
  t.ok(pc)
})

test('the PC closed mid-fetch: nothing at the target; completes when it is back', { timeout: 120000 }, async (t) => {
  let { pc, laptop, pcDocs, laptopDocs } = await linkedPair(t)
  t.ok(await eventually(() => read(path.join(laptopDocs, 'a.txt')), 15000))
  const big = bytes(40 * 1024 * 1024, 9)
  const pcDir = pc.dir
  writeTree(pcDocs, { 'big.bin': big })
  const incoming = path.join(laptopDocs, '.swarmfs-trash', '.incoming')
  t.ok(await eventually(() => fs.existsSync(incoming) && fs.readdirSync(incoming).length > 0, 30000, 5), 'a download started')
  await pc.close()
  t.absent(fs.existsSync(path.join(laptopDocs, 'big.bin')), 'nothing under its name')
  pc = await device(t, 'pc', { dir: pcDir, minFree: 0 })
  await pc.sync()
  t.ok(await eventually(() => read(path.join(laptopDocs, 'big.bin'))?.equals(big), 60000), 'completed, byte-identical')
  t.ok(laptop)
})

test('a name not valid on this disk: skipped, said, the entry kept', { timeout: 90000 }, async (t) => {
  const { drive, docs, laptopEvents, laptopDocs, ld } = await linkedPair(t)
  t.ok(await eventually(() => read(path.join(laptopDocs, 'a.txt')), 15000))
  if (os.platform() !== 'win32') return t.comment('Windows only')
  const a = (await drive.list(docs.id)).items[0]
  const bad = await drive.space.put('file', { name: 'a:b.txt', parent: docs.id, content: contentRef(a.hash, a.size) })
  const e = await laptopEvents.wait((e) => e.action === 'skipped', 15000)
  t.ok(e && e.reason === 'name' && e.path.endsWith('a:b.txt'), 'skipped (name)')
  t.ok(await ld.get(bad.id), 'the entry stays')
})
