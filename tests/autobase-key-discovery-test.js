/**
 * Test: Key discovery pattern for multi-device autobase
 * 
 * Pattern:
 * 1. Device A creates autobase with bootstrap=null → becomes indexer
 * 2. Device A broadcasts its autobase key on discovery topic (derived from identity)
 * 3. Device B joins discovery topic, receives key, joins autobase
 * 4. Both devices can now replicate
 * 
 * Run: node tests/autobase-key-discovery-test.js
 */

import Corestore from 'corestore'
import Autobase from 'autobase'
import HyperDB from 'hyperdb'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Import the actual schema
import spec from '../src/userdb/spec/hyperdb/index.js'

const testDir = path.join(os.tmpdir(), 'autobase-key-disc-test-' + Date.now())
fs.mkdirSync(testDir, { recursive: true })

console.log('Test dir:', testDir)

// Db class
class Db {
  constructor(core) {
    this.db = HyperDB.bee(core, spec, { autoUpdate: true, extension: false })
  }
  async ready() { await this.db.ready() }
  async close() { await this.db.close() }
  
  async putDevice(entry) {
    const tx = this.db.transaction()
    await tx.insert('@userdb/device', entry)
    await tx.flush()
  }
  
  async *findDevices() {
    for await (const d of this.db.find('@userdb/device', {})) {
      yield d
    }
  }
}

// Discovery topic (derived from identity - same for all devices)
const discoveryTopic = crypto.hash(Buffer.from('user-identity-derivation'))

async function test() {
  console.log('\n' + '='.repeat(60))
  console.log('TEST: Key Discovery Pattern')
  console.log('='.repeat(60))
  console.log(`Discovery topic: ${discoveryTopic.toString('hex').slice(0, 16)}...`)
  
  // =========================================================================
  // DEVICE A: Creates new autobase
  // =========================================================================
  console.log('\n--- Device A (first device) ---')
  
  const storeA = new Corestore(path.join(testDir, 'deviceA'))
  await storeA.ready()
  
  // No stored key - create new autobase
  const autobaseA = new Autobase(storeA, null, {
    autostart: true,
    optimistic: true,
    valueEncoding: 'json',
    open: (store) => new Db(store.get('view')),
    apply: async (nodes, view, base) => {
      for (const node of nodes) {
        const value = node.value
        if (value && value.add) {
          console.log(`[A] Adding writer: ${value.add.slice(0, 16)}...`)
          await base.addWriter(Buffer.from(value.add, 'hex'))
          continue
        }
        if (value && value.type === 'register-device') {
          console.log(`[A] Registering: ${value.name}`)
          await view.putDevice({
            deviceId: value.deviceId,
            name: value.name,
            publicKey: Buffer.from(value.publicKey, 'hex'),
            userIdentity: value.userIdentity,
            proof: Buffer.from(value.proof || '', 'hex'),
            addedAt: value.addedAt,
            lastSeen: value.addedAt
          })
        }
      }
    }
  })
  
  await autobaseA.ready()
  const keyA = autobaseA.key
  console.log(`[A] Created autobase`)
  console.log(`[A] writable: ${autobaseA.writable}`)
  console.log(`[A] key: ${keyA.toString('hex').slice(0, 16)}...`)
  
  // Register device A
  await autobaseA.append({ add: autobaseA.local.key.toString('hex') }, { optimistic: true })
  await autobaseA.append({
    type: 'register-device',
    deviceId: 'device-a',
    name: 'DeviceA',
    publicKey: autobaseA.local.key.toString('hex'),
    userIdentity: 'test-user',
    proof: 'proof-a',
    addedAt: Date.now()
  }, { optimistic: true })
  await autobaseA.update()
  
  // Create swarm for A - join discovery topic AND autobase topic
  const swarmA = new Hyperswarm()
  let sharedAutobaseKey = null
  
  swarmA.on('connection', (conn) => {
    console.log('[A] Connection received')
    storeA.replicate(conn)
    
    // Send autobase key to new peers
    conn.write(JSON.stringify({ type: 'autobase-key', key: keyA.toString('hex') }))
    
    conn.on('data', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'autobase-key') {
          sharedAutobaseKey = Buffer.from(msg.key, 'hex')
          console.log(`[A] Received key: ${msg.key.slice(0, 16)}...`)
        }
        if (msg.type === 'local-key') {
          // New device wants us to add them as a writer
          console.log(`[A] Received local key from new device: ${msg.key.slice(0, 16)}...`)
          // Get the core so corestore knows to replicate it
          const writerKey = Buffer.from(msg.key, 'hex')
          storeA.get({ key: writerKey })
          // IMPORTANT: In optimistic mode, indexer must explicitly add the writer
          // This acknowledges their optimistic writes
          console.log(`[A] Adding writer ${msg.key.slice(0, 16)}... to autobase`)
          autobaseA.addWriter(writerKey).then(() => {
            console.log(`[A] Writer ${msg.key.slice(0, 16)} added!`)
          }).catch(err => {
            console.log(`[A] Failed to add writer: ${err.message}`)
          })
        }
      } catch {}
    })
  })
  
  // Join discovery topic (for finding new devices)
  await swarmA.join(discoveryTopic)
  // Also join autobase topic (for replication)
  await swarmA.join(keyA)
  await swarmA.flush()
  console.log(`[A] Joined discovery topic`)
  console.log(`[A] Joined autobase topic`)
  
  // =========================================================================
  // DEVICE B: Joins discovery topic, receives key, joins autobase
  // =========================================================================
  console.log('\n--- Device B (second device) ---')
  
  const storeB = new Corestore(path.join(testDir, 'deviceB'))
  await storeB.ready()
  
  // First, join discovery topic to get the autobase key
  const swarmB = new Hyperswarm()
  let receivedKey = null
  let bConnections = []
  
  swarmB.on('connection', (conn) => {
    console.log('[B] Connection received')
    bConnections.push(conn)
    storeB.replicate(conn)
    
    conn.on('data', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'autobase-key' && !receivedKey) {
          receivedKey = Buffer.from(msg.key, 'hex')
          console.log(`[B] Received autobase key: ${msg.key.slice(0, 16)}...`)
        }
      } catch {}
    })
  })
  
  // Join discovery topic first
  await swarmB.join(discoveryTopic)
  await swarmB.flush()
  console.log(`[B] Joined discovery topic`)
  
  // Wait for connection and key
  console.log('\nWaiting for key discovery...')
  await new Promise(r => setTimeout(r, 3000))
  
  if (!receivedKey) {
    console.log('[B] ❌ No key received!')
    console.log('\nTEST: ❌ FAILED - key discovery did not work')
    return
  }
  
  console.log(`[B] Got key: ${receivedKey.toString('hex').slice(0, 16)}...`)
  
  // Now create autobase with received key
  const autobaseB = new Autobase(storeB, receivedKey, {
    autostart: true,
    optimistic: true,
    valueEncoding: 'json',
    open: (store) => new Db(store.get('view')),
    apply: async (nodes, view, base) => {
      for (const node of nodes) {
        const value = node.value
        if (value && value.add) {
          console.log(`[B] Adding writer: ${value.add.slice(0, 16)}...`)
          await base.addWriter(Buffer.from(value.add, 'hex'))
          continue
        }
        if (value && value.type === 'register-device') {
          console.log(`[B] Registering: ${value.name}`)
          await view.putDevice({
            deviceId: value.deviceId,
            name: value.name,
            publicKey: Buffer.from(value.publicKey, 'hex'),
            userIdentity: value.userIdentity,
            proof: Buffer.from(value.proof || '', 'hex'),
            addedAt: value.addedAt,
            lastSeen: value.addedAt
          })
        }
      }
    }
  })
  
  await autobaseB.ready()
  console.log(`[B] Joined autobase`)
  console.log(`[B] writable: ${autobaseB.writable}`)
  console.log(`[B] key: ${autobaseB.key.toString('hex').slice(0, 16)}...`)
  console.log(`[B] local.key: ${autobaseB.local.key.toString('hex').slice(0, 16)}...`)
  
  // Also join autobase topic for replication
  await swarmB.join(receivedKey)
  await swarmB.flush()
  
  // Send our local key to the indexer so they can replicate our optimistic writes
  // This is crucial for optimistic mode to work!
  const localKeyB = autobaseB.local.key.toString('hex')
  console.log(`[B] Sending local key to indexer: ${localKeyB.slice(0, 16)}...`)
  
  // Send local key so indexer can replicate our core
  for (const conn of bConnections) {
    conn.write(JSON.stringify({ type: 'local-key', key: localKeyB }))
  }
  
  // Update to fetch remote data
  console.log('\n[B] Updating to fetch remote data...')
  await autobaseB.update()
  
  // Check if B sees A's device
  console.log('\n[B] Devices after update:')
  const bDevices = []
  for await (const d of autobaseB.view.findDevices()) {
    bDevices.push(d)
    console.log(`  - ${d.name}`)
  }
  
  // Register device B
  console.log('\n[B] Registering device...')
  await autobaseB.append({ add: autobaseB.local.key.toString('hex') }, { optimistic: true })
  await autobaseB.append({
    type: 'register-device',
    deviceId: 'device-b',
    name: 'DeviceB',
    publicKey: autobaseB.local.key.toString('hex'),
    userIdentity: 'test-user',
    proof: 'proof-b',
    addedAt: Date.now()
  }, { optimistic: true })
  await autobaseB.update()
  
  // Sync both - multiple rounds to ensure full sync
  console.log('\nSyncing both...')
  for (let i = 0; i < 5; i++) {
    console.log(`\n  Sync round ${i + 1}...`)
    console.log(`    A inputs: ${autobaseA.inputs?.length || 0}, A length: ${autobaseA.length}`)
    console.log(`    B inputs: ${autobaseB.inputs?.length || 0}, B length: ${autobaseB.length}`)
    await autobaseA.update()
    await autobaseB.update()
    await new Promise(r => setTimeout(r, 1000))
  }
  
  // Final check
  console.log('\n--- Final Results ---')
  
  console.log('\n[A] devices:')
  const aFinal = []
  for await (const d of autobaseA.view.findDevices()) {
    aFinal.push(d)
    console.log(`  - ${d.name}`)
  }
  
  console.log('\n[B] devices:')
  const bFinal = []
  for await (const d of autobaseB.view.findDevices()) {
    bFinal.push(d)
    console.log(`  - ${d.name}`)
  }
  
  // Cleanup
  await swarmA.destroy()
  await swarmB.destroy()
  await autobaseA.close()
  await autobaseB.close()
  await storeA.close()
  await storeB.close()
  
  const passed = aFinal.length === 2 && bFinal.length === 2
  console.log(`\nTEST: ${passed ? '✅ PASSED' : '❌ FAILED'}`)
  
  if (!passed) {
    console.log(`  Expected: 2 devices each`)
    console.log(`  A got: ${aFinal.length}`)
    console.log(`  B got: ${bFinal.length}`)
  }
  
  return passed
}

await test()

// Cleanup
fs.rmSync(testDir, { recursive: true })
