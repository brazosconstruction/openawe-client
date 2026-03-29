# OpenAwe OpenClaw Client

Bridge between the OpenAwe mobile app and your OpenClaw instance. Connects to the relay server, handles E2E encryption, and forwards messages to OpenClaw's API.

## Quick Start

```bash
# Install dependencies
npm install

# Generate a pairing code (share with the mobile app)
node src/client.js --pair

# Start the client
node src/client.js

# Check status
node src/client.js --status
```

## How It Works

1. **Client connects to relay** as "host" role with a unique relay ID
2. **Mobile app connects to relay** as "client" with the same relay ID (from pairing code)
3. **Messages are E2E encrypted** using X25519 + XChaCha20-Poly1305
4. Client **decrypts incoming messages** and forwards them to OpenClaw's API
5. Client **encrypts OpenClaw's response** and sends it back through the relay

## Commands

| Command | Description |
|---------|-------------|
| `node src/client.js` | Start the client (persistent connection) |
| `node src/client.js --pair` | Generate a new pairing code |
| `node src/client.js --status` | Show connection status and paired devices |
| `node src/client.js --echo` | Force echo mode (skip OpenClaw API) |
| `node src/client.js --relay=ws://host:port/v1/connect` | Override relay URL |

## Configuration

All config is stored in `~/.openclaw/relay/`:

- `config.json` — Relay ID, server URL, paired devices
- `keypair.json` — Host X25519 keypair (private + public)

## Message Protocol

```json
// App -> OpenClaw (decrypted payload)
{"type": "chat", "message": "Hello", "sessionId": "optional"}

// OpenClaw -> App (encrypted response)
{"type": "response", "message": "Hi there!", "sessionId": "..."}

// Status
{"type": "status", "connected": true}
```

## Architecture

```
┌─────────────┐     WebSocket      ┌─────────────┐     WebSocket      ┌─────────────┐
│  OpenAwe    │ ←── (encrypted) ──→│   Relay     │ ←── (encrypted) ──→│  This Client│
│  Mobile App │                    │   Server    │                    │  (OpenClaw) │
└─────────────┘                    └─────────────┘                    └──────┬──────┘
                                                                            │
                                                                     HTTP API calls
                                                                            │
                                                                     ┌──────▼──────┐
                                                                     │   OpenClaw  │
                                                                     │   Gateway   │
                                                                     └─────────────┘
```

## Echo Mode

If the OpenClaw gateway API is unreachable, the client automatically falls back to echo mode — it echoes back whatever message it receives, prefixed with "Echo:". This proves the full relay pipeline works end-to-end.

Force echo mode with `--echo`.
