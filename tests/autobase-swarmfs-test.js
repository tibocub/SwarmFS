/**
 * Minimal Autobase test - exact workshop pattern
 * 
 * Uses SINGLE topic (autobase.discoveryKey) for all connections.
 * Bootstrap key is passed via shared file (simulating CLI flag or saved key).
 * 
 * Flow:
 * 1. Device A creates autobase with null bootstrap, saves key to file
 * 2. Device B reads key from file, joins same autobase
 * 3. Both connect via autobase.discoveryKey
 * 4. Device A adds Device B as writer when it sees new writer
 * 5. Both devices register and see each other
 */

import Corestore from 'corestore'
import Autobase from 'autobase'
import HyperDB from 'hyperdb'
import Hyperswarm from 'hyperswarm'
import fs from 'fs'
import path from 'path'
import os from 'os'

import spec from '../src/userdb/spec/hyperdb/index.js'

const testDir = path.join(os.tmpdir(), 'swarmfs-test-' + Date.now())
fs.mkdirSync(testDir, { recursive: true })
const keyFile = path.join(testDir, 'autobase-key')

console.log('Test dir:', testDir)
console.log('============================================================')
console.log('TEST: Minimal Autobase (Workshop Pattern)')
console.log('============================================================')
console.log()

// HyperDB wrapper
class UserDB {
  constructor(core) {
    this.db = HyperDB.bee(core, spec, { autoUpdate: true, extension: false })
  }
  
  async ready() { await this.db.ready() }
  async close() { await this.db.close() }
  
  async registerDevice(deviceId, deviceName) {
    const tx = this.db.transaction()
    await tx.insert('@userdb/device', { 
      deviceId, 
      name: deviceName, 
      userIdentity: 'test-user',
      publicKey: Buffer.alloc(32).fill(1),
      proof: Buffer.alloc(64).fill(2),
      addedAt: Date.now()
    })
    await tx.flush()
  }
  
  async getDevices() {
    const devices = []
    for await (const d of this.db.find('@userdb/device', {})) {
      devices.push(d)
    }
    return devices
  }
}

// Apply function
async function apply(nodes, view, base) {
  for (const node of nodes) {
    const value = JSON.parse(node.value.toString('utf8'))
    
    if (value.type === 'add-writer') {
      await base.addWriter(Buffer.from(value.key, 'hex'), { indexer: true })
    }
    
    if (value.type === 'register-device') {
      await view.registerDevice(value.deviceId, value.deviceName)
    }
  }
}

// Device class
class Device {
  constructor(name, storagePath) {
    this.name = name
    this.store = new Corestore(storagePath)
    this.swarm = null
    this.autobase = null
    this.userdb = null
  }
  
  async init() {
    await this.store.ready()
    
    // Workshop pattern: single swarm with keypair from corestore
    this.swarm = new Hyperswarm({
      keyPair: await this.store.createKeyPair('swarm-keypair')
    })
    
    // Workshop pattern: replicate on ALL connections
    this.swarm.on('connection', (conn, info) => {
      this.store.replicate(conn)
      console.log(`[${this.name}] Peer connected`)
    })
  }
  
  async createAutobase(bootstrapKey = null) {
    const openView = (store) => new UserDB(store.get('userdb-view'))
    const closeView = async (view) => await view.close()
    
    this.autobase = new Autobase(this.store, bootstrapKey, {
      open: openView,
      apply,
      close: closeView,
      ackInterval: 100
    })
    
    await this.autobase.ready()
    this.userdb = this.autobase.view
    
    console.log(`[${this.name}] Autobase ready`)
    console.log(`[${this.name}]   key: ${this.autobase.key.toString('hex').slice(0, 16)}...`)
    console.log(`[${this.name}]   local.key: ${this.autobase.local.key.toString('hex').slice(0, 16)}...`)
    console.log(`[${this.name}]   isIndexer: ${this.autobase.isIndexer}`)
  }
  
  async joinAutobaseTopic() {
    if (!this.autobase) return
    // Workshop pattern: join autobase.discoveryKey
    await this.swarm.join(this.autobase.discoveryKey, { server: true, client: true }).flushed()
    console.log(`[${this.name}] Joined autobase topic`)
  }
  
  async addWriter(key) {
    const op = Buffer.from(JSON.stringify({
      type: 'add-writer',
      key: key.toString('hex')
    }), 'utf8')
    await this.autobase.append(op)
    console.log(`[${this.name}] Added writer: ${key.toString('hex').slice(0, 16)}...`)
  }
  
  async registerDevice() {
    const deviceId = this.autobase.local.key.toString('hex')
    const op = Buffer.from(JSON.stringify({
      type: 'register-device',
      deviceId,
      deviceName: this.name
    }), 'utf8')
    await this.autobase.append(op)
    console.log(`[${this.name}] Registered device: ${this.name}`)
  }
  
  async sync() {
    await this.autobase.update()
    await this.userdb.ready()
  }
  
  async getDevices() {
    return this.userdb.getDevices()
  }
  
  async close() {
    if (this.swarm) await this.swarm.destroy()
    if (this.autobase) await this.autobase.close()
  }
}

// Main test
async function run() {
  // --- Device A (first device) ---
  console.log('--- Device A ---')
  const deviceA = new Device('DeviceA', path.join(testDir, 'device-a'))
  await deviceA.init()
  await deviceA.createAutobase(null) // null = new autobase, becomes indexer
  await deviceA.joinAutobaseTopic()
  
  // Save key for Device B
  fs.writeFileSync(keyFile, deviceA.autobase.key.toString('hex'))
  console.log(`[DeviceA] Saved key to file`)
  
  // Add self as writer and register
  await deviceA.addWriter(deviceA.autobase.local.key)
  await deviceA.registerDevice()
  await deviceA.sync()
  
  console.log()
  
  // --- Device B (second device) ---
  console.log('--- Device B ---')
  const deviceB = new Device('DeviceB', path.join(testDir, 'device-b'))
  await deviceB.init()
  
  // Read key from file
  const keyHex = fs.readFileSync(keyFile, 'utf8')
  const bootstrapKey = Buffer.from(keyHex, 'hex')
  console.log(`[DeviceB] Read key from file: ${keyHex.slice(0, 16)}...`)
  
  await deviceB.createAutobase(bootstrapKey)
  await deviceB.joinAutobaseTopic()
  
  // Write our local key to file so Device A can add us
  const deviceBKeyFile = path.join(testDir, 'device-b-key')
  fs.writeFileSync(deviceBKeyFile, deviceB.autobase.local.key.toString('hex'))
  console.log(`[DeviceB] Wrote local key to file`)
  
  // Wait for connection
  await new Promise(r => setTimeout(r, 2000))
  
  // Check if writable
  console.log(`[DeviceB] writable: ${deviceB.autobase.writable}`)
  
  // --- Device A adds Device B as writer ---
  console.log()
  console.log('--- Device A adding Device B as writer ---')
  
  // Read Device B's local key
  const deviceBKeyHex = fs.readFileSync(deviceBKeyFile, 'utf8')
  const deviceBKey = Buffer.from(deviceBKeyHex, 'hex')
  console.log(`[DeviceA] Read Device B key: ${deviceBKeyHex.slice(0, 16)}...`)
  
  // Add Device B as writer
  await deviceA.addWriter(deviceBKey)
  await deviceA.sync()
  
  // --- Device B waits to become writable ---
  console.log()
  console.log('--- Device B waiting to be writable ---')
  for (let i = 0; i < 20; i++) {
    await deviceB.sync()
    if (deviceB.autobase.writable) {
      console.log(`[DeviceB] Now writable!`)
      break
    }
    await new Promise(r => setTimeout(r, 500))
  }
  
  if (deviceB.autobase.writable) {
    await deviceB.registerDevice()
    await deviceB.sync()
  } else {
    console.log(`[DeviceB] ERROR: Not writable after timeout`)
  }
  
  console.log()
  
  // --- Final sync ---
  console.log('--- Final sync ---')
  await deviceA.sync()
  await deviceB.sync()
  await new Promise(r => setTimeout(r, 1000))
  
  console.log()
  console.log('--- Results ---')
  console.log()
  
  const devicesA = await deviceA.getDevices()
  const devicesB = await deviceB.getDevices()
  
  console.log('[DeviceA] devices:')
  for (const d of devicesA) {
    console.log(`  - ${d.name}`)
  }
  
  console.log()
  console.log('[DeviceB] devices:')
  for (const d of devicesB) {
    console.log(`  - ${d.name}`)
  }
  
  console.log()
  
  // Verify
  const namesA = devicesA.map(d => d.name).sort()
  const namesB = devicesB.map(d => d.name).sort()
  const expected = ['DeviceA', 'DeviceB']
  
  if (JSON.stringify(namesA) === JSON.stringify(expected) && 
      JSON.stringify(namesB) === JSON.stringify(expected)) {
    console.log('TEST: ✅ PASSED')
  } else {
    console.log('TEST: ❌ FAILED')
    console.log(`  DeviceA: ${JSON.stringify(namesA)}`)
    console.log(`  DeviceB: ${JSON.stringify(namesB)}`)
  }
  
  // Cleanup
  await deviceA.close()
  await deviceB.close()
  fs.rmSync(testDir, { recursive: true, force: true })
}

run().catch(err => {
  console.error('Test error:', err)
  process.exit(1)
})
