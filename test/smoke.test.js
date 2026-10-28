import test from 'brittle'
import { SwarmFS } from '../index.js'
import { device } from './helpers.js'

test('an instance opens and closes', async (t) => {
  const sfs = await device(t)
  t.ok(sfs instanceof SwarmFS)
  t.is(typeof sfs.device, 'string')
  t.ok(sfs.hg)
  await sfs.close()
})

test('the platform gives what sync needs: recursive watch, statfs, a stable ino', async (t) => {
  const fs = (await import('fs')).default
  const path = (await import('path')).default
  const { tmpDir, eventually } = await import('./helpers.js')
  const dir = tmpDir(t)
  const seen = []
  const watcher = fs.watch(dir, { recursive: true }, (event, name) => seen.push(String(name)))
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'x.txt'), 'x')
  t.ok(await eventually(() => seen.some((n) => n.replace(/\\/g, '/') === 'sub/x.txt'), 3000), 'an event for a file in a sub-folder')
  watcher.close()

  const st = await fs.promises.statfs(dir)
  t.ok(st.bavail > 0 && st.bsize > 0 && st.blocks > 0, 'statfs')
  const a = await fs.promises.stat(path.join(dir, 'sub', 'x.txt'))
  fs.renameSync(path.join(dir, 'sub', 'x.txt'), path.join(dir, 'y.txt'))
  const b = await fs.promises.stat(path.join(dir, 'y.txt'))
  t.ok(a.ino > 0 && a.ino === b.ino, 'a rename keeps ino')
})
