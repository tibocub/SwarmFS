// Story 1: add files in place and see the tree. One device.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { hashFile } from 'swarmwire-lib'
import { hash } from '../lib/holdings.js'
import { device, tmpDir, writeTree, snapshot, codeOf, bytes } from './helpers.js'

const names = (items) => items.map((i) => `${i.kind}:${i.name}`)

test('a folder is listed as a tree, files with name, size and hash', async (t) => {
  const sfs = await device(t)
  const disk = writeTree(tmpDir(t, 'disk'), { 'photos/b.jpg': 'bbb', 'photos/a.jpg': 'aaaa', 'photos/trip/c.jpg': 'cc' })
  const drive = await sfs.createSpace('My files')
  t.alike(sfs.spaces(), [{ key: drive.key, name: 'My files' }])
  t.is(sfs.space(drive.key), drive)

  const photos = await drive.add(path.join(disk, 'photos'))
  t.is(photos.kind, 'folder')
  t.alike(names((await drive.list()).items), ['folder:photos'])

  const { items, complete } = await drive.list(photos.id)
  t.ok(complete)
  t.alike(names(items), ['folder:trip', 'file:a.jpg', 'file:b.jpg'], 'folders first, then by name')
  const a = items[1]
  t.is(a.size, 4)
  t.is(a.hash.length, 64)
  t.alike(a.holders, [{ device: sfs.device, name: 'dev', online: true, path: path.join(disk, 'photos', 'a.jpg') }])
  t.alike(names((await drive.list(items[0].id)).items), ['file:c.jpg'])
  t.is((await drive.get(a.id)).name, 'a.jpg')

  const page = await drive.list(photos.id, { limit: 2 })
  t.alike(names((await drive.list(photos.id, { after: page.items.at(-1) })).items), ['file:b.jpg'], 'paged')
})

test('two identical files: two entries, one content, held here at two paths', async (t) => {
  const sfs = await device(t)
  const disk = writeTree(tmpDir(t, 'disk'), { 'a.jpg': 'same', 'copy/a.jpg': 'same' })
  const drive = await sfs.createSpace('dup')
  const one = await drive.add(path.join(disk, 'a.jpg'))
  const two = await drive.add(path.join(disk, 'copy', 'a.jpg'))
  t.not(one.id, two.id)
  t.is(one.hash, two.hash)
  t.is((await drive.get(one.id)).holders[0].path, path.join(disk, 'a.jpg'))
  t.is((await drive.get(two.id)).holders[0].path, path.join(disk, 'copy', 'a.jpg'))
})

test('adding writes nothing on disk: files unchanged, nothing next to them', async (t) => {
  const sfs = await device(t)
  const disk = writeTree(tmpDir(t, 'disk'), { 'x/1.txt': 'one', 'x/sub/2.txt': 'two' })
  const before = snapshot(disk)
  const drive = await sfs.createSpace('in place')
  await drive.add(path.join(disk, 'x'))
  t.alike(snapshot(disk), before, 'same files, bytes and mtimes; nothing added')
  t.is(fs.readdirSync(disk).length, 1)
})

test('unknown space and entry are NOT_FOUND', async (t) => {
  const sfs = await device(t)
  const drive = await sfs.createSpace('x')
  t.is(await codeOf((async () => sfs.space('nope'))()), 'NOT_FOUND')
  const gone = await drive.add(writeTree(tmpDir(t, 'disk'), { 'f.txt': 'f' }) + '/f.txt')
  await drive.space.del(gone.id)
  t.is(await codeOf(drive.get(gone.id)), 'NOT_FOUND')
})

test('a file written while it is hashed: root, size and mtime all come from its final bytes', async (t) => {
  const file = path.join(tmpDir(t, 'disk'), 'growing.bin')
  fs.writeFileSync(file, bytes(8 * 1024 * 1024))
  const hashing = hash(file)
  await new Promise((resolve) => setTimeout(resolve, 5))
  fs.appendFileSync(file, 'more')
  const got = await hashing
  const st = fs.statSync(file)
  t.alike(got, { root: await hashFile(file), size: st.size, mtime: Math.floor(st.mtimeMs) })
})
