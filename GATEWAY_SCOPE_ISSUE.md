# Gateway Scope Issue — operator.write Required

## Summary

The OpenClaw Gateway WebSocket client (openclaw-api.js) successfully connects and
authenticates with the gateway using the token from `gateway.auth.token`. However,
calling `chat.send` fails with:

```
missing scope: operator.write
```

## Root Cause

The gateway auth token (`gateway.auth.token` in openclaw.json) grants basic connection
access but does NOT include `operator.write` scope. The OpenClaw gateway has a scope
system where different methods require different scopes:

- `health` — no scope needed (works)
- `chat.send` — requires `operator.write` (fails)
- `send` — requires `operator.write` (fails)
- `config.get` — requires `operator.read` (fails)
- `status` — requires `operator.read` (fails)

The gateway token is designed for basic connectivity (like the control UI login). Full
operator access requires device-paired authentication, which involves:
1. Generating a key pair
2. Registering the device via `device.pair.*` API
3. Getting the pairing approved
4. Using the resulting device token with signed requests

## What Works

- `probe()` — Gateway reachability check ✓
- `connect()` — WebSocket connection + auth ✓
- Echo mode fallback — When gateway unavailable ✓
- Reconnection logic — Exponential backoff ✓
- Chat event handling — Properly parses delta/final events ✓
- Full relay integration — client.js properly wires relay→API→relay ✓

## Fix Options

### Option 1: OpenClaw Config Change (Quick)
If OpenClaw supports granting additional scopes to the gateway token, this would be
the simplest fix. Check if `gateway.auth.scopes` or similar config exists.

### Option 2: Device Pairing (Proper)
Implement device pairing flow in the OpenAwe client:
1. Generate a keypair on first run
2. Use `device.pair.request` to initiate pairing
3. Get approval from gateway owner
4. Use the issued device token with `operator.write` scope
5. Include device identity in connect params

This is the "correct" approach and matches how the OpenClaw CLI authenticates.

### Option 3: Use Hooks/Webhooks (Alternative)  
OpenClaw supports HTTP hooks that can receive messages and process them through the
agent pipeline. This would bypass the WebSocket scope issue entirely.

## Current Architecture

```
[Mobile App] ←E2E encrypted→ [Relay Server] ←→ [OpenAwe Client] ←WS→ [OpenClaw Gateway]
                                                  (client.js)          (chat.send fails)
                                                  (openclaw-api.js)
```

The relay connection is separate from the gateway connection. Messages flow:
1. App sends encrypted message → Relay → Client
2. Client decrypts → calls api.sendMessage()
3. api.sendMessage() calls chat.send via WebSocket
4. Response events flow back → Client encrypts → Relay → App
