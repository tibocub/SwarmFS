/**
 * Test script for Autobase with Hyperswarm replication
 * Run: node tests/autobase-network-test.js
 */

import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'

const testDir = path.join(os.tmpdir(), 'autobase-net-test-' + Date.now())
fs.mkdirSync(testDir, { recursive: true })

console.log('Test dir:', testDir)

// Shared topic key (simulating same user identity)
const topicKey = crypto.hash(Buffer.from('test-user-identity'))

function createAutobase(name) {
  const store = new Corestore(path.join(testDir, name))
  
  const autobase = new Autobase(store, null, {
    autostart: true,
    valueEncoding: 'json',
    open: (store) => {
      const core = store.get('view')
      return new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    },
    apply: async (nodes, view, base) => {
      console.log(`[${name}] Apply ${nodes.length} nodes`)
      for (const node of nodes) {
        const value = node.value
        if (value && value.add) {
          console.log(`[${name}] Adding writer: ${value.add.slice(0, 16)}...`)
          await base.addWriter(Buffer.from(value.add, 'hex'))
          continue
        }
        if (value && value.type === 'register-device') {
          console.log(`[${name}] Registering device: ${value.name}`)
          await view.put(`device:${value.deviceId}`, value)
        }
      }
    }
  })
  
  return { store, autobase }
}

async function test() {
  console.log('\n=== Creating two autobases with network replication ===\n')
  
  // Create peer 1
  const peer1 = createAutobase('peer1')
  await peer1.autobase.ready()
  console.log('[Peer1] Key:', peer1.autobase.key.toString('hex'))
  console.log('[Peer1] Local writer key:', peer1.autobase.local.key.toString('hex'))
  
  // Create swarm 1
  const swarm1 = new Hyperswarm()
  swarm1.on('connection', (conn) => {
    console.log('[Peer1] Connection received')
    peer1.store.replicate(conn)
  })
  await swarm1.join(topicKey)
  await swarm1.flush()
  
  // Register device 1
  console.log('\n[Peer1] Registering device...')
  await peer1.autobase.append({ 
    add: peer1.autobase.local.key.toString('hex')
  })
  await peer1.autobase.append({
    type: 'register-device',
    deviceId: 'device-1',
    name: 'Peer1-Device'
  })
  await peer1.autobase.update()
  
  // Check peer1 view
  const dev1 = await peer1.autobase.view.get('device:device-1')
  console.log('[Peer1] Device in view:', dev1?.value)
  
  // Share the autobase key with peer2
  const sharedAutobaseKey = peer1.autobase.key
  
  // Create peer 2 with shared key
  console.log('\n--- Creating Peer2 with shared key ---')
  const peer2 = createAutobase('peer2')
  
  // Need to recreate with shared key
  await peer2.autobase.close()
  await peer2.store.close()
  
  const store2 = new Corestore(path.join(testDir, 'peer2'))
  const autobase2 = new Autobase(store2, sharedAutobaseKey, {
    autostart: true,
    valueEncoding: 'json',
    open: (store) => {
      const core = store.get('view')
      return new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    },
    apply: async (nodes, view, base) => {
      console.log(`[Peer2] Apply ${nodes.length} nodes`)
      for (const node of nodes) {
        const value = node.value
        if (value && value.add) {
          console.log(`[Peer2] Adding writer: ${value.add.slice(0, 16)}...`)
          await base.addWriter(Buffer.from(value.add, 'hex'))
          continue
        }
        if (value && value.type === 'register-device') {
          console.log(`[Peer2] Registering device: ${value.name}`)
          await view.put(`device:${value.deviceId}`, value)
        }
      }
    }
  })
  
  await autobase2.ready()
  console.log('[Peer2] Key:', autobase2.key.toString('hex'))
  console.log('[Peer2] Local writer key:', autobase2.local.key.toString('hex'))
  console.log('[Peer2] writable:', autobase2.writable)
  console.log('[Peer2] isIndexer:', autobase2.isIndexer)
  
  // Create swarm 2
  const swarm2 = new Hyperswarm()
  swarm2.on('connection', (conn) => {
    console.log('[Peer2] Connection received')
    store2.replicate(conn)
  })
  await swarm2.join(topicKey)
  await swarm2.flush()
  
  // Wait for connection
  console.log('\nWaiting for peer connection...')
  await new Promise(r => setTimeout(r, 2000))
  
  // Update peer2 to fetch remote data
  console.log('\n[Peer2] Updating...')
  await autobase2.update()
  
  // Check if peer2 sees peer1's device
  const dev1on2 = await autobase2.view.get('device:device-1')
  console.log('[Peer2] Device from Peer1:', dev1on2?.value)
  
  // List all devices on both peers
  console.log('\n=== All devices on Peer1 ===')
  for await (const entry of peer1.autobase.view.createReadStream()) {
    console.log('  ', entry.key, entry.value)
  }
  
  console.log('\n=== All devices on Peer2 ===')
  for await (const entry of autobase2.view.createReadStream()) {
    console.log('  ', entry.key, entry.value)
  }
  
  // Cleanup
  await swarm1.destroy()
  await swarm2.destroy()
  await peer1.autobase.close()
  await autobase2.close()
  await peer1.store.close()
  await store2.close()
  
  console.log('\nTest complete')
}

await test()

// Cleanup
fs.rmSync(testDir, { recursive: true })
