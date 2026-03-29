import { CryptoManager, PairingPayload } from '../crypto';
import { randomBytes } from 'crypto';

describe('CryptoManager', () => {
  describe('Key pair generation', () => {
    test('generates valid key pairs', () => {
      const keypair = CryptoManager.generateKeyPair();
      
      expect(keypair.publicKey).toBeInstanceOf(Buffer);
      expect(keypair.privateKey).toBeInstanceOf(Buffer);
      expect(keypair.publicKey.length).toBe(32); // X25519 public key size
      expect(keypair.privateKey.length).toBe(32); // X25519 private key size
    });

    test('generates different key pairs each time', () => {
      const keypair1 = CryptoManager.generateKeyPair();
      const keypair2 = CryptoManager.generateKeyPair();
      
      expect(keypair1.publicKey.equals(keypair2.publicKey)).toBe(false);
      expect(keypair1.privateKey.equals(keypair2.privateKey)).toBe(false);
    });
  });

  describe('Encryption/Decryption', () => {
    test('encrypts and decrypts messages correctly', () => {
      const aliceKeypair = CryptoManager.generateKeyPair();
      const bobKeypair = CryptoManager.generateKeyPair();
      
      const originalMessage = Buffer.from('Hello, this is a secret message!');
      
      // Alice encrypts for Bob
      const encrypted = CryptoManager.encrypt(originalMessage, bobKeypair.publicKey, aliceKeypair.privateKey);
      
      // Bob decrypts from Alice
      const decrypted = CryptoManager.decrypt(encrypted, aliceKeypair.publicKey, bobKeypair.privateKey);
      
      expect(decrypted.toString()).toBe(originalMessage.toString());
    });

    test('fails to decrypt with wrong keys', () => {
      const aliceKeypair = CryptoManager.generateKeyPair();
      const bobKeypair = CryptoManager.generateKeyPair();
      const charlieKeypair = CryptoManager.generateKeyPair();
      
      const originalMessage = Buffer.from('Secret message');
      const encrypted = CryptoManager.encrypt(originalMessage, bobKeypair.publicKey, aliceKeypair.privateKey);
      
      // Charlie tries to decrypt (wrong key)
      expect(() => {
        CryptoManager.decrypt(encrypted, aliceKeypair.publicKey, charlieKeypair.privateKey);
      }).toThrow('Decryption failed');
    });

    test('handles empty messages', () => {
      const aliceKeypair = CryptoManager.generateKeyPair();
      const bobKeypair = CryptoManager.generateKeyPair();
      
      const emptyMessage = Buffer.alloc(0);
      const encrypted = CryptoManager.encrypt(emptyMessage, bobKeypair.publicKey, aliceKeypair.privateKey);
      const decrypted = CryptoManager.decrypt(encrypted, aliceKeypair.publicKey, bobKeypair.privateKey);
      
      expect(decrypted.length).toBe(0);
    });
  });

  describe('Message encryption (JSON)', () => {
    test('encrypts and decrypts JSON messages', () => {
      const aliceKeypair = CryptoManager.generateKeyPair();
      const bobKeypair = CryptoManager.generateKeyPair();
      
      const originalData = {
        type: 'chat',
        message: 'Hello, Bob!',
        timestamp: Date.now(),
      };
      
      const encrypted = CryptoManager.encryptMessage(originalData, bobKeypair.publicKey, aliceKeypair.privateKey);
      const decrypted = CryptoManager.decryptMessage(encrypted, aliceKeypair.publicKey, bobKeypair.privateKey);
      
      expect(decrypted).toEqual(originalData);
    });
  });

  describe('Pairing codes and deep links', () => {
    test('generates valid pairing codes', () => {
      const code = CryptoManager.generatePairingCode();
      
      expect(code).toHaveLength(8);
      expect(code).toMatch(/^[A-Z0-9]+$/);
    });

    test('generates different codes each time', () => {
      const code1 = CryptoManager.generatePairingCode();
      const code2 = CryptoManager.generatePairingCode();
      
      expect(code1).not.toBe(code2);
    });

    test('generates auth tokens', () => {
      const token = CryptoManager.generateAuthToken();
      
      expect(token).toHaveLength(64); // 32 bytes in hex = 64 chars
      expect(token).toMatch(/^[a-f0-9]+$/);
    });

    test('encodes and decodes pairing payloads', () => {
      const payload: PairingPayload = {
        relayId: 'test-relay-id',
        publicKey: 'dGVzdC1wdWJsaWMta2V5',
        relayServer: 'wss://test.example.com',
        authToken: 'test-auth-token',
        expiresAt: Date.now() + 600000,
      };
      
      const encoded = CryptoManager.encodePairingPayload(payload);
      const decoded = CryptoManager.decodePairingPayload(encoded);
      
      expect(decoded).toEqual(payload);
    });

    test('generates valid deep links', () => {
      const payload: PairingPayload = {
        relayId: 'test-relay-id',
        publicKey: 'dGVzdC1wdWJsaWMta2V5',
        relayServer: 'wss://test.example.com',
        authToken: 'test-auth-token',
        expiresAt: Date.now() + 600000,
      };
      
      const deepLink = CryptoManager.generatePairingDeepLink(payload);
      
      expect(deepLink).toMatch(/^openawe:\/\/pair\/.+$/);
    });

    test('rejects expired pairing payloads', () => {
      const expiredPayload: PairingPayload = {
        relayId: 'test-relay-id',
        publicKey: 'dGVzdC1wdWJsaWMta2V5',
        relayServer: 'wss://test.example.com',
        authToken: 'test-auth-token',
        expiresAt: Date.now() - 1000, // Expired 1 second ago
      };
      
      const encoded = CryptoManager.encodePairingPayload(expiredPayload);
      
      expect(() => {
        CryptoManager.decodePairingPayload(encoded);
      }).toThrow('Pairing code has expired');
    });

    test('rejects invalid payloads', () => {
      const invalidEncoded = 'invalid-base64-data';
      
      expect(() => {
        CryptoManager.decodePairingPayload(invalidEncoded);
      }).toThrow('Invalid pairing payload');
    });
  });
});