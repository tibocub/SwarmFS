// Two devices of one person (a PC and a laptop, paired by code) and a folder of `size` files of
// 1-4 KB, played with the tests' own helpers (test/helpers.js linkedPair), local DHT:
//   sfs.pair-and-add  pairing the laptop, adding the folder on the PC, the laptop seeing it and
//                     linking it to a folder of its own
//   sfs.link-sync     from the link until every file is on the laptop's disk
//   sfs.edit-notice   a file edited on the PC, until the PC records it: the watcher's settle
//                     time (lib/watch.js SETTLE, 2 s by design), not work. flat
//   sfs.edit          from the PC recording the edit until the laptop's copy has the new bytes:
//                     the sync pass (scale audit, perf scenario 10). flat: a pass should not
//                     walk every file
//   sfs.held          `held` records per file (scale audit 11; the personal space)
//   sfs.has           `has` records per file in the space, "show holdings" on (scale audit 11)

import fs from 'fs'
import path from 'path'
import { context, record, now, eventually, within, sizes } from '../harness.mjs'
import { linkedPair, bytes } from '../../test/helpers.js'

const REPEATS = 2
const EDITS = 2 // per repeat

for (const n of sizes([20, 200])) {
  const res = { pairs: [], syncs: [], notices: [], edits: [], held: [], has: [] }
  for (let r = 0; r < REPEATS; r++) {
    const t = context()
    try {
      const files = {}
      for (let i = 0; i < n; i++) files[`docs/f${i}.txt`] = bytes(1024 + (i * 331) % 3072, i + 1)
      let start = now()
      const { pc, laptop, drive, pcDocs, laptopDocs } = await linkedPair(t, files)
      res.pairs.push(now() - start)
      start = now()
      const all = await eventually(() => fs.existsSync(laptopDocs) && fs.readdirSync(laptopDocs).filter((f) => f.endsWith('.txt')).length === n, 120000)
      if (!all) throw new Error('the laptop never got every file')
      res.syncs.push(now() - start)

      for (let e = 0; e < EDITS; e++) {
        const name = `f${r * EDITS + e}.txt`
        const next = bytes(2000, 1000 + r * EDITS + e)
        const recorded = new Promise((resolve) => {
          const on = (ev) => { if (ev.action === 'updated' && ev.path.endsWith(name)) { pc.off('sync', on); resolve(now()) } }
          pc.on('sync', on)
        })
        start = now()
        fs.writeFileSync(path.join(pcDocs, name), next)
        const at = await within(recorded, 30000, null)
        if (at === null) throw new Error('the PC never recorded the edit')
        res.notices.push(at - start)
        if (!await eventually(() => { try { return fs.readFileSync(path.join(laptopDocs, name)).equals(next) } catch { return false } }, 30000, 5)) throw new Error('the edit never reached the laptop')
        res.edits.push(now() - at)
      }

      const held = await laptop.hg.personal.query('held').fromDevice(laptop.device).latest(n + 50)
      res.held.push(held.items.length / n)
      await drive.showHoldings(true)
      const has = await eventually(async () => { const l = await drive.space.query('has').latest(4 * n); return l.items.length >= n && l.items.length }, 30000)
      res.has.push((has || 0) / n)
    } finally {
      await t.close()
    }
  }
  record('sfs.pair-and-add', n, 'ms', res.pairs)
  record('sfs.link-sync', n, 'ms', res.syncs)
  record('sfs.edit-notice', n, 'ms', res.notices, { flat: true })
  record('sfs.edit', n, 'ms', res.edits, { flat: true })
  record('sfs.held', n, 'records/file', res.held, { flat: true })
  record('sfs.has', n, 'records/file', res.has, { flat: true })
}
