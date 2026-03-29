/**
 * Test script for Autobase store/retrieve pattern
 * Run: node tests/autobase-test.js
 */

import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import fs from 'fs'
import path from 'path'
import os from 'os'

const testDir = path.join(os.tmpdir(), 'autobase-test-' + Date.now())
fs.mkdirSync(testDir, { recursive: true })

console.log('Test dir:', testDir)

// Test 1: Single autobase with append and read
async function test1() {
  console.log('\n=== Test 1: Single Autobase ===')
  
  const store = new Corestore(path.join(testDir, 'test1'))
  await store.ready()
  
  const bootstrapKey = null // Create new autobase
  
  const autobase = new Autobase(store, bootstrapKey, {
    autostart: true,
    valueEncoding: 'json',
    open: (store) => {
      const core = store.get('view')
      return new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    },
    apply: async (nodes, view, base) => {
      console.log('  Apply called with', nodes.length, 'nodes')
      for (const node of nodes) {
        const value = node.value
        console.log('    Node value:', value)
        
        // Handle add-writer
        if (value && value.add) {
          console.log('    Adding writer:', value.add)
          await base.addWriter(Buffer.from(value.add, 'hex'))
          continue
        }
        
        // Handle data
        if (value && value.type === 'put') {
          console.log('    Putting:', value.key, '=', value.data)
          await view.put(value.key, value.data)
        }
      }
    }
  })
  
  await autobase.ready()
  console.log('Autobase ready:')
  console.log('  writable:', autobase.writable)
  console.log('  isIndexer:', autobase.isIndexer)
  console.log('  key:', autobase.key?.toString('hex'))
  
  // Append data
  console.log('\nAppending data...')
  await autobase.append({ type: 'put', key: 'device1', data: { name: 'Device One' } })
  
  // Wait for apply
  await autobase.update()
  
  // Read back
  console.log('\nReading from view...')
  const entry = await autobase.view.get('device1')
  console.log('  Entry:', entry?.value)
  
  await autobase.close()
  await store.close()
  
  console.log('Test 1 complete')
}

// Test 2: Two autobases sharing same bootstrap key
async function test2() {
  console.log('\n=== Test 2: Two Autobases with shared key ===')
  
  // Create first autobase
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
      for (const node of nodes) {
        const value = node.value
        if (value && value.add) {
          await base.addWriter(Buffer.from(value.add, 'hex'))
          continue
        }
        if (value && value.type === 'put') {
          await view.put(value.key, value.data)
        }
      }
    }
  })
  
  await autobase1.ready()
  const sharedKey = autobase1.key
  console.log('Autobase1 key:', sharedKey.toString('hex'))
  console.log('Autobase1 writable:', autobase1.writable)
  
  // Add data to first
  await autobase1.append({ type: 'put', key: 'from-peer1', data: { source: 'peer1' } })
  await autobase1.update()
  
  // Create second autobase with same key
  const store2 = new Corestore(path.join(testDir, 'peer2'))
  await store2.ready()
  
  const autobase2 = new Autobase(store2, sharedKey, {
    autostart: true,
    valueEncoding: 'json',
    open: (store) => {
      const core = store.get('view')
      return new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    },
    apply: async (nodes, view, base) => {
      for (const node of nodes) {
        const value = node.value
        if (value && value.add) {
          await base.addWriter(Buffer.from(value.add, 'hex'))
          continue
        }
        if (value && value.type === 'put') {
          await view.put(value.key, value.data)
        }
      }
    }
  })
  
  await autobase2.ready()
  console.log('Autobase2 writable:', autobase2.writable)
  console.log('Autobase2 isIndexer:', autobase2.isIndexer)
  
  // Update to sync
  await autobase2.update()
  
  // Check if peer2 can see peer1's data
  const entry = await autobase2.view.get('from-peer1')
  console.log('Peer2 sees from-peer1:', entry?.value)
  
  // Check autobase1 view
  const entry1 = await autobase1.view.get('from-peer1')
  console.log('Peer1 sees from-peer1:', entry1?.value)
  
  await autobase1.close()
  await autobase2.close()
  await store1.close()
  await store2.close()
  
  console.log('Test 2 complete')
}

// Run tests
await test1()
await test2()

// Cleanup
fs.rmSync(testDir, { recursive: true })
console.log('\nAll tests done, cleaned up')
