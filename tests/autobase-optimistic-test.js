/**
 * Test optimistic mode - allows appending before being a writer
 * Run: node tests/autobase-optimistic-test.js
 */

import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'

const testDir = path.join(os.tmpdir(), 'autobase-opt-test-' + Date.now())
fs.mkdirSync(testDir, { recursive: true })

console.log('Test dir:', testDir)

// Shared bootstrap key (simulating same user identity)
const bootstrapKey = crypto.hash(Buffer.from('shared-user-identity'))

function createAutobase(name, storePath) {
  const store = new Corestore(storePath)
  
  const autobase = new Autobase(store, bootstrapKey, {
    autostart: true,
    optimistic: true,  // Allow appending before being a writer
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
  console.log('\n=== Test: Optimistic mode with shared bootstrap key ===\n')
  console.log('Shared bootstrap key:', bootstrapKey.toString('hex').slice(0, 16) + '...')
  
  // Create peer 1
  const peer1 = createAutobase('Peer1', path.join(testDir, 'peer1'))
  await peer1.autobase.ready()
  console.log('[Peer1] writable:', peer1.autobase.writable)
  console.log('[Peer1] isIndexer:', peer1.autobase.isIndexer)
  console.log('[Peer1] key:', peer1.autobase.key.toString('hex').slice(0, 16) + '...')
  console.log('[Peer1] local.key:', peer1.autobase.local.key.toString('hex').slice(0, 16) + '...')
  
  // Create swarm 1
  const swarm1 = new Hyperswarm()
  swarm1.on('connection', (conn) => {
    console.log('[Peer1] Connection received')
    peer1.store.replicate(conn)
  })
  await swarm1.join(bootstrapKey)
  await swarm1.flush()
  
  // Register device 1 (optimistically)
  console.log('\n[Peer1] Registering device (optimistic)...')
  const localKey1 = peer1.autobase.local.key.toString('hex')
  await peer1.autobase.append({ add: localKey1 }, { optimistic: true })
  await peer1.autobase.append({
    type: 'register-device',
    deviceId: 'device-1',
    name: 'Peer1-Device'
  }, { optimistic: true })
  await peer1.autobase.update()
  
  // Check peer1 view
  const dev1 = await peer1.autobase.view.get('device:device-1')
  console.log('[Peer1] Device in view:', dev1?.value)
  
  // Create peer 2 with SAME bootstrap key
  console.log('\n--- Creating Peer2 with same bootstrap key ---')
  const peer2 = createAutobase('Peer2', path.join(testDir, 'peer2'))
  await peer2.autobase.ready()
  console.log('[Peer2] writable:', peer2.autobase.writable)
  console.log('[Peer2] isIndexer:', peer2.autobase.isIndexer)
  console.log('[Peer2] key:', peer2.autobase.key.toString('hex').slice(0, 16) + '...')
  console.log('[Peer2] local.key:', peer2.autobase.local.key.toString('hex').slice(0, 16) + '...')
  
  // Create swarm 2
  const swarm2 = new Hyperswarm()
  swarm2.on('connection', (conn) => {
    console.log('[Peer2] Connection received')
    peer2.store.replicate(conn)
  })
  await swarm2.join(bootstrapKey)
  await swarm2.flush()
  
  // Wait for connection
  console.log('\nWaiting for peer connection...')
  await new Promise(r => setTimeout(r, 2000))
  
  // Update peer2 to fetch remote data
  console.log('\n[Peer2] Updating...')
  await peer2.autobase.update()
  
  // Check if peer2 sees peer1's device
  const dev1on2 = await peer2.autobase.view.get('device:device-1')
  console.log('[Peer2] Device from Peer1:', dev1on2?.value)
  
  // Register device 2 (optimistically)
  console.log('\n[Peer2] Registering device (optimistic)...')
  const localKey2 = peer2.autobase.local.key.toString('hex')
  await peer2.autobase.append({ add: localKey2 }, { optimistic: true })
  await peer2.autobase.append({
    type: 'register-device',
    deviceId: 'device-2',
    name: 'Peer2-Device'
  }, { optimistic: true })
  await peer2.autobase.update()
  
  // Sync both
  console.log('\nSyncing both peers...')
  await peer1.autobase.update()
  await peer2.autobase.update()
  
  // List all devices on both peers
  console.log('\n=== All devices on Peer1 ===')
  for await (const entry of peer1.autobase.view.createReadStream()) {
    console.log('  ', entry.key, entry.value?.name || entry.value)
  }
  
  console.log('\n=== All devices on Peer2 ===')
  for await (const entry of peer2.autobase.view.createReadStream()) {
    console.log('  ', entry.key, entry.value?.name || entry.value)
  }
  
  // Cleanup
  await swarm1.destroy()
  await swarm2.destroy()
  await peer1.autobase.close()
  await peer2.autobase.close()
  await peer1.store.close()
  await peer2.store.close()
  
  console.log('\nTest complete')
}

await test()

// Cleanup
fs.rmSync(testDir, { recursive: true })
