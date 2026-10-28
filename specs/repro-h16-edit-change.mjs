// H16 repro: npx brittle-node specs/repro-h16-edit-change.mjs (PC + paired phone, local DHT).
// Prints which events the phone sees for a put, an edit and a del made on the PC.
import test from 'brittle'
import { pair, eventually } from '../test/helpers.js'
import { contentRef } from '../lib/types.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('does change fire on the other device for put, edit, del?', { timeout: 60000 }, async (t) => {
  const { pc, phone } = await pair(t)
  const drive = await pc.createSpace('s')
  const pd = await eventually(() => phone.spaces().find((s) => s.key === drive.key) && phone.space(drive.key), 15000)
  const seen = []
  pd.space.on('change', (e) => seen.push(JSON.stringify(e)))
  pd.space.on('logs', () => seen.push('logs'))
  const r = await drive.space.put('file', { name: 'a', parent: drive.key, content: contentRef('a'.repeat(64), 1) })
  await eventually(async () => (await pd.space.get(r.id)).record, 10000)
  await sleep(1500)
  console.log('after put', seen.length, seen.join(' '))
  seen.length = 0
  await drive.space.edit(r.id, { name: 'b' })
  const renamed = await eventually(async () => (await pd.space.get(r.id)).record?.name === 'b', 10000)
  await sleep(1500)
  console.log('after edit', !!renamed, seen.length, seen.join(' '))
  seen.length = 0
  await drive.space.del(r.id)
  const gone = await eventually(async () => !(await pd.space.get(r.id)).record, 10000)
  await sleep(1500)
  console.log('after del', !!gone, seen.length, seen.join(' '))
  t.pass()
})
