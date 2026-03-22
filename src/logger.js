/**
 * Simple file-based logger for debugging
 * Appends log entries to a file for post-mortem analysis
 */

import fs from 'fs'
import path from 'path'

const VERBOSE = process.env.SWARMFS_VERBOSE === '1' || process.env.SWARMFS_VERBOSE === 'true'

class Logger {
  constructor(logPath) {
    this.logPath = logPath
    this.stream = null
    this.enabled = true
    
    try {
      // Ensure directory exists
      const dir = path.dirname(logPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      
      // Open file in append mode
      this.stream = fs.createWriteStream(logPath, { flags: 'a' })
      
      // Log session start
      this.log('SESSION_START', { timestamp: new Date().toISOString() })
    } catch (err) {
      console.error(`Failed to initialize logger: ${err.message}`)
      this.enabled = false
    }
  }
  
  log(event, data = {}) {
    if (!this.enabled || !this.stream) return
    
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...data
    }) + '\n'
    
    this.stream.write(entry)
  }
  
  close() {
    if (this.stream) {
      this.log('SESSION_END', { timestamp: new Date().toISOString() })
      this.stream.end()
      this.stream = null
    }
  }
}

// Global logger instance
let globalLogger = null

export function initLogger(logPath) {
  if (globalLogger) {
    globalLogger.close()
  }
  globalLogger = new Logger(logPath)
  return globalLogger
}

export function getLogger() {
  return globalLogger
}

export function closeLogger() {
  if (globalLogger) {
    globalLogger.close()
    globalLogger = null
  }
}

/**
 * Debug logging - logs to file and optionally to console
 * @param {string} category - Log category (e.g., 'MUX', 'SUBTREE', 'BITFIELD')
 * @param {...any} args - Arguments to log
 */
export function debug(category, ...args) {
  const logger = globalLogger
  if (logger) {
    logger.log(category, { message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') })
  }
  if (VERBOSE) {
    console.log(`[${category}]`, ...args)
  }
}

export default Logger
