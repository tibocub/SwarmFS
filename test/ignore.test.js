// The ignore rules of a linked folder: the fixed list and .swarmfsignore (research R8).

import test from 'brittle'
import { compile, ignored } from '../lib/ignore.js'

test('the fixed list', (t) => {
  const rules = compile('')
  for (const p of ['a.part', 'x/y.part', '.swarmfs-trash', '.swarmfs-trash/2026/a.txt', 'Thumbs.db', 'sub/desktop.ini',
    '.DS_Store', '~$report.docx', 'd/~$x.xlsx', 'a.tmp', '.a.txt.swp']) t.ok(ignored(rules, p, false), p)
  for (const p of ['a.txt', 'part', 'x.parts', 'tmp/a.txt', 'report.docx', '.swarmfsignore']) t.absent(ignored(rules, p, false), p)
})

test('.swarmfsignore: comments, *, **, trailing /, anchored when it has a /', (t) => {
  const rules = compile([
    '# build output',
    '',
    'build/',
    '*.log',
    'docs/*.pdf',
    '/top.txt',
    'a/**/z.txt',
    'cache'
  ].join('\n'))
  t.ok(ignored(rules, 'build', true), 'a folder build')
  t.ok(ignored(rules, 'src/build/out.js', false), 'under a build folder, any depth')
  t.absent(ignored(rules, 'build', false), 'a file named build: folders only')
  t.ok(ignored(rules, 'x.log', false))
  t.ok(ignored(rules, 'deep/er/x.log', false), 'no slash: any depth')
  t.ok(ignored(rules, 'docs/a.pdf', false))
  t.absent(ignored(rules, 'other/docs/a.pdf', false), 'with a slash: from the root')
  t.absent(ignored(rules, 'docs/sub/a.pdf', false), '* stays within a name')
  t.ok(ignored(rules, 'top.txt', false))
  t.absent(ignored(rules, 'sub/top.txt', false))
  t.ok(ignored(rules, 'a/z.txt', false), '** matches no folder')
  t.ok(ignored(rules, 'a/b/c/z.txt', false), '** matches many')
  t.ok(ignored(rules, 'cache', false))
  t.ok(ignored(rules, 'x/cache/y.txt', false), 'a matched folder ignores what is under it')
  t.ok(ignored(rules, 'x\\cache\\y.txt', false), 'Windows separators')
  t.absent(ignored(rules, 'a.txt', false))
})
