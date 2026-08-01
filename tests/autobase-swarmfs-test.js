/**
 * Autobase test with explicit roles and key exchange
 * 
 * Flow:
 * 1. Indexer creates autobase with null bootstrap (random key)
 * 2. Both join a SHARED discovery topic (derived from mnemonic)
 * 3. Indexer broadcasts its autobase.key on the shared topic
 * 4. Non-indexer receives key, creates autobase with that key
 * 5. Non-indexer sends writer request
 * 6. Indexer adds writer
 * 7. Both start replication on the shared connection
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

const MNEMONIC = 'test-user-mnemonic-phrase'

console.log('Test dir:', testDir)
console.log('============================================================')
console.log('TEST: Autobase with Explicit Roles + Key Exchange')
console.log('============================================================')
console.log()

// Derive shared discovery topic from mnemonic
function deriveDiscoveryTopic(mnemonic) {
  const namespace = Buffer.from('swarmfs-user-discovery-v1')
  return crypto.hash(Buffer.concat([namespace, Buffer.from(mnemonic)]))
}

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
  constructor(name, storagePath, isIndexer) {
    this.name = name
    this.isIndexer = isIndexer
    this.store = new Corestore(storagePath)
    this.swarm = null
    this.autobase = null
    this.userdb = null
    this.writersAdded = new Set()
    this.receivedKey = null
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
  
  async joinDiscoveryTopic(topic) {
    await this.swarm.join(topic, { server: true, client: true }).flushed()
    console.log(`[${this.name}] Joined discovery topic: ${topic.toString('hex').slice(0, 16)}...`)
  }
  
  async addWriter(key) {
    const keyHex = key.toString('hex')
    if (this.writersAdded.has(keyHex)) {
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
  const discoveryTopic = deriveDiscoveryTopic(MNEMONIC)
  
  // ========================================
  // DEVICE A (Indexer)
  // ========================================
  console.log('--- Device A (Indexer) ---')
  const deviceA = new Device('DeviceA', path.join(testDir, 'device-a'), true)
  await deviceA.init()
  await deviceA.createAutobase(null) // null = new autobase, becomes indexer
  
  // Setup connection handler BEFORE joining topic
  deviceA.swarm.on('connection', (conn, info) => {
    const peerId = (conn.remotePublicKey || info.publicKey).toString('hex')
    console.log(`[DeviceA] Peer connected: ${peerId.slice(0, 16)}...`)
    
    let buffer = ''
    let keySent = false
    
    const onData = (data) => {
      buffer += data.toString()
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        
        if (!line) continue
        
        try {
          const msg = JSON.parse(line)
          
          // Send autobase key if requested
          if (msg.type === 'get-key' && !keySent) {
            const keyMsg = JSON.stringify({ 
              type: 'autobase-key', 
              key: deviceA.autobase.key.toString('hex') 
            }) + '\n'
            conn.write(keyMsg)
            keySent = true
            console.log(`[DeviceA] Sent autobase key: ${deviceA.autobase.key.toString('hex').slice(0, 16)}...`)
          }
          
          // Handle writer request
          if (msg.type === 'writer-request' && msg.key) {
            console.log(`[DeviceA] Writer request from: ${msg.key.slice(0, 16)}...`)
            
            deviceA.addWriter(Buffer.from(msg.key, 'hex')).then(() => {
              conn.write(JSON.stringify({ type: 'writer-added' }) + '\n')
              console.log(`[DeviceA] Sent writer-added confirmation`)
              
              // Start replication
              conn.removeListener('data', onData)
              deviceA.store.replicate(conn)
              console.log(`[DeviceA] Replication started`)
            })
          }
        } catch {
          // Not JSON
        }
      }
    }
    
    conn.on('data', onData)
  })
  
  await deviceA.joinDiscoveryTopic(discoveryTopic)
  
  // Add self as writer and register
  await deviceA.addWriter(deviceA.autobase.local.key)
  await deviceA.registerDevice()
  await deviceA.sync()
  
  console.log()
  
  // ========================================
  // DEVICE B (Non-Indexer)
  // ========================================
  console.log('--- Device B (Non-Indexer) ---')
  const deviceB = new Device('DeviceB', path.join(testDir, 'device-b'), false)
  await deviceB.init()
  
  let autobaseKeyReceived = null
  let writerAddedReceived = false
  
  // Setup connection handler BEFORE joining topic
  deviceB.swarm.on('connection', (conn, info) => {
    const peerId = (conn.remotePublicKey || info.publicKey).toString('hex')
    console.log(`[DeviceB] Peer connected: ${peerId.slice(0, 16)}...`)
    
    let buffer = ''
    
    const onData = (data) => {
      buffer += data.toString()
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        
        if (!line) continue
        
        try {
          const msg = JSON.parse(line)
          
          // Receive autobase key
          if (msg.type === 'autobase-key' && msg.key) {
            autobaseKeyReceived = Buffer.from(msg.key, 'hex')
            console.log(`[DeviceB] Received autobase key: ${msg.key.slice(0, 16)}...`)
          }
          
          // Receive writer-added confirmation
          if (msg.type === 'writer-added') {
            writerAddedReceived = true
            console.log(`[DeviceB] Writer-added confirmation received`)
            
            // Start replication
            conn.removeListener('data', onData)
            deviceB.store.replicate(conn)
            console.log(`[DeviceB] Replication started`)
          }
        } catch {
          // Not JSON
        }
      }
    }
    
    conn.on('data', onData)
    
    // Request autobase key immediately
    conn.write(JSON.stringify({ type: 'get-key' }) + '\n')
    console.log(`[DeviceB] Sent get-key request`)
  })
  
  await deviceB.joinDiscoveryTopic(discoveryTopic)
  
  // Wait for autobase key
  console.log(`[DeviceB] Waiting for autobase key...`)
  for (let i = 0; i < 20; i++) {
    if (autobaseKeyReceived) break
    await new Promise(r => setTimeout(r, 500))
  }
  
  if (!autobaseKeyReceived) {
    console.log(`[DeviceB] ERROR: No autobase key received`)
    console.log('TEST: ❌ FAILED')
    return
  }
  
  // Create autobase with received key
  console.log(`[DeviceB] Creating autobase with received key...`)
  await deviceB.createAutobase(autobaseKeyReceived)
  
  // Send writer request to indexer (need to reconnect or use existing connection)
  // For simplicity, we'll wait for the indexer to process our request
  // The connection handler already sent get-key, now we send writer-request
  
  // Find the connection and send writer request
  const connections = deviceB.swarm.connections
  if (connections.size > 0) {
    const conn = connections.values().next().value
    conn.write(JSON.stringify({ 
      type: 'writer-request', 
      key: deviceB.autobase.local.key.toString('hex') 
    }) + '\n')
    console.log(`[DeviceB] Sent writer request: ${deviceB.autobase.local.key.toString('hex').slice(0, 16)}...`)
  }
  
  // Wait to become writable
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
    await deviceB.registerDevice()
    await deviceB.sync()
  }
  
  console.log()
  
  // ========================================
  // FINAL SYNC
  // ========================================
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
  try {
    fs.rmSync(testDir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors on Windows
  }
}

run().catch(err => {
  console.error('Test error:', err)
  process.exit(1)
})
