/**
 * openclaw-api.js — OpenClaw Gateway WebSocket Client for OpenAwe
 *
 * Connects directly to the OpenClaw Gateway WebSocket API using the
 * native JSON-RPC protocol. Replaces the previous CLI-based approach.
 *
 * Protocol:
 *   - Request:  { type: "req", id, method, params }
 *   - Response: { type: "res", id, ok, payload|error }
 *   - Events:   { type: "event", event, payload, seq }
 *
 * Device Pairing:
 *   Uses OpenClaw's device pairing protocol to obtain operator.write scope.
 *   On first connection, creates a pairing request that must be approved via
 *   `openclaw devices` CLI. After approval, the device token is stored locally
 *   and used for subsequent connections.
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789';
const DEFAULT_AUTH_TOKEN = '9d8c89c5669fb8c7ca635929203b158d1e0dc92d182c3bd6';

const CONNECT_TIMEOUT_MS = 15000;
const CHAT_TIMEOUT_MS = 180000;
const PROBE_TIMEOUT_MS = 5000;
const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 15000;
const PAIRING_POLL_INTERVAL_MS = 3000;
const PAIRING_MAX_WAIT_MS = 300000; // 5 minutes

const DEVICE_CONFIG_DIR = path.join(process.env.HOME, '.openclaw', 'relay');
const DEVICE_CONFIG_FILE = path.join(DEVICE_CONFIG_DIR, 'config.json');

// Must match one of GATEWAY_CLIENT_IDS in the gateway
const CLIENT_ID = 'cli';
const CLIENT_MODE = 'cli';
const CLIENT_VERSION = '0.1.0';

class OpenClawAPI {
  constructor(opts = {}) {
    this.echoMode = opts.echoMode || false;
    this.gatewayUrl = opts.gatewayUrl || DEFAULT_GATEWAY_URL;
    this.authToken = opts.authToken || DEFAULT_AUTH_TOKEN;
    this.sessionKey = opts.sessionKey || 'main';
    this.apiAvailable = null;

    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.closed = false;

    this.pending = new Map();
    this.chatListeners = new Map();

    this.backoffMs = RECONNECT_BASE_MS;
    this.reconnectTimer = null;
    this._connectTimer = null;
    this._connectResolve = null;
    this._connectReject = null;
    this._connectTimeout = null;
    this._connectSent = false;

    // Device pairing state
    this._deviceIdentity = null;
    this._pairingInProgress = false;
    this._challengeNonce = null;
  }

  _uuid() {
    return crypto.randomUUID();
  }

  // --- Device Identity Management ---

  /**
   * Load or create a stable device identity for gateway pairing.
   * Stores: { deviceId, publicKey, privateKeyPem, deviceToken }
   */
  _loadOrCreateDeviceIdentity() {
    if (this._deviceIdentity) return this._deviceIdentity;

    try {
      if (fs.existsSync(DEVICE_CONFIG_FILE)) {
        const raw = fs.readFileSync(DEVICE_CONFIG_FILE, 'utf-8');
        const config = JSON.parse(raw);
        if (config.gatewayDevice?.deviceId && config.gatewayDevice?.publicKey && config.gatewayDevice?.privateKeyPem) {
          this._deviceIdentity = config.gatewayDevice;
          console.log(`[openclaw-ws] Loaded device identity: ${this._deviceIdentity.deviceId.slice(0, 16)}...`);
          if (this._deviceIdentity.deviceToken) {
            console.log('[openclaw-ws] Device token found from previous pairing');
          }
          return this._deviceIdentity;
        }
      }
    } catch (err) {
      console.log(`[openclaw-ws] Could not load device config: ${err.message}`);
    }

    // Generate new Ed25519 keypair
    const keypair = crypto.generateKeyPairSync('ed25519');
    
    // Export as PEM for storage and signing
    const publicKeyPem = keypair.publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPem = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    
    // Get raw public key bytes for base64url encoding and device ID derivation
    const publicKeyDer = keypair.publicKey.export({ type: 'spki', format: 'der' });
    // Ed25519 SPKI DER is 44 bytes: 12 bytes header + 32 bytes raw key
    const publicKeyRaw = publicKeyDer.subarray(12);
    const publicKeyB64Url = publicKeyRaw.toString('base64url');

    // Device ID = SHA-256 of the raw public key bytes, hex-encoded
    const deviceId = crypto.createHash('sha256').update(publicKeyRaw).digest('hex');

    this._deviceIdentity = {
      deviceId,
      publicKey: publicKeyB64Url,
      publicKeyPem,
      privateKeyPem,
      deviceToken: null,
      createdAt: new Date().toISOString(),
    };

    this._saveDeviceIdentity();
    console.log(`[openclaw-ws] Created new device identity: ${deviceId.slice(0, 16)}...`);
    return this._deviceIdentity;
  }

  /**
   * Save device identity to config file
   */
  _saveDeviceIdentity() {
    try {
      if (!fs.existsSync(DEVICE_CONFIG_DIR)) {
        fs.mkdirSync(DEVICE_CONFIG_DIR, { recursive: true, mode: 0o700 });
      }

      let config = {};
      if (fs.existsSync(DEVICE_CONFIG_FILE)) {
        config = JSON.parse(fs.readFileSync(DEVICE_CONFIG_FILE, 'utf-8'));
      }

      config.gatewayDevice = this._deviceIdentity;
      fs.writeFileSync(DEVICE_CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`[openclaw-ws] Failed to save device identity: ${err.message}`);
    }
  }

  /**
   * Build the V3 device auth payload string and sign it.
   * Format: v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily
   */
  _buildSignedDeviceAuth(challengeNonce) {
    const identity = this._deviceIdentity;
    const signedAtMs = Date.now();
    const nonce = challengeNonce || this._uuid();
    const role = 'operator';
    const scopes = ['operator.admin', 'operator.write', 'operator.read'];
    // Token in signature must match what resolveSignatureToken picks from connectParams.auth
    // Priority: auth.token > auth.deviceToken > auth.bootstrapToken
    const token = this.authToken || identity.deviceToken || '';
    const platform = process.platform || 'darwin';
    const deviceFamily = 'desktop';

    // Build V3 payload
    const payloadV3 = [
      'v3',
      identity.deviceId,
      CLIENT_ID,
      CLIENT_MODE,
      role,
      scopes.join(','),
      String(signedAtMs),
      token,
      nonce,
      platform,
      deviceFamily,
    ].join('|');

    // Sign with private key
    const privateKey = crypto.createPrivateKey(identity.privateKeyPem);
    const signatureRaw = crypto.sign(null, Buffer.from(payloadV3, 'utf8'), privateKey);
    const signature = signatureRaw.toString('base64url');

    return { signature, signedAt: signedAtMs, nonce };
  }

  async probe() {
    if (this.echoMode) {
      console.log('[openclaw-ws] Echo mode — skipping probe');
      this.apiAvailable = false;
      return false;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try { testWs.close(); } catch {}
        console.log('[openclaw-ws] Gateway probe timed out');
        this.apiAvailable = false;
        resolve(false);
      }, PROBE_TIMEOUT_MS);

      let testWs;
      try {
        testWs = new WebSocket(this.gatewayUrl);
      } catch (err) {
        clearTimeout(timeout);
        console.log('[openclaw-ws] Gateway not reachable:', err.message);
        this.apiAvailable = false;
        resolve(false);
        return;
      }

      testWs.on('open', () => {
        clearTimeout(timeout);
        testWs.close();
        console.log('[openclaw-ws] Gateway is reachable');
        this.apiAvailable = true;
        resolve(true);
      });

      testWs.on('error', (err) => {
        clearTimeout(timeout);
        console.log('[openclaw-ws] Gateway probe error:', err.message);
        this.apiAvailable = false;
        resolve(false);
      });
    });
  }

  async connect() {
    if (this.connected) return;
    if (this.connecting) {
      return new Promise((resolve, reject) => {
        const check = setInterval(() => {
          if (this.connected) { clearInterval(check); resolve(); }
          if (!this.connecting) { clearInterval(check); reject(new Error('connect failed')); }
        }, 100);
        setTimeout(() => { clearInterval(check); reject(new Error('connect wait timeout')); }, CONNECT_TIMEOUT_MS);
      });
    }

    // Ensure device identity exists
    this._loadOrCreateDeviceIdentity();

    this.connecting = true;
    this.closed = false;
    this._connectSent = false;
    this._challengeNonce = null;

    return new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;

      this._connectTimeout = setTimeout(() => {
        this.connecting = false;
        this._connectResolve = null;
        this._connectReject = null;
        try { this.ws?.close(); } catch {}
        reject(new Error('Gateway connect timeout'));
      }, CONNECT_TIMEOUT_MS);

      try {
        this.ws = new WebSocket(this.gatewayUrl);
      } catch (err) {
        clearTimeout(this._connectTimeout);
        this.connecting = false;
        reject(err);
        return;
      }

      this.ws.on('open', () => {
        console.log('[openclaw-ws] WebSocket opened, awaiting challenge or sending connect...');
        this._connectTimer = setTimeout(() => {
          if (!this._connectSent) {
            this._sendConnect();
          }
        }, 750);
      });

      this.ws.on('message', (data) => {
        this._handleMessage(String(data));
      });

      this.ws.on('close', (code, reason) => {
        const reasonStr = String(reason || '');
        console.log(`[openclaw-ws] WebSocket closed (${code}): ${reasonStr}`);
        this.connected = false;
        this.connecting = false;
        this._connectSent = false;

        if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
        if (this._connectTimeout) { clearTimeout(this._connectTimeout); this._connectTimeout = null; }

        // Check if closed due to pairing requirement
        if (code === 1008 && reasonStr.includes('pairing required')) {
          if (this._connectReject && !this._pairingInProgress) {
            const pairingReject = this._connectReject;
            const pairingResolve = this._connectResolve;
            this._connectResolve = null;
            this._connectReject = null;
            this._handlePairingRequired(pairingResolve, pairingReject);
          }
          return;
        }

        // Reject the connect promise if still pending
        if (this._connectReject) {
          this._connectReject(new Error(`Gateway closed (${code}): ${reasonStr}`));
          this._connectResolve = null;
          this._connectReject = null;
        }

        // Flush pending RPC requests
        for (const [, p] of this.pending) {
          p.reject(new Error(`Gateway closed (${code})`));
          if (p.timer) clearTimeout(p.timer);
        }
        this.pending.clear();

        // Flush chat listeners
        for (const [, listener] of this.chatListeners) {
          listener.reject(new Error(`Gateway closed (${code})`));
          if (listener.timer) clearTimeout(listener.timer);
        }
        this.chatListeners.clear();

        if (!this.closed) {
          this._scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        console.error('[openclaw-ws] WebSocket error:', err.message);
      });
    });
  }

  _sendConnect() {
    if (this._connectSent) return;
    this._connectSent = true;

    const identity = this._deviceIdentity;
    const instanceId = this._uuid();
    const { signature, signedAt, nonce } = this._buildSignedDeviceAuth(this._challengeNonce);

    const connectParams = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: CLIENT_ID,
        version: CLIENT_VERSION,
        platform: process.platform || 'darwin',
        deviceFamily: 'desktop',
        mode: CLIENT_MODE,
        instanceId,
      },
      role: 'operator',
      scopes: ['operator.admin', 'operator.write', 'operator.read'],
      caps: ['tool-events'],
      device: {
        id: identity.deviceId,
        publicKey: identity.publicKey,
        signature,
        signedAt,
        nonce,
      },
      auth: {
        token: this.authToken,
      },
    };

    // If we have a device token from a previous pairing, include it
    if (identity.deviceToken) {
      connectParams.auth.deviceToken = identity.deviceToken;
    }

    this._request('connect', connectParams)
      .then((hello) => {
        if (this._connectTimeout) { clearTimeout(this._connectTimeout); this._connectTimeout = null; }
        this.connected = true;
        this.connecting = false;
        this.backoffMs = RECONNECT_BASE_MS;

        // Check if the gateway returned a device token in the hello response
        if (hello?.auth?.deviceToken && !identity.deviceToken) {
          identity.deviceToken = hello.auth.deviceToken;
          this._saveDeviceIdentity();
          console.log('[openclaw-ws] Received and saved device token from gateway');
        }

        console.log('[openclaw-ws] Connected and authenticated with device identity');
        if (this._connectResolve) {
          this._connectResolve();
          this._connectResolve = null;
          this._connectReject = null;
        }
      })
      .catch((err) => {
        if (this._connectTimeout) { clearTimeout(this._connectTimeout); this._connectTimeout = null; }
        this.connecting = false;

        // Check if device token was rejected (revoked/invalid)
        if (identity.deviceToken && (
          err.message?.includes('token_mismatch') ||
          err.message?.includes('device-token-mismatch') ||
          err.details?.code === 'AUTH_DEVICE_TOKEN_MISMATCH'
        )) {
          console.log('[openclaw-ws] Device token rejected — clearing and will re-pair');
          identity.deviceToken = null;
          this._saveDeviceIdentity();
        }

        console.error('[openclaw-ws] Connect auth failed:', err.message);
        try { this.ws?.close(); } catch {}
        if (this._connectReject) {
          this._connectReject(err);
          this._connectResolve = null;
          this._connectReject = null;
        }
      });
  }

  /**
   * Handle pairing requirement: poll for approval then reconnect
   */
  async _handlePairingRequired(resolve, reject) {
    if (this._pairingInProgress) return;
    this._pairingInProgress = true;

    const identity = this._deviceIdentity;

    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║              DEVICE PAIRING REQUIRED                    ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║                                                          ║');
    console.log('║  This OpenAwe client needs to be paired with the        ║');
    console.log('║  OpenClaw gateway to send messages.                     ║');
    console.log('║                                                          ║');
    console.log('║  To approve, run:                                        ║');
    console.log('║                                                          ║');
    console.log('║    openclaw devices                                      ║');
    console.log('║                                                          ║');
    console.log('║  Then approve the pending pairing request.              ║');
    console.log('║                                                          ║');
    console.log(`║  Device: ${identity.deviceId.slice(0, 20)}...                    ║`);
    console.log('║                                                          ║');
    console.log('║  Waiting for approval...                                 ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    const startTime = Date.now();

    while (Date.now() - startTime < PAIRING_MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, PAIRING_POLL_INTERVAL_MS));

      if (this.closed) {
        this._pairingInProgress = false;
        reject(new Error('Client closed during pairing'));
        return;
      }

      try {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        process.stdout.write(`\r[openclaw-ws] Checking if pairing approved... (${elapsed}s elapsed)  `);

        // Try a fresh connection
        await this._attemptReconnect();

        // If we get here, connection succeeded!
        console.log('');
        console.log('[openclaw-ws] Device pairing approved! Connected successfully.');
        console.log('');
        this._pairingInProgress = false;
        resolve();
        return;
      } catch (err) {
        // Still pending or other transient error, keep polling
        continue;
      }
    }

    // Timeout
    console.log('');
    this._pairingInProgress = false;
    reject(new Error('Pairing approval timeout (5 minutes). Run `openclaw devices` to approve.'));
  }

  /**
   * Attempt a single reconnection. Resolves if connected, rejects otherwise.
   */
  _attemptReconnect() {
    return new Promise((resolve, reject) => {
      this.connecting = false;
      this.connected = false;
      this._connectSent = false;
      this._challengeNonce = null;

      const timeout = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('connect timeout'));
      }, CONNECT_TIMEOUT_MS);

      let ws;
      try {
        ws = new WebSocket(this.gatewayUrl);
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }

      // Temporarily swap ws and handlers
      this.ws = ws;

      ws.on('open', () => {
        // Give gateway time to send challenge, then send connect
        const timer = setTimeout(() => {
          if (!this._connectSent) {
            this._connectSent = true;
            // Note: if challenge was received, _challengeNonce is already set via _handleMessage

            const identity = this._deviceIdentity;
            const instanceId = this._uuid();
            const { signature, signedAt, nonce } = this._buildSignedDeviceAuth(this._challengeNonce);

            const connectParams = {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: CLIENT_ID,
                version: CLIENT_VERSION,
                platform: process.platform || 'darwin',
                deviceFamily: 'desktop',
                mode: CLIENT_MODE,
                instanceId,
              },
              role: 'operator',
              scopes: ['operator.admin', 'operator.write', 'operator.read'],
              caps: ['tool-events'],
              device: {
                id: identity.deviceId,
                publicKey: identity.publicKey,
                signature,
                signedAt,
                nonce,
              },
              auth: {
                token: this.authToken,
              },
            };

            if (identity.deviceToken) {
              connectParams.auth.deviceToken = identity.deviceToken;
            }

            const reqId = this._uuid();
            const msg = { type: 'req', id: reqId, method: 'connect', params: connectParams };

            const reqTimeout = setTimeout(() => {
              this.pending.delete(reqId);
              clearTimeout(timeout);
              try { ws.close(); } catch {}
              reject(new Error('connect request timeout'));
            }, 10000);

            this.pending.set(reqId, {
              resolve: (hello) => {
                clearTimeout(timeout);
                clearTimeout(reqTimeout);
                this.connected = true;
                this.connecting = false;
                this.backoffMs = RECONNECT_BASE_MS;

                if (hello?.auth?.deviceToken && !identity.deviceToken) {
                  identity.deviceToken = hello.auth.deviceToken;
                  this._saveDeviceIdentity();
                  console.log('\n[openclaw-ws] Received and saved device token from gateway');
                }

                resolve();
              },
              reject: (err) => {
                clearTimeout(timeout);
                clearTimeout(reqTimeout);
                try { ws.close(); } catch {}
                reject(err);
              },
              timer: reqTimeout,
            });

            try {
              ws.send(JSON.stringify(msg));
            } catch (err) {
              this.pending.delete(reqId);
              clearTimeout(reqTimeout);
              clearTimeout(timeout);
              reject(err);
            }
          }
        }, 750);

        // Also handle challenge event
        ws.on('message', (data) => {
          this._handleMessage(String(data));
        });
      });

      ws.on('close', (code, reason) => {
        clearTimeout(timeout);
        const reasonStr = String(reason || '');
        this.connected = false;
        this.connecting = false;
        this._connectSent = false;

        // Flush pending
        for (const [, p] of this.pending) {
          p.reject(new Error(`closed (${code}): ${reasonStr}`));
          if (p.timer) clearTimeout(p.timer);
        }
        this.pending.clear();

        reject(new Error(`closed (${code}): ${reasonStr}`));
      });

      ws.on('error', () => {});
    });
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'event') {
      if (msg.event === 'connect.challenge') {
        // Capture the nonce from the challenge
        if (msg.payload?.nonce) {
          this._challengeNonce = msg.payload.nonce;
        }
        if (this._connectTimer) {
          clearTimeout(this._connectTimer);
          this._connectTimer = null;
        }
        if (!this._connectSent) {
          this._sendConnect();
        }
        return;
      }

      if (msg.event === 'chat') {
        this._handleChatEvent(msg.payload);
        return;
      }

      return;
    }

    if (msg.type === 'res') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);

      if (msg.ok) {
        pending.resolve(msg.payload);
      } else {
        const err = new Error(msg.error?.message || 'request failed');
        err.code = msg.error?.code;
        err.details = msg.error?.details;
        pending.reject(err);
      }
    }
  }

  _handleChatEvent(payload) {
    if (!payload) return;
    const { runId, state, sessionKey } = payload;

    for (const [listenerId, listener] of this.chatListeners) {
      if (listener.runId === runId || (!listener.runId && listener.sessionKey === sessionKey)) {
        if (!listener.runId && runId) {
          listener.runId = runId;
        }

        if (state === 'delta') {
          const text = this._extractText(payload.message);
          if (text) listener.buffer = text;
        } else if (state === 'final') {
          const text = this._extractText(payload.message);
          if (text) listener.buffer = text;
          if (listener.timer) clearTimeout(listener.timer);
          this.chatListeners.delete(listenerId);
          listener.resolve(listener.buffer || '');
        } else if (state === 'aborted') {
          if (listener.timer) clearTimeout(listener.timer);
          this.chatListeners.delete(listenerId);
          listener.resolve(listener.buffer || '[Response aborted]');
        } else if (state === 'error') {
          if (listener.timer) clearTimeout(listener.timer);
          this.chatListeners.delete(listenerId);
          listener.reject(new Error(payload.errorMessage || 'chat error'));
        }
        return;
      }
    }
  }

  _extractText(message) {
    if (!message) return null;
    if (typeof message.text === 'string') return message.text;
    if (Array.isArray(message.content)) {
      const parts = message.content
        .filter(c => c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text);
      if (parts.length > 0) return parts.join('');
    }
    if (typeof message.content === 'string') return message.content;
    return null;
  }

  _request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Gateway not connected'));
        return;
      }

      const id = this._uuid();
      const msg = { type: 'req', id, method, params };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  _scheduleReconnect() {
    if (this.closed || this.reconnectTimer || this._pairingInProgress) return;
    console.log(`[openclaw-ws] Reconnecting in ${this.backoffMs}ms...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        console.log('[openclaw-ws] Reconnected successfully');
      } catch (err) {
        console.error('[openclaw-ws] Reconnect failed:', err.message);
        this.backoffMs = Math.min(this.backoffMs * 1.7, RECONNECT_MAX_MS);
        this._scheduleReconnect();
      }
    }, this.backoffMs);
  }

  async sendMessage(msg) {
    if (this.apiAvailable === null) {
      await this.probe();
    }

    if (!this.apiAvailable) {
      return this._echoResponse(msg);
    }

    if (!this.connected) {
      try {
        await this.connect();
      } catch (err) {
        console.error('[openclaw-ws] Failed to connect:', err.message);
        return {
          type: 'response',
          message: `Sorry, I couldn't connect to the gateway. Error: ${err.message}`,
          sessionId: msg.sessionId || 'default',
          error: true,
        };
      }
    }

    try {
      const messageText = typeof msg === 'string' ? msg : msg.message;
      const sessionKey = msg.sessionKey || this.sessionKey;
      const idempotencyKey = this._uuid();

      console.log(`[openclaw-ws] Sending: "${messageText.slice(0, 80)}"`);

      const responsePromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.chatListeners.delete(idempotencyKey);
          reject(new Error('Chat response timeout'));
        }, CHAT_TIMEOUT_MS);

        this.chatListeners.set(idempotencyKey, {
          runId: null,
          sessionKey,
          resolve,
          reject,
          buffer: '',
          timer,
        });
      });

      const chatPayload = {
        sessionKey,
        message: messageText,
        deliver: false,
        idempotencyKey,
      };

      // If message has a media path, include it in the message text
      if (msg.mediaPath) {
        chatPayload.message = messageText
          ? `${messageText}\n\n[Image: ${msg.mediaPath}]`
          : `[Image: ${msg.mediaPath}]`;
      }

      const ack = await this._request('chat.send', chatPayload);

      const listener = this.chatListeners.get(idempotencyKey);
      if (listener && ack?.runId) {
        listener.runId = ack.runId;
      }

      const responseText = await responsePromise;

      console.log(`[openclaw-ws] Response: "${String(responseText).slice(0, 80)}"`);

      return {
        type: 'response',
        message: responseText,
        sessionId: sessionKey,
        model: 'openclaw',
      };
    } catch (err) {
      console.error('[openclaw-ws] Send failed:', err.message);
      return {
        type: 'response',
        message: `Sorry, I couldn't process that right now. Error: ${err.message}`,
        sessionId: msg.sessionId || 'default',
        error: true,
      };
    }
  }

  _echoResponse(msg) {
    const messageText = typeof msg === 'string' ? msg : msg.message;
    return {
      type: 'response',
      message: `[Gateway unavailable] Echo: ${messageText}`,
      sessionId: msg.sessionId || 'echo-session',
      echoMode: true,
    };
  }

  disconnect() {
    this.closed = true;
    this.connected = false;
    this.connecting = false;
    this._connectSent = false;
    this._pairingInProgress = false;

    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
    if (this._connectTimeout) { clearTimeout(this._connectTimeout); this._connectTimeout = null; }

    for (const [, p] of this.pending) {
      p.reject(new Error('Client disconnected'));
      if (p.timer) clearTimeout(p.timer);
    }
    this.pending.clear();

    for (const [, listener] of this.chatListeners) {
      listener.reject(new Error('Client disconnected'));
      if (listener.timer) clearTimeout(listener.timer);
    }
    this.chatListeners.clear();

    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    console.log('[openclaw-ws] Disconnected');
  }
}

module.exports = { OpenClawAPI };
