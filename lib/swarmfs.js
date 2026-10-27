// SwarmFS: one Hypergraph instance; its spaces are files spaces (Drives).

import hypergraph from 'hypergraph/next'
import { types, rules } from './types.js'
import { Drive } from './drive.js'
import { SwarmFSError } from './errors.js'
import { rescan } from './holdings.js'

const { Hypergraph } = hypergraph

export class SwarmFS {
  constructor (hg) {
    this.hg = hg
    this._drives = new Map()
  }

  static async open (dir, { password, joinCode, joinTimeout, deviceName, bootstrap, readTimeout } = {}) {
    const hg = await Hypergraph.open(dir, { types, rules, password, joinCode, joinTimeout, deviceName, bootstrap, readTimeout })
    const sfs = new SwarmFS(hg)
    await sfs.rescan() // before connecting: writes don't wait for peers
    await hg.connectToSwarm()
    return sfs
  }

  get device () {
    return this.hg.device.publicKey
  }

  addDevice ({ password } = {}) {
    return this.hg.addDevice({ password })
  }

  // Online: connected to this device in the personal space (only the person's devices meet there).
  async devices () {
    const online = new Set(this.hg.personal.peers().map((p) => p.device))
    return (await this.hg.devices()).map((d) => ({ ...d, online: d.current || online.has(d.publicKey) }))
  }

  // 'spaces': a space appeared or left, also on another device of the person.
  on (event, fn) {
    this.hg.on(event, fn)
    return this
  }

  off (event, fn) {
    this.hg.off(event, fn)
    return this
  }

  async createSpace (name) {
    const space = await this.hg.createSpace({ name, private: true })
    return this.space(space.key)
  }

  spaces () {
    return this.hg.spaces().map(({ key, name }) => ({ key, name }))
  }

  space (key) {
    let drive = this._drives.get(key)
    if (!drive) {
      let space
      try {
        space = this.hg.space(key)
      } catch (err) {
        throw err.code === 'NOT_FOUND' ? new SwarmFSError('NOT_FOUND', `no space ${key}`) : err
      }
      drive = new Drive(this, space)
      this._drives.set(key, drive)
    }
    return drive
  }

  // Follow the disk: what this device added and holds (data-model.md, state transitions).
  rescan () {
    return rescan(this.hg)
  }

  close () {
    return this.hg.close()
  }
}
