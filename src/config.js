/**
 * Configuration loader for SwarmFS
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_FILE = path.join(__dirname, '..', 'swarmfs.config.json');

let cachedConfig = null;

/**
 * Protocol configuration constants
 */
export const PROTOCOL_CONFIG = {
  MAX_CONCURRENT_SUBTREE_SERVES: 8,    // Prevents memory exhaustion
  MAX_SUBTREE_SERVE_QUEUE_SIZE: 100,   // Drop requests if exceeded
  REQUEST_TIMEOUT_MS: 30000,           // Per-subtree request timeout
  MERKLE_CACHE_MAX_SIZE: 10,           // Max cached merkle trees
  BACKPRESSURE_THRESHOLD: 4 * 1024 * 1024, // 4MB pending bytes before backpressure
}

/**
 * Download configuration constants
 */
export const DOWNLOAD_CONFIG = {
  TARGET_SUBTREE_BYTES: 64 * 1024 * 1024,  // 64MB subtrees
  MAX_CONCURRENT_REQUESTS: 8,
  ENDGAME_THRESHOLD: 0.95,             // Switch to endgame at 95% complete
  DEFAULT_SUBTREE_CHUNKS: 8,           // Default chunks per subtree request
}

/**
 * Network configuration constants
 */
export const NETWORK_CONFIG = {
  MAX_CONNECTIONS: 50,
  FLUSH_TIMEOUT_MS: 30000,
}

/**
 * Load configuration from file
 */
export function loadConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }

  try {
    const configData = fs.readFileSync(CONFIG_FILE, 'utf8');
    cachedConfig = JSON.parse(configData);
    
    // Resolve dataDir relative to config file location
    if (cachedConfig.dataDir && !path.isAbsolute(cachedConfig.dataDir)) {
      cachedConfig.dataDir = path.resolve(path.dirname(CONFIG_FILE), cachedConfig.dataDir);
    }
    
    return cachedConfig;
  } catch (error) {
    // Return defaults if config file doesn't exist
    console.warn('Warning: Could not load config, using defaults');
    cachedConfig = {
      dataDir: path.join(__dirname, '..', 'swarmfs-data'),
      chunkSize: 262144,
      ignorePatterns: ['node_modules', '.git', '.swarmfs', '*.tmp', '*.temp']
    };
    return cachedConfig;
  }
}

/**
 * Get data directory path
 */
export function getDataDir() {
  const config = loadConfig();
  return config.dataDir;
}

/**
 * Get chunk size
 */
export function getChunkSize() {
  const config = loadConfig();
  return config.chunkSize || 262144;
}

/**
 * Get ignore patterns
 */
export function getIgnorePatterns() {
  const config = loadConfig();
  return config.ignorePatterns || [];
}
