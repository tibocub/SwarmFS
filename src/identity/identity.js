/**
 * Identity management for SwarmFS
 * Handles user identity (mnemonic-based) and device identity (keypair)
 * Uses keet-identity-key for hierarchical deterministic key derivation
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'hypercore-crypto'
import IdentityKey from 'keet-identity-key'
import { encryptJSON, decryptJSON, hash } from './crypto.js'

const DEFAULT_IDENTITY_DIR = () => path.join(os.homedir(), '.swarmfs', 'identity')

/**
 * IdentityManager handles user and device identity
 */
export class IdentityManager {
  constructor(options = {}) {
    this.identityDir = options.identityDir || DEFAULT_IDENTITY_DIR()
    
    // User identity (from mnemonic)
    this.userIdentity = null
    this.mnemonic = null
    
    // Device identity (local keypair)
    this.deviceKeyPair = null
    this.deviceName = null
    this.deviceProof = null
  }

  /**
   * Check if user identity exists locally
   * @returns {boolean}
   */
  hasUserIdentity() {
    const userPath = path.join(this.identityDir, 'user.json.enc')
    return fs.existsSync(userPath)
  }

  /**
   * Check if device identity exists locally
   * @returns {boolean}
   */
  hasDeviceIdentity() {
    const devicePath = path.join(this.identityDir, 'device.json')
    return fs.existsSync(devicePath)
  }

  /**
   * Initialize or load user identity
   * @param {string|null} mnemonic - Mnemonic for existing user, or null to create new
   * @param {string|null} password - Password to encrypt mnemonic (required for new users)
   * @returns {Object} User identity info
   */
  async initUser(mnemonic = null, password = null) {
    // Ensure identity directory exists
    if (!fs.existsSync(this.identityDir)) {
      fs.mkdirSync(this.identityDir, { recursive: true })
    }

    const userPath = path.join(this.identityDir, 'user.json.enc')

    if (mnemonic) {
      // Loading existing identity with mnemonic
      this.mnemonic = mnemonic
      this.userIdentity = await IdentityKey.from({ mnemonic })
      
      // Save encrypted if password provided
      if (password) {
        this._saveUserEncrypted(userPath, password)
      }
    } else if (fs.existsSync(userPath)) {
      // Existing encrypted identity - need password
      if (!password) {
        throw new Error('Password required to decrypt existing identity')
      }
      
      const loaded = await this._loadUserEncrypted(userPath, password)
      if (!loaded) {
        throw new Error('Failed to decrypt identity - wrong password?')
      }
    } else {
      // Create new identity
      if (!password) {
        throw new Error('Password required for new identity')
      }
      
      this.mnemonic = IdentityKey.generateMnemonic()
      this.userIdentity = await IdentityKey.from({ mnemonic: this.mnemonic })
      this._saveUserEncrypted(userPath, password)
    }

    return {
      mnemonic: this.mnemonic,
      identityPublicKey: this.userIdentity.identityPublicKey,
      profileDiscoveryPublicKey: this.userIdentity.profileDiscoveryPublicKey
    }
  }

  /**
   * Initialize or load device identity
   * @param {string|null} deviceName - Human-readable device name
   * @returns {Object} Device identity info
   */
  async initDevice(deviceName = null) {
    if (!this.userIdentity) {
      throw new Error('User identity must be initialized first')
    }

    const devicePath = path.join(this.identityDir, 'device.json')

    // Try to load existing device
    if (fs.existsSync(devicePath)) {
      try {
        const deviceConfig = JSON.parse(fs.readFileSync(devicePath, 'utf8'))
        
        this.deviceName = deviceConfig.deviceName
        this.deviceKeyPair = {
          publicKey: Buffer.from(deviceConfig.publicKey, 'hex'),
          secretKey: Buffer.from(deviceConfig.secretKey, 'hex')
        }
        
        // Re-generate proof from user identity
        this.deviceProof = this.userIdentity.bootstrap(this.deviceKeyPair.publicKey)
        
        return {
          deviceName: this.deviceName,
          devicePublicKey: this.deviceKeyPair.publicKey,
          isNew: false
        }
      } catch (err) {
        console.warn('Failed to load device config, creating new one:', err.message)
      }
    }

    // Create new device
    this.deviceName = deviceName || this._getDefaultDeviceName()
    this.deviceKeyPair = crypto.keyPair()
    
    // Bootstrap proof linking device to user
    this.deviceProof = this.userIdentity.bootstrap(this.deviceKeyPair.publicKey)
    
    // Save device config (keypair is NOT encrypted - device-specific)
    const deviceConfig = {
      deviceName: this.deviceName,
      publicKey: this.deviceKeyPair.publicKey.toString('hex'),
      secretKey: this.deviceKeyPair.secretKey.toString('hex'),
      createdAt: Date.now()
    }
    
    fs.writeFileSync(devicePath, JSON.stringify(deviceConfig, null, 2))

    return {
      deviceName: this.deviceName,
      devicePublicKey: this.deviceKeyPair.publicKey,
      isNew: true
    }
  }

  /**
   * Get default device name based on system info
   * @returns {string}
   */
  _getDefaultDeviceName() {
    const hostname = os.hostname()
    const platform = os.platform()
    const timestamp = Date.now().toString(36).slice(-4)
    return `${hostname}-${platform}-${timestamp}`
  }

  /**
   * Save user identity encrypted
   */
  _saveUserEncrypted(userPath, password) {
    const data = {
      mnemonic: this.mnemonic,
      identityPublicKey: this.userIdentity.identityPublicKey.toString('hex'),
      createdAt: Date.now()
    }
    
    const encrypted = encryptJSON(data, password)
    fs.writeFileSync(userPath, JSON.stringify(encrypted, null, 2))
  }

  /**
   * Load user identity from encrypted file
   * @returns {Promise<boolean>} Success
   */
  async _loadUserEncrypted(userPath, password) {
    const encrypted = JSON.parse(fs.readFileSync(userPath, 'utf8'))
    const data = decryptJSON(encrypted, password)
    
    if (!data) {
      return false
    }
    
    this.mnemonic = data.mnemonic
    this.userIdentity = await IdentityKey.from({ mnemonic: this.mnemonic })
    
    return true
  }

  /**
   * Get keys for database initialization
   * @returns {Object} Database keys
   */
  getDatabaseKeys() {
    if (!this.userIdentity) {
      throw new Error('User identity not initialized')
    }

    return {
      identityPublicKey: this.userIdentity.identityPublicKey,
      profileDiscoveryPublicKey: this.userIdentity.profileDiscoveryPublicKey,
      profileDiscoveryEncryptionKey: this.userIdentity.getProfileDiscoveryEncryptionKey()
    }
  }

  /**
   * Get device public key as hex string
   * @returns {string}
   */
  getDeviceId() {
    if (!this.deviceKeyPair) {
      throw new Error('Device identity not initialized')
    }
    return this.deviceKeyPair.publicKey.toString('hex')
  }

  /**
   * Get user public key as hex string
   * @returns {string}
   */
  getUserId() {
    if (!this.userIdentity) {
      throw new Error('User identity not initialized')
    }
    return this.userIdentity.identityPublicKey.toString('hex')
  }

  /**
   * Derive a private topic key for user device swarm
   * This is derived from the mnemonic, so only devices with the same
   * user identity can derive the same topic key
   * @returns {Buffer} 32-byte topic key
   */
  deriveUserSwarmTopic() {
    if (!this.mnemonic) {
      throw new Error('User identity not initialized')
    }
    
    // Use the mnemonic to derive a deterministic but private topic
    // The namespace ensures this is specific to SwarmFS user device sync
    const namespace = Buffer.from('swarmfs-user-swarm-v1')
    const mnemonicBuffer = Buffer.from(this.mnemonic, 'utf8')
    const combined = Buffer.concat([namespace, mnemonicBuffer])
    
    // Hash to get 32-byte key
    return crypto.hash(combined)
  }

  /**
   * Verify a device proof
   * @param {*} proof - Proof to verify
   * @returns {Object|null} Verified info or null if invalid
   */
  verifyDeviceProof(proof) {
    return IdentityKey.verify(proof, null)
  }

  /**
   * Attest a new device using this device's keypair
   * @param {Buffer} newDevicePublicKey - Public key of new device
   * @returns {*} Proof chain
   */
  attestNewDevice(newDevicePublicKey) {
    if (!this.deviceKeyPair || !this.deviceProof) {
      throw new Error('Device identity must be initialized first')
    }

    return IdentityKey.attestDevice(
      newDevicePublicKey,
      this.deviceKeyPair,
      this.deviceProof
    )
  }

  /**
   * Export identity for backup (mnemonic only - sensitive!)
   * @returns {Object}
   */
  exportIdentity() {
    if (!this.userIdentity) {
      throw new Error('User identity not initialized')
    }

    return {
      mnemonic: this.mnemonic,
      identityPublicKey: this.userIdentity.identityPublicKey.toString('hex'),
      deviceName: this.deviceName,
      devicePublicKey: this.deviceKeyPair?.publicKey.toString('hex') || null
    }
  }

  /**
   * Clear sensitive data from memory
   */
  clear() {
    if (this.userIdentity) {
      this.userIdentity.clear()
    }
    this.deviceKeyPair = null
    this.deviceProof = null
    this.mnemonic = null
  }

  /**
   * Get status info
   * @returns {Object}
   */
  getStatus() {
    return {
      hasUser: !!this.userIdentity,
      hasDevice: !!this.deviceKeyPair,
      userId: this.getUserId?.() || null,
      deviceId: this.getDeviceId?.() || null,
      deviceName: this.deviceName
    }
  }
}

export default IdentityManager
