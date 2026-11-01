// Two people sharing a space (spec 003): Alice's folder of `size` files of 1-4 KB, Bob invited
// and the folder linked on his PC (test/helpers.js sharedPair), local DHT:
//   sfs.share-and-join  Alice makes the space and invites Bob, he joins, she adds the folder,
//                       he sees it and links it
//   sfs.shared-sync     from Bob's link until every file is on his disk
//   sfs.shared-edit     Bob edits one of Alice's files, until her disk has his bytes

import fs from 'fs'
import path from 'path'
import { context, record, now, eventually, sizes } from '../harness.mjs'
import { sharedPair, bytes } from '../../test/helpers.js'

const REPEATS = 3

for (const n of sizes([10, 100])) {
  const joins = []
  const syncs = []
  const edits = []
  for (let r = 0; r < REPEATS; r++) {
    const t = context()
    try {
      const files = {}
      for (let i = 0; i < n; i++) files[`docs/f${i}.txt`] = bytes(1024 + (i * 331) % 3072, i + 1)
      let start = now()
      const { aliceDocs, bobDocs } = await sharedPair(t, files)
      joins.push(now() - start)
      start = now()
      const all = await eventually(() => fs.existsSync(bobDocs) && fs.readdirSync(bobDocs).filter((f) => f.endsWith('.txt')).length === n, 120000)
      if (!all) throw new Error('Bob never got every file')
      syncs.push(now() - start)

      const name = `f${r}.txt`
      const next = bytes(2000, 2000 + r)
      start = now()
      fs.writeFileSync(path.join(bobDocs, name), next)
      if (!await eventually(() => { try { return fs.readFileSync(path.join(aliceDocs, name)).equals(next) } catch { return false } }, 30000)) throw new Error('Bob\'s edit never reached Alice')
      edits.push(now() - start)
    } finally {
      await t.close()
    }
  }
  record('sfs.share-and-join', n, 'ms', joins)
  record('sfs.shared-sync', n, 'ms', syncs)
  record('sfs.shared-edit', n, 'ms', edits)
}
