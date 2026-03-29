import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { RelayConfig, PairedDevice, KeyPair } from '../types';
import { CryptoManager } from '../crypto';

export class ConfigManager {
  private configPath: string;
  private keysDir: string;
  private config: RelayConfig;

  constructor(configDir?: string) {
    const baseDir = configDir || path.join(os.homedir(), '.openclaw', 'relay');
    this.configPath = path.join(baseDir, 'config.json');
    this.keysDir = path.join(baseDir, 'keys');
    
    // Ensure directories exist
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(this.keysDir, { recursive: true });
    
    this.config = this.loadConfig();
  }

  /**
   * Load config from file or create default
   */
  private loadConfig(): RelayConfig {
    if (fs.existsSync(this.configPath)) {
      try {
        const data = fs.readFileSync(this.configPath, 'utf-8');
        const config = JSON.parse(data) as RelayConfig;
        
        // Validate and migrate if needed
        return this.validateAndMigrate(config);
      } catch (error) {
        console.warn('Failed to load config, creating new one:', error instanceof Error ? error.message : String(error));
      }
    }
    
    return this.createDefaultConfig();
  }

  /**
   * Create default configuration
   */
  private createDefaultConfig(): RelayConfig {
    const relayId = uuidv4();
    const keypairPath = path.join(this.keysDir, 'keypair.json');
    
    // Generate initial keypair
    this.generateAndSaveKeypair(keypairPath);
    
    const config: RelayConfig = {
      relayId,
      relayServer: 'wss://relay.openawe.com/v1/connect',
      enabled: true,
      keypairPath,
      pairedDevices: [],
    };
    
    this.saveConfig(config);
    return config;
  }

  /**
   * Validate and migrate older config versions
   */
  private validateAndMigrate(config: RelayConfig): RelayConfig {
    // Ensure required fields exist
    if (!config.relayId) config.relayId = uuidv4();
    if (!config.relayServer) config.relayServer = 'wss://relay.openawe.com/v1/connect';
    if (config.enabled === undefined) config.enabled = true;
    if (!config.keypairPath) {
      config.keypairPath = path.join(this.keysDir, 'keypair.json');
      this.generateAndSaveKeypair(config.keypairPath);
    }
    if (!config.pairedDevices) config.pairedDevices = [];
    
    // Ensure keypair file exists
    if (!fs.existsSync(config.keypairPath)) {
      this.generateAndSaveKeypair(config.keypairPath);
    }
    
    // Save migrated config
    this.saveConfig(config);
    return config;
  }

  /**
   * Generate and save a new keypair
   */
  private generateAndSaveKeypair(filepath: string): KeyPair {
    const keypair = CryptoManager.generateKeyPair();
    
    const keypairData = {
      publicKey: keypair.publicKey.toString('base64'),
      privateKey: keypair.privateKey.toString('base64'),
      createdAt: new Date().toISOString(),
    };
    
    fs.writeFileSync(filepath, JSON.stringify(keypairData, null, 2), {
      mode: 0o600, // Read/write for owner only
    });
    
    return keypair;
  }

  /**
   * Load keypair from file
   */
  loadKeypair(): KeyPair {
    if (!fs.existsSync(this.config.keypairPath)) {
      throw new Error(`Keypair file not found: ${this.config.keypairPath}`);
    }
    
    try {
      const data = fs.readFileSync(this.config.keypairPath, 'utf-8');
      const keypairData = JSON.parse(data);
      
      return {
        publicKey: Buffer.from(keypairData.publicKey, 'base64'),
        privateKey: Buffer.from(keypairData.privateKey, 'base64'),
      };
    } catch (error) {
      throw new Error(`Failed to load keypair: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Save current config to file
   */
  private saveConfig(config?: RelayConfig): void {
    const configToSave = config || this.config;
    
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(configToSave, null, 2), {
        mode: 0o600,
      });
      
      if (config) {
        this.config = config;
      }
    } catch (error) {
      throw new Error(`Failed to save config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): RelayConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<RelayConfig>): void {
    this.config = { ...this.config, ...updates };
    this.saveConfig();
  }

  /**
   * Add a paired device
   */
  addPairedDevice(device: PairedDevice): void {
    // Remove existing device with same ID if present
    this.config.pairedDevices = this.config.pairedDevices.filter(d => d.id !== device.id);
    
    // Add new device
    this.config.pairedDevices.push(device);
    
    this.saveConfig();
  }

  /**
   * Remove a paired device
   */
  removePairedDevice(deviceId: string): boolean {
    const initialLength = this.config.pairedDevices.length;
    this.config.pairedDevices = this.config.pairedDevices.filter(d => d.id !== deviceId);
    
    if (this.config.pairedDevices.length < initialLength) {
      this.saveConfig();
      return true;
    }
    
    return false;
  }

  /**
   * Get paired device by ID
   */
  getPairedDevice(deviceId: string): PairedDevice | undefined {
    return this.config.pairedDevices.find(d => d.id === deviceId);
  }

  /**
   * Get paired device by public key
   */
  getPairedDeviceByPublicKey(publicKey: string): PairedDevice | undefined {
    return this.config.pairedDevices.find(d => d.publicKey === publicKey);
  }

  /**
   * List all paired devices
   */
  listPairedDevices(): PairedDevice[] {
    return [...this.config.pairedDevices];
  }

  /**
   * Regenerate relay ID (forces re-pairing of all devices)
   */
  regenerateRelayId(): string {
    const newRelayId = uuidv4();
    this.updateConfig({ 
      relayId: newRelayId,
      pairedDevices: [], // Clear all paired devices
    });
    return newRelayId;
  }

  /**
   * Regenerate keypair (forces re-pairing of all devices)
   */
  regenerateKeypair(): KeyPair {
    const newKeypair = this.generateAndSaveKeypair(this.config.keypairPath);
    this.updateConfig({
      pairedDevices: [], // Clear all paired devices
    });
    return newKeypair;
  }

  /**
   * Get config file paths for debugging
   */
  getPaths(): { configPath: string; keysDir: string; keypairPath: string } {
    return {
      configPath: this.configPath,
      keysDir: this.keysDir,
      keypairPath: this.config.keypairPath,
    };
  }
}

export { RelayConfig, PairedDevice };