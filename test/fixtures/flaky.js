// A fixture for scripts/test-runner.js (not a *.test.js, so not run on its own):
// fails the first time, passes the next (FLAKY_MARKER is the file that
// remembers the first run).

import test from 'brittle'
import fs from 'fs'

test('fails once', (t) => {
  const marker = /** @type {string} */ (process.env.FLAKY_MARKER)
  if (fs.existsSync(marker)) return t.pass('second run')
  fs.writeFileSync(marker, '')
  t.fail('first run')
})
