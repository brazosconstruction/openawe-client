import { ConfigManager } from '../config';
import { PairedDevice } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('ConfigManager', () => {
  let tempDir: string;
  let configManager: ConfigManager;

  beforeEach(() => {
    // Create a temporary directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openawe-test-'));
    configManager = new ConfigManager(tempDir);
  });

  afterEach(() => {
    // Clean up temporary directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Initialization', () => {
    test('creates default config on first run', () => {
      const config = configManager.getConfig();
      
      expect(config.relayId).toBeDefined();
      expect(config.relayId).toHaveLength(36); // UUID length
      expect(config.relayServer).toBe('wss://relay.openawe.com/v1/connect');
      expect(config.enabled).toBe(true);
      expect(config.pairedDevices).toEqual([]);
      expect(config.keypairPath).toContain('keypair.json');
    });

    test('creates config and key files', () => {
      const paths = configManager.getPaths();
      
      expect(fs.existsSync(paths.configPath)).toBe(true);
      expect(fs.existsSync(paths.keypairPath)).toBe(true);
    });

    test('loads existing config', () => {
      const originalConfig = configManager.getConfig();
      const originalRelayId = originalConfig.relayId;
      
      // Create a new config manager for the same directory
      const configManager2 = new ConfigManager(tempDir);
      const loadedConfig = configManager2.getConfig();
      
      expect(loadedConfig.relayId).toBe(originalRelayId);
    });
  });

  describe('Configuration management', () => {
    test('updates config fields', () => {
      configManager.updateConfig({
        enabled: false,
        relayServer: 'wss://custom-relay.example.com',
      });
      
      const config = configManager.getConfig();
      expect(config.enabled).toBe(false);
      expect(config.relayServer).toBe('wss://custom-relay.example.com');
    });

    test('persists config updates', () => {
      configManager.updateConfig({ enabled: false });
      
      // Create new config manager to verify persistence
      const configManager2 = new ConfigManager(tempDir);
      const config = configManager2.getConfig();
      
      expect(config.enabled).toBe(false);
    });
  });

  describe('Keypair management', () => {
    test('loads keypair', () => {
      const keypair = configManager.loadKeypair();
      
      expect(keypair.publicKey).toBeInstanceOf(Buffer);
      expect(keypair.privateKey).toBeInstanceOf(Buffer);
      expect(keypair.publicKey.length).toBe(32);
      expect(keypair.privateKey.length).toBe(32);
    });

    test('regenerates keypair', () => {
      const originalKeypair = configManager.loadKeypair();
      const newKeypair = configManager.regenerateKeypair();
      
      expect(newKeypair.publicKey.equals(originalKeypair.publicKey)).toBe(false);
      expect(newKeypair.privateKey.equals(originalKeypair.privateKey)).toBe(false);
      
      // Verify paired devices were cleared
      const config = configManager.getConfig();
      expect(config.pairedDevices).toEqual([]);
    });

    test('regenerates relay ID', () => {
      const originalConfig = configManager.getConfig();
      const originalRelayId = originalConfig.relayId;
      
      const newRelayId = configManager.regenerateRelayId();
      
      expect(newRelayId).not.toBe(originalRelayId);
      expect(newRelayId).toHaveLength(36);
      
      // Verify paired devices were cleared
      const config = configManager.getConfig();
      expect(config.pairedDevices).toEqual([]);
    });
  });

  describe('Paired device management', () => {
    const mockDevice: PairedDevice = {
      id: 'test-device-id',
      name: 'Test Device',
      publicKey: 'dGVzdC1wdWJsaWMta2V5',
      pairedAt: new Date().toISOString(),
    };

    test('adds paired device', () => {
      configManager.addPairedDevice(mockDevice);
      
      const devices = configManager.listPairedDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0]).toEqual(mockDevice);
    });

    test('retrieves paired device by ID', () => {
      configManager.addPairedDevice(mockDevice);
      
      const device = configManager.getPairedDevice(mockDevice.id);
      expect(device).toEqual(mockDevice);
    });

    test('retrieves paired device by public key', () => {
      configManager.addPairedDevice(mockDevice);
      
      const device = configManager.getPairedDeviceByPublicKey(mockDevice.publicKey);
      expect(device).toEqual(mockDevice);
    });

    test('removes paired device', () => {
      configManager.addPairedDevice(mockDevice);
      
      const removed = configManager.removePairedDevice(mockDevice.id);
      expect(removed).toBe(true);
      
      const devices = configManager.listPairedDevices();
      expect(devices).toHaveLength(0);
    });

    test('returns false when removing non-existent device', () => {
      const removed = configManager.removePairedDevice('non-existent-id');
      expect(removed).toBe(false);
    });

    test('replaces device with same ID', () => {
      configManager.addPairedDevice(mockDevice);
      
      const updatedDevice = { ...mockDevice, name: 'Updated Device Name' };
      configManager.addPairedDevice(updatedDevice);
      
      const devices = configManager.listPairedDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].name).toBe('Updated Device Name');
    });

    test('handles multiple paired devices', () => {
      const device1 = { ...mockDevice, id: 'device-1', name: 'Device 1' };
      const device2 = { ...mockDevice, id: 'device-2', name: 'Device 2' };
      
      configManager.addPairedDevice(device1);
      configManager.addPairedDevice(device2);
      
      const devices = configManager.listPairedDevices();
      expect(devices).toHaveLength(2);
      
      const names = devices.map(d => d.name).sort();
      expect(names).toEqual(['Device 1', 'Device 2']);
    });
  });

  describe('Error handling', () => {
    test('handles corrupted config file', () => {
      const paths = configManager.getPaths();
      
      // Write invalid JSON to config file
      fs.writeFileSync(paths.configPath, 'invalid json content');
      
      // Should create new config instead of crashing
      const configManager2 = new ConfigManager(tempDir);
      const config = configManager2.getConfig();
      
      expect(config.relayId).toBeDefined();
      expect(config.enabled).toBe(true);
    });

    test('handles missing keypair file', () => {
      const paths = configManager.getPaths();
      
      // Delete keypair file
      fs.unlinkSync(paths.keypairPath);
      
      expect(() => {
        configManager.loadKeypair();
      }).toThrow('Keypair file not found');
    });

    test('handles corrupted keypair file', () => {
      const paths = configManager.getPaths();
      
      // Write invalid JSON to keypair file
      fs.writeFileSync(paths.keypairPath, 'invalid json content');
      
      expect(() => {
        configManager.loadKeypair();
      }).toThrow('Failed to load keypair');
    });
  });
});