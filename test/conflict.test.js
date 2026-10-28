// Spec 002 story 5: two devices change one file without seeing each other's change: both
// versions kept, as a conflict copy named after the device whose version lost.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { device, linkedPair, eventually, contents } from './helpers.js'

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p).toString() : null)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const outsideTrash = (dir) => [...contents(dir)].filter(([p]) => !p.includes('.swarmfs-trash'))
const files = (dir) => outsideTrash(dir).map(([p, hex]) => [path.relative(dir, p), Buffer.from(hex, 'hex').toString()]).sort()

// Both devices closed; `onPC` and `onLaptop` change their disks; both reopened and syncing.
async function apart (t, setup, onPC, onLaptop) {
  let { pc, laptop, pcDocs, laptopDocs } = setup
  const pcDir = pc.dir
  const laptopDir = laptop.dir
  await pc.close()
  await laptop.close()
  await sleep(50)
  onPC(pcDocs)
  onLaptop(laptopDocs)
  pc = await device(t, 'pc', { dir: pcDir, minFree: 0 })
  laptop = await device(t, 'laptop', { dir: laptopDir, minFree: 0 })
  await pc.sync()
  await laptop.sync()
  return { pc, laptop }
}

test('one file edited on both while apart: both versions on both devices, same names', { timeout: 120000 }, async (t) => {
  const setup = await linkedPair(t, { 'docs/report.docx': 'original' })
  t.ok(await eventually(() => read(path.join(setup.laptopDocs, 'report.docx')), 15000))
  const met = Date.now()
  await apart(t, setup,
    (dir) => fs.writeFileSync(path.join(dir, 'report.docx'), 'edited on the PC'),
    (dir) => fs.writeFileSync(path.join(dir, 'report.docx'), 'edited on the laptop'))
  const same = await eventually(() => {
    const a = files(setup.pcDocs)
    const b = files(setup.laptopDocs)
    return a.length === 2 && JSON.stringify(a) === JSON.stringify(b) && a
  }, 20000)
  t.ok(same, 'the same two files on both')
  t.comment(`settled ${Date.now() - met} ms after reopening (SC-009: < 20 s)`)
  if (same) {
    t.alike(same.map(([, v]) => v).sort(), ['edited on the PC', 'edited on the laptop'], 'both versions kept')
    t.ok(same.some(([n]) => /^report \((pc|laptop)'s copy\)\.docx$/.test(n)), `named after the device that lost: ${same.map(([n]) => n)}`)
  }
  const trashed = [...contents(setup.pcDocs), ...contents(setup.laptopDocs)].filter(([p]) => p.includes('.swarmfs-trash') && !p.includes('.incoming'))
  t.alike(trashed.map(([, h]) => Buffer.from(h, 'hex').toString()).filter((v) => v.startsWith('edited')), [], 'no edit in any trash')
})

test('two edits on the PC while the laptop is off: no conflict, the laptop fast-forwards', { timeout: 120000 }, async (t) => {
  let { pc, laptop, pcDocs, laptopDocs } = await linkedPair(t, { 'docs/notes.txt': 'v1' })
  t.ok(await eventually(() => read(path.join(laptopDocs, 'notes.txt')) === 'v1', 15000))
  const laptopDir = laptop.dir
  await laptop.close()
  fs.writeFileSync(path.join(pcDocs, 'notes.txt'), 'v2')
  await sleep(3500)
  fs.writeFileSync(path.join(pcDocs, 'notes.txt'), 'v3!')
  await sleep(3500)
  laptop = await device(t, 'laptop', { dir: laptopDir, minFree: 0 })
  await laptop.sync()
  t.ok(await eventually(() => read(path.join(laptopDocs, 'notes.txt')) === 'v3!', 20000), 'the newest version in place')
  await sleep(2000)
  t.alike(files(laptopDocs).map(([n]) => n), ['notes.txt'], 'no conflict copy (the base history, research R4)')
  t.ok(pc)
})

test('a taken copy name gets a number', { timeout: 120000 }, async (t) => {
  const setup = await linkedPair(t, { 'docs/r.txt': 'original', "docs/r (pc's copy).txt": 'old copy', "docs/r (laptop's copy).txt": 'old copy' })
  t.ok(await eventually(() => read(path.join(setup.laptopDocs, "r (laptop's copy).txt")), 15000))
  await apart(t, setup,
    (dir) => fs.writeFileSync(path.join(dir, 'r.txt'), 'pc edit'),
    (dir) => fs.writeFileSync(path.join(dir, 'r.txt'), 'laptop edit'))
  const copy = await eventually(() => files(setup.laptopDocs).find(([n]) => / copy 2\)\.txt$/.test(n)), 20000)
  t.ok(copy, `copy 2: ${copy && copy[0]}`)
})

test('renamed on one, edited on the other: no content lost', { timeout: 120000 }, async (t) => {
  const setup = await linkedPair(t, { 'docs/a.txt': 'original' })
  t.ok(await eventually(() => read(path.join(setup.laptopDocs, 'a.txt')), 15000))
  await apart(t, setup,
    (dir) => fs.renameSync(path.join(dir, 'a.txt'), path.join(dir, 'b.txt')),
    (dir) => fs.writeFileSync(path.join(dir, 'a.txt'), 'edited on the laptop'))
  const both = await eventually(() => {
    const a = files(setup.pcDocs)
    const b = files(setup.laptopDocs)
    return JSON.stringify(a) === JSON.stringify(b) && a.some(([, v]) => v === 'edited on the laptop') && a
  }, 20000)
  t.ok(both, `the edit kept, the same on both: ${JSON.stringify(both)}`)
})

test('renamed differently on each while apart: both end at the winning name', { timeout: 120000 }, async (t) => {
  const setup = await linkedPair(t, { 'docs/a.txt': 'same' })
  t.ok(await eventually(() => read(path.join(setup.laptopDocs, 'a.txt')), 15000))
  await apart(t, setup,
    (dir) => fs.renameSync(path.join(dir, 'a.txt'), path.join(dir, 'by-pc.txt')),
    (dir) => fs.renameSync(path.join(dir, 'a.txt'), path.join(dir, 'by-laptop.txt')))
  const same = await eventually(() => {
    const a = files(setup.pcDocs)
    return a.length === 1 && JSON.stringify(a) === JSON.stringify(files(setup.laptopDocs)) && a
  }, 20000)
  t.ok(same, `one name on both: ${JSON.stringify(same)}`)
})

test('deleted on the PC while the laptop is still saving it: kept, added again', { timeout: 120000 }, async (t) => {
  const { drive, docs, pcDocs, laptopDocs } = await linkedPair(t, { 'docs/a.txt': 'aaaa' })
  t.ok(await eventually(() => read(path.join(laptopDocs, 'a.txt')), 15000))
  // the PC's delete reaches the laptop ~2.5 s later (its 2 s settle); the laptop saves 1.5 s in,
  // so the delete arrives while the laptop's edit is still settling (not recorded)
  fs.rmSync(path.join(pcDocs, 'a.txt'))
  await sleep(1500)
  fs.writeFileSync(path.join(laptopDocs, 'a.txt'), 'being edited')
  const back = await eventually(async () => (await drive.list(docs.id)).items.find((i) => i.name === 'a.txt' && i.size === 12), 20000)
  t.ok(back, 'a.txt is an entry again, with the edit')
  t.is(read(path.join(laptopDocs, 'a.txt')), 'being edited', 'the edit stays in place')
})
