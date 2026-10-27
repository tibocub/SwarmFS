// Story 2: a second device sees everything, and who holds what.

import test from 'brittle'
import path from 'path'
import { SwarmFS } from '../index.js'
import { device, pair, tmpDir, writeTree, bootstrap, codeOf, eventually } from './helpers.js'

test('a wrong or reused pairing code is refused', async (t) => {
  const pc = await device(t, 'pc')
  const { code, added } = await pc.addDevice()
  t.is(await codeOf(SwarmFS.open(tmpDir(t, 'x'), { joinCode: 'not a code', bootstrap: await bootstrap(t) })), 'INVITE_INVALID')
  await device(t, 'phone', { joinCode: code })
  t.ok(await added)
  t.is(await codeOf(SwarmFS.open(tmpDir(t, 'y'), { joinCode: code, joinTimeout: 4000, bootstrap: await bootstrap(t) })), 'INVITE_INVALID', 'reused')
})

test('the phone sees the space, the tree and who holds what; also with the PC closed', async (t) => {
  const { pc, phone } = await pair(t)
  const disk = writeTree(tmpDir(t, 'disk'), { 'photos/a.jpg': 'aaaa', 'photos/trip/c.jpg': 'cc' })
  const drive = await pc.createSpace('My files')
  const photos = await drive.add(path.join(disk, 'photos'))

  const devices = await eventually(async () => {
    const d = await phone.devices()
    return d.length === 2 && d.find((x) => !x.current).online && d
  })
  t.ok(devices, 'the phone sees the PC online')
  t.alike(devices.map((d) => d.name).sort(), ['pc', 'phone'])

  const started = Date.now()
  const seen = await eventually(() => phone.spaces().find((s) => s.key === drive.key))
  t.ok(seen, 'the space appears on the phone')
  const pd = phone.space(drive.key)
  const a = await eventually(async () => {
    const top = await pd.list(undefined, { timeout: 1000 })
    if (top.items.length !== 1) return null
    const { items } = await pd.list(photos.id, { timeout: 1000 })
    const file = items.find((i) => i.name === 'a.jpg')
    return items.length === 2 && file && file.holders.length === 1 && file.holders[0].online && file
  })
  t.ok(a, 'the tree, with holders')
  t.ok(Date.now() - started < 10000, `within 10 s (${Date.now() - started} ms)`)
  t.alike(a.holders, [{ device: pc.device, name: 'pc', online: true, path: null }], 'the PC holds it; no path for another device')

  // hypergraph H4: where() and fromDevice() combine
  const held = (dev) => phone.hg.personal.query('held').where({ root: a.hash }).fromDevice(dev).latest(10)
  t.is((await held(pc.device)).items.length, 1, 'H4: held by the PC')
  t.is((await held(phone.device)).items.length, 0, 'H4: not by the phone')

  const event = new Promise((resolve) => phone.on('spaces', resolve))
  const later = await pc.createSpace('Later')
  await event
  t.ok(phone.spaces().find((s) => s.key === later.key), "'spaces' fires for a space made on the other device")

  await pc.close()
  const offline = await eventually(async () => {
    const { items } = await pd.list(photos.id, { timeout: 500 })
    const file = items.find((i) => i.name === 'a.jpg')
    return file && !file.holders[0].online && items
  })
  t.ok(offline, 'still listed with the PC closed, held by the PC, not online')
  t.ok((await phone.devices()).find((d) => d.name === 'pc' && !d.online))
})

test('a stranger has no such space', async (t) => {
  const pc = await device(t, 'pc')
  const drive = await pc.createSpace('mine')
  const stranger = await device(t, 'stranger')
  t.is(await codeOf((async () => stranger.space(drive.key))()), 'NOT_FOUND')
  t.alike(stranger.spaces(), [])
})
