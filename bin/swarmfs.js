#!/usr/bin/env node
// The CLI, a trial tool over the library. `swarmfs` alone (or `swarmfs shell`) opens the
// instance, stays online and reads commands from stdin, one per line. `init` and `join` are
// one-shot and ask for the password that keeps the recovery phrase; the other commands also
// run one-shot (open, act, close), for scripts.
// Print with console.log: on Bare, process.stdout.write never reaches a piped stdout
// (swarmwire's lesson).

import fs from 'fs'
import os from 'os'
import path from 'path'
import process from 'process'
import { SwarmFS } from '../index.js'

const USAGE = `usage: swarmfs [command] [--dir <folder>] [--name <device name>] [--bootstrap <host:port>]
  (none), shell              stay online and read the commands below from stdin, one per line
  init                       make this device; asks for a password
  join <code>                make this folder a new device of that person; asks for a password
  create <name>              a files space
  add <space> <path>         a file or folder, in place
  ls <space> [folder]        entries: id, kind, name, size, holders
  get <space> <id> <path>    fetch a file to <path>
  rescan                     follow the disk
  link <space> <folder> <path>  sync a space folder (id from ls; the space's name for its
                             top) with a local folder, both ways (the shell keeps it in sync)
  unlink <path>              stop syncing it; files and entries stay
  links                      linked folders here
  confirm <path>             apply a mass delete a linked folder was paused for
  trash                      what syncing replaced or removed (kept until emptied)
  trash empty                delete it for good (asks first)
  devices                    this person's devices
  pair                       print a code for a new device (one-shot: ends once it joined);
                             asks for the password (once per shell)
  quit                       end the shell (also: end of input, Ctrl+C)
<space>: a name or a key, quoted if it has spaces. --dir: default ~/.swarmfs. --name: this
device's name when made (default: the host name). --bootstrap: a private DHT (tests).
The password keeps the recovery phrase sealed in the folder; typed hidden, or taken from
SWARMFS_PASSWORD (scripts, tests). Syncing leaves max(5 GB, 5 % of the disk) free;
SWARMFS_MIN_FREE (bytes) sets another floor.`

const WAIT = 15000 // how long a one-shot command waits for the person's other devices to connect

const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args.splice(i, 2)[1]
}
const dir = option('--dir') || path.join(os.homedir(), '.swarmfs')
const name = option('--name') || os.hostname()
const node = option('--bootstrap')
const [command = 'shell', ...rest] = args
const inShell = command === 'shell'
let pass = null // the password, once asked
let input = null // stdin's lines (nextLine), once read

const commands = {
  init: async (sfs) => console.log(`device ${sfs.device}`),
  join: async (sfs) => console.log(`device ${sfs.device}`), // the open did it

  create: async (sfs, name) => {
    const drive = await sfs.createSpace(name)
    console.log(`${drive.key}\t${drive.name}`)
  },

  add: async (sfs, space, file) => console.log(line(await (await drive(sfs, space)).add(file))),

  ls: async (sfs, space, folder) => {
    const d = await drive(sfs, space)
    await online(sfs, d)
    let page = { items: [] }
    do {
      const last = page.items.at(-1)
      page = await d.list(folder, { after: last, timeout: inShell ? 0 : WAIT }) // one-shot: waits for the other devices' entries
      for (const e of page.items) console.log(line(e))
    } while (page.items.length === 100)
    if (!page.complete) console.log('(incomplete: a device holding more of this space is not online)')
  },

  get: async (sfs, space, id, file) => {
    const d = await drive(sfs, space)
    await online(sfs, d)
    const { path, bytes } = await d.fetch(id, file)
    console.log(`${path}\t${bytes} bytes`)
  },

  rescan: (sfs) => sfs.rescan(),

  link: async (sfs, space, folder, local) => {
    const d = await drive(sfs, space)
    await d.link(folder === space || folder === d.key ? d.top : folder, local)
    console.log(`linked ${path.resolve(local)}`)
  },

  unlink: async (sfs, local) => {
    await sfs.unlink(local)
    console.log(`unlinked ${path.resolve(local)}`)
  },

  links: async (sfs) => {
    const names = new Map(sfs.spaces().map((s) => [s.key, s.name]))
    for (const l of await sfs.links()) console.log(`${l.path}\t${names.get(l.space) || l.space}${l.paused ? `\tpaused (${l.paused})` : ''}`)
  },

  confirm: async (sfs, local) => {
    await sfs.confirm(local)
    console.log(`removed what was deleted in ${path.resolve(local)}`)
  },

  trash: async (sfs, what) => {
    const items = await sfs.trash()
    if (what !== 'empty') {
      for (const i of items) console.log(`${i.folder}\t${i.path}\t${i.size}\t${new Date(i.trashed).toISOString()}`)
      if (!items.length) console.log('the trash is empty')
      return
    }
    const bytes = items.reduce((n, i) => n + i.size, 0)
    console.log(`delete ${items.length} files (${mb(bytes)}) for good? (yes/no)`)
    if ((await nextLine())?.trim() !== 'yes') return console.log('kept')
    const done = await sfs.emptyTrash()
    console.log(`deleted ${done.files} files (${mb(done.bytes)})`)
  },

  devices: async (sfs) => {
    for (const d of await sfs.devices()) {
      console.log(`${d.publicKey}\t${d.name}\t${d.online ? 'online' : 'offline'}${d.current ? '\t(this device)' : ''}`)
    }
  },

  pair: async (sfs) => {
    pass ??= await password('the one this device was made with')
    const { code, added } = await sfs.addDevice({ password: pass }).catch((err) => { pass = null; throw err })
    console.log(code)
    console.log('waiting for the new device to join (10 min)...')
    const joined = added.then((device) => console.log(device ? `added ${device.name}` : 'pairing code expired'))
    if (!inShell) await joined
  }
}

if (!inShell && !commands[command]) {
  console.log(USAGE)
  process.exitCode = 1
} else {
  const [host, port] = node ? node.split(':') : []
  let sfs = null
  try {
    const fresh = !(await fs.promises.readdir(dir).catch(() => [])).length
    const makes = command === 'init' || command === 'join'
    if (fresh && !makes) throw Object.assign(new Error(`no device in ${dir} yet: swarmfs init, or swarmfs join <code>`), { code: 'NO_DEVICE' })
    if (fresh) pass = await password('to keep the recovery phrase', { twice: true })
    sfs = await SwarmFS.open(dir, {
      password: pass ?? undefined,
      deviceName: name,
      joinCode: command === 'join' ? rest[0] : undefined,
      minFree: process.env.SWARMFS_MIN_FREE ? Number(process.env.SWARMFS_MIN_FREE) : undefined,
      bootstrap: node ? [{ host, port: Number(port) }] : undefined
    })
    if (inShell) await shell(sfs)
    else await commands[command](sfs, ...rest)
  } catch (err) {
    fail(err)
    process.exitCode = 1
  } finally {
    if (sfs) await sfs.close()
    if (input) process.stdin.destroy() // else Bare waits on it
  }
}

// Commands from stdin, one at a time, each followed by a `>` line (the prompt).
async function shell (sfs) {
  console.log(`device ${sfs.device} (${name}), online; "help" lists the commands`)
  sfs.on('sync', (e) => console.log(syncLine(e)))
  await sfs.sync() // linked folders kept in sync while the shell runs (spec 002)
  process.once('SIGINT', () => push('quit'))
  for (;;) {
    console.log('>')
    const typed = await nextLine()
    if (typed === null) break // end of input
    const [cmd, ...words] = (typed.match(/"[^"]*"|\S+/g) || []).map((w) => w.replace(/^"(.*)"$/, '$1'))
    if (cmd === 'quit') break
    if (!cmd) continue
    if (!commands[cmd] || cmd === 'init' || cmd === 'join') {
      console.log(cmd === 'help' ? USAGE : `${cmd}: not a shell command ("help" lists them; init and join are one-shot)`)
      continue
    }
    try {
      await commands[cmd](sfs, ...words)
    } catch (err) {
      fail(err)
    }
  }
}

// From SWARMFS_PASSWORD, else asked on stdin; typed in a terminal, it isn't shown (raw mode).
// `twice`: a new one, typed again to catch a typo (a terminal only).
async function password (why, { twice = false } = {}) {
  if (process.env.SWARMFS_PASSWORD) return process.env.SWARMFS_PASSWORD
  const tty = !!process.stdin.isTTY
  const ask = async (prompt) => {
    console.log(prompt)
    if (tty) process.stdin.setRawMode(true)
    try {
      return await nextLine()
    } finally {
      if (tty) process.stdin.setRawMode(false)
    }
  }
  const typed = await ask(`password (${why}):`)
  if (!typed) throw Object.assign(new Error('a password is needed (or SWARMFS_PASSWORD)'), { code: 'NO_PASSWORD' })
  if (twice && tty && (await ask('again:')) !== typed) throw Object.assign(new Error('the two passwords differ'), { code: 'NO_PASSWORD' })
  return typed
}

// stdin, line by line, read only once asked for. Raw mode (a password) sends each key:
// Enter is \r, Backspace \x7f, Ctrl+C \x03 (then: nothing typed).
function nextLine () {
  if (!input) {
    input = { lines: [], typed: '', cr: false, ended: false, wake: () => {} }
    process.stdin.on('data', (chunk) => {
      for (const c of String(chunk)) {
        if (c === '\n' && input.cr) { input.cr = false; continue } // the \n of \r\n
        input.cr = c === '\r'
        if (c === '\r' || c === '\n') push(input.typed)
        else if (c === '\x7f' || c === '\b') input.typed = input.typed.slice(0, -1)
        else if (c === '\x03') push('')
        else input.typed += c
      }
    })
    process.stdin.on('end', () => {
      if (input.typed) push(input.typed)
      input.ended = true
      input.wake()
    })
  }
  return new Promise(function next (resolve) {
    input.wake = () => {} // once per wait: a second line must not go to this one
    if (input.lines.length) return resolve(input.lines.shift())
    if (input.ended) return resolve(null)
    input.wake = () => next(resolve)
  })
}

function push (line) {
  input.lines.push(line)
  input.typed = ''
  input.wake()
}

function fail (err) {
  // shortcut: hypergraph's lock error has no code yet (requests H13); match its message until it does.
  if (/could not be locked/.test(err.message)) {
    console.error(`IN_USE: ${dir} is in use by a swarmfs shell (or another swarmfs): type the command there, or quit it first`)
  } else {
    console.error(err.code ? `${err.code}: ${err.message}` : err)
  }
}

// A space by name or key; just joined, its name may arrive a moment after the open
// (one-shot: waits for it; the shell: ask again).
async function drive (sfs, nameOrKey) {
  const find = () => sfs.spaces().find((s) => s.key === nameOrKey || s.name === nameOrKey)
  if (!inShell) await until(sfs, 'spaces', find)
  const s = find()
  if (!s) throw Object.assign(new Error(`no space ${nameOrKey}`), { code: 'NOT_FOUND' })
  return sfs.space(s.key)
}

// Holders show online only once connected: one-shot, wait for one of the person's other
// devices, if any. The shell is online all along: holders show as they are now.
async function online (sfs, d) {
  if (!inShell && (await sfs.devices()).length > 1) await until(d.space, 'peers', () => d.space.peers().length > 0)
}

// Resolves once check() is true (checked now and on each `event`), or after WAIT.
function until (emitter, event, check) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      emitter.off(event, test)
      resolve()
    }
    const test = () => { if (check()) finish() }
    const timer = setTimeout(finish, WAIT)
    emitter.on(event, test)
    test()
  })
}

// One thing sync did (contracts/api.md), as a line: never tab-separated, unlike entries.
function syncLine (e) {
  const word = e.action.padEnd(9)
  if (e.action === 'paused' && e.reason === 'missing') return `${word} ${e.path} (not found: unplugged?)`
  if (e.action === 'paused') return `${word} ${e.path}: ${e.count} files deleted at once; "confirm ${e.path}" removes them everywhere, or restore them`
  if (e.action === 'low-space') return `${word} ${e.path}: ${gb(e.free)} free, floor ${gb(e.floor)}; fetching stopped`
  if (e.action === 'skipped') return `${word} ${e.path} (name not valid on this disk)`
  if (e.action === 'error') return `${word} ${e.path || ''}: ${e.reason}`
  return e.to ? `${word} ${e.path} -> ${e.to}` : `${word} ${e.path}`
}

// declarations, not consts: the shell runs (top-level await) before the end of this file is reached
function gb (n) { return `${(n / 1e9).toFixed(1)} GB` }
function mb (n) { return `${(n / 1e6).toFixed(1)} MB` }

// One entry, tab-separated: id, kind, name, size, holders.
function line (e) {
  const holders = e.holders.map((h) => `${h.name} (${h.online ? 'online' : 'offline'})`).join(', ')
  return e.kind === 'folder' ? `${e.id}\tfolder\t${e.name}` : `${e.id}\tfile\t${e.name}\t${e.size}\t${holders}`
}
