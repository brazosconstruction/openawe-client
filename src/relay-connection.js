/**
 * relay-connection.js — WebSocket connection to the OpenAwe relay server
 *
 * Handles:
 * - Registration as "host" role with relayId
 * - Auto-reconnect with exponential backoff
 * - Application-level heartbeat (ping/pong)
 * - Message routing to/from the relay
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

class RelayConnection extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.relayServerUrl - WebSocket URL (e.g. ws://localhost:8090/v1/connect)
   * @param {string} opts.relayId - Unique ID for this OpenClaw instance
   */
  constructor(opts) {
    super();
    this.relayServerUrl = opts.relayServerUrl;
    this.relayId = opts.relayId;
    this.ws = null;
    this.registered = false;
    this.partnerOnline = false;
    this.destroyed = false;

    // Reconnect settings
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000; // 30s max
    this.baseReconnectDelay = 1000; // 1s base
    this.reconnectTimer = null;

    // Heartbeat
    this.heartbeatInterval = null;
    this.heartbeatMs = 25000; // 25s (relay expects 30s)
  }

  /** Connect to the relay server */
  connect() {
    if (this.destroyed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return; // Already connected/connecting
    }

    this._log(`Connecting to ${this.relayServerUrl}...`);

    try {
      this.ws = new WebSocket(this.relayServerUrl);
    } catch (err) {
      this._log(`Connection error: ${err.message}`);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this._log('Connected to relay');
      this.reconnectAttempts = 0;

      // Register as host
      this._send({
        type: 'register',
        relayId: this.relayId,
        role: 'host',
      });

      // Start heartbeat
      this._startHeartbeat();
    });

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        this._log('Received invalid JSON from relay');
        return;
      }

      switch (msg.type) {
        case 'registered':
          this.registered = true;
          this._log(`Registered as ${msg.role} for relay ${msg.relayId}`);
          this.emit('registered', msg);
          break;

        case 'status':
          this.partnerOnline = msg.online;
          this._log(`Partner (${msg.partnerRole}) is ${msg.online ? 'ONLINE' : 'OFFLINE'}`);
          this.emit('partnerStatus', msg);
          break;

        case 'data':
          // Encrypted message from the app
          this.emit('data', msg.payload);
          break;

        case 'pong':
          // Heartbeat response
          break;

        case 'error':
          this._log(`Relay error: ${msg.message}`);
          this.emit('relayError', msg);
          break;

        default:
          this._log(`Unknown message type: ${msg.type}`);
      }
    });

    this.ws.on('close', (code, reason) => {
      this._log(`Disconnected from relay (code=${code}, reason=${reason || 'none'})`);
      this.registered = false;
      this.partnerOnline = false;
      this._stopHeartbeat();
      this.emit('disconnected', { code, reason: reason?.toString() });

      if (!this.destroyed && code !== 4409) {
        this._scheduleReconnect();
      } else if (code === 4409) {
        this._log('Replaced by new connection — not reconnecting (another client instance may be running)');
      }
    });

    this.ws.on('error', (err) => {
      this._log(`WebSocket error: ${err.message}`);
      // 'close' event will fire after this
    });
  }

  /** Send encrypted data payload to the partner (the app) */
  sendData(payload) {
    if (!this.registered || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this._log('Cannot send: not connected/registered');
      return false;
    }
    this._send({ type: 'data', payload });
    return true;
  }

  /** Gracefully disconnect */
  disconnect() {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, 'Client shutting down');
      this.ws = null;
    }
  }

  /** Check if connected and registered */
  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN && this.registered;
  }

  // --- Internal ---

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this._send({ type: 'ping' });
      }
    }, this.heartbeatMs);
  }

  _stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  _scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;

    this.reconnectAttempts++;
    // Exponential backoff with jitter
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1) + Math.random() * 1000,
      this.maxReconnectDelay
    );
    this._log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [relay] ${msg}`);
  }
}

module.exports = { RelayConnection };
