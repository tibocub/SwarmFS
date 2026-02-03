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
