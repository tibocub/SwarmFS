import os from 'os'
import path from 'path'
import crypto from 'crypto'

function stableHash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16)
}

export function getIpcEndpoint(dataDir) {
  const dir = String(dataDir || '').trim()
  if (!dir) {
    throw new Error('dataDir required')
  }

  if (os.platform() === 'win32') {
    return `\\\\.\\pipe\\swarmfs-${stableHash(dir)}`
  }

  return path.join(dir, 'swarmfs.sock')
}
