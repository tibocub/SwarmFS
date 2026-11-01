// Two devices of one person (a PC and a laptop, paired by code) and a folder of `size` files of
// 1-4 KB, played with the tests' own helpers (test/helpers.js linkedPair), local DHT:
//   sfs.pair-and-add  pairing the laptop, adding the folder on the PC, the laptop seeing it and
//                     linking it to a folder of its own
//   sfs.link-sync     from the link until every file is on the laptop's disk
//   sfs.edit          a file edited on the PC, until the laptop's copy has the new bytes

import fs from 'fs'
import path from 'path'
import { context, record, now, eventually, sizes } from '../harness.mjs'
import { linkedPair, bytes } from '../../test/helpers.js'

const REPEATS = 3

for (const n of sizes([10, 100])) {
  const pairs = []
  const syncs = []
  const edits = []
  for (let r = 0; r < REPEATS; r++) {
    const t = context()
    try {
      const files = {}
      for (let i = 0; i < n; i++) files[`docs/f${i}.txt`] = bytes(1024 + (i * 331) % 3072, i + 1)
      let start = now()
      const { pcDocs, laptopDocs } = await linkedPair(t, files)
      pairs.push(now() - start)
      start = now()
      const all = await eventually(() => fs.existsSync(laptopDocs) && fs.readdirSync(laptopDocs).filter((f) => f.endsWith('.txt')).length === n, 120000)
      if (!all) throw new Error('the laptop never got every file')
      syncs.push(now() - start)

      // one edit per repeat, a different file each time
      const name = `f${r}.txt`
      const next = bytes(2000, 1000 + r)
      start = now()
      fs.writeFileSync(path.join(pcDocs, name), next)
      if (!await eventually(() => { try { return fs.readFileSync(path.join(laptopDocs, name)).equals(next) } catch { return false } }, 30000)) throw new Error('the edit never reached the laptop')
      edits.push(now() - start)
    } finally {
      await t.close()
    }
  }
  record('sfs.pair-and-add', n, 'ms', pairs)
  record('sfs.link-sync', n, 'ms', syncs)
  record('sfs.edit', n, 'ms', edits)
}
