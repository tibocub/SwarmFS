/**
 * Test script using actual Db class from userdb.js
 * Run: node tests/userdb-db-test.js
 */

import Corestore from 'corestore'
import Autobase from 'autobase'
import HyperDB from 'hyperdb'
import crypto from 'hypercore-crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Import the schema
import spec from '../src/userdb/spec/hyperdb/index.js'

const testDir = path.join(os.tmpdir(), 'userdb-db-test-' + Date.now())
fs.mkdirSync(testDir, { recursive: true })

console.log('Test dir:', testDir)

// Db class from userdb.js
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

  async putDevice(entry) {
    console.log('[Db] putDevice called with:', entry)
    const tx = this.db.transaction()
    await tx.insert('@userdb/device', entry)
    await tx.flush()
    console.log('[Db] putDevice done')
  }

  async getDevice(deviceId) {
    const result = await this.db.get('@userdb/device', { deviceId })
    console.log('[Db] getDevice(', deviceId, ') =', result)
    return result
  }

  async *findDevices() {
    console.log('[Db] findDevices called')
    for await (const device of this.db.find('@userdb/device', {})) {
      console.log('[Db] yielding device:', device)
      yield device
    }
  }
}

async function test() {
  console.log('\n=== Test: Single Autobase with Db class ===\n')
  
  const store = new Corestore(path.join(testDir, 'test1'))
  await store.ready()
  
  const bootstrapKey = crypto.hash(Buffer.from('test-bootstrap'))
  
  const autobase = new Autobase(store, bootstrapKey, {
    autostart: true,
    valueEncoding: 'json',
    open: (store) => {
      const viewCore = store.get('view')
      return new Db(viewCore, { extension: false })
    },
    apply: async (nodes, view, base) => {
      console.log('[Apply] Called with', nodes.length, 'nodes')
      for (const node of nodes) {
        const value = node.value
        console.log('[Apply] Node value:', JSON.stringify(value).slice(0, 100))
        
        if (value && value.add) {
          console.log('[Apply] Adding writer:', value.add.slice(0, 16))
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
        
        // Apply register-device
        if (op.type === 'register-device') {
          console.log('[Apply] Registering device:', op.deviceId)
          await view.putDevice({
            deviceId: op.deviceId,
            name: op.name,
            publicKey: Buffer.from(op.publicKey, 'hex'),
            userIdentity: op.userIdentity,
            proof: Buffer.from(op.proof, 'hex'),
            addedAt: op.addedAt,
            lastSeen: op.addedAt
          })
        }
      }
    }
  })
  
  await autobase.ready()
  console.log('Autobase ready:')
  console.log('  writable:', autobase.writable)
  console.log('  key:', autobase.key.toString('hex').slice(0, 16) + '...')
  
  // Add self as writer
  console.log('\nAdding self as writer...')
  await autobase.append({ add: autobase.local.key.toString('hex') })
  
  // Register device
  console.log('\nRegistering device...')
  const deviceOp = JSON.stringify({
    type: 'register-device',
    deviceId: 'test-device-1',
    name: 'TestDevice',
    publicKey: autobase.local.key.toString('hex'),
    userIdentity: 'test-user',
    proof: 'test-proof',
    addedAt: Date.now()
  })
  await autobase.append(deviceOp)
  
  // Update to process
  await autobase.update()
  
  // Check view
  console.log('\n--- Checking view ---')
  const device = await autobase.view.getDevice('test-device-1')
  console.log('getDevice result:', device)
  
  // List all devices
  console.log('\n--- All devices ---')
  const devices = []
  for await (const d of autobase.view.findDevices()) {
    devices.push(d)
    console.log('Found:', d)
  }
  console.log('Total devices:', devices.length)
  
  await autobase.close()
  await store.close()
  
  console.log('\nTest complete')
}

await test()

// Cleanup
fs.rmSync(testDir, { recursive: true })
