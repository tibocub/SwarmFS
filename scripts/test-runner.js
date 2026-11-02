#!/usr/bin/env node
// Runs test files in parallel, one process per file, and reports how long
// each took. Same idea as hypergraph's scripts/test-runner.js.
//
//   node scripts/test-runner.js [--jobs N] [--bare] [file ...]
//
// Default files: test/*.test.js. --bare runs them on Bare instead of Node.
// --jobs defaults to the number of CPU cores minus two (SFS_TEST_JOBS overrides);
// test processes run at below-normal priority. Files start longest first (by
// their last run, kept in the gitignored .test-times.json). Every file must
// print its own "# tests = n/n" line to count as passed.
//
// Files run as plain scripts (`node file`, `bare file`), not through brittle's
// CLI, whose glob walks the whole cwd (node_modules, .claude/worktrees...)
// before each file: ~4 s per file on this machine (measured 2026-11-02).

import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TIMES = path.join(ROOT, '.test-times.json')
const BARE = path.join(ROOT, 'node_modules', 'bare', 'bin', 'bare') // a Node script starting the runtime

const opts = { jobs: Number(process.env.SFS_TEST_JOBS) || Math.max(1, os.cpus().length - 2), bare: false, files: [] }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--jobs') opts.jobs = Number(argv[++i])
  else if (argv[i] === '--bare') opts.bare = true
  else opts.files.push(argv[i])
}
const files = opts.files.length
  ? opts.files
  : fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => `test/${f}`)

function run (file) {
  return new Promise((resolve) => {
    const start = Date.now()
    const p = spawn(process.execPath, opts.bare ? [BARE, file] : [file], { cwd: ROOT })
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {} // keep the machine responsive
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('exit', (code) => {
      const m = /# tests = (\d+)\/(\d+) pass/.exec(out)
      const passed = m ? Number(m[1]) : (out.match(/^ok \d+/gm) || []).length
      const total = m ? Number(m[2]) : passed + 1 // no summary: crashed or timed out
      resolve({ file, ms: Date.now() - start, code, passed, total, ok: code === 0 && !!m && passed === total, out })
    })
  })
}

let times = {}
try { times = JSON.parse(fs.readFileSync(TIMES, 'utf-8')) } catch {}
const key = (f) => (opts.bare ? `bare:${f}` : f)
const order = (f) => (key(f) in times ? times[key(f)] : Infinity) // unknown files first
const queue = [...files].sort((a, b) => order(b) - order(a))
const started = Date.now()
const results = []
const worker = async () => {
  while (queue.length) {
    const r = await run(queue.shift())
    results.push(r)
    process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.file}${r.ok ? '' : `  (exit ${r.code}, ${r.passed}/${r.total})`}\n`)
  }
}
await Promise.all(Array.from({ length: Math.min(opts.jobs, files.length) }, worker))
for (const r of results) times[key(r.file)] = r.ms
try { fs.writeFileSync(TIMES, JSON.stringify(times, null, 2)) } catch {}

const failed = results.filter(r => !r.ok)
for (const r of failed) {
  process.stdout.write(`\n──── ${r.file} ────\n`)
  process.stdout.write(r.out.split('\n').filter(l => /not ok|Error|error|# tests|# asserts/.test(l)).slice(0, 40).join('\n') + '\n')
}
const tests = results.reduce((n, r) => n + r.total, 0)
const passed = results.reduce((n, r) => n + r.passed, 0)
process.stdout.write(`\n${passed}/${tests} tests passed in ${files.length} files${failed.length ? ` (${failed.length} FAILED)` : ''}; ` +
  `wall ${((Date.now() - started) / 1000).toFixed(1)}s, ${opts.jobs} jobs${opts.bare ? ', Bare' : ''}\n`)
process.exit(failed.length ? 1 : 0)
