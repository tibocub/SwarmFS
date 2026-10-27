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
