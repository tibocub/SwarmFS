/**
 * User Database - Multi-writer P2P database using Autobase + HyperDB
 * Based on the hyperdb-autobase-workshop solution pattern
 * 
 * Each device writes to its own Hypercore, and Autobase merges them
 * into a unified view. This allows offline writes and automatic sync
 * when devices come online.
 */

import path from 'path'
import fs from 'fs'
import Corestore from 'corestore'
import HyperDB from 'hyperdb'
import Autobase from 'autobase'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import ReadyResource from 'ready-resource'

// Import generated schema
import spec from './spec/hyperdb/index.js'

/**
 * Db - Wrapper around HyperDB.bee for use with Autobase
 * Following the workshop solution pattern
 */
class Db extends ReadyResource {
  constructor(core, { extension = false } = {}) {
    super()
    this.db = HyperDB.bee(core, spec, { autoUpdate: true, extension })
  }

  get publicKey() {
    return this.db.core.key
  }

  get discoveryKey() {
    return this.db.core.discoveryKey
  }

  async _open() {
    await this.db.ready()
  }

  async _close() {
    await this.db.close()
  }

  // Device operations
  async putDevice(entry) {
    if (!this.opened) await this.ready()
    const tx = this.db.transaction()
    await tx.insert('@userdb/device', entry)
    await tx.flush()
  }

  async getDevice(deviceId) {
    if (!this.opened) await this.ready()
    return await this.db.get('@userdb/device', { deviceId })
  }

  // Friend operations
  async putFriend(entry) {
    if (!this.opened) await this.ready()
    const tx = this.db.transaction()
    await tx.insert('@userdb/friend', entry)
    await tx.flush()
  }

  async getFriend(identityKey) {
    if (!this.opened) await this.ready()
    return await this.db.get('@userdb/friend', { identityKey })
  }

  async deleteFriend(identityKey) {
    if (!this.opened) await this.ready()
    const tx = this.db.transaction()
    await tx.delete('@userdb/friend', { identityKey })
    await tx.flush()
  }

  // Setting operations
  async putSetting(entry) {
    if (!this.opened) await this.ready()
    const tx = this.db.transaction()
    await tx.insert('@userdb/setting', entry)
    await tx.flush()
  }

  async getSetting(key) {
    if (!this.opened) await this.ready()
    return await this.db.get('@userdb/setting', { key })
  }

  // Find all devices
  async *findDevices() {
    if (!this.opened) await this.ready()
    for await (const device of this.db.find('@userdb/device', {})) {
      yield device
    }
  }

  // Find all friends
  async *findFriends() {
    if (!this.opened) await this.ready()
    for await (const friend of this.db.find('@userdb/friend', {})) {
      yield friend
    }
  }
}

/**
 * UserDatabase manages the multi-writer database for user data
 * Following the workshop solution RegistryService pattern
 */
export class UserDatabase extends ReadyResource {
  constructor(options = {}) {
    super()
    
    this.storagePath = options.storagePath
    this.identity = options.identity  // IdentityManager instance
    
    this.store = null
    this.autobase = null
    this._deviceKey = null
  }

  get view() {
    return this.autobase.view
  }

  get autobaseKey() {
    return this.autobase?.key
  }

  get key() {
    return this.autobase?.key
  }

  get discoveryKey() {
    return this.autobase?.discoveryKey
  }

  /**
   * Initialize the database - called by ReadyResource
   */
  async _open() {
    this.store = new Corestore(this.storagePath)
    await this.store.ready()

    // Derive bootstrap key from user identity
    // All devices with same mnemonic will derive the same key
    // This ensures they all join the SAME autobase
    const bootstrapKey = this.identity.deriveUserSwarmTopic()
    console.log(`[USERDB] Bootstrap key: ${bootstrapKey.toString('hex').slice(0, 16)}...`)

    // Create Autobase with shared bootstrap key
    // optimistic=true allows appending before being a writer
    this.autobase = new Autobase(this.store, bootstrapKey, {
      autostart: true,
      optimistic: true,
      valueEncoding: 'json',
      open: (store) => {
        const viewCore = store.get('view')
        return new Db(viewCore, { extension: false })
      },
      apply: async (nodes, view, base) => {
        if (!view.opened) await view.ready()
        console.log(`[USERDB] Apply ${nodes.length} nodes`)

        for (const node of nodes) {
          const value = node.value

          // Handle add-writer operation (pattern from autobase examples)
          if (value && value.add) {
            console.log(`[USERDB] Adding writer: ${value.add.slice(0, 16)}...`)
            await base.addWriter(Buffer.from(value.add, 'hex'))
            // In optimistic mode, acknowledge the writer
            if (base.ackWriter) {
              await base.ackWriter(node.from.key)
            }
            continue
          }

          if (value === null || value === undefined) {
            continue
          }

          let op = value
          if (typeof value === 'string') {
            try {
              op = JSON.parse(value)
            } catch {
              console.warn('Failed to parse operation:', value)
              continue
            }
          }

          await this._applyOperation(op, view)
        }
      },
      close: async (view) => {
        await view.close()
      }
    })

    await this.autobase.ready()
    await this.view.ready()

    // Debug: log autobase state
    console.log(`[USERDB] Autobase ready:`)
    console.log(`  writable: ${this.autobase.writable}`)
    console.log(`  isIndexer: ${this.autobase.isIndexer}`)
    console.log(`  length: ${this.autobase.length}`)
    console.log(`  key: ${this.autobase.key?.toString('hex').slice(0, 16)}...`)

    // Save the autobase key for future sessions
    if (this.autobase.key) {
      const keyPath = path.join(this.storagePath, 'autobase-key')
      fs.writeFileSync(keyPath, this.autobase.key.toString('hex'))
    }

    // Ensure the view core is downloaded
    this.view.db.core.download({ start: 0, end: -1 })

    // Store device key for reference
    this._deviceKey = this.store.get({ keyPair: this.identity.deviceKeyPair })
    await this._deviceKey.ready()

    // Register this device (handles writable check internally)
    await this._registerThisDevice()
  }

  async _close() {
    if (this.autobase) {
      await this.autobase.close()
    }
    if (this.store) {
      await this.store.close()
    }
  }

  /**
   * Apply an operation to the database view
   */
  async _applyOperation(op, view) {
    try {
      switch (op.type) {
        case 'register-device':
          await view.putDevice({
            deviceId: op.deviceId,
            name: op.name,
            publicKey: Buffer.from(op.publicKey, 'hex'),
            userIdentity: op.userIdentity,
            proof: Buffer.from(op.proof, 'hex'),
            addedAt: op.addedAt,
            lastSeen: op.addedAt
          })
          break
        case 'add-friend':
          await view.putFriend({
            identityKey: op.identityKey,
            name: op.name || null,
            addedAt: op.addedAt,
            proof: op.proof ? Buffer.from(op.proof, 'hex') : null
          })
          break
        case 'remove-friend':
          await view.deleteFriend(op.identityKey)
          break
        case 'set-setting':
          await view.putSetting({
            key: op.key,
            value: op.value,
            updatedAt: op.updatedAt
          })
          break
        default:
          console.warn('Unknown operation type:', op.type)
      }
    } catch (err) {
      console.error('Failed to apply operation:', err)
    }
  }

  /**
   * Register this device in the database
   * This also adds the device as a writer to enable multi-writer sync
   */
  async _registerThisDevice() {
    const deviceId = this._hashKey(this.identity.deviceKeyPair.publicKey)
    console.log(`[USERDB] Registering device: ${deviceId}`)

    // Check if already registered in the view
    const existing = await this.view.getDevice(deviceId)
    if (existing) {
      console.log(`[USERDB] Device already registered`)
      return // Already registered
    }

    // In optimistic mode, we can append even when not a writer
    // Add ourselves as a writer
    console.log(`[USERDB] Appending add-writer operation`)
    await this.autobase.append({ add: this.identity.deviceKeyPair.publicKey.toString('hex') }, { optimistic: true })

    // Then register the device metadata
    const op = JSON.stringify({
      type: 'register-device',
      deviceId,
      name: this.identity.deviceName,
      publicKey: this.identity.deviceKeyPair.publicKey.toString('hex'),
      userIdentity: this.identity.getUserId(),
      proof: this.identity.deviceProof.toString('hex'),
      addedAt: Date.now()
    })
    console.log(`[USERDB] Appending register-device operation`)
    await this.autobase.append(op, { optimistic: true })
    console.log(`[USERDB] Device registered`)
  }

  /**
   * Append an operation to the autobase
   */
  async append(operation) {
    if (!this.opened) await this.ready()
    // Encode as JSON string for compact-encoding compatibility
    const op = typeof operation === 'string' ? operation : JSON.stringify(operation)
    await this.autobase.append(op)
  }

  /**
   * Get a device by ID
   */
  async getDevice(deviceId) {
    if (!this.opened) await this.ready()
    return await this.view.getDevice(deviceId)
  }

  /**
   * Get all devices
   */
  async getAllDevices() {
    if (!this.opened) await this.ready()
    // Sync remote data before reading
    await this.autobase.update()
    const devices = []
    for await (const device of this.view.findDevices()) {
      devices.push(device)
    }
    return devices
  }

  /**
   * Add a friend
   */
  async addFriend(identityKey, name = null, proof = null) {
    await this.append({
      type: 'add-friend',
      identityKey,
      name,
      addedAt: Date.now(),
      proof
    })
  }

  /**
   * Remove a friend
   */
  async removeFriend(identityKey) {
    await this.append({
      type: 'remove-friend',
      identityKey
    })
  }

  /**
   * Get a friend by identity key
   */
  async getFriend(identityKey) {
    if (!this.opened) await this.ready()
    return await this.view.getFriend(identityKey)
  }

  /**
   * Get all friends
   */
  async getAllFriends() {
    if (!this.opened) await this.ready()
    const friends = []
    for await (const friend of this.view.findFriends()) {
      friends.push(friend)
    }
    return friends
  }

  /**
   * Set a setting
   */
  async setSetting(key, value) {
    await this.append({
      type: 'set-setting',
      key,
      value,
      updatedAt: Date.now()
    })
  }

  /**
   * Get a setting
   */
  async getSetting(key) {
    if (!this.opened) await this.ready()
    return await this.view.getSetting(key)
  }

  /**
   * Hash a public key to create a device ID
   */
  _hashKey(publicKey) {
    return crypto.hash(publicKey).toString('hex').slice(0, 16)
  }

  /**
   * Add another writer (for new devices)
   */
  async addWriter(publicKey) {
    if (!this.opened) await this.ready()
    // Use 'add' property for autobase pattern
    const keyHex = Buffer.isBuffer(publicKey) ? publicKey.toString('hex') : publicKey
    await this.autobase.append({ add: keyHex })
  }

  /**
   * Get replication stream for networking
   */
  replicate(isInitiator) {
    return this.store.replicate(isInitiator)
  }

  /**
   * Get status info
   */
  getStatus() {
    return {
      isReady: this.opened,
      key: this.key?.toString('hex') || null,
      deviceKey: this._deviceKey?.key?.toString('hex') || null,
      isIndexer: this.autobase?.isIndexer || false
    }
  }
}

export default UserDatabase
