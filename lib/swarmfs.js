// SwarmFS: one Hypergraph instance; its spaces are files spaces (Drives).

import hypergraph from 'hypergraph/next'
import { types, rules } from './types.js'
import { Drive } from './drive.js'
import { SwarmFSError } from './errors.js'

const { Hypergraph } = hypergraph

export class SwarmFS {
  constructor (hg) {
    this.hg = hg
    this._drives = new Map()
  }

  static async open (dir, { password, joinCode, deviceName, bootstrap } = {}) {
    const hg = await Hypergraph.open(dir, { types, rules, password, joinCode, deviceName, bootstrap })
    const sfs = new SwarmFS(hg)
    await hg.connectToSwarm()
    return sfs
  }

  get device () {
    return this.hg.device.publicKey
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

  close () {
    return this.hg.close()
  }
}
