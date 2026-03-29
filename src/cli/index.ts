#!/usr/bin/env node

import { Command } from 'commander';
import { RelayClient } from '../relay';
import { PairingCodeData } from '../pairing';
import { ConnectionState } from '../types';

const program = new Command();

// Global relay client instance
let relayClient: RelayClient | null = null;

function getRelayClient(): RelayClient {
  if (!relayClient) {
    relayClient = new RelayClient();
  }
  return relayClient;
}

function formatConnectionState(state: ConnectionState): string {
  const status = state.status.charAt(0).toUpperCase() + state.status.slice(1);
  let info = `Status: ${status}`;
  
  if (state.lastConnected) {
    info += `\nLast connected: ${state.lastConnected.toLocaleString()}`;
  }
  
  if (state.latency !== undefined) {
    info += `\nLatency: ${state.latency}ms`;
  }
  
  if (state.reconnectAttempts > 0) {
    info += `\nReconnect attempts: ${state.reconnectAttempts}`;
  }
  
  return info;
}

// Main command
program
  .name('openawe-relay-client')
  .description('OpenClaw Relay Client - E2E encrypted connection for OpenClaw instances')
  .version('1.0.0');

// Status command
program
  .command('status')
  .description('Show connection status and configuration')
  .action(() => {
    try {
      const client = getRelayClient();
      const config = client.getConfigManager().getConfig();
      const connectionState = client.getConnectionState();
      const pairedDevices = client.getPairingManager().listPairedDevices();
      
      console.log('=== OpenClaw Relay Client Status ===');
      console.log(`Relay ID: ${config.relayId}`);
      console.log(`Server: ${config.relayServer}`);
      console.log(`Enabled: ${config.enabled}`);
      console.log('');
      console.log(formatConnectionState(connectionState));
      console.log('');
      console.log(`Paired Devices: ${pairedDevices.length}`);
      
      if (pairedDevices.length > 0) {
        console.log('');
        pairedDevices.forEach((device, index) => {
          console.log(`  ${index + 1}. ${device.name} (${device.id})`);
          console.log(`     Paired: ${new Date(device.pairedAt).toLocaleString()}`);
        });
      }
      
      const paths = client.getConfigManager().getPaths();
      console.log('');
      console.log('Configuration:');
      console.log(`  Config: ${paths.configPath}`);
      console.log(`  Keys: ${paths.keypairPath}`);
      
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Start command
program
  .command('start')
  .description('Start the relay client connection')
  .option('-d, --daemon', 'Run in background (daemon mode)')
  .action(async (options) => {
    try {
      const client = getRelayClient();
      
      // Set up event listeners
      client.on('connected', () => {
        console.log('✅ Connected to relay server');
      });
      
      client.on('disconnected', (reason) => {
        console.log(`❌ Disconnected from relay server: ${reason}`);
      });
      
      client.on('reconnecting', (attempt) => {
        console.log(`🔄 Reconnecting... (attempt ${attempt})`);
      });
      
      client.on('error', (error) => {
        console.error('❌ Error:', error.message);
      });
      
      client.on('paired', (device) => {
        console.log(`📱 New device paired: ${device.name} (${device.id})`);
      });
      
      client.on('message', (message) => {
        console.log(`💬 Message from ${message.deviceId}:`, message);
      });
      
      client.on('audio', (audioData, deviceId) => {
        console.log(`🎵 Audio from ${deviceId}: ${audioData.length} bytes`);
      });
      
      console.log('🚀 Starting OpenClaw Relay Client...');
      await client.start();
      
      if (!options.daemon) {
        console.log('Press Ctrl+C to stop');
        
        // Handle graceful shutdown
        process.on('SIGINT', async () => {
          console.log('\n🛑 Shutting down...');
          await client.stop();
          process.exit(0);
        });
        
        // Keep the process running
        process.stdin.resume();
      }
      
    } catch (error) {
      console.error('❌ Failed to start:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Stop command
program
  .command('stop')
  .description('Stop the relay client connection')
  .action(async () => {
    try {
      const client = getRelayClient();
      await client.stop();
      console.log('✅ Relay client stopped');
    } catch (error) {
      console.error('❌ Error stopping client:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Pair command
program
  .command('pair')
  .description('Generate a pairing code for mobile devices')
  .option('-n, --name <name>', 'Expected device name (for display)')
  .action((options) => {
    try {
      const client = getRelayClient();
      const pairingManager = client.getPairingManager();
      
      const codeData: PairingCodeData = pairingManager.generatePairingCode(options.name);
      
      console.log('📱 New Pairing Code Generated');
      console.log('');
      console.log(`Code: ${codeData.code}`);
      console.log(`Deep Link: ${codeData.deepLink}`);
      console.log(`Expires: ${codeData.expiresAt.toLocaleString()}`);
      console.log('');
      console.log('Instructions:');
      console.log('1. Open the OpenAwe app on your mobile device');
      console.log('2. Tap "Add OpenClaw" or "Pair Device"');
      console.log(`3. Enter code: ${codeData.code}`);
      console.log('   OR tap the deep link if available');
      console.log('');
      console.log('⚠️  Code expires in 10 minutes');
      
    } catch (error) {
      console.error('❌ Error generating pairing code:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Devices command
program
  .command('devices')
  .description('List all paired devices')
  .action(() => {
    try {
      const client = getRelayClient();
      const devices = client.getPairingManager().listPairedDevices();
      
      if (devices.length === 0) {
        console.log('No paired devices found');
        console.log('Use "pair" command to generate a pairing code');
        return;
      }
      
      console.log(`Found ${devices.length} paired device(s):`);
      console.log('');
      
      devices.forEach((device, index) => {
        console.log(`${index + 1}. ${device.name}`);
        console.log(`   ID: ${device.id}`);
        console.log(`   Paired: ${new Date(device.pairedAt).toLocaleString()}`);
        console.log(`   Public Key: ${device.publicKey.substring(0, 16)}...`);
        console.log('');
      });
      
    } catch (error) {
      console.error('❌ Error listing devices:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Remove device command
program
  .command('remove <deviceId>')
  .description('Remove/unpair a device')
  .action((deviceId) => {
    try {
      const client = getRelayClient();
      const pairingManager = client.getPairingManager();
      
      const device = pairingManager.getPairedDevice(deviceId);
      if (!device) {
        console.error(`❌ Device not found: ${deviceId}`);
        process.exit(1);
      }
      
      const success = pairingManager.unpairDevice(deviceId);
      if (success) {
        console.log(`✅ Device removed: ${device.name} (${deviceId})`);
      } else {
        console.error(`❌ Failed to remove device: ${deviceId}`);
        process.exit(1);
      }
      
    } catch (error) {
      console.error('❌ Error removing device:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Send test message command
program
  .command('send <deviceId> [message]')
  .description('Send a test message to a paired device')
  .action(async (deviceId, message = 'Hello from OpenClaw Relay Client!') => {
    try {
      const client = getRelayClient();
      
      const device = client.getPairingManager().getPairedDevice(deviceId);
      if (!device) {
        console.error(`❌ Device not found: ${deviceId}`);
        process.exit(1);
      }
      
      if (!client.isConnected()) {
        console.log('🔄 Connecting to relay server...');
        await client.start();
      }
      
      console.log(`📤 Sending message to ${device.name}...`);
      await client.sendMessage(deviceId, 'chat', { text: message });
      console.log('✅ Message sent successfully');
      
      await client.stop();
      
    } catch (error) {
      console.error('❌ Error sending message:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Config command
program
  .command('config')
  .description('Show configuration details')
  .option('--reset', 'Reset configuration to defaults')
  .action((options) => {
    try {
      const client = getRelayClient();
      const configManager = client.getConfigManager();
      
      if (options.reset) {
        console.log('⚠️  Resetting configuration...');
        const newRelayId = configManager.regenerateRelayId();
        configManager.regenerateKeypair();
        console.log(`✅ Configuration reset. New Relay ID: ${newRelayId}`);
        console.log('⚠️  All paired devices have been unpaired');
        return;
      }
      
      const config = configManager.getConfig();
      const paths = configManager.getPaths();
      
      console.log('=== Configuration ===');
      console.log(`Relay ID: ${config.relayId}`);
      console.log(`Server: ${config.relayServer}`);
      console.log(`Enabled: ${config.enabled}`);
      console.log(`Paired Devices: ${config.pairedDevices.length}`);
      console.log('');
      console.log('Files:');
      console.log(`  Config: ${paths.configPath}`);
      console.log(`  Keypair: ${paths.keypairPath}`);
      console.log(`  Keys Directory: ${paths.keysDir}`);
      
    } catch (error) {
      console.error('❌ Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse();