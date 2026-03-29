/**
 * Test: Workshop Pattern - Autobase with bootstrap key sharing
 * 
 * Pattern (matching hyperdb-autobase-workshop):
 * 1. Device A creates autobase (bootstrap=null) → becomes indexer
 * 2. Device A joins swarm on base.discoveryKey
 * 3. Device B receives A's key via identity-derived discovery topic
 * 4. Device B creates autobase with received key, joins base.discoveryKey
 * 5. Both use store.replicate() for corestore replication
 * 6. A adds B as writer with { indexer: true }
 * 
 * Run: node tests/autobase-workshop-pattern-test.js
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

const testDir = path.join(os.tmpdir(), 'autobase-workshop-test-' + Date.now())
fs.mkdirSync(testDir, { recursive: true })

console.log('Test dir:', testDir)

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

// Identity-derived discovery topic (for key exchange)
function deriveDiscoveryTopic(mnemonic) {
  const namespace = Buffer.from('swarmfs-user-swarm-v1')
  const mnemonicBuffer = Buffer.from(mnemonic, 'utf8')
  return crypto.hash(Buffer.concat([namespace, mnemonicBuffer]))
}

async function test() {
  console.log('\n' + '='.repeat(60))
  console.log('TEST: Workshop Pattern with Key Exchange')
  console.log('='.repeat(60))
  
  const mnemonic = 'test test test test test test test test test test test test'
  const discoveryTopic = deriveDiscoveryTopic(mnemonic)
  
  console.log(`Discovery topic: ${discoveryTopic.toString('hex').slice(0, 16)}...`)
  
  // =========================================================================
  // DEVICE A - Creates autobase, becomes indexer
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
  console.log(`[A] key: ${autobaseA.key.toString('hex').slice(0, 16)}...`)
  console.log(`[A] local.key: ${autobaseA.local.key.toString('hex').slice(0, 16)}...`)
  
  // Register device A
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
  
  // Swarm for key exchange (discovery topic)
  const swarmKeyExchange = new Hyperswarm()
  let writerRequests = []
  let aKeyConns = []
  
  swarmKeyExchange.on('connection', (conn) => {
    console.log('[A] Key exchange connection')
    aKeyConns.push(conn)
    storeA.replicate(conn)
    
    // Send autobase key
    conn.write(JSON.stringify({ type: 'autobase-key', key: autobaseA.key.toString('hex') }))
    
    conn.on('data', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'writer-key') {
          console.log(`[A] Writer request: ${msg.key.slice(0, 16)}...`)
          writerRequests.push(Buffer.from(msg.key, 'hex'))
        }
      } catch {}
    })
  })
  await swarmKeyExchange.join(discoveryTopic, { server: true, client: true })
  await swarmKeyExchange.flush()
  
  // Also join autobase discovery key for replication
  const swarmAutobaseA = new Hyperswarm()
  swarmAutobaseA.on('connection', (conn) => {
    console.log('[A] Autobase replication connection')
    storeA.replicate(conn)
  })
  await swarmAutobaseA.join(autobaseA.discoveryKey, { server: true, client: true })
  await swarmAutobaseA.flush()
  
  // =========================================================================
  // DEVICE B - Receives key, joins autobase
  // =========================================================================
  console.log('\n--- Device B ---')
  
  const storeB = new Corestore(path.join(testDir, 'deviceB'))
  await storeB.ready()
  
  // First, join discovery topic to get the key
  const swarmKeyExchangeB = new Hyperswarm()
  let receivedKey = null
  let bKeyConns = []
  
  swarmKeyExchangeB.on('connection', (conn) => {
    console.log('[B] Key exchange connection')
    bKeyConns.push(conn)
    storeB.replicate(conn)
    
    conn.on('data', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'autobase-key' && !receivedKey) {
          receivedKey = Buffer.from(msg.key, 'hex')
          console.log(`[B] Received key: ${msg.key.slice(0, 16)}...`)
        }
      } catch {}
    })
  })
  await swarmKeyExchangeB.join(discoveryTopic, { server: true, client: true })
  await swarmKeyExchangeB.flush()
  
  console.log('\nWaiting for key...')
  await new Promise(r => setTimeout(r, 2000))
  
  if (!receivedKey) {
    console.log('[B] ❌ No key received')
    return false
  }
  
  // Create autobase with received key
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
  
  // Join autobase discovery key for replication
  const swarmAutobaseB = new Hyperswarm()
  swarmAutobaseB.on('connection', (conn) => {
    console.log('[B] Autobase replication connection')
    storeB.replicate(conn)
  })
  await swarmAutobaseB.join(autobaseB.discoveryKey, { server: true, client: true })
  await swarmAutobaseB.flush()
  
  // Send writer request via tracked connections
  console.log('[B] Sending writer request...')
  for (const conn of bKeyConns) {
    conn.write(JSON.stringify({ type: 'writer-key', key: autobaseB.local.key.toString('hex') }))
  }
  
  // Wait for A to add us
  console.log('\nWaiting for A to add writer...')
  await new Promise(r => setTimeout(r, 2000))
  
  // A processes writer requests
  if (writerRequests.length > 0) {
    for (const key of writerRequests) {
      console.log(`[A] Adding writer: ${key.toString('hex').slice(0, 16)}...`)
      await autobaseA.append({ add: key.toString('hex') })
    }
    await autobaseA.update()
  }
  
  // Sync
  console.log('\nSyncing...')
  for (let i = 0; i < 5; i++) {
    await autobaseA.update()
    await autobaseB.update()
    console.log(`[B] Round ${i+1}: writable=${autobaseB.writable}`)
    if (autobaseB.writable) break
    await new Promise(r => setTimeout(r, 500))
  }
  
  // B registers if writable
  if (autobaseB.writable) {
    console.log('\n[B] Registering...')
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
  await autobaseA.update()
  await autobaseB.update()
  await new Promise(r => setTimeout(r, 500))
  await autobaseA.update()
  await autobaseB.update()
  
  // Results
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
  await swarmKeyExchange.destroy()
  await swarmKeyExchangeB.destroy()
  await swarmAutobaseA.destroy()
  await swarmAutobaseB.destroy()
  await autobaseA.close()
  await autobaseB.close()
  await storeA.close()
  await storeB.close()
  
  const passed = aDevices.length === 2 && bDevices.length === 2
  console.log(`\nTEST: ${passed ? '✅ PASSED' : '❌ FAILED'}`)
  
  return passed
}

await test()
fs.rmSync(testDir, { recursive: true })
