// Story 4: keep the tree up to date. Rescan follows the disk; rename, move and
// remove change entries only, never local files.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { device, pair, tmpDir, writeTree, snapshot, codeOf, eventually } from './helpers.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Names in `folder` ('kind:name'), sorted as listed.
async function names (drive, folder) {
  const { items } = await drive.list(folder, { timeout: 500 })
  return items.map((i) => `${i.kind}:${i.name}`).join(' ')
}

// A PC with folder `docs/` added, seen by the phone.
async function setup (t, files = { 'docs/a.txt': 'aaaa', 'docs/sub/b.txt': 'bb' }) {
  const { pc, phone } = await pair(t)
  const disk = writeTree(tmpDir(t, 'disk'), files)
  const drive = await pc.createSpace('My files')
  const docs = await drive.add(path.join(disk, 'docs'))
  await eventually(() => phone.spaces().find((s) => s.key === drive.key))
  const pd = phone.space(drive.key)
  const want = await names(drive, docs.id)
  t.ok(await eventually(async () => (await names(pd, docs.id)) === want), 'the phone sees docs/')
  return { pc, phone, disk, drive, pd, docs }
}

test('rescan: an edited file gets its new content everywhere, the old one is no longer held', async (t) => {
  const { pc, phone, disk, drive, pd, docs } = await setup(t)
  const a = (await drive.list(docs.id)).items.find((i) => i.name === 'a.txt')
  await sleep(20) // a different mtime even on coarse clocks
  fs.writeFileSync(path.join(disk, 'docs', 'a.txt'), 'changed!')
  await pc.rescan()

  const now = await eventually(async () => {
    const e = await pd.get(a.id)
    return e.hash !== a.hash && e
  })
  t.ok(now, 'the phone sees the new content')
  t.is(now.size, 8)
  t.is(now.holders.length, 1)
  const oldHeld = await eventually(async () => (await phone.hg.personal.query('held').where({ root: a.hash }).latest(10)).items.length === 0)
  t.ok(oldHeld, 'the old content is no longer held')
})

test('rescan: a deleted file stays listed, held by nobody; a new file appears', async (t) => {
  const { pc, disk, drive, pd, docs } = await setup(t)
  fs.rmSync(path.join(disk, 'docs', 'a.txt'))
  writeTree(disk, { 'docs/new.txt': 'new', 'docs/deep/er/x.txt': 'x' })
  await pc.rescan()

  const { items } = await drive.list(docs.id)
  t.alike(items.map((i) => i.name), ['deep', 'sub', 'a.txt', 'new.txt'])
  t.alike(items.find((i) => i.name === 'a.txt').holders, [], 'a.txt held by nobody')
  const deep = items.find((i) => i.name === 'deep')
  t.is(await names(drive, (await drive.list(deep.id)).items[0].id), 'file:x.txt', 'new nested folders too')
  t.ok(await eventually(async () => (await names(pd, docs.id)) === 'folder:deep folder:sub file:a.txt file:new.txt'), 'on the phone')

  await pc.rescan()
  t.is((await drive.list(docs.id)).items.length, 4, 'a second rescan adds nothing')
})

test('rename, move and remove from the phone: the PC sees them, its files untouched', async (t) => {
  const { pc, disk, drive, pd, docs } = await setup(t)
  const before = snapshot(disk)
  const { items } = await pd.list(docs.id)
  const sub = items.find((i) => i.name === 'sub')
  const a = items.find((i) => i.name === 'a.txt')

  t.is(await codeOf(pd.rename(a.id, 'x/y')), 'INVALID_NAME')
  t.is(await codeOf(pd.move(a.id, 'no-such-folder')), 'NOT_FOUND')
  await pd.rename(a.id, 'renamed.txt')
  await pd.move(a.id, sub.id)
  t.ok(await eventually(async () => (await names(drive, docs.id)) === 'folder:sub'), 'H3: a move leaves the old folder')
  t.ok(await eventually(async () => (await names(drive, sub.id)) === 'file:b.txt file:renamed.txt'), 'and appears in the new one')

  await pd.remove(docs.id)
  t.ok(await eventually(async () => (await names(drive)) === ''), 'removed for the PC')
  t.is(await names(pd), '', 'and the phone')
  t.is(await codeOf(drive.get(sub.id)), 'NOT_FOUND', 'the subtree too')
  t.alike(snapshot(disk), before, 'no local file renamed, moved, changed or deleted')

  await pc.rescan()
  t.is(await names(drive), '', 'a rescan does not bring removed entries back')
})

test('offline: both add, then reconnect; two renames end the same on both', async (t) => {
  t.timeout(90000)
  let { pc, phone, disk, drive, docs } = await setup(t, { 'docs/a.txt': 'aaaa' })
  const a = (await drive.list(docs.id)).items[0]
  const pcDir = pc.dir
  const phoneDir = phone.dir
  const phoneDisk = writeTree(tmpDir(t, 'phone-disk'), { 'p.txt': 'from the phone' })

  await pc.close()
  await phone.space(drive.key).add(path.join(phoneDisk, 'p.txt'), { parent: docs.id })
  await phone.space(drive.key).rename(a.id, 'by-phone.txt')
  await phone.close()

  pc = await device(t, 'pc', { dir: pcDir })
  writeTree(disk, { 'docs/q.txt': 'from the pc' })
  await pc.rescan()
  await pc.space(drive.key).rename(a.id, 'by-pc.txt')

  phone = await device(t, 'phone', { dir: phoneDir })
  const both = async (sfs) => {
    const n = await names(sfs.space(drive.key), docs.id)
    return n.includes('p.txt') && n.includes('q.txt') && n
  }
  const onPc = await eventually(() => both(pc), 20000)
  t.ok(onPc, 'the PC has both new files')
  t.ok(await eventually(async () => (await both(phone)) === (await both(pc)), 20000), `same on both: ${onPc}`)
})

test('a folder removed while the other device adds into it: the file moves to the top at its rescan', async (t) => {
  t.timeout(90000)
  let { pc, phone, disk, drive, docs } = await setup(t, { 'docs/a.txt': 'aaaa' })
  const pcDir = pc.dir
  const phoneDir = phone.dir

  await phone.close()
  writeTree(disk, { 'docs/late.txt': 'added while apart' })
  await pc.rescan()
  await pc.close()

  phone = await device(t, 'phone', { dir: phoneDir })
  const pd = phone.space(drive.key)
  await pd.remove(docs.id) // the phone hasn't seen late.txt
  pc = await device(t, 'pc', { dir: pcDir })
  const pdr = pc.space(drive.key)
  t.ok(await eventually(async () => !(await names(pdr)).includes('docs'), 20000), 'the PC sees docs removed')
  await pc.rescan()
  t.is(await names(pdr), 'file:late.txt', 'late.txt kept, at the top')
  t.ok(await eventually(async () => (await names(pd)) === 'file:late.txt', 20000), 'on the phone too')
})
