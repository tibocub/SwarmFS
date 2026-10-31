// Spec 003 story 6: each person chooses whether others see what their devices hold.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { person, invited, eventually, writeTree, tmpDir } from './helpers.js'

test('off by default: Bob sees only "not here" and still fetches; on: "Alice, online"; off again: gone', { timeout: 120000 }, async (t) => {
  const alice = await person(t, 'alice')
  const bob = await person(t, 'bob')
  const drive = await alice.createSpace('Family')
  const bd = await invited(t, drive, bob)
  const disk = writeTree(tmpDir(t, 'disk'), { 'film.mp4': 'film' })
  const film = await drive.add(path.join(disk, 'film.mp4'))
  const other = await alice.createSpace('Other')
  await other.add(path.join(writeTree(tmpDir(t, 'disk2'), { 'x.txt': 'x' }), 'x.txt'))

  const seen = await eventually(() => bd.get(film.id).catch(() => null), 20000)
  t.alike(seen.holders, [], 'off: no holder shown to Bob')
  t.is((await drive.space.query('has').latest(10)).items.length, 0, 'no `has` record at all')
  const out = path.join(tmpDir(t, 'out'), 'film.mp4')
  t.ok(await eventually(() => bd.fetch(film.id, out).catch(() => null), 20000), 'fetched anyway while Alice is online')
  t.is(fs.readFileSync(out, 'utf8'), 'film')

  await drive.showHoldings(true)
  const shown = await eventually(async () => (await bd.get(film.id)).holders.find((h) => h.name === 'Alice'), 20000)
  t.ok(shown, 'on: Alice shown as a holder')
  t.ok(shown && shown.online && shown.path === null, 'online, never a path')
  t.is((await other.space.query('has').latest(10)).items.length, 0, 'her other space unaffected')

  await drive.showHoldings(false)
  t.ok(await eventually(async () => !(await bd.get(film.id)).holders.some((h) => h.name === 'Alice'), 20000), 'off again: gone')
})
