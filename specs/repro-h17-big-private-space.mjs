// H17 repro: npx brittle-node specs/repro-h17-big-private-space.mjs (local DHT, ~2 min).
// A device paired after a private space holds 1,000 files never gets access (status().access 'waiting').
// With 300 files it sees them in ~0.4 s.
import test from 'brittle'
import path from 'path'
import { device, tmpDir, writeTree, eventually } from '../test/helpers.js'
test('pair with 1000, no sync', { timeout: 240000 }, async (t) => {
  const files = { 'docs/keep.txt': 'k' }
  for (let i = 0; i < 1000; i++) files[`docs/f/${i}.txt`] = `file ${i}`
  const pc = await device(t, 'pc')
  const disk = writeTree(tmpDir(t, 'd'), files)
  const sp = await pc.hg.createSpace({ name: 'My files', private: true, policy: 'everything' }); const drive = pc.space(sp.key)
  const docs = await drive.add(path.join(disk, 'docs'))
  const { code, added } = await pc.addDevice()
  const laptop = await device(t, 'laptop', { joinCode: code })
  await added
  const s = Date.now()
  const ld = await eventually(() => laptop.spaces().find((x) => x.key === drive.key) && laptop.space(drive.key), 30000)
  console.log('space after', Date.now() - s)
  const got = await eventually(async () => (await ld.get(docs.id).catch((e) => { return null })), 90000)
  console.log('docs after', Date.now() - s, !!got)
  const list = await ld.list(docs.id, { timeout: 2000 }).catch((e) => e.message)
  console.log('status', JSON.stringify(ld.space.status()).slice(0, 300))
  console.log('list', JSON.stringify(list).slice(0, 200))
  t.ok(got)
})
