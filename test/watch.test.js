import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { device, tmpDir, writeTree, eventually, codeOf, syncEvents } from './helpers.js'
import { stat } from '../lib/holdings.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function setup (t, files = { 'docs/a.txt': 'aaaa' }) {
  const pc = await device(t, 'pc', { minFree: 0 })
  const disk = writeTree(tmpDir(t, 'disk'), files)
  const drive = await pc.createSpace('My files')
  const docs = await drive.add(path.join(disk, 'docs'))
  const events = syncEvents(pc)
  await pc.sync()
  return { pc, drive, docs, root: path.join(disk, 'docs'), events }
}

async function entries (drive, folder) {
  return Object.fromEntries((await drive.list(folder, { limit: 1000 })).items.map((i) => [i.name, i]))
}

test('new, saved, renamed, moved and deleted files follow by themselves', { timeout: 90000 }, async (t) => {
  const { drive, docs, root, events } = await setup(t, { 'docs/a.txt': 'aaaa', 'docs/sub/b.txt': 'bb' })
  const a = (await entries(drive, docs.id))['a.txt']

  fs.writeFileSync(path.join(root, 'notes.txt'), 'notes')
  const written = Date.now()
  t.ok(await eventually(async () => (await entries(drive, docs.id))['notes.txt'], 10000), 'a new file becomes an entry')
  t.ok(Date.now() - written < 5000, `within 5 s of the last change (${Date.now() - written} ms)`)

  fs.writeFileSync(path.join(root, 'a.txt'), 'a new version')
  const saved = await eventually(async () => { const e = (await entries(drive, docs.id))['a.txt']; return e.hash !== a.hash && e }, 10000)
  t.ok(saved, 'a saved file gets its new content')
  const { record } = await drive.space.get(a.id)
  t.is(record.base, a.hash, 'and records the content it replaced')

  fs.renameSync(path.join(root, 'a.txt'), path.join(root, 'renamed.txt'))
  const renamed = await eventually(async () => (await entries(drive, docs.id))['renamed.txt'], 10000)
  t.is(renamed && renamed.id, a.id, 'a rename renames the same entry')
  const sub = (await entries(drive, docs.id)).sub
  fs.renameSync(path.join(root, 'renamed.txt'), path.join(root, 'sub', 'renamed.txt'))
  const moved = await eventually(async () => (await entries(drive, sub.id))['renamed.txt'], 10000)
  t.is(moved && moved.id, a.id, 'a move moves the same entry')
  t.absent(events.some((e) => e.action === 'added' && e.path.endsWith('renamed.txt')), 'nothing added for them')

  fs.rmSync(path.join(root, 'notes.txt'))
  t.ok(await eventually(async () => !(await entries(drive, docs.id))['notes.txt'], 10000), 'a deleted file is removed from the space')
})

test('a file written for 10 s is recorded once, after it stops', { timeout: 60000 }, async (t) => {
  const { drive, docs, root, events } = await setup(t)
  const file = path.join(root, 'slow.bin')
  const end = Date.now() + 10000
  while (Date.now() < end) {
    fs.appendFileSync(file, 'x'.repeat(1000))
    await sleep(300)
  }
  t.ok(await eventually(async () => (await entries(drive, docs.id))['slow.bin'], 10000), 'recorded')
  await sleep(3000)
  t.is(events.filter((e) => e.path === file).length, 1, 'one change recorded (SC-005)')
  t.is((await entries(drive, docs.id))['slow.bin'].size, fs.statSync(file).size, 'its final size')
})

test('a delete and a different file of the same size and mtime in one batch: two entries, not a rename', { timeout: 60000 }, async (t) => {
  const { drive, docs, root } = await setup(t, { 'docs/a.jpg': 'AAAA' })
  const a = (await entries(drive, docs.id))['a.jpg']
  const { mtime } = fs.statSync(path.join(root, 'a.jpg'))
  fs.rmSync(path.join(root, 'a.jpg'))
  fs.writeFileSync(path.join(root, 'b.jpg'), 'BBBB')
  fs.utimesSync(path.join(root, 'b.jpg'), mtime, mtime) // a copy tool keeping mtime
  const b = await eventually(async () => { const all = await entries(drive, docs.id); return !all['a.jpg'] && all['b.jpg'] }, 10000)
  t.ok(b, 'a.jpg removed, b.jpg added')
  t.not(b.id, a.id, 'a new entry')
  t.not(b.hash, a.hash, 'with its own content')
})

// Rename detection trusts a file id only when exact: NTFS ids exceed 2^53, and as a Number
// 15 of 200 fresh files once shared one with another file.
test('file ids: never shared by two files (null when not exact)', async (t) => {
  const dir = tmpDir(t, 'ids')
  const ids = []
  for (let i = 0; i < 200; i++) {
    fs.writeFileSync(path.join(dir, `f${i}`), 'x')
    ids.push((await stat(path.join(dir, `f${i}`))).ino)
  }
  const exact = ids.filter((id) => id !== null)
  t.is(new Set(exact).size, exact.length, `${exact.length} exact ids, all different`)
})

test('the ignore list and .swarmfsignore: never entries; .swarmfsignore itself synced', { timeout: 60000 }, async (t) => {
  const { drive, docs, root } = await setup(t, { 'docs/.swarmfsignore': 'build/\n*.log\n', 'docs/a.txt': 'a' })
  writeTree(root, {
    '~$report.docx': 'lock', 'report.tmp': 't', 'a.swp': 's', 'Thumbs.db': 'th', 'desktop.ini': 'd', '.DS_Store': 'ds',
    'x.part': 'p', 'build/out.js': 'o', 'run.log': 'l', 'deep/er/run.log': 'l', 'deep/er/ok.txt': 'ok'
  })
  const deep = await eventually(async () => (await entries(drive, docs.id)).deep, 10000)
  t.ok(deep, 'other files still added')
  await sleep(3000)
  t.alike(Object.keys(await entries(drive, docs.id)).sort(), ['.swarmfsignore', 'a.txt', 'deep'], 'nothing ignored became an entry (SC-010)')
  const er = (await entries(drive, deep.id)).er
  t.alike(Object.keys(await entries(drive, er.id)), ['ok.txt'])

  fs.appendFileSync(path.join(root, '.swarmfsignore'), '*.bak\n')
  await sleep(3000)
  writeTree(root, { 'new.bak': 'b', 'new.txt': 'n' })
  t.ok(await eventually(async () => (await entries(drive, docs.id))['new.txt'], 10000), 'a new file')
  t.absent((await entries(drive, docs.id))['new.bak'], 'a rule added later applies to new files')
})

test('a folder renamed: its entry renamed, its files untouched', { timeout: 60000 }, async (t) => {
  const { drive, docs, root, events } = await setup(t, { 'docs/old/a.txt': 'a', 'docs/old/b.txt': 'b' })
  const old = (await entries(drive, docs.id)).old
  const ids = async () => Object.values(await entries(drive, old.id)).map((e) => [e.name, e.id, e.hash])
  const files = await ids()
  fs.renameSync(path.join(root, 'old'), path.join(root, 'new'))
  const now = await eventually(async () => (await entries(drive, docs.id)).new, 10000)
  t.is(now && now.id, old.id, 'the same folder entry')
  t.alike(await ids(), files, 'the same file entries')
  t.ok((await entries(drive, old.id))['a.txt'].holders[0].path.includes(path.join('new', 'a.txt')), 'held at the new path')
  t.absent(events.some((e) => e.action === 'added' || e.action === 'removed' || e.action === 'updated'), 'nothing added, removed or rehashed')
})

test('changes made while closed are picked up at sync(); a rename is not an add', { timeout: 60000 }, async (t) => {
  let { pc, drive, docs, root } = await setup(t, { 'docs/a.txt': 'aaaa', 'docs/b.txt': 'bb' })
  const before = await entries(drive, docs.id)
  const dir = pc.dir
  await pc.close()
  fs.renameSync(path.join(root, 'a.txt'), path.join(root, 'c.txt'))
  fs.rmSync(path.join(root, 'b.txt'))
  fs.writeFileSync(path.join(root, 'd.txt'), 'new')
  pc = await device(t, 'pc', { dir, minFree: 0 })
  await pc.sync()
  const now = await entries(pc.space(drive.key), docs.id)
  t.alike(Object.keys(now).sort(), ['c.txt', 'd.txt'])
  t.is(now['c.txt'].id, before['a.txt'].id, 'renamed, same entry')
})

test('a single added file: edits followed; deleted, its entry stays; add inside a linked folder refused', { timeout: 60000 }, async (t) => {
  const { pc, drive, root } = await setup(t)
  const other = writeTree(tmpDir(t, 'single'), { 'one.txt': 'one' })
  const one = await drive.add(path.join(other, 'one.txt'))
  await pc.rescan() // a file added while syncing is watched from the next rescan
  fs.writeFileSync(path.join(other, 'one.txt'), 'one, edited')
  t.ok(await eventually(async () => (await drive.get(one.id)).size === 11, 10000), 'its entry gets the new content')
  fs.rmSync(path.join(other, 'one.txt'))
  await pc.rescan()
  t.ok(await drive.get(one.id), 'deleted: the entry stays (v1)')

  t.is(await codeOf(drive.add(path.join(root, 'a.txt'))), 'EXISTS', 'a file in a linked folder')
  t.is(await codeOf(drive.add(path.dirname(root))), 'EXISTS', 'a folder holding one')
})

test('one watcher per folder (Bare on Linux, where a tree watch is the top folder only): changes in sub-folders, new ones included', { timeout: 90000 }, async (t) => {
  const { watch } = await import('../lib/watch.js')
  const root = writeTree(tmpDir(t, 'w'), { 'sub/a.txt': 'a', 'sub/deep/b.txt': 'b', 'old/c.txt': 'c' })
  const seen = new Set()
  const w = watch(root, { perFolder: true, onBatch: (rels) => { for (const r of rels) seen.add(r.replace(/\\/g, '/')) }, onError: (err) => t.fail(String(err)) })
  t.teardown(() => w.close())
  const p = (...s) => path.join(root, ...s)
  const saw = (...rels) => eventually(() => rels.every((r) => seen.has(r)), 10000)

  fs.writeFileSync(p('sub', 'deep', 'new.txt'), 'n')
  t.ok(await saw('sub/deep/new.txt'), 'a new file two folders down')
  fs.writeFileSync(p('sub', 'a.txt'), 'saved')
  t.ok(await saw('sub/a.txt'), 'a save')
  fs.renameSync(p('sub', 'deep', 'b.txt'), p('sub', 'deep', 'b2.txt'))
  t.ok(await saw('sub/deep/b.txt', 'sub/deep/b2.txt'), 'a rename: both names')
  fs.mkdirSync(p('made', 'later'), { recursive: true })
  t.ok(await saw('made'), 'a folder made after the watch started')
  fs.writeFileSync(p('made', 'later', 'x.txt'), 'x')
  t.ok(await saw('made/later/x.txt'), 'is watched, and the folder made in it')
  fs.renameSync(p('old'), p('sub', 'moved'))
  t.ok(await saw('old', 'sub/moved'), 'a folder moved: both places')
  fs.unlinkSync(p('sub', 'moved', 'c.txt'))
  t.ok(await saw('sub/moved/c.txt'), 'is watched under its new place')
  fs.rmSync(p('made'), { recursive: true })
  seen.delete('made')
  t.ok(await saw('made'), 'a folder deleted')
})
