/**
 * Password-based encryption utilities for sensitive identity data
 * Uses AES-256-GCM for authenticated encryption
 */

import crypto from 'crypto'
import { promisify } from 'util'
import { Readable } from 'stream'

const pbkdf2 = promisify(crypto.pbkdf2)

/**
 * Encrypt data with a password using AES-256-GCM
 * @param {string|Buffer} data - Data to encrypt
 * @param {string} password - Encryption password
 * @returns {Object} Encrypted data with salt, iv, and authTag
 */
export function encrypt(data, password) {
  const salt = crypto.randomBytes(32)
  const iv = crypto.randomBytes(16)
  
  // Derive key using PBKDF2
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256')
  
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  
  const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
  const encrypted = Buffer.concat([
    cipher.update(dataBuffer),
    cipher.final()
  ])
  
  const authTag = cipher.getAuthTag()
  
  return {
    encrypted: encrypted.toString('hex'),
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex')
  }
}

/**
 * Decrypt data with a password
 * @param {Object} data - Encrypted data object with encrypted, salt, iv, authTag
 * @param {string} password - Decryption password
 * @returns {Buffer|null} Decrypted data or null if decryption failed
 */
export function decrypt(data, password) {
  try {
    const salt = Buffer.from(data.salt, 'hex')
    const iv = Buffer.from(data.iv, 'hex')
    const authTag = Buffer.from(data.authTag, 'hex')
    const encrypted = Buffer.from(data.encrypted, 'hex')
    
    // Derive the same key
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256')
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ])
    
    return decrypted
  } catch (error) {
    // Decryption failed - likely wrong password or corrupted data
    return null
  }
}

/**
 * Encrypt an object to JSON with password
 * @param {Object} obj - Object to encrypt
 * @param {string} password - Encryption password
 * @returns {Object} Encrypted data object
 */
export function encryptJSON(obj, password) {
  return encrypt(JSON.stringify(obj), password)
}

/**
 * Decrypt JSON data with password
 * @param {Object} data - Encrypted data object
 * @param {string} password - Decryption password
 * @returns {Object|null} Parsed JSON object or null if failed
 */
export function decryptJSON(data, password) {
  const decrypted = decrypt(data, password)
  if (!decrypted) return null
  
  try {
    return JSON.parse(decrypted.toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Generate a random password
 * @param {number} length - Password length (default 32)
 * @returns {string} Random password
 */
export function generatePassword(length = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*'
  const randomBytes = crypto.randomBytes(length)
  
  let password = ''
  for (let i = 0; i < length; i++) {
    password += chars[randomBytes[i] % chars.length]
  }
  
  return password
}

/**
 * Hash a value with SHA-256
 * @param {string|Buffer} value - Value to hash
 * @returns {string} Hex-encoded hash
 */
export function hash(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

export default {
  encrypt,
  decrypt,
  encryptJSON,
  decryptJSON,
  generatePassword,
  hash
}
