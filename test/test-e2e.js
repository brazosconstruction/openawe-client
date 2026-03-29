#!/usr/bin/env node
/**
 * test-e2e.js — End-to-end test simulating a mobile app connecting through the relay
 *
 * 1. Starts the OpenClaw client
 * 2. Connects as "client" role to the relay
 * 3. Sends an unencrypted chat message
 * 4. Verifies response comes back
 */

const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');

const RELAY_URL = 'ws://localhost:8090/v1/connect';
const RELAY_ID = '98ae6059-b123-4911-bdd0-42bd32e727df'; // From config

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== OpenAwe E2E Test ===\n');

  // 1. Start the client in the background
  console.log('[1] Starting OpenClaw client...');
  const client = spawn('node', ['src/client.js', '--relay=ws://localhost:8090/v1/connect', '--echo'], {
    cwd: path.join(__dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let clientOutput = '';
  client.stdout.on('data', (d) => {
    const s = d.toString();
    clientOutput += s;
    process.stdout.write(`  [client] ${s}`);
  });
  client.stderr.on('data', (d) => {
    process.stderr.write(`  [client err] ${d}`);
  });

  // Wait for client to register
  await sleep(2000);

  if (!clientOutput.includes('Registered')) {
    console.error('FAIL: Client did not register with relay');
    client.kill();
    process.exit(1);
  }
  console.log('[1] Client registered with relay ✓\n');

  // 2. Connect as the "app" (client role)
  console.log('[2] Connecting as mobile app...');
  const ws = new WebSocket(RELAY_URL);

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  // Register as client
  ws.send(JSON.stringify({ type: 'register', relayId: RELAY_ID, role: 'client' }));

  // Collect messages
  let registered = false;
  let partnerOnline = false;
  let response = null;
  let statusFromHost = null;

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    console.log(`  [app] Received: ${JSON.stringify(msg)}`);

    if (msg.type === 'registered') registered = true;
    if (msg.type === 'status' && msg.online !== undefined) partnerOnline = msg.online;
    if (msg.type === 'data') {
      try {
        const parsed = JSON.parse(msg.payload);
        if (parsed.type === 'status') {
          statusFromHost = parsed;
        } else {
          response = parsed;
        }
      } catch {
        response = msg.payload;
      }
    }
  });

  await sleep(2000);

  if (!registered) {
    console.error('FAIL: App did not register');
    cleanup(client, ws);
    process.exit(1);
  }
  console.log('[2] App registered with relay ✓');

  if (partnerOnline) {
    console.log('[2] Host is online ✓');
  }

  if (statusFromHost) {
    console.log(`[2] Host status message: ${JSON.stringify(statusFromHost)} ✓`);
  }
  console.log('');

  // 3. Send a chat message (unencrypted for test)
  console.log('[3] Sending chat message: "Hello OpenClaw!"');
  const chatMsg = JSON.stringify({ type: 'chat', message: 'Hello OpenClaw!', sessionId: 'test-123' });
  ws.send(JSON.stringify({ type: 'data', payload: chatMsg }));

  // Wait for response
  await sleep(3000);

  if (!response) {
    console.error('FAIL: No response received after 3 seconds');
    cleanup(client, ws);
    process.exit(1);
  }

  console.log(`[3] Response: ${JSON.stringify(response)}`);

  if (response.type === 'response' && response.message) {
    console.log(`\n${'='.repeat(50)}`);
    console.log('  ✅ SUCCESS! Full pipeline working end-to-end.');
    console.log(`  Sent:     "Hello OpenClaw!"`);
    console.log(`  Received: "${response.message}"`);
    console.log(`  Mode:     ${response.echoMode ? 'Echo' : 'OpenClaw API'}`);
    console.log(`${'='.repeat(50)}\n`);
  } else {
    console.log('\n⚠️  Got a response but unexpected format');
  }

  // Cleanup
  cleanup(client, ws);
  console.log('=== Test Complete ===');
}

function cleanup(client, ws) {
  try { ws.close(); } catch {}
  try { client.kill(); } catch {}
}

main().catch((err) => {
  console.error(`Test error: ${err.message}`);
  process.exit(1);
});
