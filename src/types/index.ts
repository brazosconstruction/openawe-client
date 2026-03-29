export interface RelayConfig {
  relayId: string;
  relayServer: string;
  enabled: boolean;
  keypairPath: string;
  pairedDevices: PairedDevice[];
}

export interface PairedDevice {
  name: string;
  publicKey: string;
  pairedAt: string;
  id: string;
}

export interface KeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

export interface PairingPayload {
  relayId: string;
  publicKey: string;
  relayServer: string;
  authToken: string;
  expiresAt: number;
}

export interface RelayMessage {
  type: 'register' | 'data' | 'ping' | 'pong' | 'status';
  relayId?: string;
  role?: 'host' | 'client';
  payload?: string;
  online?: boolean;
}

export interface DecryptedMessage {
  type: 'chat' | 'audio' | 'command' | 'status';
  data: any;
  timestamp: number;
  deviceId?: string;
}

export interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  lastConnected?: Date;
  reconnectAttempts: number;
  latency?: number;
}

export interface RelayClientEvents extends Record<string, any[]> {
  connected: [];
  disconnected: [reason: string];
  reconnecting: [attempt: number];
  paired: [device: PairedDevice];
  unpaired: [deviceId: string];
  message: [message: DecryptedMessage];
  audio: [audioData: Buffer, deviceId: string];
  error: [error: Error];
  statusUpdate: [status: ConnectionState];
}