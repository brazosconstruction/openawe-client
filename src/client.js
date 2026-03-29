#!/usr/bin/env node

/**
 * client.js — OpenAwe OpenClaw Client
 *
 * Main entry point. Connects to the OpenAwe relay server, handles E2E encryption,
 * and bridges messages between the OpenAwe mobile app and OpenClaw.
 *
 * Usage:
 *   node src/client.js          — Start the client (persistent connection)
 *   node src/client.js --pair   — Generate a pairing code
 *   node src/client.js --status — Show connection status and paired devices
 *   node src/client.js --echo   — Force echo mode (skip OpenClaw API)
 */

const {
  initCrypto,
  generateKeyPair,
  serializeKeyPair,
  deserializeKeyPair,
  deriveSessionKey,
  encryptToWire,
  decryptFromWire,
  encodePairingPayload,
  generateShortCode,
  formatShortCode,
} = require('@openawe/crypto');

const {
  loadConfig,
  saveConfig,
  loadKeyPair,
  saveKeyPair,
  generateRelayId,
  addPairedDevice,
  CONFIG_DIR,
} = require('./config');

const { RelayConnection } = require('./relay-connection');
const http = require('http');
const https = require('https');
const { OpenClawAPI } = require('./openclaw-api');

// --- CLI Argument Parsing ---
const args = process.argv.slice(2);
const CMD_PAIR = args.includes('--pair');
const CMD_STATUS = args.includes('--status');
const FORCE_ECHO = args.includes('--echo');
const RELAY_URL = args.find((a) => a.startsWith('--relay='))?.split('=')[1];

// --- Main ---

async function main() {
  // Initialize crypto (libsodium)
  await initCrypto();

  // Ensure we have a keypair
  let serializedKP = loadKeyPair();
  if (!serializedKP) {
    log('No keypair found — generating new host keypair...');
    const kp = generateKeyPair();
    serializedKP = serializeKeyPair(kp);
    saveKeyPair(serializedKP);
    log(`Keypair generated and saved to ${CONFIG_DIR}/keypair.json`);
  }

  // Ensure we have config with a relay ID
  let config = loadConfig();
  if (!config.relayId) {
    config.relayId = generateRelayId();
    saveConfig(config);
    log(`Generated relay ID: ${config.relayId}`);
  }

  // Override relay URL if provided
  if (RELAY_URL) {
    config.relayServerUrl = RELAY_URL;
  }

  // Route to subcommand
  if (CMD_PAIR) {
    await handlePair(config, serializedKP);
  } else if (CMD_STATUS) {
    handleStatus(config, serializedKP);
  } else {
    await handleRun(config, serializedKP);
  }
}

// --- Pair: Generate a pairing code ---

async function handlePair(config, serializedKP) {
  const shortCode = generateShortCode(8);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  const payload = {
    relayId: config.relayId,
    publicKey: serializedKP.publicKey,
    relayServerUrl: config.relayServerUrl.replace('ws://', 'http://').replace('wss://', 'https://'),
    oneTimeToken: shortCode,
    expiresAt,
  };

  const encoded = encodePairingPayload(payload);

  // Register short code with relay server
  const relayHttpUrl = config.relayServerUrl
    .replace('ws://', 'http://')
    .replace('wss://', 'https://')
    .replace('/v1/connect', '');
  
  try {
    await registerShortCode(relayHttpUrl, shortCode, encoded);
    log('Short code registered with relay server');
  } catch (err) {
    log(`Warning: Could not register short code with relay: ${err.message}`);
    log('Short code will only work if relay server adds support later');
  }

  console.log('\n========================================');
  console.log('  OpenAwe Pairing Code');
  console.log('========================================\n');
  console.log(`  Short Code: ${formatShortCode(shortCode)}`);
  console.log(`  Expires:    ${new Date(expiresAt).toLocaleTimeString()}`);
  console.log(`  Relay ID:   ${config.relayId}`);
  console.log(`  Relay URL:  ${config.relayServerUrl}`);
  console.log(`  Public Key: ${serializedKP.publicKey.slice(0, 20)}...`);
  console.log('');
  console.log('  Full Pairing Payload (base64):');
  console.log(`  ${encoded}`);
  console.log('');
  console.log('  Deep Link:');
  console.log(`  openawe://pair/${encoded}`);
  console.log('\n========================================\n');

  // Store the pending pairing in config so the running client can accept it
  config.pendingPairing = {
    shortCode,
    expiresAt,
    payload: encoded,
  };
  saveConfig(config);
  log('Pairing info saved. Start the client to accept incoming pairing requests.');
}

/**
 * Register a short code -> payload mapping with the relay server via HTTP POST
 */
function registerShortCode(relayBaseUrl, shortCode, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL('/v1/pair', relayBaseUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const body = JSON.stringify({ code: shortCode, payload });

    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}


// --- Status: Show current state ---

function handleStatus(config, serializedKP) {
  console.log('\n========================================');
  console.log('  OpenAwe Client Status');
  console.log('========================================\n');
  console.log(`  Relay ID:     ${config.relayId}`);
  console.log(`  Relay Server: ${config.relayServerUrl}`);
  console.log(`  Public Key:   ${serializedKP.publicKey.slice(0, 20)}...`);
  console.log(`  Config Dir:   ${CONFIG_DIR}`);
  console.log('');

  if (config.pairedDevices && config.pairedDevices.length > 0) {
    console.log('  Paired Devices:');
    for (const d of config.pairedDevices) {
      console.log(`    - ${d.name || 'Unnamed'} (paired ${d.pairedAt || 'unknown'})`);
      console.log(`      Key: ${d.publicKey.slice(0, 20)}...`);
    }
  } else {
    console.log('  Paired Devices: None');
    console.log('  Run `node src/client.js --pair` to generate a pairing code.');
  }

  if (config.pendingPairing) {
    const expired = new Date(config.pendingPairing.expiresAt) < new Date();
    console.log(`\n  Pending Pairing: ${expired ? 'EXPIRED' : 'ACTIVE'}`);
    if (!expired) {
      console.log(`    Code: ${formatShortCode(config.pendingPairing.shortCode)}`);
      console.log(`    Expires: ${new Date(config.pendingPairing.expiresAt).toLocaleTimeString()}`);
    }
  }

  console.log('\n========================================\n');
}

// --- Run: Start persistent connection ---

async function handleRun(config, serializedKP) {
  log('Starting OpenAwe OpenClaw Client...');
  log(`Relay ID: ${config.relayId}`);
  log(`Relay Server: ${config.relayServerUrl}`);
  log(`Paired devices: ${config.pairedDevices?.length || 0}`);

  // Initialize OpenClaw API
  const api = new OpenClawAPI({ echoMode: FORCE_ECHO });
  await api.probe();

  if (api.apiAvailable) {
    log('OpenClaw gateway detected — forwarding messages to API');
  } else {
    log('Running in ECHO MODE — messages will be echoed back');
  }

  // Deserialize our keypair for crypto operations
  const hostKP = deserializeKeyPair(serializedKP);

  // Build session key cache: { devicePublicKey: sessionKey }
  const sessionKeys = new Map();
  for (const device of (config.pairedDevices || [])) {
    try {
      const theirPubKey = deserializeKeyPair({ publicKey: device.publicKey, privateKey: serializedKP.privateKey }).publicKey;
      // Actually we just need to convert their base64 pubkey to Uint8Array
      // We'll use the crypto lib properly
    } catch (err) {
      log(`Warning: Could not load session key for device ${device.name}: ${err.message}`);
    }
  }

  // Connect to relay
  const relay = new RelayConnection({
    relayServerUrl: config.relayServerUrl,
    relayId: config.relayId,
  });

  relay.on('registered', () => {
    log('Registered with relay as host');
  });

  // Track whether the app is currently online (connected to relay)
  let appOnline = false;

  relay.on('partnerStatus', (status) => {
    appOnline = !!status.online;
    if (status.online) {
      log('App connected! Ready to receive messages.');
      // Send status back to app so it can auto-reconnect without re-pairing
      relay.sendData(JSON.stringify({
        type: 'status',
        online: true,
        connected: true,
        echoMode: !api.apiAvailable,
        relayId: config.relayId,
      }));
    } else {
      log('App disconnected (backgrounded or offline).');
    }
  });

  relay.on('data', async (payload) => {
    await handleIncomingData(payload, hostKP, serializedKP, config, api, relay, () => appOnline);
  });

  relay.on('disconnected', () => {
    // RelayConnection handles reconnect automatically
  });

  relay.on('relayError', (err) => {
    log(`Relay error: ${err.message}`);
  });

  // Start connection
  relay.connect();

  // Handle graceful shutdown
  const shutdown = (sig) => {
    log(`Received ${sig} — shutting down...`);
    api.disconnect();
    relay.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log('Client running. Press Ctrl+C to stop.');
}

// --- Message Handling ---

async function handleIncomingData(payload, hostKP, serializedKP, config, api, relay, getAppOnline) {
  let decrypted;

  // First, try to parse as plain JSON (for pairing messages and unencrypted bootstrap)
  log(`[debug] payload length: ${payload.length}, first 100: ${String(payload).slice(0, 100)}`);
  try {
    const plain = JSON.parse(payload);
    if (plain.type === 'pair_request' || plain.type === 'pairing_request') {
      await handlePairRequest(plain, hostKP, serializedKP, config, relay);
      return;
    }
    // Push token registration from the mobile app
    if (plain.type === 'push_token' && plain.token) {
      config.pushToken = plain.token;
      saveConfig(config);
      log(`Push token registered: ${plain.token.slice(0, 30)}...`);
      return;
    }

    // If it's a plain chat message (unencrypted), handle it directly
    // Also handle messages that only carry attachments (no text body)
    if (plain.type === 'chat' && (plain.message || plain.attachments)) {
      const hasAttachments = Array.isArray(plain.attachments) && plain.attachments.length > 0;
      const displayText = plain.message || (hasAttachments ? '[attachment]' : '');
      log(`[unencrypted] Received: ${displayText}`);

      // Build the message payload for the OpenClaw API.
      // The gateway chat.send RPC accepts a plain text message string only.
      // If the user sent image attachments without text, acknowledge them but note
      // that image vision support requires the encrypted E2E flow or a future API update.
      let messageText = plain.message || '';
      let savedImagePath = null;
      if (hasAttachments) {
        // Save first attachment to a temp file so OpenClaw can read it
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const firstImg = plain.attachments.find(a => a.data);
        if (!firstImg && !messageText) messageText = '[User sent an attachment]';
        if (firstImg) {
          try {
            const ext = firstImg.mimeType === 'image/png' ? 'png' : 'jpg';
            savedImagePath = path.join(os.tmpdir(), `openawe-img-${Date.now()}.${ext}`);
            const imgBuffer = Buffer.from(firstImg.data, 'base64');
            fs.writeFileSync(savedImagePath, imgBuffer);
            log(`[image] Saved to ${savedImagePath} (${imgBuffer.length} bytes)`);
            if (!messageText) {
              messageText = `[Image attached: ${savedImagePath}]`;
            } else {
              messageText = `${messageText} [Image: ${savedImagePath}]`;
            }
          } catch (err) {
            log(`[image] Failed to save: ${err.message}`);
            if (!messageText) messageText = '[User sent an attachment]';
          }
        }
      }

      const msgWithSession = { 
        ...plain, 
        message: messageText, 
        sessionKey: plain.sessionKey || 'main',
        ...(savedImagePath ? { mediaPath: savedImagePath } : {})
      };
      const response = await api.sendMessage(msgWithSession);
      log(`[unencrypted] Response: ${response.message}`);
      relay.sendData(JSON.stringify({ type: 'chat', message: response.message }));
      return;
    }
  } catch {
    // Not plain JSON — likely encrypted
  }

  // Try to decrypt with each paired device's session key
  const { from_base64 } = require('libsodium-wrappers');
  for (const device of (config.pairedDevices || [])) {
    try {
      const theirPubKeyBytes = from_base64(device.publicKey, 1); // ORIGINAL variant = 1
      const sessionKey = deriveSessionKey(hostKP.privateKey, theirPubKeyBytes);
      decrypted = decryptFromWire(payload, sessionKey);
      log(`Decrypted message from ${device.name || 'paired device'}`);
      break;
    } catch {
      // Wrong key, try next device
      continue;
    }
  }

  if (!decrypted) {
    log('Could not decrypt message (no matching paired device or bad payload)');
    // Send an error back (unencrypted since we can't identify the sender)
    relay.sendData(JSON.stringify({
      type: 'error',
      message: 'Could not decrypt message. Is your device paired?',
    }));
    return;
  }

  // Parse decrypted message
  let msg;
  try {
    msg = JSON.parse(decrypted);
  } catch {
    log(`Decrypted content is not JSON: ${decrypted.slice(0, 100)}`);
    return;
  }

  log(`Received (decrypted): type=${msg.type}, message=${msg.message?.slice(0, 80) || '(none)'}`);

  if (msg.type === 'chat') {
    // Forward to OpenClaw API
    const response = await api.sendMessage(msg);
    log(`Response: ${response.message.slice(0, 80)}`);

    // Check if the app is currently online
    const isOnline = typeof getAppOnline === 'function' ? getAppOnline() : true;

    if (!isOnline && config.pushToken) {
      // App is backgrounded — fire a push notification to wake it
      log(`App is offline — sending push notification to ${config.pushToken.slice(0, 30)}...`);
      try {
        const preview = response.message.slice(0, 100) + (response.message.length > 100 ? '…' : '');
        await sendExpoPushNotification(config.pushToken, {
          title: 'Nora',
          body: preview,
          data: { type: 'message' },
        });
        log('Push notification sent successfully');
      } catch (err) {
        log(`Push notification failed: ${err.message}`);
      }
    }

    // Encrypt the response and send back (relay will buffer if app reconnects)
    for (const device of (config.pairedDevices || [])) {
      try {
        const { from_base64: fb64 } = require('libsodium-wrappers');
        const theirPubKeyBytes = fb64(device.publicKey, 1);
        const sessionKey = deriveSessionKey(hostKP.privateKey, theirPubKeyBytes);
        const encrypted = encryptToWire(JSON.stringify(response), sessionKey);
        relay.sendData(encrypted);
        return;
      } catch {
        continue;
      }
    }

    // If encryption fails, send unencrypted as fallback
    log('Warning: Could not encrypt response, sending unencrypted');
    relay.sendData(JSON.stringify({ type: 'chat', message: response.message }));
  }
}

// --- Pairing Handler ---

async function handlePairRequest(msg, hostKP, serializedKP, config, relay) {
  log(`Pairing request received from: ${msg.deviceName || msg.deviceInfo?.name || 'Unknown device'}`);

  // Validate against pending pairing
  const pending = config.pendingPairing;
  if (!pending) {
    log('No pending pairing — rejecting');
    relay.sendData(JSON.stringify({ type: 'pair_rejected', reason: 'No pending pairing' }));
    return;
  }

  if (new Date(pending.expiresAt) < new Date()) {
    log('Pending pairing expired — rejecting');
    relay.sendData(JSON.stringify({ type: 'pair_rejected', reason: 'Pairing code expired' }));
    config.pendingPairing = null;
    saveConfig(config);
    return;
  }

  const token = msg.oneTimeToken || msg.authToken;
  if (token !== pending.shortCode) {
    log('Invalid pairing code — rejecting');
    relay.sendData(JSON.stringify({ type: 'pair_rejected', reason: 'Invalid code' }));
    return;
  }

  // Pairing accepted!
  if (!msg.publicKey) {
    log('Pairing request missing public key — rejecting');
    relay.sendData(JSON.stringify({ type: 'pair_rejected', reason: 'Missing public key' }));
    return;
  }

  const device = {
    name: msg.deviceName || msg.deviceInfo?.name || `Device-${Date.now()}`,
    publicKey: msg.publicKey,
    pairedAt: new Date().toISOString(),
  };

  addPairedDevice(config, device);
  config.pendingPairing = null;
  saveConfig(config);

  log(`Device "${device.name}" paired successfully!`);

  // Send confirmation with our public key
  relay.sendData(JSON.stringify({
    type: 'pairing_success',
    hostPublicKey: serializedKP.publicKey,
    relayId: config.relayId,
    deviceName: device.name,
  }));
}

// --- Push Notifications ---

/**
 * Send an Expo push notification via the Expo Push API.
 * Docs: https://docs.expo.dev/push-notifications/sending-notifications/
 */
function sendExpoPushNotification(token, { title = 'Nora', body = 'New message', data = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      to: token,
      title,
      body,
      data,
      sound: 'default',
      priority: 'high',
    });

    const req = https.request(
      {
        hostname: 'exp.host',
        path: '/--/api/v2/push/send',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`Expo push API returned ${res.statusCode}: ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// --- Utilities ---

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [client] ${msg}`);
}

// --- Go ---

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
