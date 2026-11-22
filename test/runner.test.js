// scripts/test-runner.js: a failure that passes when run again alone is FLAKY, never a plain pass;
// --quick/--merge pick from the test map (per function), and run everything when it can't be
// trusted. Node only: the runner is a Node script.

import test from 'brittle'

if (typeof Bare !== 'undefined') {
  test('test runner: skipped on Bare (a Node script)', (t) => { t.pass('skipped on Bare') })
} else {
  const { execFile } = await import('child_process')
  const path = (await import('path')).default
  const fs = (await import('fs')).default
  const os = (await import('os')).default
  const { fileURLToPath } = await import('url')
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const { pick, editsOf, tempRoot, SHARED } = await import('../scripts/test-runner.js')

  /** @param {Record<string, string>} env */
  const runFixture = (env) => new Promise((resolve) => {
    execFile(process.execPath, ['scripts/test-runner.js', '--jobs', '1', 'test/fixtures/flaky.js'], { cwd: root, env: { ...process.env, ...env } }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout }))
  })

  test('a failure that passes alone is reported FLAKY, and counted; failing twice fails the run', async (t) => {
    const marker = path.join(os.tmpdir(), `sfs-flaky-${process.pid}-${Date.now()}`)
    t.teardown(() => fs.rmSync(marker, { force: true }))
    const out = await runFixture({ FLAKY_MARKER: marker })
    t.ok(/^FAIL .*flaky\.js/m.test(out.stdout), 'the first run fails')
    t.ok(/^FLAKY \(passed alone\) .*flaky\.js/m.test(out.stdout), 'the retry passes, reported as FLAKY')
    t.ok(/\(1 FLAKY\)/.test(out.stdout), 'the summary counts it')
    t.absent(/^ok .*flaky\.js/m.test(out.stdout), 'never a plain pass')
    t.is(out.code, 0, 'a flaky file alone does not fail the run')

    // a marker in a folder that doesn't exist: writing it throws, so the file fails every time
    const twice = await runFixture({ FLAKY_MARKER: path.join(marker + '-none', 'x') })
    t.ok(/^FAIL again .*flaky\.js/m.test(twice.stdout), 'failing twice: a real failure')
    t.is(twice.code, 1, 'the run fails')
  })

  const candidates = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js']
  // lib/sync.js: a constant at the top, then two functions; a runs one, b the other.
  const src = 'const MASS = 100\nfunction one () {\n  return MASS\n}\nfunction two () {\n  return 2\n}\n'
  const at = (/** @type {string} */ s) => src.indexOf(s)
  const map = {
    known: ['lib/sync.js', 'lib/tree.js', 'test/helpers.js', 'perf/x.js', ...candidates],
    fns: { 'lib/sync.js': [[at('function one'), at('function two') - 1], [at('function two'), src.length - 1]], 'lib/tree.js': [[0, 10]] },
    tests: {
      'test/a.test.js': { 'lib/sync.js': [0] },
      'test/b.test.js': { 'lib/sync.js': [1], 'lib/tree.js': [0] },
      'test/c.test.js': { 'lib/tree.js': [], 'hypergraph:lib/space.js': [3] }
    }
  }
  /**
   * @param {string[]} changed
   * @param {object} [extra]
   */
  const picked = (changed, extra = {}) => {
    const r = pick({ candidates, changed, map, stale: null, ...extra })
    return r.all ? r.why : [...r.picked.keys()].sort()
  }
  const edit = (/** @type {string} */ text) => ({ edits: { 'lib/sync.js': [[at(text), at(text) + text.length]] } })

  test('picks the tests that ran a changed function, or a changed linked package', (t) => {
    t.alike(picked(['lib/sync.js'], edit('  return MASS\n')), ['test/a.test.js'], 'inside one(): a only')
    t.alike(picked(['lib/sync.js'], edit('  return 2\n')), ['test/b.test.js'], 'inside two(): b only')
    t.alike(picked(['lib/sync.js'], edit('const MASS = 100\n')), ['test/a.test.js', 'test/b.test.js'], 'the top level: every test that loaded it')
    t.alike(picked(['lib/tree.js']), ['test/b.test.js', 'test/c.test.js'], 'edits unknown: every test that loaded it')
    t.alike(picked(['test/a.test.js', 'README.md']), ['test/a.test.js'], 'a changed test; docs change nothing')
    t.alike(picked(['perf/x.js']), [], 'a file no test loaded picks nothing')
    t.alike(picked([], { siblingsChanged: ['hypergraph'] }), ['test/c.test.js'], 'hypergraph changed: every test that ran any of it')
    const reads = { ...SHARED, readsSources: ['test/c.test.js'] }
    t.alike(picked(['lib/sync.js'], { ...edit('  return 2\n'), shared: reads }), ['test/b.test.js', 'test/c.test.js'], 'a test reading every source runs on any source change')
    t.alike(picked([], { siblingsChanged: ['swarmwire-lib'], shared: reads }), ['test/c.test.js'], 'and on a linked package change')
    t.alike(picked([], { candidates: [...candidates, 'test/new.test.js'] }), ['test/new.test.js'], 'a test missing from the map runs')
  })

  test('edits land in the map\'s copy of the file', (t) => {
    const mine = src.replace(/\n/g, '\r\n') // the run saw the working tree: CRLF on Windows
    const cut = (/** @type {[number, number]} */ r) => mine.slice(r[0], r[1])
    t.is(cut(editsOf('lib/sync.js', { sources: { 'lib/sync.js': mine } }, null, { now: mine.replace('return 2', 'return 3'), base: mine })[0]), '  return 2\r\n', 'changed after the map')
    t.is(cut(editsOf('lib/sync.js', { sources: { 'lib/sync.js': mine } }, null, { now: mine, base: src.replace('return MASS', 'return 1') })[0]), '  return MASS\r\n', 'already in the map')
  })

  test('edits: a file unchanged since the base, read from git, has none (its final newline kept)', async (t) => {
    const { execFileSync } = await import('child_process')
    const text = execFileSync('git', ['show', 'HEAD:README.md'], { cwd: root, encoding: 'utf-8' })
    const now = fs.readFileSync(path.join(root, 'README.md'), 'utf-8')
    if (now.replace(/\r\n/g, '\n') !== text) return t.pass('README.md has local changes: nothing to compare')
    t.alike(editsOf('README.md', { sources: { 'README.md': now } }, 'HEAD'), [], 'no edits')
  })

  test('temp: the system folder or HG_TEST_TMP; HG_TEST_TMP_FALLBACK under 3 GB free, said', (t) => {
    const said = []
    const say = (/** @type {string} */ line) => { said.push(line) }
    const freeOf = (/** @type {string} */ dir) => (dir === 'main' ? ROOM.main : ROOM.spare)
    const ROOM = { main: 9e9, spare: 70e9 }
    t.is(tempRoot({ env: { HG_TEST_TMP: 'main', HG_TEST_TMP_FALLBACK: 'spare' }, freeOf, say }), 'main', 'room: the chosen folder')
    t.alike(said, [], 'nothing said')
    ROOM.main = 2e9
    t.is(tempRoot({ env: { HG_TEST_TMP: 'main', HG_TEST_TMP_FALLBACK: 'spare' }, freeOf, say }), 'spare', 'under 3 GB: the fallback')
    t.ok(/2000 MB free in main, under 3 GB: using spare/.test(said[0]), 'said: ' + said[0])
    ROOM.spare = 1e9
    t.is(tempRoot({ env: { HG_TEST_TMP: 'main', HG_TEST_TMP_FALLBACK: 'spare' }, freeOf, say }), 'main', 'both low: stays, warned')
    t.ok(/warning/.test(said[1]))
    t.is(tempRoot({ env: {}, freeOf: () => 9e9, say }), os.tmpdir(), 'no setting: the system temp folder')
  })

  test('temp: each file gets its own folder, removed after it ran', async (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-root-'))
    t.teardown(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))
    const out = await new Promise((resolve) => {
      execFile(process.execPath, ['scripts/test-runner.js', '--jobs', '1', 'test/fixtures/writes-temp.js'], { cwd: root, env: { ...process.env, HG_TEST_TMP: tmpRoot, EXPECT_ROOT: tmpRoot } }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout }))
    })
    t.is(out.code, 0, out.stdout)
    t.ok(/1\/1 tests passed/.test(out.stdout), 'it wrote in a folder of its own')
    t.alike(fs.readdirSync(tmpRoot), [], 'and the folder is gone')
  })

  test('falls back to everything when the map can\'t be trusted', (t) => {
    t.ok(/no test map/.test(String(picked(['lib/sync.js'], { map: null }))), 'no map')
    t.ok(/changed after/.test(String(picked([], { stale: 'test helpers or config changed after the map was made' }))), 'a stale map')
    t.ok(/test helper changed: test\/helpers\.js/.test(String(picked(['test/helpers.js']))), 'a helper changed')
    t.ok(/package-lock\.json changed/.test(String(picked(['package-lock.json']))), 'the lockfile')
    t.ok(/scripts\/test-runner\.js changed/.test(String(picked(['scripts/test-runner.js']))), 'the runner')
    t.ok(/lib\/new\.js is new/.test(String(picked(['lib/new.js']))), 'a new source file')
  })
}
