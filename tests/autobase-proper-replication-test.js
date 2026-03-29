/**
 * Test: Proper Autobase replication pattern
 * Key insight: Autobase manages its own cores, we need to replicate the autobase itself
 * Run: node tests/autobase-proper-replication-test.js
 */

import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'

const testDir = path.join(os.tmpdir(), 'autobase-proper-test-' + Date.now())
fs.mkdirSync(testDir, { recursive: true })

console.log('Test dir:', testDir)

// Shared topic for discovery (derived from user identity)
const discoveryTopic = crypto.hash(Buffer.from('user-identity-topic'))

async function test() {
  console.log('\n=== Test: Proper Autobase replication ===\n')
  
  // === PEER 1: Creates new autobase ===
  const store1 = new Corestore(path.join(testDir, 'peer1'))
  await store1.ready()
  
  const autobase1 = new Autobase(store1, null, {
    autostart: true,
    valueEncoding: 'json',
    open: (store) => {
      const core = store.get('view')
      return new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    },
    apply: async (nodes, view, base) => {
      console.log('[P1] Apply', nodes.length, 'nodes')
      for (const node of nodes) {
        const value = node.value
        if (value && value.add) {
          console.log('[P1] Adding writer:', value.add.slice(0, 16))
          await base.addWriter(Buffer.from(value.add, 'hex'))
          continue
        }
        if (value && value.type === 'register-device') {
          console.log('[P1] Register device:', value.name)
          await view.put(`device:${value.deviceId}`, value)
        }
      }
    }
  })
  
  await autobase1.ready()
  console.log('[P1] Created autobase')
  console.log('[P1] writable:', autobase1.writable)
  console.log('[P1] key:', autobase1.key.toString('hex').slice(0, 16) + '...')
  console.log('[P1] local.key:', autobase1.local.key.toString('hex').slice(0, 16) + '...')
  
  // Add self as writer and register device
  await autobase1.append({ add: autobase1.local.key.toString('hex') })
  await autobase1.append({ type: 'register-device', deviceId: 'dev1', name: 'Device1' })
  await autobase1.update()
  
  const dev1Check = await autobase1.view.get('device:dev1')
  console.log('[P1] Device registered:', dev1Check?.value?.name)
  
  // Create swarm for P1
  const swarm1 = new Hyperswarm()
  const topicKey1 = autobase1.key  // Use autobase key as topic for discovery
  
  swarm1.on('connection', (conn) => {
    console.log('[P1] Connection from peer')
    store1.replicate(conn)
  })
  
  await swarm1.join(topicKey1)
  await swarm1.flush()
  console.log('[P1] Joined swarm topic:', topicKey1.toString('hex').slice(0, 16) + '...')
  
  // === PEER 2: Joins with P1's key ===
  console.log('\n--- Creating Peer 2 ---')
  const store2 = new Corestore(path.join(testDir, 'peer2'))
  await store2.ready()
  
  const sharedKey = autobase1.key  // This is the key P2 needs
  console.log('[P2] Joining with key:', sharedKey.toString('hex').slice(0, 16) + '...')
  
  const autobase2 = new Autobase(store2, sharedKey, {
    autostart: true,
    valueEncoding: 'json',
    open: (store) => {
      const core = store.get('view')
      return new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    },
    apply: async (nodes, view, base) => {
      console.log('[P2] Apply', nodes.length, 'nodes')
      for (const node of nodes) {
        const value = node.value
        if (value && value.add) {
          console.log('[P2] Adding writer:', value.add.slice(0, 16))
          await base.addWriter(Buffer.from(value.add, 'hex'))
          continue
        }
        if (value && value.type === 'register-device') {
          console.log('[P2] Register device:', value.name)
          await view.put(`device:${value.deviceId}`, value)
        }
      }
    }
  })
  
  await autobase2.ready()
  console.log('[P2] writable:', autobase2.writable)
  console.log('[P2] isIndexer:', autobase2.isIndexer)
  console.log('[P2] local.key:', autobase2.local.key.toString('hex').slice(0, 16) + '...')
  
  // Create swarm for P2 - join SAME topic as P1
  const swarm2 = new Hyperswarm()
  
  swarm2.on('connection', (conn) => {
    console.log('[P2] Connection from peer')
    store2.replicate(conn)
  })
  
  await swarm2.join(sharedKey)  // Same topic as P1
  await swarm2.flush()
  console.log('[P2] Joined swarm topic:', sharedKey.toString('hex').slice(0, 16) + '...')
  
  // Wait for connection and sync
  console.log('\nWaiting for connection...')
  await new Promise(r => setTimeout(r, 3000))
  
  // Update P2 to fetch remote data
  console.log('\n[P2] Updating...')
  await autobase2.update()
  
  // Check if P2 sees P1's device
  const dev1on2 = await autobase2.view.get('device:dev1')
  console.log('[P2] Device from P1:', dev1on2?.value?.name)
  
  // List all devices on both
  console.log('\n=== Devices on P1 ===')
  for await (const entry of autobase1.view.createReadStream()) {
    console.log('  ', entry.key, '=', entry.value?.name || entry.value)
  }
  
  console.log('\n=== Devices on P2 ===')
  for await (const entry of autobase2.view.createReadStream()) {
    console.log('  ', entry.key, '=', entry.value?.name || entry.value)
  }
  
  // Cleanup
  await swarm1.destroy()
  await swarm2.destroy()
  await autobase1.close()
  await autobase2.close()
  await store1.close()
  await store2.close()
  
  console.log('\nTest complete')
}

await test()

// Cleanup
fs.rmSync(testDir, { recursive: true })
