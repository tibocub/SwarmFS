/**
 * Build script for HyperDB schema
 * Run with: node src/userdb/build.js
 * 
 * This generates:
 * - spec/hyperschema/ - Schema definitions
 * - spec/hyperdb/ - Database configuration
 */

import path from 'path'
import { fileURLToPath } from 'url'
import HyperDB from 'hyperdb/builder'
import Hyperschema from 'hyperschema'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SPEC_DIR = path.join(__dirname, 'spec')

const SCHEMA_DIR = path.join(SPEC_DIR, 'hyperschema')
const DB_DIR = path.join(SPEC_DIR, 'hyperdb')

// Ensure spec directories exist
if (!fs.existsSync(SCHEMA_DIR)) {
  fs.mkdirSync(SCHEMA_DIR, { recursive: true })
}
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true })
}

// Build schema and database
setupSchema()
setupDb()

function setupSchema() {
  const schema = Hyperschema.from(SCHEMA_DIR)
  const userdb = schema.namespace('userdb')

  // Device entry - registered devices for a user
  userdb.register({
    name: 'device',
    fields: [
      {
        name: 'deviceId',
        type: 'string',  // Hash of device public key
        required: true
      },
      {
        name: 'name',
        type: 'string',  // Human-readable device name
        required: true
      },
      {
        name: 'publicKey',
        type: 'fixed32',  // Device public key (32 bytes)
        required: true
      },
      {
        name: 'userIdentity',
        type: 'string',  // User's identity public key (hex)
        required: true
      },
      {
        name: 'proof',
        type: 'buffer',  // Device proof (links device to user)
        required: true
      },
      {
        name: 'addedAt',
        type: 'uint',
        required: true
      },
      {
        name: 'lastSeen',
        type: 'uint',
        required: false
      }
    ]
  })

  // Friend entry - trusted contacts
  userdb.register({
    name: 'friend',
    fields: [
      {
        name: 'identityKey',
        type: 'string',  // Friend's identity public key (hex)
        required: true
      },
      {
        name: 'name',
        type: 'string',  // Optional display name
        required: false
      },
      {
        name: 'addedAt',
        type: 'uint',
        required: true
      },
      {
        name: 'proof',
        type: 'buffer',  // Optional attestation proof
        required: false
      }
    ]
  })

  // Setting entry - key-value settings
  userdb.register({
    name: 'setting',
    fields: [
      {
        name: 'key',
        type: 'string',
        required: true
      },
      {
        name: 'value',
        type: 'string',
        required: true
      },
      {
        name: 'updatedAt',
        type: 'uint',
        required: true
      }
    ]
  })

  Hyperschema.toDisk(schema)
  console.log('Schema built successfully')
}

function setupDb() {
  const db = HyperDB.from(SCHEMA_DIR, DB_DIR)
  const dbNs = db.namespace('userdb')

  // Devices collection - keyed by deviceId
  dbNs.collections.register({
    name: 'device',
    schema: '@userdb/device',
    key: ['deviceId']
  })

  // Index devices by user identity (for querying all devices of a user)
  dbNs.indexes.register({
    name: 'device-by-user',
    collection: '@userdb/device',
    key: ['userIdentity', 'deviceId']
  })

  // Friends collection - keyed by identity key
  dbNs.collections.register({
    name: 'friend',
    schema: '@userdb/friend',
    key: ['identityKey']
  })

  // Settings collection - keyed by setting key
  dbNs.collections.register({
    name: 'setting',
    schema: '@userdb/setting',
    key: ['key']
  })

  HyperDB.toDisk(db)
  console.log('Database configuration built successfully')
}

console.log('Build complete!')
console.log(`  Schema: ${SCHEMA_DIR}`)
console.log(`  DB: ${DB_DIR}`)
