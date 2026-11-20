// npm run typecheck: tsc in strict mode over SwarmFS's own code (jsconfig.json) reports no error.

import test from 'brittle'

if (typeof Bare !== 'undefined') {
  test('typecheck: skipped on Bare (a Node script)', (t) => t.pass('skipped on Bare'))
} else {
  const { spawnSync } = await import('child_process')
  const { fileURLToPath } = await import('url')
  const root = fileURLToPath(new URL('../', import.meta.url))

  test('typecheck: the library has no type error', { timeout: 120000 }, (t) => {
    const res = spawnSync(process.execPath, [root + 'node_modules/typescript/bin/tsc', '-p', root + 'jsconfig.json'], { cwd: root, encoding: 'utf8' })
    t.is(res.status, 0, res.stdout.split('\n').slice(0, 20).join('\n') || 'no error')
  })
}
