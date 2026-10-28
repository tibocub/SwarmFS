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

test('file.base: absent, or 1 to 16 roots separated by single spaces (swarmfs/base-v1)', async (t) => {
  const sfs = await device(t)
  const { space } = await sfs.createSpace('base')
  const put = (base) => space.put('file', { name: 'f', parent: space.key, content: ref(A), base })

  t.ok(await put(undefined), 'absent (a new file, a v1 record)')
  t.ok(await put(B), 'one root')
  t.ok(await put(Array(16).fill(B).join(' ')), 'sixteen')
  t.is(await codeOf(put(Array(17).fill(B).join(' '))), 'RULE_REJECTED', 'seventeen')
  t.is(await codeOf(put('')), 'RULE_REJECTED', 'empty')
  t.is(await codeOf(put(B + '  ' + A)), 'RULE_REJECTED', 'two spaces')
  t.is(await codeOf(put('xyz')), 'RULE_REJECTED', 'not a root')
  const f = await put(B)
  const edited = await space.edit(f.id, { content: ref(B), base: A })
  t.is(edited.base, A, 'edit sets it')
})
