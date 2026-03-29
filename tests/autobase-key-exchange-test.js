/**
 * Test: Key exchange pattern for multi-device autobase
 * 
 * Pattern:
 * 1. Device A creates autobase (bootstrap=null) → becomes indexer
 * 2. Device B creates own autobase (bootstrap=null) → also becomes indexer (but different key)
 * 3. Both join discovery topic (derived from identity)
 * 4. Device A sends its autobase key to B
 * 5. Device B rejoins with A's key → becomes non-indexer
 * 6. Device B sends writer request to A
 * 7. Device A adds B as writer with { indexer: true }
 * 8. Both can now write and see each other's data
 * 
 * Run: node tests/autobase-key-exchange-test.js
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

const testDir = path.join(os.tmpdir(), 'autobase-key-exchange-test-' + Date.now())
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

// Discovery topic (simulating identity.deriveUserSwarmTopic())
const discoveryTopic = crypto.hash(Buffer.from('user-identity-derivation'))

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
  console.log('TEST: Key Exchange Pattern')
  console.log('='.repeat(60))
  console.log(`Discovery topic: ${discoveryTopic.toString('hex').slice(0, 16)}...`)
  
  // =========================================================================
  // DEVICE A: Creates autobase (becomes indexer)
  // =========================================================================
  console.log('\n--- Device A ---')
  
  const storeA = new Corestore(path.join(testDir, 'deviceA'))
  await storeA.ready()
  
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
    
    // Key exchange protocol
    conn.on('data', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        
        // Send our autobase key to new devices
        if (msg.type === 'request-key') {
          console.log(`[A] Sending autobase key to new device`)
          conn.write(JSON.stringify({ type: 'autobase-key', key: autobaseA.key.toString('hex') }))
        }
        
        // Receive writer request
        if (msg.type === 'writer-key') {
          console.log(`[A] Received writer request: ${msg.key.slice(0, 16)}...`)
          writerRequests.push({ key: Buffer.from(msg.key, 'hex'), conn })
        }
      } catch {}
    })
    
    // Send our key immediately (we're the indexer)
    conn.write(JSON.stringify({ type: 'autobase-key', key: autobaseA.key.toString('hex') }))
  })
  
  await swarmA.join(discoveryTopic, { server: true, client: true })
  await swarmA.flush()
  
  // =========================================================================
  // DEVICE B: Creates own autobase initially, then receives A's key
  // =========================================================================
  console.log('\n--- Device B ---')
  
  const storeB = new Corestore(path.join(testDir, 'deviceB'))
  await storeB.ready()
  
  // Initially creates own autobase (will be replaced)
  let autobaseB = new Autobase(storeB, null, {
    valueEncoding: 'json',
    open: (store) => new Db(store.get('view')),
    apply: createApply('B'),
    close: (view) => view.close()
  })
  
  await autobaseB.ready()
  console.log(`[B] Initial autobase:`)
  console.log(`[B] isIndexer: ${autobaseB.isIndexer}`)
  console.log(`[B] writable: ${autobaseB.writable}`)
  console.log(`[B] key: ${autobaseB.key.toString('hex').slice(0, 16)}...`)
  console.log(`[B] local.key: ${autobaseB.local.key.toString('hex').slice(0, 16)}...`)
  
  // Create swarm for B
  const swarmB = new Hyperswarm()
  let receivedKey = null
  let bConn = null
  
  swarmB.on('connection', (conn) => {
    console.log('[B] Connection received')
    bConn = conn
    autobaseB.replicate(conn)
    
    conn.on('data', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        
        // Receive autobase key from indexer
        if (msg.type === 'autobase-key' && !receivedKey) {
          receivedKey = Buffer.from(msg.key, 'hex')
          console.log(`[B] Received autobase key: ${msg.key.slice(0, 16)}...`)
        }
      } catch {}
    })
    
    // Request key from indexer
    conn.write(JSON.stringify({ type: 'request-key' }))
  })
  
  await swarmB.join(discoveryTopic, { server: true, client: true })
  await swarmB.flush()
  
  // Wait for connection and key
  console.log('\nWaiting for key exchange...')
  await new Promise(r => setTimeout(r, 3000))
  
  if (!receivedKey) {
    console.log('[B] ❌ No key received!')
    console.log('\nTEST: ❌ FAILED - key exchange did not work')
    return
  }
  
  console.log(`\n[B] Got key: ${receivedKey.toString('hex').slice(0, 16)}...`)
  
  // Check if keys are different
  if (autobaseB.key.equals(receivedKey)) {
    console.log('[B] Keys are the same (unexpected)')
  } else {
    console.log('[B] Keys are different, need to rejoin')
    
    // Don't close - just create new autobase with A's key
    // Note: In production, we'd need to handle this more carefully
    autobaseB = new Autobase(storeB, receivedKey, {
      valueEncoding: 'json',
      open: (store) => new Db(store.get('view')),
      apply: createApply('B'),
      close: (view) => view.close()
    })
    
    await autobaseB.ready()
    console.log(`[B] After rejoin:`)
    console.log(`[B] isIndexer: ${autobaseB.isIndexer}`)
    console.log(`[B] writable: ${autobaseB.writable}`)
    console.log(`[B] key: ${autobaseB.key.toString('hex').slice(0, 16)}...`)
    console.log(`[B] local.key: ${autobaseB.local.key.toString('hex').slice(0, 16)}...`)
    
    // Send writer request
    console.log(`[B] Sending writer request...`)
    bConn.write(JSON.stringify({ type: 'writer-key', key: autobaseB.local.key.toString('hex') }))
  }
  
  // Wait for A to process writer request
  await new Promise(r => setTimeout(r, 1000))
  
  // A adds B as writer
  if (writerRequests.length > 0) {
    console.log('\n[A] Processing writer requests...')
    for (const { key } of writerRequests) {
      console.log(`[A] Adding writer: ${key.toString('hex').slice(0, 16)}...`)
      await autobaseA.append({ add: key.toString('hex') })
    }
    await autobaseA.update()
  }
  
  // Wait for B to sync
  console.log('\nWaiting for B to sync...')
  await new Promise(r => setTimeout(r, 2000))
  await autobaseB.update()
  
  console.log(`[B] After sync:`)
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
