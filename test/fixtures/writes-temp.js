// A fixture for scripts/test-runner.js (not a *.test.js, so not run on its own): writes a file
// in its temp folder, which must be its own one inside EXPECT_ROOT.

import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'

test('writes in its own temp folder', (t) => {
  t.is(path.dirname(os.tmpdir()), path.resolve(/** @type {string} */ (process.env.EXPECT_ROOT)), 'a folder of its own in the temp folder')
  t.is(process.env.HG_TEST_TMP, os.tmpdir(), 'HG_TEST_TMP names it too')
  fs.writeFileSync(path.join(os.tmpdir(), 'left-behind.txt'), 'x')
})
