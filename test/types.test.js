import test from 'brittle'
import { device, codeOf } from './helpers.js'

const ref = (root) => ({ src: ['swarmwire://' + root], size: 1, type: '', digest: 'blake3:' + root, mutable: false })
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

test('the rules refuse a bad name and a digest not matching src', async (t) => {
  const sfs = await device(t)
  const { space } = await sfs.createSpace('rules')

  t.ok(await space.put('file', { name: 'ok.txt', parent: space.key, content: ref(A) }))
  for (const name of ['', 'a/b', 'a\0b', 'é'.repeat(128)]) {
    t.is(await codeOf(space.put('folder', { name, parent: space.key })), 'RULE_REJECTED', `name ${JSON.stringify(name.slice(0, 8))}`)
  }
  t.is(await codeOf(space.put('folder', { name: 'x', parent: '' })), 'RULE_REJECTED', 'empty parent')
  t.is(await codeOf(space.put('file', { name: 'x', parent: space.key, content: { ...ref(A), digest: 'blake3:' + B } })), 'RULE_REJECTED', 'digest differs')
})
