// Story 5: the CLI, run as a person runs it on two machines: a long-running shell on each,
// driven through stdin; separate processes, one DHT.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import process from 'process'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { bootstrap, tmpDir, writeTree, bytes, eventually } from './helpers.js'

const CLI = fileURLToPath(new URL('../bin/swarmfs.js', import.meta.url))

test('PC shell: create, add, pair, add while serving; phone: join, then a shell: ls, get', { timeout: 90000 }, async (t) => {
  const b = (await bootstrap(t))[0]
  const flags = (name) => ['--dir', tmpDir(t, name), '--name', name, '--bootstrap', `${b.host}:${b.port}`]
  const pcFlags = flags('pc')
  const phoneFlags = flags('phone')
  const disk = writeTree(tmpDir(t, 'disk'), { 'photos/a.jpg': bytes(50000), 'photos/trip/c.jpg': 'cc', 'late.txt': 'late' })
  const out = path.join(tmpDir(t, 'out'), 'a.jpg')

  const pc = shell(t, pcFlags)
  t.ok((await pc.ready()).startsWith('device '), 'the PC shell is online')
  t.ok((await pc.do('create "My files"')).includes('My files'), 'create')
  t.ok((await pc.do(`add "My files" "${path.join(disk, 'photos')}"`)).includes('\tfolder\tphotos'), 'add')

  const busy = run(t, ['ls', 'My files', ...pcFlags])
  t.is(await busy.exit(), 1, 'a one-shot command on a folder a shell holds fails')
  t.ok(busy.stderr().includes('in use by a swarmfs shell'), `with a clear message: ${busy.stderr().trim()}`)

  const code = (await pc.do('pair')).split(/\r?\n/)[0].trim()
  t.ok(code.length > 10, 'pair prints a code')
  t.ok((await done(t, ['join', code, ...phoneFlags])).startsWith('device '), 'join')
  t.ok(await pc.until(/added phone/), 'the PC shell says the phone joined, and stays online')

  const phone = shell(t, phoneFlags)
  await phone.ready()
  // just joined: the space and its name arrive in a moment (hypergraph H12); asking again is enough
  const top = await eventually(async () => {
    const r = rows(await phone.do('ls "My files"'))
    return r.length === 1 && r
  }, 20000)
  t.ok(top, 'the phone lists the space')
  t.is(top[0][2], 'photos')
  const inside = await eventually(async () => {
    const r = rows(await phone.do(`ls "My files" ${top[0][0]}`))
    return r.length === 2 && r.find((x) => x[2] === 'a.jpg')[4] === 'pc (online)' && r
  }, 20000)
  t.ok(inside, 'held by the PC, online')
  t.alike(inside.map((r) => r[2]), ['trip', 'a.jpg'], 'folders first')
  const a = inside[1]
  t.is(a[3], '50000')

  t.ok((await phone.do(`get "My files" ${a[0]} "${out}"`)).includes('50000'), 'get')
  t.alike(fs.readFileSync(out), fs.readFileSync(path.join(disk, 'photos/a.jpg')), 'same bytes')

  t.ok((await pc.do(`add "My files" "${path.join(disk, 'late.txt')}"`)).includes('late.txt'), 'add while serving')
  t.ok(await eventually(async () => rows(await phone.do('ls "My files"')).some((r) => r[2] === 'late.txt'), 20000), 'the phone sees it')

  pc.stdin.write('quit\n')
  t.is(await pc.exit(), 0, 'quit ends the shell')
  phone.end()
  t.is(await phone.exit(), 0, 'so does the end of its input')
})

// Tab-separated entry lines (Bare on Windows ends lines with \r\n).
const rows = (stdout) => stdout.split(/\r?\n/).filter((l) => l.includes('\t')).map((l) => l.split('\t'))

// Runs a one-shot command; its stdout once it exited cleanly.
async function done (t, args) {
  const child = run(t, args)
  const code = await child.exit()
  t.is(code, 0, `swarmfs ${args[0]} exits 0${code ? ': ' + child.stdout() + child.stderr() : ''}`)
  return child.stdout()
}

// A shell: `do(line)` sends a command and resolves to what it printed, up to the next prompt.
function shell (t, args) {
  const child = run(t, args, 'pipe')
  let seen = 0
  const prompt = async () => {
    const at = await child.until(/^>\r?\n/m, seen)
    const printed = child.stdout().slice(seen, at.index)
    seen = at.index + at[0].length
    return printed
  }
  return {
    ...child,
    ready: prompt,
    do: (line) => { child.stdin.write(line + '\n'); return prompt() },
    end: () => child.stdin.end()
  }
}

function run (t, args, stdin = 'ignore') {
  // process.execPath is whichever runtime runs the tests, so Node and Bare both get covered.
  const child = spawn(process.execPath, [CLI, ...args], { stdio: [stdin, 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  t.teardown(() => { if (child.exitCode === null) child.kill('SIGKILL'); return exited }, { order: 50 })
  return {
    stdin: child.stdin,
    stdout: () => stdout,
    stderr: () => stderr,
    exit: () => exited,
    // The first match of `re` in stdout from `from` on, once printed (the match, index in all of stdout).
    until: (re, from = 0) => new Promise((resolve, reject) => {
      const check = () => {
        const m = re.exec(stdout.slice(from))
        if (m) return resolve(Object.assign(m, { index: m.index + from }))
        if (child.exitCode !== null) return reject(new Error(`exited before ${re}: ${stderr}`))
        setTimeout(check, 50)
      }
      check()
    })
  }
}
