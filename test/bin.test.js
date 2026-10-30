// Spec 003 story 3: deleting in a shared space goes to the bin.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { device, person, sharedPair, eventually, contents, assertNothingLost, writeTree, tmpDir } from './helpers.js'

const has = (dir, rel) => fs.existsSync(path.join(dir, rel))

test('Bob deletes Alice\'s file: in the bin for both, gone from both folders, restored by anyone', async (t) => {
  const { alice, bd, drive, aliceDocs, bobDocs } = await sharedPair(t, { 'docs/budget.xlsx': 'money', 'docs/keep.txt': 'k' })
  t.ok(await eventually(() => has(bobDocs, 'budget.xlsx') && has(bobDocs, 'keep.txt'), 20000), 'Bob has both')
  const before = new Map([...contents(aliceDocs), ...contents(bobDocs)])

  fs.unlinkSync(path.join(bobDocs, 'budget.xlsx'))
  const binned = await eventually(async () => (await drive.bin()).find((e) => e.name === 'budget.xlsx'), 20000)
  t.ok(binned, 'in the bin')
  t.is(binned && binned.by.name, 'Bob', 'deleted by Bob')
  t.ok(binned && binned.binned > 0 && binned.from, 'when, and where it was')
  t.ok(await eventually(() => !has(aliceDocs, 'budget.xlsx'), 20000), 'gone from Alice\'s folder')
  assertNothingLost(t, before, path.dirname(aliceDocs))

  const back = await bd.restore(binned.id)
  t.is(back.parent, binned.from, 'restored where it was')
  t.ok(await eventually(() => has(aliceDocs, 'budget.xlsx') && has(bobDocs, 'budget.xlsx'), 20000), 'back on both disks')
  t.is((await drive.bin()).length, 0, 'the bin is empty again')
  t.ok(alice)
})

test('a folder holding both people\'s files goes to the bin whole; only authors (or admins) empty it', async (t) => {
  const { drive, bd, docs, aliceDocs, bobDocs } = await sharedPair(t, { 'docs/trip/a.jpg': 'aaa', 'docs/x.txt': 'x' })
  t.ok(await eventually(() => has(bobDocs, 'trip/a.jpg'), 20000))
  writeTree(bobDocs, { 'trip/b.jpg': 'bob' })
  writeTree(bobDocs, { 'mine.txt': 'bob only' })
  t.ok(await eventually(() => has(aliceDocs, 'trip/b.jpg') && has(aliceDocs, 'mine.txt'), 20000), 'Bob\'s files reach Alice')

  fs.rmSync(path.join(bobDocs, 'trip'), { recursive: true })
  fs.unlinkSync(path.join(bobDocs, 'mine.txt'))
  const bin = await eventually(async () => { const b = await drive.bin(); return b.length === 2 && b }, 20000)
  t.alike(bin && bin.map((e) => e.name).sort(), ['mine.txt', 'trip'], 'the folder (with all in it) and the file')
  t.ok(await eventually(() => !has(aliceDocs, 'trip') && !has(aliceDocs, 'mine.txt'), 20000), 'gone from Alice\'s folder')

  t.alike(await bd.emptyBin(), { removed: 1, kept: 1 }, 'Bob empties only what is all his')
  t.alike((await drive.bin()).map((e) => e.name), ['trip'])
  t.alike(await drive.emptyBin(), { removed: 1, kept: 0 }, 'the owner empties the rest')
  t.is((await drive.list(docs.id)).items.length, 1, 'x.txt left')
})

test('a space never shared deletes as in spec 002 (no bin)', async (t) => {
  const sfs = await device(t, 'pc', { minFree: 0 })
  const drive = await sfs.createSpace('Mine')
  const disk = writeTree(tmpDir(t, 'disk'), { 'docs/a.txt': 'a' })
  const docs = await drive.add(path.join(disk, 'docs'))
  const [a] = (await drive.list(docs.id)).items
  await drive.remove(a.id)
  t.is((await drive.bin()).length, 0)
  t.is((await drive.list(docs.id)).items.length, 0)
})

test('a linked folder whose space folder is binned pauses, its files untouched; restored, it resumes', async (t) => {
  const { drive, bd, docs, aliceDocs, bobDocs, bobEvents } = await sharedPair(t, { 'docs/a.txt': 'aaaa' })
  t.ok(await eventually(() => has(bobDocs, 'a.txt'), 20000))
  await drive.remove(docs.id) // Alice bins the whole folder Bob linked
  t.ok(await bobEvents.wait((e) => e.action === 'paused' && e.reason === 'in-bin'), 'Bob\'s folder paused (in the bin)')
  t.ok(has(bobDocs, 'a.txt'), 'his file untouched')
  t.is((await bd.sfs.links())[0].paused, 'in-bin')
  await bd.restore(docs.id)
  t.ok(await bobEvents.wait((e) => e.action === 'resumed' && e.path === bobDocs), 'resumed')
  t.ok(has(aliceDocs, 'a.txt'))
})

test('restore into a folder emptied for good lands at the top', async (t) => {
  const alice = await person(t, 'alice')
  const bob = await person(t, 'bob')
  const drive = await alice.createSpace('Family')
  await bob.join(await drive.invite())
  await eventually(async () => (await drive.members()).length === 2)
  const disk = writeTree(tmpDir(t, 'disk'), { 'docs/sub/a.txt': 'a' })
  const docs = await drive.add(path.join(disk, 'docs'))
  const [sub] = (await drive.list(docs.id)).items
  const [a] = (await drive.list(sub.id)).items
  await drive.remove(a.id)
  await drive.space.del(sub.id) // its folder deleted for good meanwhile
  t.is((await drive.restore(a.id)).parent, drive.top, 'at the top')
})
