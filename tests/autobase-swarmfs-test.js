/**
 * Autobase test with automatic writer discovery
 * 
 * Key insight: The indexer needs to learn new peers' local.key to add them as writers.
 * 
 * Approach: Simple handshake BEFORE replication starts
 * 1. New peer connects and immediately sends: { type: 'writer-request', key: localKey }
 * 2. Indexer receives, adds writer, then sends: { type: 'writer-added' }
 * 3. Both sides THEN start store.replicate(conn)
 * 
 * This avoids mixing JSON with binary replication data.
 */

import Corestore from 'corestore'
import Autobase from 'autobase'
import HyperDB from 'hyperdb'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'

import spec from '../src/userdb/spec/hyperdb/index.js'

const testDir = path.join(os.tmpdir(), 'swarmfs-test-' + Date.now())
fs.mkdirSync(testDir, { recursive: true })
const keyFile = path.join(testDir, 'autobase-key')

console.log('Test dir:', testDir)
console.log('============================================================')
console.log('TEST: Autobase with Automatic Writer Discovery')
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
    this.writersAdded = new Set() // Track writers we've added
  }
  
  async init() {
    await this.store.ready()
    
    this.swarm = new Hyperswarm({
      keyPair: await this.store.createKeyPair('swarm-keypair')
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
    
    const discoveryKey = this.autobase.discoveryKey
    await this.swarm.join(discoveryKey, { server: true, client: true }).flushed()
    console.log(`[${this.name}] Joined autobase topic`)
  }
  
  async addWriter(key) {
    const keyHex = key.toString('hex')
    if (this.writersAdded.has(keyHex)) {
      console.log(`[${this.name}] Writer already added: ${keyHex.slice(0, 16)}...`)
      return
    }
    
    const op = Buffer.from(JSON.stringify({
      type: 'add-writer',
      key: keyHex
    }), 'utf8')
    await this.autobase.append(op)
    this.writersAdded.add(keyHex)
    console.log(`[${this.name}] Added writer: ${keyHex.slice(0, 16)}...`)
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
  // --- Device A (first device, becomes indexer) ---
  console.log('--- Device A ---')
  const deviceA = new Device('DeviceA', path.join(testDir, 'device-a'))
  await deviceA.init()
  await deviceA.createAutobase(null) // null = new autobase, becomes indexer
  await deviceA.joinAutobaseTopic()
  
  // Save key for Device B
  fs.writeFileSync(keyFile, deviceA.autobase.key.toString('hex'))
  console.log(`[DeviceA] Saved key to file`)
  
  // Add self as writer
  await deviceA.addWriter(deviceA.autobase.local.key)
  await deviceA.registerDevice()
  await deviceA.sync()
  
  // Setup connection handler with automatic writer discovery
  deviceA.swarm.on('connection', (conn, info) => {
    const peerId = (conn.remotePublicKey || info.publicKey).toString('hex')
    console.log(`[DeviceA] Peer connected: ${peerId.slice(0, 16)}...`)
    
    // Indexer: wait for writer request, then start replication
    let handshakeDone = false
    let buffer = ''
    
    const onData = (data) => {
      if (handshakeDone) return
      
      buffer += data.toString()
      const idx = buffer.indexOf('\n')
      
      if (idx !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        
        if (line) {
          try {
            const msg = JSON.parse(line)
            
            if (msg.type === 'writer-request' && msg.key) {
              console.log(`[DeviceA] Writer request from: ${msg.key.slice(0, 16)}...`)
              
              // Add writer
              deviceA.addWriter(Buffer.from(msg.key, 'hex')).then(() => {
                // Send confirmation
                conn.write(JSON.stringify({ type: 'writer-added' }) + '\n')
                console.log(`[DeviceA] Sent writer-added confirmation`)
                
                // Now start replication
                handshakeDone = true
                conn.removeListener('data', onData)
                deviceA.store.replicate(conn)
                console.log(`[DeviceA] Replication started`)
              }).catch(err => {
                console.error(`[DeviceA] Failed to add writer: ${err.message}`)
              })
            }
          } catch {
            // Not JSON, ignore
          }
        }
      }
    }
    
    conn.on('data', onData)
  })
  
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
  
  // Setup connection handler BEFORE joining topic
  deviceB.swarm.on('connection', (conn, info) => {
    const peerId = (conn.remotePublicKey || info.publicKey).toString('hex')
    console.log(`[DeviceB] Peer connected: ${peerId.slice(0, 16)}...`)
    
    // Non-indexer: send writer request, wait for confirmation, then start replication
    let handshakeDone = false
    let buffer = ''
    
    // Send writer request immediately
    const localKey = deviceB.autobase.local.key.toString('hex')
    conn.write(JSON.stringify({ type: 'writer-request', key: localKey }) + '\n')
    console.log(`[DeviceB] Sent writer request: ${localKey.slice(0, 16)}...`)
    
    const onData = (data) => {
      if (handshakeDone) return
      
      buffer += data.toString()
      const idx = buffer.indexOf('\n')
      
      if (idx !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        
        if (line) {
          try {
            const msg = JSON.parse(line)
            
            if (msg.type === 'writer-added') {
              console.log(`[DeviceB] Writer added confirmation received`)
              
              // Now start replication
              handshakeDone = true
              conn.removeListener('data', onData)
              deviceB.store.replicate(conn)
              console.log(`[DeviceB] Replication started`)
            }
          } catch {
            // Not JSON, ignore
          }
        }
      }
    }
    
    conn.on('data', onData)
  })
  
  // NOW join the topic
  await deviceB.joinAutobaseTopic()
  
  // Wait for connection and writer addition
  console.log(`[DeviceB] Waiting to become writable...`)
  for (let i = 0; i < 30; i++) {
    await deviceB.sync()
    if (deviceB.autobase.writable) {
      console.log(`[DeviceB] Now writable!`)
      break
    }
    await new Promise(r => setTimeout(r, 500))
  }
  
  if (!deviceB.autobase.writable) {
    console.log(`[DeviceB] ERROR: Not writable after timeout`)
  } else {
    // Register device
    await deviceB.registerDevice()
    await deviceB.sync()
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
