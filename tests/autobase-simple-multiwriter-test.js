/**
 * Simple multi-writer test matching hyperdb-autobase-workshop pattern
 * 
 * Pattern:
 * 1. Device A creates autobase (bootstrap=null) → becomes indexer
 * 2. Device B joins with bootstrap key → not indexer
 * 3. Device A adds Device B as writer with { indexer: true }
 * 4. Both can now write and see each other's data
 * 
 * Run: node tests/autobase-simple-multiwriter-test.js
 */

import Corestore from 'corestore'
import Autobase from 'autobase'
import HyperDB from 'hyperdb'
import Hyperswarm from 'hyperswarm'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Import the actual schema
import spec from '../src/userdb/spec/hyperdb/index.js'

const testDir = path.join(os.tmpdir(), 'autobase-simple-test-' + Date.now())
fs.mkdirSync(testDir, { recursive: true })

console.log('Test dir:', testDir)

// Db class matching workshop pattern
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

// Simple apply function matching workshop pattern
function createApply(name) {
  return async function apply(nodes, view, base) {
    if (!view.opened) await view.ready()
    
    for (const node of nodes) {
      const value = node.value
      
      // Handle add-writer (matching workshop pattern)
      if (value && value.add) {
        console.log(`[${name}] Adding writer: ${value.add.slice(0, 16)}...`)
        // Key pattern: { indexer: true } so new writers can also write
        await base.addWriter(Buffer.from(value.add, 'hex'), { indexer: true })
        continue
      }
      
      // Handle register-device
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
  console.log('TEST: Simple Multi-Writer (Workshop Pattern)')
  console.log('='.repeat(60))
  
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
  swarmA.on('connection', (conn) => {
    console.log('[A] Connection received')
    autobaseA.replicate(conn)
  })
  await swarmA.join(autobaseA.discoveryKey, { server: true, client: true })
  await swarmA.flush()
  
  const bootstrapKey = autobaseA.key
  console.log(`[A] Bootstrap key for others: ${bootstrapKey.toString('hex').slice(0, 16)}...`)
  
  // =========================================================================
  // DEVICE B: Joins with bootstrap key
  // =========================================================================
  console.log('\n--- Device B ---')
  
  const storeB = new Corestore(path.join(testDir, 'deviceB'))
  await storeB.ready()
  
  const autobaseB = new Autobase(storeB, bootstrapKey, {
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
  
  // Create swarm for B
  const swarmB = new Hyperswarm()
  swarmB.on('connection', (conn) => {
    console.log('[B] Connection received')
    autobaseB.replicate(conn)
  })
  await swarmB.join(autobaseB.discoveryKey, { server: true, client: true })
  await swarmB.flush()
  
  // Wait for connection
  console.log('\nWaiting for connection...')
  await new Promise(r => setTimeout(r, 2000))
  
  // B is not an indexer yet - needs A to add it
  console.log('\n[B] Not an indexer yet, waiting to be added...')
  
  // A adds B as writer with { indexer: true }
  console.log('\n[A] Adding B as writer with indexer: true...')
  await autobaseA.append({ add: autobaseB.local.key.toString('hex') })
  await autobaseA.update()
  
  // Wait for B to receive the update
  console.log('\nWaiting for B to sync...')
  await new Promise(r => setTimeout(r, 2000))
  await autobaseB.update()
  
  console.log(`\n[B] After sync - isIndexer: ${autobaseB.isIndexer}`)
  console.log(`[B] After sync - writable: ${autobaseB.writable}`)
  
  // Now B can register itself
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
