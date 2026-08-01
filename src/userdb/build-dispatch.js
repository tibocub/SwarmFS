/**
 * Build script for Hyperdispatch (operation router)
 * Run with: node src/userdb/build-dispatch.js
 * 
 * This generates the hyperdispatch router for encoding/decoding
 * autobase operations.
 */

import path from 'path'
import { fileURLToPath } from 'url'
import Hyperdispatch from 'hyperdispatch'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SPEC_DIR = path.join(__dirname, 'spec')

const DISPATCH_DIR = path.join(SPEC_DIR, 'hyperdispatch')

// Ensure spec directories exist
if (!fs.existsSync(DISPATCH_DIR)) {
  fs.mkdirSync(DISPATCH_DIR, { recursive: true })
}

// Build hyperdispatch router
buildDispatch()

function buildDispatch() {
  const dispatch = Hyperdispatch.from(DISPATCH_DIR)
  const ns = dispatch.namespace('userdb')

  // Add writer operation - used to add new devices as writers
  ns.register({
    name: 'add-writer',
    requestType: '@userdb/writer',
    id: 0
  })

  // Register device operation
  ns.register({
    name: 'register-device',
    requestType: '@userdb/device-op',
    id: 1
  })

  // Add friend operation
  ns.register({
    name: 'add-friend',
    requestType: '@userdb/friend-op',
    id: 2
  })

  // Remove friend operation
  ns.register({
    name: 'remove-friend',
    requestType: '@userdb/remove-friend-op',
    id: 3
  })

  // Set setting operation
  ns.register({
    name: 'set-setting',
    requestType: '@userdb/setting-op',
    id: 4
  })

  Hyperdispatch.toDisk(dispatch)
  console.log('Hyperdispatch built successfully')
}

console.log('Build complete!')
console.log(`  Dispatch: ${DISPATCH_DIR}`)
