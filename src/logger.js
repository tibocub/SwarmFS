/**
 * Simple file-based logger for debugging
 * Appends log entries to a file for post-mortem analysis
 */

import fs from 'fs'
import path from 'path'

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

export default Logger
