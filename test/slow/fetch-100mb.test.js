// SC-003: a 100 MB file fetched from the other device, verified. Slow: `npm run test:slow`.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { bytes, filesOnPC } from '../helpers.js'

test('a 100 MB file fetched whole and verified', { timeout: 300000, todo: true } /* swarmwire S7: see fetch.test.js */, async (t) => {
  const size = 100 * 1024 * 1024
  const { pd, disk, byName, out } = await filesOnPC(t, { 'big.bin': bytes(size, 9) })
  const target = path.join(out, 'big.bin')
  const started = Date.now()
  t.alike(await pd.fetch(byName['big.bin'].id, target), { path: target, bytes: size })
  t.comment(`${Date.now() - started} ms`)
  t.ok(fs.readFileSync(target).equals(fs.readFileSync(path.join(disk, 'big.bin'))), 'same bytes')
})
