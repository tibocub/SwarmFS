/**
 * Check what happens with isIndexer when using deterministic bootstrap key
 */

import Corestore from 'corestore'
import Autobase from 'autobase'
import crypto from 'hypercore-crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'

const testDir = path.join(os.tmpdir(), 'autobase-indexer-test-' + Date.now())
fs.mkdirSync(testDir, { recursive: true })

// Derive deterministic key (same as SwarmFS does)
const namespace = Buffer.from('swarmfs-autobase-bootstrap-v1')
const bootstrapKey = crypto.hash(Buffer.concat([namespace, Buffer.from('test-user-mnemonic')]))

console.log('Bootstrap key:', bootstrapKey.toString('hex').slice(0, 16) + '...')
console.log()

// Create two autobases with SAME key (simulating two devices with same mnemonic)
console.log('--- Device A (first to create) ---')
const storeA = new Corestore(path.join(testDir, 'a'))
await storeA.ready()
const autobaseA = new Autobase(storeA, bootstrapKey, { open: () => {}, apply: () => {} })
await autobaseA.ready()
console.log('isIndexer:', autobaseA.isIndexer)
console.log('writable:', autobaseA.writable)
console.log('autobase.key:', autobaseA.key.toString('hex').slice(0, 16) + '...')
console.log('local.key:', autobaseA.local.key.toString('hex').slice(0, 16) + '...')

console.log()
console.log('--- Device B (second, same bootstrap key) ---')
const storeB = new Corestore(path.join(testDir, 'b'))
await storeB.ready()
const autobaseB = new Autobase(storeB, bootstrapKey, { open: () => {}, apply: () => {} })
await autobaseB.ready()
console.log('isIndexer:', autobaseB.isIndexer)
console.log('writable:', autobaseB.writable)
console.log('autobase.key:', autobaseB.key.toString('hex').slice(0, 16) + '...')
console.log('local.key:', autobaseB.local.key.toString('hex').slice(0, 16) + '...')

console.log()
console.log('--- Analysis ---')
console.log('Same autobase.key:', autobaseA.key.equals(autobaseB.key) ? 'YES' : 'NO')
console.log('Same local.key:', autobaseA.local.key.equals(autobaseB.local.key) ? 'YES (PROBLEM!)' : 'NO (good - each device has unique local key)')
console.log()
console.log('Both are indexers:', (autobaseA.isIndexer && autobaseB.isIndexer) ? 'YES (PROBLEM - both think they can add writers!)' : 'NO')

fs.rmSync(testDir, { recursive: true, force: true })
