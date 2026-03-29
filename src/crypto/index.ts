import * as sodium from 'sodium-native';
import { KeyPair, PairingPayload } from '../types';
import { randomBytes } from 'crypto';

export class CryptoManager {
  /**
   * Generate a new X25519 keypair for E2E encryption
   */
  static generateKeyPair(): KeyPair {
    const publicKey = Buffer.allocUnsafe(sodium.crypto_box_PUBLICKEYBYTES);
    const privateKey = Buffer.allocUnsafe(sodium.crypto_box_SECRETKEYBYTES);
    
    sodium.crypto_box_keypair(publicKey, privateKey);
    
    return {
      publicKey,
      privateKey,
    };
  }

  /**
   * Encrypt a message using XChaCha20-Poly1305
   */
  static encrypt(message: Buffer, recipientPublicKey: Buffer, senderPrivateKey: Buffer): Buffer {
    const nonce = Buffer.allocUnsafe(sodium.crypto_box_NONCEBYTES);
    sodium.randombytes_buf(nonce);
    
    const ciphertext = Buffer.allocUnsafe(message.length + sodium.crypto_box_MACBYTES);
    
    sodium.crypto_box_easy(ciphertext, message, nonce, recipientPublicKey, senderPrivateKey);
    
    // Format: [nonce][ciphertext+mac]
    return Buffer.concat([nonce, ciphertext]);
  }

  /**
   * Decrypt a message using XChaCha20-Poly1305
   */
  static decrypt(encryptedData: Buffer, senderPublicKey: Buffer, recipientPrivateKey: Buffer): Buffer {
    if (encryptedData.length < sodium.crypto_box_NONCEBYTES + sodium.crypto_box_MACBYTES) {
      throw new Error('Invalid encrypted data length');
    }
    
    const nonce = encryptedData.slice(0, sodium.crypto_box_NONCEBYTES);
    const ciphertext = encryptedData.slice(sodium.crypto_box_NONCEBYTES);
    
    const message = Buffer.allocUnsafe(ciphertext.length - sodium.crypto_box_MACBYTES);
    
    const success = sodium.crypto_box_open_easy(message, ciphertext, nonce, senderPublicKey, recipientPrivateKey);
    
    if (!success) {
      throw new Error('Decryption failed - invalid signature or corrupted data');
    }
    
    return message;
  }

  /**
   * Generate a secure pairing code (6-8 alphanumeric characters)
   */
  static generatePairingCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const length = 8;
    let result = '';
    
    const randomBuffer = randomBytes(length);
    for (let i = 0; i < length; i++) {
      result += chars[randomBuffer[i] % chars.length];
    }
    
    return result;
  }

  /**
   * Generate a secure auth token for pairing
   */
  static generateAuthToken(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Encode a pairing payload to base64 for deep link
   */
  static encodePairingPayload(payload: PairingPayload): string {
    const json = JSON.stringify(payload);
    return Buffer.from(json).toString('base64url');
  }

  /**
   * Decode a pairing payload from base64 deep link
   */
  static decodePairingPayload(encodedPayload: string): PairingPayload {
    try {
      const json = Buffer.from(encodedPayload, 'base64url').toString('utf-8');
      const payload = JSON.parse(json) as PairingPayload;
      
      // Validate required fields
      if (!payload.relayId || !payload.publicKey || !payload.relayServer || !payload.authToken) {
        throw new Error('Invalid pairing payload - missing required fields');
      }
      
      // Check expiration
      if (Date.now() > payload.expiresAt) {
        throw new Error('Pairing code has expired');
      }
      
      return payload;
    } catch (error) {
      throw new Error(`Invalid pairing payload: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generate a deep link for pairing
   */
  static generatePairingDeepLink(payload: PairingPayload): string {
    const encodedPayload = this.encodePairingPayload(payload);
    return `openawe://pair/${encodedPayload}`;
  }

  /**
   * Encrypt a JSON message for transmission
   */
  static encryptMessage(data: any, recipientPublicKey: Buffer, senderPrivateKey: Buffer): string {
    const message = Buffer.from(JSON.stringify(data), 'utf-8');
    const encrypted = this.encrypt(message, recipientPublicKey, senderPrivateKey);
    return encrypted.toString('base64');
  }

  /**
   * Decrypt and parse a JSON message
   */
  static decryptMessage<T = any>(encryptedData: string, senderPublicKey: Buffer, recipientPrivateKey: Buffer): T {
    const encrypted = Buffer.from(encryptedData, 'base64');
    const decrypted = this.decrypt(encrypted, senderPublicKey, recipientPrivateKey);
    return JSON.parse(decrypted.toString('utf-8'));
  }
}

export { KeyPair, PairingPayload };