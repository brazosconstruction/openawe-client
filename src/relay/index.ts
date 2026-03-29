import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { ConfigManager } from '../config';
import { PairingManager } from '../pairing';
import { CryptoManager } from '../crypto';
import { RelayMessage, DecryptedMessage, ConnectionState, RelayClientEvents, PairedDevice } from '../types';

export class RelayClient {
  private emitter: EventEmitter;
  private config: ConfigManager;
  private pairing: PairingManager;
  private ws: WebSocket | null = null;
  private connectionState: ConnectionState;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPingTime: number = 0;
  private isReconnecting: boolean = false;

  constructor(configDir?: string) {
    this.emitter = new EventEmitter();
    
    this.config = new ConfigManager(configDir);
    this.pairing = new PairingManager(this.config);
    
    this.connectionState = {
      status: 'disconnected',
      reconnectAttempts: 0,
    };
    
    this.setupEventListeners();
  }

  /**
   * Set up internal event listeners
   */
  private setupEventListeners(): void {
    // Event setup if needed
  }

  // EventEmitter interface methods
  on(event: string, listener: (...args: any[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    return this.emitter.emit(event, ...args);
  }

  once(event: string, listener: (...args: any[]) => void): this {
    this.emitter.once(event, listener);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  /**
   * Start the relay client connection
   */
  async start(): Promise<void> {
    const relayConfig = this.config.getConfig();
    
    if (!relayConfig.enabled) {
      throw new Error('Relay client is disabled in configuration');
    }
    
    await this.connect();
  }

  /**
   * Stop the relay client
   */
  async stop(): Promise<void> {
    this.isReconnecting = false;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.updateConnectionState({ status: 'disconnected', reconnectAttempts: 0 });
  }

  /**
   * Connect to the relay server
   */
  private async connect(): Promise<void> {
    const relayConfig = this.config.getConfig();
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return; // Already connected
    }
    
    this.updateConnectionState({ 
      status: this.connectionState.reconnectAttempts > 0 ? 'reconnecting' : 'connecting' 
    });
    
    try {
      this.ws = new WebSocket(relayConfig.relayServer);
      
      this.ws.on('open', () => {
        this.onConnected();
      });
      
      this.ws.on('message', (data: WebSocket.Data) => {
        this.onMessage(data);
      });
      
      this.ws.on('close', (code: number, reason: Buffer) => {
        this.onDisconnected(code, reason.toString());
      });
      
      this.ws.on('error', (error: Error) => {
        this.onError(error);
      });
      
      this.ws.on('pong', () => {
        const latency = Date.now() - this.lastPingTime;
        this.updateConnectionState({ latency });
      });
      
    } catch (error) {
      this.onError(error as Error);
    }
  }

  /**
   * Handle successful connection
   */
  private onConnected(): void {
    const relayConfig = this.config.getConfig();
    
    // Register with the relay server
    this.sendRelayMessage({
      type: 'register',
      relayId: relayConfig.relayId,
      role: 'host',
    });
    
    this.updateConnectionState({
      status: 'connected',
      lastConnected: new Date(),
      reconnectAttempts: 0,
    });
    
    this.startHeartbeat();
    this.emit('connected');
  }

  /**
   * Handle disconnection
   */
  private onDisconnected(code: number, reason: string): void {
    this.ws = null;
    
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    
    const wasConnected = this.connectionState.status === 'connected';
    this.updateConnectionState({ status: 'disconnected' });
    
    if (wasConnected) {
      this.emit('disconnected', reason || `WebSocket closed with code ${code}`);
    }
    
    // Auto-reconnect if not manually stopped
    if (!this.isReconnecting && this.config.getConfig().enabled) {
      this.scheduleReconnect();
    }
  }

  /**
   * Handle connection errors
   */
  private onError(error: Error): void {
    this.emit('error', error);
    
    // If connection failed, schedule reconnect
    if (this.connectionState.status === 'connecting' || this.connectionState.status === 'reconnecting') {
      this.scheduleReconnect();
    }
  }

  /**
   * Handle incoming messages
   */
  private onMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString()) as RelayMessage;
      
      switch (message.type) {
        case 'data':
          this.handleDataMessage(message);
          break;
        case 'status':
          // Handle status updates from relay
          break;
        case 'pong':
          // Handled by WebSocket pong event
          break;
        default:
          console.warn('Unknown relay message type:', message.type);
      }
      
    } catch (error) {
      this.emit('error', new Error(`Failed to parse relay message: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Handle encrypted data messages from mobile clients
   */
  private async handleDataMessage(message: RelayMessage): Promise<void> {
    if (!message.payload) {
      return;
    }
    
    try {
      const keypair = this.config.loadKeypair();
      
      // Try to decrypt with each paired device's public key
      const pairedDevices = this.config.listPairedDevices();
      let decrypted: any = null;
      let senderDevice: PairedDevice | null = null;
      
      for (const device of pairedDevices) {
        try {
          const devicePublicKey = Buffer.from(device.publicKey, 'base64');
          decrypted = CryptoManager.decryptMessage(message.payload, devicePublicKey, keypair.privateKey);
          senderDevice = device;
          break;
        } catch (error) {
          // Try next device
          continue;
        }
      }
      
      if (!decrypted || !senderDevice) {
        throw new Error('Could not decrypt message - no matching paired device found');
      }
      
      // Parse the decrypted message
      const decryptedMessage: DecryptedMessage = {
        ...decrypted,
        deviceId: senderDevice.id,
        timestamp: decrypted.timestamp || Date.now(),
      };
      
      // Emit specific events based on message type
      switch (decryptedMessage.type) {
        case 'chat':
          this.emit('message', decryptedMessage);
          break;
        case 'audio':
          if (decryptedMessage.data && Buffer.isBuffer(decryptedMessage.data)) {
            this.emit('audio', decryptedMessage.data, senderDevice.id);
          }
          break;
        case 'command':
        case 'status':
          this.emit('message', decryptedMessage);
          break;
      }
      
    } catch (error) {
      this.emit('error', new Error(`Failed to handle data message: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Send an encrypted message to a paired device
   */
  async sendMessage(deviceId: string, messageType: string, data: any): Promise<void> {
    const device = this.config.getPairedDevice(deviceId);
    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }
    
    const keypair = this.config.loadKeypair();
    const devicePublicKey = Buffer.from(device.publicKey, 'base64');
    
    const message = {
      type: messageType,
      data,
      timestamp: Date.now(),
    };
    
    const encryptedPayload = CryptoManager.encryptMessage(message, devicePublicKey, keypair.privateKey);
    
    await this.sendRelayMessage({
      type: 'data',
      payload: encryptedPayload,
    });
  }

  /**
   * Send message to all paired devices
   */
  async broadcast(messageType: string, data: any): Promise<void> {
    const devices = this.config.listPairedDevices();
    
    for (const device of devices) {
      try {
        await this.sendMessage(device.id, messageType, data);
      } catch (error) {
        this.emit('error', new Error(`Failed to send to device ${device.id}: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }

  /**
   * Send a raw relay protocol message
   */
  private async sendRelayMessage(message: RelayMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to relay server');
    }
    
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.lastPingTime = Date.now();
        this.ws.ping();
        
        // Also send ping message
        this.sendRelayMessage({ type: 'ping' }).catch(error => {
          this.emit('error', error);
        });
      }
    }, 30000); // 30 seconds
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }
    
    this.isReconnecting = true;
    this.connectionState.reconnectAttempts++;
    
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    const delay = Math.min(1000 * Math.pow(2, this.connectionState.reconnectAttempts - 1), 30000);
    
    this.updateConnectionState({ status: 'reconnecting' });
    this.emit('reconnecting', this.connectionState.reconnectAttempts);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Update connection state and emit event
   */
  private updateConnectionState(updates: Partial<ConnectionState>): void {
    this.connectionState = { ...this.connectionState, ...updates };
    this.emit('statusUpdate', this.connectionState);
  }

  // Public API methods

  /**
   * Get current connection status
   */
  getConnectionState(): ConnectionState {
    return { ...this.connectionState };
  }

  /**
   * Get configuration manager
   */
  getConfigManager(): ConfigManager {
    return this.config;
  }

  /**
   * Get pairing manager
   */
  getPairingManager(): PairingManager {
    return this.pairing;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connectionState.status === 'connected';
  }

  /**
   * Force reconnection
   */
  async reconnect(): Promise<void> {
    await this.stop();
    await this.start();
  }
}

export { ConfigManager, PairingManager, CryptoManager };