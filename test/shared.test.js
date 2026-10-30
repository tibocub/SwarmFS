// Spec 003 story 2: everyone edits, nothing is lost; conflict copies named after the person.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { device, sharedPair, eventually, contents, writeTree, bytes } from './helpers.js'

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p).toString() : null)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const files = (dir) => [...contents(dir)].filter(([p]) => !p.includes('.swarmfs-trash'))
  .map(([p, hex]) => [path.relative(dir, p), Buffer.from(hex, 'hex').toString()]).sort()

test('Bob adds, edits, renames and moves Alice\'s files; her disk follows; 1 MB across people', { timeout: 120000 }, async (t) => {
  const { aliceDocs, bobDocs } = await sharedPair(t, { 'docs/a.txt': 'a1', 'docs/b.txt': 'b', 'docs/sub/c.txt': 'c' })
  t.ok(await eventually(() => read(path.join(bobDocs, 'sub', 'c.txt')) && read(path.join(bobDocs, 'b.txt')), 20000))

  fs.writeFileSync(path.join(bobDocs, 'a.txt'), 'a2 by Bob')
  fs.renameSync(path.join(bobDocs, 'b.txt'), path.join(bobDocs, 'b2.txt'))
  fs.renameSync(path.join(bobDocs, 'sub', 'c.txt'), path.join(bobDocs, 'c.txt'))
  const at = Date.now()
  fs.writeFileSync(path.join(bobDocs, 'big.bin'), bytes(1 << 20))
  t.ok(await eventually(() => read(path.join(aliceDocs, 'a.txt')) === 'a2 by Bob' && read(path.join(aliceDocs, 'b2.txt')) === 'b' &&
    read(path.join(aliceDocs, 'c.txt')) === 'c' && fs.existsSync(path.join(aliceDocs, 'big.bin')), 20000), 'Alice\'s disk follows Bob\'s changes')
  t.comment(`1 MB from Bob on Alice's disk after ${Date.now() - at} ms (SC-002: < 10 s)`)
  const old = [...contents(aliceDocs)].filter(([p]) => p.includes('.swarmfs-trash') && !p.includes('.incoming')).map(([, h]) => Buffer.from(h, 'hex').toString())
  t.ok(old.includes('a1'), 'her replaced version in her trash')
})

test('Alice and Bob edit one file while apart: both versions, the copy named after the person', { timeout: 120000 }, async (t) => {
  const setup = await sharedPair(t, { 'docs/report.docx': 'original' })
  t.ok(await eventually(() => read(path.join(setup.bobDocs, 'report.docx')), 20000))
  const aliceDir = setup.alice.dir
  const bobDir = setup.bob.dir
  await setup.alice.close()
  await setup.bob.close()
  await sleep(50)
  fs.writeFileSync(path.join(setup.aliceDocs, 'report.docx'), 'edited by Alice')
  fs.writeFileSync(path.join(setup.bobDocs, 'report.docx'), 'edited by Bob')
  const alice = await device(t, 'alice', { dir: aliceDir, minFree: 0 })
  const bob = await device(t, 'bob', { dir: bobDir, minFree: 0 })
  const met = Date.now()
  await alice.sync()
  await bob.sync()
  const same = await eventually(() => {
    const a = files(setup.aliceDocs)
    const b = files(setup.bobDocs)
    return a.length === 2 && JSON.stringify(a) === JSON.stringify(b) && a
  }, 30000)
  t.ok(same, 'the same two files on both')
  t.comment(`settled ${Date.now() - met} ms after reopening (SC-003: < 20 s)`)
  if (same) {
    t.alike(same.map(([, v]) => v).sort(), ['edited by Alice', 'edited by Bob'], 'both versions kept')
    t.ok(same.some(([n]) => /^report \((Alice|Bob)'s copy\)\.docx$/.test(n)), `named after the person who lost: ${same.map(([n]) => n)}`)
  }
})

test('two entries of one name from two people: the second placed under its author\'s name', { timeout: 120000 }, async (t) => {
  const setup = await sharedPair(t, { 'docs/x.txt': 'x' })
  t.ok(await eventually(() => read(path.join(setup.bobDocs, 'x.txt')), 20000))
  await setup.alice.close()
  await setup.bob.close()
  writeTree(setup.aliceDocs, { 'plan.txt': 'Alice\'s plan' })
  writeTree(setup.bobDocs, { 'plan.txt': 'Bob\'s plan' })
  const alice = await device(t, 'alice', { dir: setup.alice.dir, minFree: 0 })
  const bob = await device(t, 'bob', { dir: setup.bob.dir, minFree: 0 })
  await alice.sync()
  await bob.sync()
  const same = await eventually(() => {
    const a = files(setup.aliceDocs)
    return a.length === 3 && JSON.stringify(a) === JSON.stringify(files(setup.bobDocs)) && a
  }, 30000)
  t.ok(same, 'both plans on both disks, the same names')
  if (same) t.ok(same.some(([n]) => /^plan \((Alice|Bob)'s copy\)\.txt$/.test(n)), `${same.map(([n]) => n)}`)
})
