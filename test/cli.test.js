// Story 5: the CLI, run as a person runs it on two machines: separate processes, one DHT.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import process from 'process'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { bootstrap, tmpDir, writeTree, bytes } from './helpers.js'

const CLI = fileURLToPath(new URL('../bin/swarmfs.js', import.meta.url))

// timeout: the first ls waits 15 s for the space's name until hypergraph H12
test('PC: init, create, add, pair, serve; phone: join, ls, get', { timeout: 90000 }, async (t) => {
  const b = (await bootstrap(t))[0]
  const flags = (name) => ['--dir', tmpDir(t, name), '--name', name, '--bootstrap', `${b.host}:${b.port}`]
  const pc = flags('pc')
  const phone = flags('phone')
  const disk = writeTree(tmpDir(t, 'disk'), { 'photos/a.jpg': bytes(50000), 'photos/trip/c.jpg': 'cc' })
  const out = path.join(tmpDir(t, 'out'), 'a.jpg')

  t.ok((await done(t, ['init', ...pc])).startsWith('device '), 'init')
  t.ok((await done(t, ['create', 'My files', ...pc])).includes('My files'), 'create')
  t.ok((await done(t, ['add', 'My files', path.join(disk, 'photos'), ...pc])).includes('\tfolder\tphotos'), 'add')

  const pair = run(t, ['pair', ...pc])
  const code = (await pair.line()).trim()
  t.ok(code.length > 10, 'pair prints a code')
  t.ok((await done(t, ['join', code, ...phone])).startsWith('device '), 'join')
  t.is(await pair.exit(), 0, 'pair ends once the phone joined')

  const serve = run(t, ['serve', ...pc])
  t.ok((await serve.line()).startsWith('serving'), 'serve stays online')

  const top = rows(await done(t, ['ls', 'My files', ...phone]))
  t.is(top.length, 1)
  t.is(top[0][2], 'photos')
  const inside = rows(await done(t, ['ls', 'My files', top[0][0], ...phone]))
  const a = inside.find((r) => r[2] === 'a.jpg')
  t.alike(inside.map((r) => r[2]), ['trip', 'a.jpg'], 'folders first')
  t.is(a[3], '50000')
  t.is(a[4], 'pc (online)', 'held by the PC, online')

  t.ok((await done(t, ['get', 'My files', a[0], out, ...phone])).includes('50000'), 'get')
  t.alike(fs.readFileSync(out), fs.readFileSync(path.join(disk, 'photos/a.jpg')), 'same bytes')
})

// Tab-separated entry lines of `ls` (Bare on Windows ends lines with \r\n).
const rows = (stdout) => stdout.trim().split(/\r?\n/).map((l) => l.split('\t'))

// Runs a one-shot command; its stdout once it exited cleanly.
async function done (t, args) {
  const child = run(t, args)
  const code = await child.exit()
  t.is(code, 0, `swarmfs ${args[0]} exits 0${code ? ': ' + child.stdout() + child.stderr() : ''}`)
  return child.stdout()
}

function run (t, args) {
  // process.execPath is whichever runtime runs the tests, so Node and Bare both get covered.
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  t.teardown(() => { if (child.exitCode === null) child.kill('SIGKILL'); return exited }, { order: 50 })
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    exit: () => exited,
    // The first line, once printed.
    line: () => new Promise((resolve, reject) => {
      const check = () => {
        if (stdout.includes('\n')) return resolve(stdout.slice(0, stdout.indexOf('\n')))
        if (child.exitCode !== null) return reject(new Error(`exited before a line: ${stderr}`))
        setTimeout(check, 50)
      }
      check()
    })
  }
}
