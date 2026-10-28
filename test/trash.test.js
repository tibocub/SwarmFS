// The trash of a linked folder and the free-space floor (research R9, R10).

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { toTrash, listTrash, emptyTrash, freeSpace, floor } from '../lib/trash.js'
import { tmpDir, writeTree } from './helpers.js'

test('moving to the trash keeps the path, both versions, and the bytes until emptied', async (t) => {
  const linked = writeTree(tmpDir(t, 'linked'), { 'a.txt': 'one', 'sub/b.txt': 'bb', 'sub/c/d.txt': 'ddd' })
  const before = Date.now() - 1000
  await toTrash(linked, path.join(linked, 'a.txt'))
  writeTree(linked, { 'a.txt': 'two!' })
  await toTrash(linked, path.join(linked, 'a.txt'))
  await toTrash(linked, path.join(linked, 'sub', 'c'))
  t.absent(fs.existsSync(path.join(linked, 'a.txt')), 'moved, not copied')
  writeTree(linked, { '.swarmfs-trash/.incoming/abc.part': 'partial' })

  const items = await listTrash(linked)
  t.alike(items.map((i) => [i.path, i.size]).sort(), [['a.txt', 3], ['a.txt', 4], [path.join('sub', 'c', 'd.txt'), 3]], 'both versions and the folder, not .incoming')
  t.ok(items.every((i) => i.trashed >= before && i.trashed <= Date.now() + 1000), 'when')

  t.alike(await emptyTrash(linked), { files: 3, bytes: 10 })
  t.alike(await listTrash(linked), [])
  t.ok(fs.existsSync(path.join(linked, '.swarmfs-trash', '.incoming', 'abc.part')), '.incoming kept')
  t.ok(fs.existsSync(path.join(linked, 'sub', 'b.txt')), 'nothing else touched')
})

test('free space and the floor', async (t) => {
  const dir = tmpDir(t)
  const { free, total } = await freeSpace(dir)
  t.ok(free > 0 && total >= free, `free ${free} of ${total}`)
  t.is(await floor(dir), Math.max(5e9, Math.floor(0.05 * total)), 'max(5 GB, 5 %)')
  t.is(await floor(dir, 123), 123, 'minFree')
  t.is(await floor(dir, 0), 0)
})
