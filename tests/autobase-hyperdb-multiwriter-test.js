/**
 * Comprehensive test for Autobase + HyperDB multi-writer pattern
 * Mirrors the actual UserDatabase implementation
 * Run: node tests/autobase-hyperdb-multiwriter-test.js
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

const testDir = path.join(os.tmpdir(), 'autobase-hyperdb-test-' + Date.now())
fs.mkdirSync(testDir, { recursive: true })

console.log('Test dir:', testDir)

// ============================================================================
// Db class - mirrors src/userdb/userdb.js Db class
// ============================================================================
class Db {
  constructor(core, { extension = false } = {}) {
    this.db = HyperDB.bee(core, spec, { autoUpdate: true, extension })
  }

  get publicKey() {
    return this.db.core.key
  }

  async ready() {
    await this.db.ready()
  }

  async close() {
    await this.db.close()
  }

  // Device operations - mirrors actual implementation
  async putDevice(entry) {
    console.log(`  [Db.putDevice] deviceId=${entry.deviceId}, name=${entry.name}`)
    const tx = this.db.transaction()
    await tx.insert('@userdb/device', entry)
    await tx.flush()
  }

  async getDevice(deviceId) {
    const result = await this.db.get('@userdb/device', { deviceId })
    console.log(`  [Db.getDevice] deviceId=${deviceId} -> ${result ? 'found' : 'not found'}`)
    return result
  }

  async *findDevices() {
    console.log('  [Db.findDevices] iterating...')
    for await (const device of this.db.find('@userdb/device', {})) {
      console.log(`  [Db.findDevices] raw device:`, device)
      // HyperDB returns the record directly, not wrapped in { value: ... }
      yield device
    }
  }
}

// ============================================================================
// Test helper to create Autobase with same pattern as UserDatabase
// ============================================================================
function createAutobaseInstance(name, storePath, bootstrapKey) {
  const store = new Corestore(storePath)
  
  const autobase = new Autobase(store, bootstrapKey, {
    autostart: true,
    optimistic: true,
    valueEncoding: 'json',
    open: (store) => {
      const viewCore = store.get('view')
      return new Db(viewCore, { extension: false })
    },
    apply: async (nodes, view, base) => {
      console.log(`[${name}] Apply ${nodes.length} nodes`)
      
      for (const node of nodes) {
        const value = node.value
        
        // Handle add-writer operation
        if (value && value.add) {
          console.log(`[${name}] Adding writer: ${value.add.slice(0, 16)}...`)
          await base.addWriter(Buffer.from(value.add, 'hex'))
          continue
        }
        
        if (value === null || value === undefined) continue
        
        let op = value
        if (typeof value === 'string') {
          try {
            op = JSON.parse(value)
          } catch {
            continue
          }
        }
        
        // Handle register-device operation
        if (op.type === 'register-device') {
          console.log(`[${name}] Registering device: ${op.name}`)
          await view.putDevice({
            deviceId: op.deviceId,
            name: op.name,
            publicKey: Buffer.from(op.publicKey, 'hex'),
            userIdentity: op.userIdentity,
            proof: Buffer.from(op.proof || '', 'hex'),
            addedAt: op.addedAt,
            lastSeen: op.addedAt
          })
        }
      }
    }
  })
  
  return { store, autobase }
}

// ============================================================================
// TEST 1: Single writer can write and read
// ============================================================================
async function test1_singleWriter() {
  console.log('\n' + '='.repeat(60))
  console.log('TEST 1: Single writer can write and read')
  console.log('='.repeat(60))
  
  const bootstrapKey = crypto.hash(Buffer.from('test-single-writer'))
  const { store, autobase } = createAutobaseInstance('Single', path.join(testDir, 'test1'), bootstrapKey)
  
  await autobase.ready()
  console.log('\nAutobase state:')
  console.log(`  writable: ${autobase.writable}`)
  console.log(`  isIndexer: ${autobase.isIndexer}`)
  console.log(`  key: ${autobase.key.toString('hex').slice(0, 16)}...`)
  console.log(`  local.key: ${autobase.local.key.toString('hex').slice(0, 16)}...`)
  
  // Register device
  console.log('\nRegistering device...')
  await autobase.append({ add: autobase.local.key.toString('hex') }, { optimistic: true })
  await autobase.append(JSON.stringify({
    type: 'register-device',
    deviceId: 'device-single',
    name: 'SingleDevice',
    publicKey: autobase.local.key.toString('hex'),
    userIdentity: 'test-user',
    proof: 'test-proof',
    addedAt: Date.now()
  }), { optimistic: true })
  
  // Update to process
  await autobase.update()
  
  // Read back
  console.log('\nReading devices...')
  const devices = []
  for await (const d of autobase.view.findDevices()) {
    devices.push(d)
  }
  
  console.log(`\nResult: Found ${devices.length} device(s)`)
  devices.forEach(d => console.log(`  - ${d.name} (${d.deviceId})`))
  
  await autobase.close()
  await store.close()
  
  const passed = devices.length === 1 && devices[0].name === 'SingleDevice'
  console.log(`\nTEST 1: ${passed ? '✅ PASSED' : '❌ FAILED'}`)
  return passed
}

// ============================================================================
// TEST 2: Two writers with network replication
// ============================================================================
async function test2_multiWriterWithNetwork() {
  console.log('\n' + '='.repeat(60))
  console.log('TEST 2: Two writers with network replication')
  console.log('='.repeat(60))
  
  // Shared bootstrap key - both use the SAME key
  const bootstrapKey = crypto.hash(Buffer.from('test-multi-writer-shared'))
  console.log(`Shared bootstrap key: ${bootstrapKey.toString('hex').slice(0, 16)}...`)
  
  // Create Peer 1
  console.log('\n--- Creating Peer 1 ---')
  const p1 = createAutobaseInstance('P1', path.join(testDir, 'test2-p1'), bootstrapKey)
  await p1.autobase.ready()
  console.log(`P1 writable: ${p1.autobase.writable}`)
  console.log(`P1 local.key: ${p1.autobase.local.key.toString('hex').slice(0, 16)}...`)
  
  // Register device 1
  console.log('\nP1 registering device...')
  await p1.autobase.append({ add: p1.autobase.local.key.toString('hex') }, { optimistic: true })
  await p1.autobase.append(JSON.stringify({
    type: 'register-device',
    deviceId: 'device-p1',
    name: 'Peer1Device',
    publicKey: p1.autobase.local.key.toString('hex'),
    userIdentity: 'test-user',
    proof: 'proof-p1',
    addedAt: Date.now()
  }), { optimistic: true })
  await p1.autobase.update()
  
  // Check P1's local view
  console.log('\nP1 local devices:')
  const p1LocalDevices = []
  for await (const d of p1.autobase.view.findDevices()) {
    p1LocalDevices.push(d)
    console.log(`  - ${d.name}`)
  }
  
  // Create swarm for P1
  const swarm1 = new Hyperswarm()
  swarm1.on('connection', (conn) => {
    console.log('[P1] Connection received')
    p1.store.replicate(conn)
  })
  // Use autobase.key as swarm topic (same as bootstrapKey in this case)
  await swarm1.join(p1.autobase.key)
  await swarm1.flush()
  console.log(`P1 joined swarm topic: ${p1.autobase.key.toString('hex').slice(0, 16)}...`)
  
  // Create Peer 2 with SAME bootstrap key
  console.log('\n--- Creating Peer 2 ---')
  const p2 = createAutobaseInstance('P2', path.join(testDir, 'test2-p2'), bootstrapKey)
  await p2.autobase.ready()
  console.log(`P2 writable: ${p2.autobase.writable}`)
  console.log(`P2 local.key: ${p2.autobase.local.key.toString('hex').slice(0, 16)}...`)
  
  // Create swarm for P2
  const swarm2 = new Hyperswarm()
  swarm2.on('connection', (conn) => {
    console.log('[P2] Connection received')
    p2.store.replicate(conn)
  })
  await swarm2.join(p2.autobase.key)
  await swarm2.flush()
  console.log(`P2 joined swarm topic: ${p2.autobase.key.toString('hex').slice(0, 16)}...`)
  
  // Wait for connection
  console.log('\nWaiting for peer connection...')
  await new Promise(r => setTimeout(r, 3000))
  
  // Update P2 to fetch remote data
  console.log('\nP2 updating to fetch remote data...')
  await p2.autobase.update()
  
  // Check if P2 sees P1's device
  console.log('\nP2 devices after update:')
  const p2DevicesAfterUpdate = []
  for await (const d of p2.autobase.view.findDevices()) {
    p2DevicesAfterUpdate.push(d)
    console.log(`  - ${d.name}`)
  }
  
  // Register device 2
  console.log('\nP2 registering device...')
  await p2.autobase.append({ add: p2.autobase.local.key.toString('hex') }, { optimistic: true })
  await p2.autobase.append(JSON.stringify({
    type: 'register-device',
    deviceId: 'device-p2',
    name: 'Peer2Device',
    publicKey: p2.autobase.local.key.toString('hex'),
    userIdentity: 'test-user',
    proof: 'proof-p2',
    addedAt: Date.now()
  }), { optimistic: true })
  await p2.autobase.update()
  
  // Sync both
  console.log('\nSyncing both peers...')
  await p1.autobase.update()
  await p2.autobase.update()
  
  // Final check - both should see 2 devices
  console.log('\n--- Final Results ---')
  
  console.log('\nP1 devices:')
  const p1FinalDevices = []
  for await (const d of p1.autobase.view.findDevices()) {
    p1FinalDevices.push(d)
    console.log(`  - ${d.name} (${d.deviceId})`)
  }
  
  console.log('\nP2 devices:')
  const p2FinalDevices = []
  for await (const d of p2.autobase.view.findDevices()) {
    p2FinalDevices.push(d)
    console.log(`  - ${d.name} (${d.deviceId})`)
  }
  
  // Cleanup
  await swarm1.destroy()
  await swarm2.destroy()
  await p1.autobase.close()
  await p2.autobase.close()
  await p1.store.close()
  await p2.store.close()
  
  const passed = p1FinalDevices.length === 2 && p2FinalDevices.length === 2
  console.log(`\nTEST 2: ${passed ? '✅ PASSED' : '❌ FAILED'}`)
  
  if (!passed) {
    console.log(`  Expected: 2 devices each`)
    console.log(`  P1 got: ${p1FinalDevices.length} devices`)
    console.log(`  P2 got: ${p2FinalDevices.length} devices`)
  }
  
  return passed
}

// ============================================================================
// Run all tests
// ============================================================================
async function runTests() {
  console.log('Starting Autobase + HyperDB multi-writer tests')
  console.log('Using actual HyperDB schema from src/userdb/spec/hyperdb/index.js')
  
  const results = []
  
  results.push(await test1_singleWriter())
  results.push(await test2_multiWriterWithNetwork())
  
  console.log('\n' + '='.repeat(60))
  console.log('SUMMARY')
  console.log('='.repeat(60))
  console.log(`Test 1 (Single writer): ${results[0] ? '✅' : '❌'}`)
  console.log(`Test 2 (Multi-writer): ${results[1] ? '✅' : '❌'}`)
  console.log(`\nOverall: ${results.every(r => r) ? '✅ ALL PASSED' : '❌ SOME FAILED'}`)
  
  // Cleanup
  fs.rmSync(testDir, { recursive: true })
}

await runTests()
