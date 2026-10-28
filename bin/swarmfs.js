#!/usr/bin/env node
// The CLI: each command opens the instance folder, does one thing over the library, closes.
// `serve` and `pair` stay online. Print with console.log: on Bare, process.stdout.write
// never reaches a piped stdout (swarmwire's lesson).

import os from 'os'
import path from 'path'
import process from 'process'
import { SwarmFS } from '../index.js'

const USAGE = `usage: swarmfs <command> [--dir <folder>] [--name <device name>] [--bootstrap <host:port>]
  init                       make this device (also done by any first command)
  create <name>              a files space
  add <space> <path>         a file or folder, in place
  ls <space> [folder]        entries: id, kind, name, size, holders
  get <space> <id> <path>    fetch a file to <path>
  rescan                     follow the disk
  devices                    this person's devices
  pair                       print a code for a new device; ends once it joined
  join <code>                make this folder a new device of that person
  serve                      stay online for your other devices (Ctrl+C to stop)
<space>: a name or a key. --dir: default ~/.swarmfs. --name: this device's name when made
(default: the host name). --bootstrap: a private DHT (tests).`

const WAIT = 15000 // how long a command waits for the person's other devices to connect

const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args.splice(i, 2)[1]
}
const dir = option('--dir') || path.join(os.homedir(), '.swarmfs')
const name = option('--name') || os.hostname()
const node = option('--bootstrap')
const [command, ...rest] = args

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
      page = await d.list(folder, { after: last })
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

  devices: async (sfs) => {
    for (const d of await sfs.devices()) {
      console.log(`${d.publicKey}\t${d.name}\t${d.online ? 'online' : 'offline'}${d.current ? '\t(this device)' : ''}`)
    }
  },

  pair: async (sfs) => {
    const { code, added } = await sfs.addDevice()
    console.log(code)
    console.log('waiting for the new device to join (10 min)...')
    const device = await added
    console.log(device ? `added ${device.name}` : 'expired')
  },

  serve: async (sfs) => {
    console.log(`serving ${sfs.device} (Ctrl+C to stop)`)
    await new Promise((resolve) => process.once('SIGINT', resolve))
  }
}

if (!commands[command]) {
  console.log(USAGE)
  process.exitCode = command ? 1 : 0
} else {
  const [host, port] = node ? node.split(':') : []
  let sfs = null
  try {
    sfs = await SwarmFS.open(dir, {
      deviceName: name,
      joinCode: command === 'join' ? rest[0] : undefined,
      bootstrap: node ? [{ host, port: Number(port) }] : undefined
    })
    await commands[command](sfs, ...rest)
  } catch (err) {
    console.error(err.code ? `${err.code}: ${err.message}` : err)
    process.exitCode = 1
  } finally {
    if (sfs) await sfs.close()
  }
}

// A space by name or key; just joined, its name may arrive a moment after the open.
async function drive (sfs, nameOrKey) {
  const find = () => sfs.spaces().find((s) => s.key === nameOrKey || s.name === nameOrKey)
  await until(sfs, 'spaces', find)
  const s = find()
  if (!s) throw Object.assign(new Error(`no space ${nameOrKey}`), { code: 'NOT_FOUND' })
  return sfs.space(s.key)
}

// Holders show online only once connected: wait for one of the person's other devices, if any.
async function online (sfs, d) {
  if ((await sfs.devices()).length > 1) await until(d.space, 'peers', () => d.space.peers().length > 0)
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

// One entry, tab-separated: id, kind, name, size, holders.
function line (e) {
  const holders = e.holders.map((h) => `${h.name} (${h.online ? 'online' : 'offline'})`).join(', ')
  return e.kind === 'folder' ? `${e.id}\tfolder\t${e.name}` : `${e.id}\tfile\t${e.name}\t${e.size}\t${holders}`
}
