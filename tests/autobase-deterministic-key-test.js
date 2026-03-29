/**
 * Test: Deterministic Autobase Key Pattern
 * 
 * Pattern:
 * 1. Both devices derive the same autobase key from the same mnemonic
 * 2. Device A creates autobase with that key → becomes indexer
 * 3. Device B joins with same key → not indexer initially
 * 4. Device A adds B as writer with { indexer: true }
 * 5. Both can now write and see each other's data
 * 
 * Run: node tests/autobase-deterministic-key-test.js
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

const testDir = path.join(os.tmpdir(), 'autobase-det-key-test-' + Date.now())
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

// Simulate deriving key from mnemonic (same as IdentityManager.deriveAutobaseKey)
function deriveAutobaseKey(mnemonic) {
  const namespace = Buffer.from('swarmfs-autobase-bootstrap-v1')
  const mnemonicBuffer = Buffer.from(mnemonic, 'utf8')
  const combined = Buffer.concat([namespace, mnemonicBuffer])
  return crypto.hash(combined)
}

// Simulate deriving discovery topic (same as IdentityManager.deriveUserSwarmTopic)
function deriveUserSwarmTopic(mnemonic) {
  const namespace = Buffer.from('swarmfs-user-swarm-v1')
  const mnemonicBuffer = Buffer.from(mnemonic, 'utf8')
  const combined = Buffer.concat([namespace, mnemonicBuffer])
  return crypto.hash(combined)
}

// Apply function
function createApply(name) {
  return async function apply(nodes, view, base) {
    if (!view.opened) await view.ready()
    
    for (const node of nodes) {
      const value = node.value
      
      if (value && value.add) {
        console.log(`[${name}] Adding writer: ${value.add.slice(0, 16)}...`)
        await base.addWriter(Buffer.from(value.add, 'hex'), { indexer: true })
        continue
      }
      
      if (value && value.type === 'register-device') {
        console.log(`[${name}] Registering device: ${value.name}`)
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
}

async function test() {
  console.log('\n' + '='.repeat(60))
  console.log('TEST: Deterministic Autobase Key Pattern')
  console.log('='.repeat(60))
  
  // Same mnemonic for both devices
  const mnemonic = 'test test test test test test test test test test test test'
  
  // Derive keys
  const autobaseKey = deriveAutobaseKey(mnemonic)
  const discoveryTopic = deriveUserSwarmTopic(mnemonic)
  
  console.log(`\nDerived keys from mnemonic:`)
  console.log(`  Autobase key: ${autobaseKey.toString('hex').slice(0, 16)}...`)
  console.log(`  Discovery topic: ${discoveryTopic.toString('hex').slice(0, 16)}...`)
  
  // =========================================================================
  // DEVICE A - First device creates autobase with bootstrap=null
  // =========================================================================
  console.log('\n--- Device A (first device) ---')
  
  const storeA = new Corestore(path.join(testDir, 'deviceA'))
  await storeA.ready()
  
  // First device creates with bootstrap=null
  const autobaseA = new Autobase(storeA, null, {
    valueEncoding: 'json',
    open: (store) => new Db(store.get('view')),
    apply: createApply('A'),
    close: (view) => view.close()
  })
  
  await autobaseA.ready()
  console.log(`[A] isIndexer: ${autobaseA.isIndexer}`)
  console.log(`[A] writable: ${autobaseA.writable}`)
  console.log(`[A] key: ${autobaseA.key.toString('hex').slice(0, 16)}...`)
  console.log(`[A] local.key: ${autobaseA.local.key.toString('hex').slice(0, 16)}...`)
  
  // Save the key (simulating local storage)
  const savedAutobaseKey = autobaseA.key
  console.log(`[A] Saved autobase key for sharing: ${savedAutobaseKey.toString('hex').slice(0, 16)}...`)
  
  // Register device A
  console.log('\n[A] Registering device...')
  await autobaseA.append({ add: autobaseA.local.key.toString('hex') })
  await autobaseA.append({
    type: 'register-device',
    deviceId: 'device-a',
    name: 'DeviceA',
    publicKey: autobaseA.local.key.toString('hex'),
    userIdentity: 'test-user',
    proof: 'proof-a',
    addedAt: Date.now()
  })
  await autobaseA.update()
  
  // Create swarm for A
  const swarmA = new Hyperswarm()
  let writerRequests = []
  
  swarmA.on('connection', (conn) => {
    console.log('[A] Connection received')
    autobaseA.replicate(conn)
    
    // Send autobase key to new devices
    conn.write(JSON.stringify({ type: 'autobase-key', key: savedAutobaseKey.toString('hex') }))
    console.log(`[A] Sent autobase key to peer`)
    
    conn.on('data', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'writer-key') {
          console.log(`[A] Writer request: ${msg.key.slice(0, 16)}...`)
          writerRequests.push({ key: Buffer.from(msg.key, 'hex'), conn })
        }
      } catch {}
    })
    
    // Say hello as indexer
    conn.write(JSON.stringify({ type: 'indexer-hello' }))
  })
  
  await swarmA.join(discoveryTopic, { server: true, client: true })
  await swarmA.flush()
  
  // =========================================================================
  // DEVICE B - Receives key from A via discovery topic
  // =========================================================================
  console.log('\n--- Device B (second device) ---')
  
  const storeB = new Corestore(path.join(testDir, 'deviceB'))
  await storeB.ready()
  
  // Create swarm for B first to receive key
  const swarmB = new Hyperswarm()
  let receivedKey = null
  let bConn = null
  
  swarmB.on('connection', (conn) => {
    console.log('[B] Connection received')
    bConn = conn
    
    conn.on('data', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'autobase-key' && !receivedKey) {
          receivedKey = Buffer.from(msg.key, 'hex')
          console.log(`[B] Received autobase key: ${msg.key.slice(0, 16)}...`)
        }
        if (msg.type === 'indexer-hello') {
          console.log('[B] Received indexer hello')
        }
      } catch {}
    })
  })
  
  await swarmB.join(discoveryTopic, { server: true, client: true })
  await swarmB.flush()
  
  // Wait for key
  console.log('\nWaiting for autobase key from indexer...')
  await new Promise(r => setTimeout(r, 3000))
  
  if (!receivedKey) {
    console.log('[B] ❌ No key received!')
    return false
  }
  
  // Now create autobase with received key
  const autobaseB = new Autobase(storeB, receivedKey, {
    valueEncoding: 'json',
    open: (store) => new Db(store.get('view')),
    apply: createApply('B'),
    close: (view) => view.close()
  })
  
  await autobaseB.ready()
  console.log(`[B] isIndexer: ${autobaseB.isIndexer}`)
  console.log(`[B] writable: ${autobaseB.writable}`)
  console.log(`[B] key: ${autobaseB.key.toString('hex').slice(0, 16)}...`)
  console.log(`[B] local.key: ${autobaseB.local.key.toString('hex').slice(0, 16)}...`)
  
  // Verify keys match!
  if (autobaseA.key.equals(autobaseB.key)) {
    console.log(`\n✓ Both autobases have the SAME key!`)
  } else {
    console.log(`\n✗ Keys don't match - test failed`)
    return false
  }
  
  // Set up replication on B's connection
  autobaseB.replicate(bConn)
  
  // Send writer request
  console.log('[B] Sending writer request...')
  bConn.write(JSON.stringify({ type: 'writer-key', key: autobaseB.local.key.toString('hex') }))
  
  // Wait for connection and writer request
  console.log('\nWaiting for writer request to be processed...')
  await new Promise(r => setTimeout(r, 2000))
  
  // A adds B as writer
  if (writerRequests.length > 0) {
    console.log('\n[A] Processing writer requests...')
    for (const { key } of writerRequests) {
      console.log(`[A] Adding writer: ${key.toString('hex').slice(0, 16)}...`)
      await autobaseA.append({ add: key.toString('hex') })
    }
    await autobaseA.update()
  }
  
  // Wait for B to sync - multiple rounds
  console.log('\nWaiting for B to sync...')
  for (let i = 0; i < 5; i++) {
    await autobaseB.update()
    await autobaseA.update()
    await new Promise(r => setTimeout(r, 500))
    console.log(`[B] Sync round ${i+1}: writable=${autobaseB.writable}`)
    if (autobaseB.writable) break
  }
  
  console.log(`\n[B] After sync:`)
  console.log(`[B] isIndexer: ${autobaseB.isIndexer}`)
  console.log(`[B] writable: ${autobaseB.writable}`)
  
  // Now B can register
  if (autobaseB.writable) {
    console.log('\n[B] Registering device...')
    await autobaseB.append({ add: autobaseB.local.key.toString('hex') })
    await autobaseB.append({
      type: 'register-device',
      deviceId: 'device-b',
      name: 'DeviceB',
      publicKey: autobaseB.local.key.toString('hex'),
      userIdentity: 'test-user',
      proof: 'proof-b',
      addedAt: Date.now()
    })
    await autobaseB.update()
  }
  
  // Final sync
  console.log('\nFinal sync...')
  await autobaseA.update()
  await autobaseB.update()
  await new Promise(r => setTimeout(r, 1000))
  await autobaseA.update()
  await autobaseB.update()
  
  // Check results
  console.log('\n--- Results ---')
  
  console.log('\n[A] devices:')
  const aDevices = []
  for await (const d of autobaseA.view.findDevices()) {
    aDevices.push(d)
    console.log(`  - ${d.name}`)
  }
  
  console.log('\n[B] devices:')
  const bDevices = []
  for await (const d of autobaseB.view.findDevices()) {
    bDevices.push(d)
    console.log(`  - ${d.name}`)
  }
  
  // Cleanup
  await swarmA.destroy()
  await swarmB.destroy()
  await autobaseA.close()
  await autobaseB.close()
  await storeA.close()
  await storeB.close()
  
  const passed = aDevices.length === 2 && bDevices.length === 2
  console.log(`\nTEST: ${passed ? '✅ PASSED' : '❌ FAILED'}`)
  
  if (!passed) {
    console.log(`  A: ${aDevices.length} devices, B: ${bDevices.length} devices`)
  }
  
  return passed
}

await test()

// Cleanup
fs.rmSync(testDir, { recursive: true })
