/**
 * config.js — Key and config management for OpenAwe OpenClaw Client
 *
 * Stores host keypair and paired device info in ~/.openclaw/relay/
 */

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(process.env.HOME, '.openclaw', 'relay');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const KEYPAIR_FILE = path.join(CONFIG_DIR, 'keypair.json');

const DEFAULT_RELAY_URL = 'ws://localhost:8090/v1/connect';

/** Default config structure */
function defaultConfig() {
  return {
    relayId: null,
    relayServerUrl: DEFAULT_RELAY_URL,
    pairedDevices: [],
    createdAt: new Date().toISOString(),
  };
}

/** Ensure the config directory exists */
function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/** Load config from disk, creating defaults if needed. Normalizes field names. */
function loadConfig() {
  ensureDir();
  if (fs.existsSync(CONFIG_FILE)) {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    
    // Normalize: support both relayServer and relayServerUrl
    if (!parsed.relayServerUrl && parsed.relayServer) {
      parsed.relayServerUrl = parsed.relayServer;
    }
    if (!parsed.relayServerUrl) {
      parsed.relayServerUrl = DEFAULT_RELAY_URL;
    }
    
    // Ensure relayServerUrl is a WebSocket URL with path
    if (parsed.relayServerUrl && !parsed.relayServerUrl.includes('/v1/connect')) {
      // Strip trailing slash and append path
      parsed.relayServerUrl = parsed.relayServerUrl.replace(/\/$/, '') + '/v1/connect';
      // Convert https to wss, http to ws
      parsed.relayServerUrl = parsed.relayServerUrl
        .replace(/^https:\/\//, 'wss://')
        .replace(/^http:\/\//, 'ws://');
    }

    if (!parsed.pairedDevices) {
      parsed.pairedDevices = [];
    }
    
    return parsed;
  }
  return defaultConfig();
}

/** Save config to disk */
function saveConfig(config) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Load the host keypair from disk (serialized format: {publicKey, privateKey} as base64 strings) */
function loadKeyPair() {
  // Check the standard location first
  if (fs.existsSync(KEYPAIR_FILE)) {
    const raw = fs.readFileSync(KEYPAIR_FILE, 'utf-8');
    return JSON.parse(raw);
  }
  // Also check the keys/ subdirectory (legacy location)
  const legacyPath = path.join(CONFIG_DIR, 'keys', 'keypair.json');
  if (fs.existsSync(legacyPath)) {
    const raw = fs.readFileSync(legacyPath, 'utf-8');
    return JSON.parse(raw);
  }
  return null;
}

/** Save the host keypair to disk */
function saveKeyPair(serializedKP) {
  ensureDir();
  fs.writeFileSync(KEYPAIR_FILE, JSON.stringify(serializedKP, null, 2), { mode: 0o600 });
}

/** Generate a relay ID (UUID-like) */
function generateRelayId() {
  const { randomBytes } = require('crypto');
  const bytes = randomBytes(16);
  // Format as UUID v4
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Add a paired device to config */
function addPairedDevice(config, device) {
  // device: { name, publicKey, pairedAt }
  config.pairedDevices = config.pairedDevices.filter(
    (d) => d.publicKey !== device.publicKey
  );
  config.pairedDevices.push(device);
  saveConfig(config);
}

/** Remove a paired device by name or publicKey */
function removePairedDevice(config, identifier) {
  config.pairedDevices = config.pairedDevices.filter(
    (d) => d.name !== identifier && d.publicKey !== identifier
  );
  saveConfig(config);
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  KEYPAIR_FILE,
  DEFAULT_RELAY_URL,
  loadConfig,
  saveConfig,
  loadKeyPair,
  saveKeyPair,
  generateRelayId,
  addPairedDevice,
  removePairedDevice,
  defaultConfig,
};
