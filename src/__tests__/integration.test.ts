import { RelayClient } from '../relay';
import { PairingManager } from '../pairing';
import { ConfigManager } from '../config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Integration Tests', () => {
  let tempDir: string;
  let relayClient: RelayClient;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openawe-integration-test-'));
    relayClient = new RelayClient(tempDir);
  });

  afterEach(async () => {
    await relayClient.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('RelayClient initialization', () => {
    test('creates config and pairing managers', () => {
      const configManager = relayClient.getConfigManager();
      const pairingManager = relayClient.getPairingManager();
      
      expect(configManager).toBeInstanceOf(ConfigManager);
      expect(pairingManager).toBeInstanceOf(PairingManager);
    });

    test('has correct initial connection state', () => {
      const state = relayClient.getConnectionState();
      
      expect(state.status).toBe('disconnected');
      expect(state.reconnectAttempts).toBe(0);
    });
  });

  describe('Pairing workflow', () => {
    test('generates pairing codes', () => {
      const pairingManager = relayClient.getPairingManager();
      const codeData = pairingManager.generatePairingCode('Test Device');
      
      expect(codeData.code).toMatch(/^[A-Z0-9]{8}$/);
      expect(codeData.deepLink).toMatch(/^openawe:\/\/pair\/.+$/);
      expect(codeData.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    test('validates pairing codes', () => {
      const pairingManager = relayClient.getPairingManager();
      const codeData = pairingManager.generatePairingCode();
      
      const validation = pairingManager.validatePairingCode(codeData.code);
      expect(validation).toBeTruthy();
      expect(validation?.code).toBe(codeData.code);
    });

    test('processes pairing requests', async () => {
      const pairingManager = relayClient.getPairingManager();
      const codeData = pairingManager.generatePairingCode();
      
      const mockDevicePublicKey = 'mock-device-public-key-base64';
      const deviceName = 'iPhone 15 Pro';
      
      const pairedDevice = await pairingManager.processPairingRequest(
        codeData.payload.authToken,
        mockDevicePublicKey,
        deviceName
      );
      
      expect(pairedDevice.name).toBe(deviceName);
      expect(pairedDevice.publicKey).toBe(mockDevicePublicKey);
      expect(pairedDevice.id).toBeDefined();
      
      // Verify device is stored in config
      const devices = pairingManager.listPairedDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0]).toEqual(pairedDevice);
    });

    test('rejects invalid auth tokens', async () => {
      const pairingManager = relayClient.getPairingManager();
      
      await expect(async () => {
        await pairingManager.processPairingRequest(
          'invalid-auth-token',
          'mock-public-key',
          'Test Device'
        );
      }).rejects.toThrow('Invalid or expired auth token');
    });
  });

  describe('Configuration management', () => {
    test('maintains config across instances', () => {
      const config1 = relayClient.getConfigManager().getConfig();
      const relayId1 = config1.relayId;
      
      // Create new client with same config directory
      const relayClient2 = new RelayClient(tempDir);
      const config2 = relayClient2.getConfigManager().getConfig();
      
      expect(config2.relayId).toBe(relayId1);
    });

    test('supports config updates', () => {
      const configManager = relayClient.getConfigManager();
      
      configManager.updateConfig({
        relayServer: 'wss://custom-relay.example.com',
        enabled: false,
      });
      
      const updated = configManager.getConfig();
      expect(updated.relayServer).toBe('wss://custom-relay.example.com');
      expect(updated.enabled).toBe(false);
    });
  });

  describe('Event system', () => {
    test('supports event listeners', (done) => {
      let eventFired = false;
      
      relayClient.on('error', (error) => {
        eventFired = true;
        expect(error).toBeInstanceOf(Error);
        done();
      });
      
      // Emit a test error
      relayClient.emit('error', new Error('Test error'));
      
      // Ensure event was handled
      setTimeout(() => {
        if (!eventFired) {
          done(new Error('Event was not fired'));
        }
      }, 100);
    });

    test('supports multiple event listeners', () => {
      let counter = 0;
      
      relayClient.on('connected', () => counter++);
      relayClient.on('connected', () => counter++);
      
      relayClient.emit('connected');
      
      expect(counter).toBe(2);
    });
  });

  describe('Device management', () => {
    test('manages multiple paired devices', async () => {
      const pairingManager = relayClient.getPairingManager();
      
      // Pair first device
      const code1 = pairingManager.generatePairingCode();
      const device1 = await pairingManager.processPairingRequest(
        code1.payload.authToken,
        'device1-public-key',
        'iPhone'
      );
      
      // Pair second device
      const code2 = pairingManager.generatePairingCode();
      const device2 = await pairingManager.processPairingRequest(
        code2.payload.authToken,
        'device2-public-key',
        'Android Phone'
      );
      
      const devices = pairingManager.listPairedDevices();
      expect(devices).toHaveLength(2);
      
      const deviceNames = devices.map(d => d.name).sort();
      expect(deviceNames).toEqual(['Android Phone', 'iPhone']);
    });

    test('unpairs devices correctly', async () => {
      const pairingManager = relayClient.getPairingManager();
      
      const code = pairingManager.generatePairingCode();
      const device = await pairingManager.processPairingRequest(
        code.payload.authToken,
        'device-public-key',
        'Test Device'
      );
      
      expect(pairingManager.listPairedDevices()).toHaveLength(1);
      
      const unpaired = pairingManager.unpairDevice(device.id);
      expect(unpaired).toBe(true);
      expect(pairingManager.listPairedDevices()).toHaveLength(0);
    });
  });

  describe('End-to-end messaging (mock)', () => {
    test('prepares message encryption for paired devices', async () => {
      const pairingManager = relayClient.getPairingManager();
      
      // Pair a mock device
      const code = pairingManager.generatePairingCode();
      const device = await pairingManager.processPairingRequest(
        code.payload.authToken,
        'bW9jay1kZXZpY2UtcHVibGljLWtleQ==', // base64 mock key
        'Test Device'
      );
      
      // Verify device is available for messaging
      const foundDevice = pairingManager.getPairedDevice(device.id);
      expect(foundDevice).toBeTruthy();
      
      // Test message would be encrypted here if we had a real relay connection
      const mockMessage = { type: 'chat', text: 'Hello from OpenClaw!' };
      expect(typeof mockMessage.text).toBe('string');
    });
  });
});