import { v4 as uuidv4 } from 'uuid';
import { CryptoManager } from '../crypto';
import { ConfigManager } from '../config';
import { PairingPayload, PairedDevice } from '../types';

export interface PairingCodeData {
  code: string;
  deepLink: string;
  payload: PairingPayload;
  expiresAt: Date;
}

export class PairingManager {
  private config: ConfigManager;
  private activePairingCodes: Map<string, PairingCodeData> = new Map();

  constructor(config: ConfigManager) {
    this.config = config;
    
    // Clean up expired codes every minute
    setInterval(() => this.cleanupExpiredCodes(), 60000);
  }

  /**
   * Generate a new pairing code and deep link
   */
  generatePairingCode(deviceName?: string): PairingCodeData {
    const relayConfig = this.config.getConfig();
    const keypair = this.config.loadKeypair();
    
    const code = CryptoManager.generatePairingCode();
    const authToken = CryptoManager.generateAuthToken();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    
    const payload: PairingPayload = {
      relayId: relayConfig.relayId,
      publicKey: keypair.publicKey.toString('base64'),
      relayServer: relayConfig.relayServer,
      authToken,
      expiresAt: expiresAt.getTime(),
    };
    
    const deepLink = CryptoManager.generatePairingDeepLink(payload);
    
    const codeData: PairingCodeData = {
      code,
      deepLink,
      payload,
      expiresAt,
    };
    
    // Store the code for validation
    this.activePairingCodes.set(code, codeData);
    this.activePairingCodes.set(authToken, codeData); // Also index by auth token
    
    return codeData;
  }

  /**
   * Process an incoming pairing request from a mobile device
   */
  async processPairingRequest(
    authToken: string, 
    devicePublicKey: string, 
    deviceName: string = 'Unknown Device'
  ): Promise<PairedDevice> {
    // Find the pairing code data by auth token
    const codeData = this.activePairingCodes.get(authToken);
    if (!codeData) {
      throw new Error('Invalid or expired auth token');
    }
    
    // Verify not expired
    if (Date.now() > codeData.expiresAt.getTime()) {
      this.activePairingCodes.delete(authToken);
      this.activePairingCodes.delete(codeData.code);
      throw new Error('Pairing code has expired');
    }
    
    // Create paired device record
    const deviceId = uuidv4();
    const pairedDevice: PairedDevice = {
      id: deviceId,
      name: deviceName,
      publicKey: devicePublicKey,
      pairedAt: new Date().toISOString(),
    };
    
    // Add to config
    this.config.addPairedDevice(pairedDevice);
    
    // Clean up the used pairing code
    this.activePairingCodes.delete(authToken);
    this.activePairingCodes.delete(codeData.code);
    
    return pairedDevice;
  }

  /**
   * Validate a pairing code (for manual entry)
   */
  validatePairingCode(code: string): PairingCodeData | null {
    const codeData = this.activePairingCodes.get(code);
    if (!codeData) {
      return null;
    }
    
    // Check if expired
    if (Date.now() > codeData.expiresAt.getTime()) {
      this.activePairingCodes.delete(code);
      this.activePairingCodes.delete(codeData.payload.authToken);
      return null;
    }
    
    return codeData;
  }

  /**
   * Revoke/unpair a device
   */
  unpairDevice(deviceId: string): boolean {
    return this.config.removePairedDevice(deviceId);
  }

  /**
   * List all paired devices
   */
  listPairedDevices(): PairedDevice[] {
    return this.config.listPairedDevices();
  }

  /**
   * Get a specific paired device
   */
  getPairedDevice(deviceId: string): PairedDevice | undefined {
    return this.config.getPairedDevice(deviceId);
  }

  /**
   * Find device by public key
   */
  findDeviceByPublicKey(publicKey: string): PairedDevice | undefined {
    return this.config.getPairedDeviceByPublicKey(publicKey);
  }

  /**
   * Get active pairing codes (for debugging)
   */
  getActivePairingCodes(): PairingCodeData[] {
    this.cleanupExpiredCodes();
    return Array.from(this.activePairingCodes.values())
      .filter((data, index, arr) => 
        // Deduplicate (same data stored under code and authToken)
        arr.findIndex(d => d.code === data.code) === index
      );
  }

  /**
   * Clean up expired pairing codes
   */
  private cleanupExpiredCodes(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];
    
    for (const [key, data] of this.activePairingCodes) {
      if (now > data.expiresAt.getTime()) {
        expiredKeys.push(key);
      }
    }
    
    for (const key of expiredKeys) {
      this.activePairingCodes.delete(key);
    }
  }

  /**
   * Clear all active pairing codes (for testing)
   */
  clearActivePairingCodes(): void {
    this.activePairingCodes.clear();
  }
}

export { PairingPayload, PairedDevice };