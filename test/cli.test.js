// Story 5: the CLI, run as a person runs it on two machines: a long-running shell on each,
// driven through stdin; separate processes, one DHT.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import process from 'process'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { bootstrap, tmpDir, writeTree, bytes, eventually, device, codeOf } from './helpers.js'

const CLI = fileURLToPath(new URL('../bin/swarmfs.js', import.meta.url))
const PASSWORD = 'pc secret'
const withPassword = { SWARMFS_PASSWORD: PASSWORD }

test('init asks for a password: the recovery phrase is not readable from the folder without it', async (t) => {
  const b = (await bootstrap(t))[0]
  const dir = tmpDir(t, 'pc')
  const flags = ['--dir', dir, '--name', 'pc', '--bootstrap', `${b.host}:${b.port}`]

  const early = run(t, ['devices', ...flags])
  t.is(await early.exit(), 1, 'a command on a new folder fails')
  t.ok(early.stderr().includes('swarmfs init'), `and says to init first: ${early.stderr().trim()}`)

  const asked = run(t, ['init', ...flags], 'pipe')
  asked.stdin.end('\n')
  t.is(await asked.exit(), 1, 'an empty password is refused')
  t.ok(asked.stdout().includes('password'), 'it was asked for')

  t.ok((await done(t, ['init', ...flags], withPassword)).startsWith('device '), 'init (SWARMFS_PASSWORD)')
  const sfs = await device(t, 'pc', { dir })
  t.is(await codeOf(sfs.hg.recoveryPhrase()), 'NOT_ALLOWED', 'not without the password')
  const words = await sfs.hg.recoveryPhrase(PASSWORD)
  t.is(words.split(' ').length, 24, 'with it')
  await sfs.close()
  t.ok(files(dir).every((f) => !fs.readFileSync(f).includes(words)), 'no file of the folder holds it in plain text')
})

test('PC shell: create, add, pair, add while serving; phone: join, then a shell: ls, get', { timeout: 90000 }, async (t) => {
  const b = (await bootstrap(t))[0]
  const flags = (name) => ['--dir', tmpDir(t, name), '--name', name, '--bootstrap', `${b.host}:${b.port}`]
  const pcFlags = flags('pc')
  const phoneFlags = flags('phone')
  const disk = writeTree(tmpDir(t, 'disk'), { 'photos/a.jpg': bytes(50000), 'photos/trip/c.jpg': 'cc', 'late.txt': 'late' })
  const out = path.join(tmpDir(t, 'out'), 'a.jpg')

  t.ok((await done(t, ['init', ...pcFlags], withPassword)).startsWith('device '), 'init')
  const pc = shell(t, pcFlags)
  t.ok((await pc.ready()).startsWith('device '), 'the PC shell is online')
  t.ok((await pc.do('create "My files"')).includes('My files'), 'create')
  t.ok((await pc.do(`add "My files" "${path.join(disk, 'photos')}"`)).includes('\tfolder\tphotos'), 'add')

  const busy = run(t, ['ls', 'My files', ...pcFlags])
  t.is(await busy.exit(), 1, 'a one-shot command on a folder a shell holds fails')
  t.ok(busy.stderr().includes('in use by a swarmfs shell'), `with a clear message: ${busy.stderr().trim()}`)

  const paired = (await pc.do('pair\n' + PASSWORD)).split(/\r?\n/) // the shell asks for the password
  t.ok(paired[0].includes('password'), 'pair asks for the password')
  const code = paired[1].trim()
  t.ok(code.length > 10, 'pair prints a code')
  t.ok((await done(t, ['join', code, ...phoneFlags], withPassword)).startsWith('device '), 'join')
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
  const words = await (await device(t, 'phone', { dir: phoneFlags[1] })).hg.recoveryPhrase(PASSWORD)
  t.is(words.split(' ').length, 24, 'the phone keeps the phrase behind the password it joined with')
})

test('spec 002: two shells keep a linked folder in sync; link, links, trash, trash empty, unlink', { timeout: 150000 }, async (t) => {
  const b = (await bootstrap(t))[0]
  const flags = (name) => ['--dir', tmpDir(t, name), '--name', name, '--bootstrap', `${b.host}:${b.port}`]
  const pcFlags = flags('pc')
  const laptopFlags = flags('laptop')
  const disk = writeTree(tmpDir(t, 'disk'), { 'photos/a.jpg': 'aaaa', 'photos/b.jpg': 'bbbb' })
  const there = path.join(tmpDir(t, 'laptop-disk'), 'photos')
  const env = { ...withPassword, SWARMFS_MIN_FREE: '0' } // the test disk may be nearly full

  t.ok((await done(t, ['init', ...pcFlags], env)).startsWith('device '))
  const floor = { SWARMFS_MIN_FREE: '0' }
  const pc = shell(t, pcFlags, floor)
  await pc.ready()
  await pc.do('create "My files"')
  const code = (await pc.do('pair\n' + PASSWORD)).split(/\r?\n/)[1].trim()
  await done(t, ['join', code, ...laptopFlags], env)
  await pc.until(/added laptop/)
  const photos = rows(await pc.do(`add "My files" "${path.join(disk, 'photos')}"`))[0]

  const laptop = shell(t, laptopFlags, floor)
  await laptop.ready()
  t.ok(await eventually(async () => rows(await laptop.do(`ls "My files" ${photos[0]}`)).length === 2, 20000), 'the laptop sees photos/')
  t.ok((await laptop.do(`link "My files" ${photos[0]} "${there}"`)).includes('linked'), 'link')
  t.ok(await laptop.until(/^fetched\s+.*b\.jpg/m), 'a line per fetched file')
  t.ok(await eventually(() => fs.existsSync(path.join(there, 'b.jpg')), 10000), 'on disk')
  t.ok((await laptop.do('links')).includes(there), 'links')

  fs.writeFileSync(path.join(disk, 'photos', 'new.jpg'), 'new on the PC')
  t.ok(await laptop.until(/^fetched\s+.*new\.jpg/m), 'a file written on the PC: fetched on the laptop, said')
  t.is(fs.readFileSync(path.join(there, 'new.jpg'), 'utf8'), 'new on the PC')

  fs.rmSync(path.join(disk, 'photos', 'a.jpg'))
  t.ok(await laptop.until(/^trashed\s+.*a\.jpg/m), 'a file deleted on the PC: trashed on the laptop, said')
  t.ok(rows(await laptop.do('trash')).some((r) => r[1] === 'a.jpg'), 'trash lists it')
  const kept = await laptop.do('trash empty\nno')
  t.ok(kept.includes('delete 1 files'), 'trash empty asks, saying how much')
  t.ok(kept.includes('kept'), '"no" keeps it')
  t.ok(rows(await laptop.do('trash')).some((r) => r[1] === 'a.jpg'), 'still there')
  t.ok((await laptop.do('trash empty\nyes')).includes('deleted 1 files'), '"yes" empties it')
  t.ok((await laptop.do('trash')).includes('the trash is empty'))

  t.ok((await laptop.do(`unlink "${there}"`)).includes('unlinked'), 'unlink')
  laptop.stdin.write('quit\n')
  t.is(await laptop.exit(), 0)

  // a one-shot command doesn't sync
  fs.writeFileSync(path.join(disk, 'photos', 'later.jpg'), 'later')
  await new Promise((resolve) => setTimeout(resolve, 3000))
  await done(t, ['ls', 'My files', ...laptopFlags], env)
  t.absent(fs.existsSync(path.join(there, 'later.jpg')), 'one-shot ls fetched nothing')
  pc.stdin.write('quit\n')
  t.is(await pc.exit(), 0)
})

// Every file under `dir`.
function files (dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)])
}

// Tab-separated entry lines (Bare on Windows ends lines with \r\n).
const rows = (stdout) => stdout.split(/\r?\n/).filter((l) => l.includes('\t')).map((l) => l.split('\t'))

// Runs a one-shot command; its stdout once it exited cleanly.
async function done (t, args, env) {
  const child = run(t, args, 'ignore', env)
  const code = await child.exit()
  t.is(code, 0, `swarmfs ${args[0]} exits 0${code ? ': ' + child.stdout() + child.stderr() : ''}`)
  return child.stdout()
}

// A shell: `do(line)` sends a command and resolves to what it printed, up to the next prompt.
function shell (t, args, env) {
  const child = run(t, args, 'pipe', env)
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

function run (t, args, stdin = 'ignore', env = {}) {
  // process.execPath is whichever runtime runs the tests, so Node and Bare both get covered.
  const child = spawn(process.execPath, [CLI, ...args], { stdio: [stdin, 'pipe', 'pipe'], env: { ...process.env, ...env } })
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
