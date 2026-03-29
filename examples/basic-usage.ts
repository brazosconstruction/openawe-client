import { RelayClient } from '../src';

async function main() {
  console.log('🚀 Starting OpenClaw Relay Client Example');
  
  // Create relay client
  const client = new RelayClient();
  
  // Set up event listeners
  client.on('connected', () => {
    console.log('✅ Connected to relay server');
  });
  
  client.on('disconnected', (reason) => {
    console.log('❌ Disconnected:', reason);
  });
  
  client.on('paired', (device) => {
    console.log(`📱 New device paired: ${device.name} (${device.id})`);
  });
  
  client.on('message', async (message) => {
    console.log(`💬 Message from ${message.deviceId}:`, message.data);
    
    // Echo the message back
    if (message.type === 'chat' && message.data.text) {
      await client.sendMessage(message.deviceId!, 'chat', {
        text: `Echo: ${message.data.text}`,
        timestamp: Date.now(),
      });
    }
  });
  
  client.on('error', (error) => {
    console.error('❌ Error:', error.message);
  });
  
  // Show current configuration
  const config = client.getConfigManager().getConfig();
  console.log(`\n📋 Configuration:`);
  console.log(`  Relay ID: ${config.relayId}`);
  console.log(`  Server: ${config.relayServer}`);
  console.log(`  Paired Devices: ${config.pairedDevices.length}`);
  
  // Generate a pairing code
  console.log(`\n🔗 Generating pairing code...`);
  const pairingManager = client.getPairingManager();
  const codeData = pairingManager.generatePairingCode('Example Device');
  
  console.log(`  Code: ${codeData.code}`);
  console.log(`  Expires: ${codeData.expiresAt.toLocaleString()}`);
  console.log(`  Deep Link: ${codeData.deepLink}`);
  
  // Start the client
  console.log(`\n🔌 Starting relay connection...`);
  try {
    await client.start();
    console.log('✅ Relay client started successfully');
    
    // Keep running for 30 seconds for demo
    setTimeout(async () => {
      console.log('\n🛑 Stopping relay client...');
      await client.stop();
      console.log('✅ Relay client stopped');
      process.exit(0);
    }, 30000);
    
  } catch (error) {
    console.error('❌ Failed to start relay client:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}