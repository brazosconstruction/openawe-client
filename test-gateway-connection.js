#!/usr/bin/env node
/**
 * test-gateway-connection.js — Test OpenClaw Gateway connectivity with device pairing
 *
 * Tests: probe, connect (with device pairing), and sendMessage.
 *
 * Flow:
 *   1. Probe gateway reachability
 *   2. Connect with device identity (triggers pairing on first run)
 *   3. If pairing needed, waits for approval via `openclaw devices`
 *   4. After pairing, chat.send should work with operator.write scope
 */

const { OpenClawAPI } = require('./src/openclaw-api');

async function main() {
  console.log('=== OpenClaw Gateway Connection Test (Device Pairing) ===\n');
  
  // Test 1: Probe
  console.log('--- Test 1: Probe ---');
  const api = new OpenClawAPI();
  const reachable = await api.probe();
  console.log(`  Gateway reachable: ${reachable}`);
  console.log(`  apiAvailable: ${api.apiAvailable}\n`);
  
  if (!reachable) {
    console.log('Gateway not reachable. Ensure openclaw gateway is running.');
    process.exit(1);
  }
  
  // Test 2: Connect (with device pairing)
  console.log('--- Test 2: Connect (with device pairing) ---');
  console.log('  If this is the first connection, you will need to approve');
  console.log('  the device pairing via: openclaw devices\n');
  try {
    await api.connect();
    console.log(`  Connected: ${api.connected}\n`);
  } catch (err) {
    console.error(`  Connect failed: ${err.message}\n`);
    api.disconnect();
    process.exit(1);
  }
  
  // Test 3: Send Message
  console.log('--- Test 3: Send Message (chat.send) ---');
  console.log('  This should now work with device pairing providing operator.write scope\n');
  
  const response = await api.sendMessage({
    message: 'Say "hello from OpenAwe" and nothing else.',
    sessionKey: 'openawe-test',
  });
  
  console.log('  Response:', JSON.stringify(response, null, 2));
  
  if (response.error) {
    console.log('\n  chat.send still failed. Check the error above.');
    console.log('  If scope-related, the device pairing may not have the right scopes.');
  } else {
    console.log('\n  ✓ SUCCESS! chat.send works with device pairing.');
    console.log('  The OpenAwe client can now send messages to OpenClaw.');
  }
  
  // Cleanup
  api.disconnect();
  console.log('\nDone.');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
