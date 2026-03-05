# ATM Cloud Relay Server

WebSocket relay that pairs exactly one desktop and one mobile ATM client into an
end-to-end encrypted room.  The server never sees plaintext application data --
it only forwards opaque ciphertext blobs between the two peers.

## Architecture

```
Desktop (Tauri)                          Mobile (browser)
      |                                        |
      |  WS: create_room(desktop_pub_key)      |
      |--------------------------------------->|
      |  <-- room_created { room_code }        |
      |                                        |
      |       User enters room code on phone   |
      |                                        |
      |  WS: join_room(code, mobile_pub_key)   |
      |<---------------------------------------|
      |  --> peer_joined { mobile_pub_key }    |
      |  <-- room_joined { desktop_pub_key }   |
      |                                        |
      |  ======= E2E encrypted relay ========  |
```

### Key modules

| File              | Purpose                                          |
|-------------------|--------------------------------------------------|
| `src/main.rs`     | Server startup, routing, background reaper task  |
| `src/config.rs`   | TOML config loading with env-var fallback        |
| `src/room.rs`     | Room lifecycle (create, join, touch, cleanup)    |
| `src/ws.rs`       | WebSocket upgrade, init protocol, relay loop     |
| `src/rate_limit.rs` | Per-IP and per-connection rate limiting         |
| `src/health.rs`   | `GET /health` JSON endpoint                      |

### Endpoints

| Route        | Description                                      |
|--------------|--------------------------------------------------|
| `GET /ws`    | WebSocket upgrade. First message determines role |
| `GET /health`| JSON health check (status, rooms, connections, uptime) |

## Prerequisites

- **Rust 1.82+** (edition 2021)
- **cargo** (comes with Rust)

## Quick start (local dev)

```bash
# Build and run with defaults (127.0.0.1:8080)
cargo run

# Or with a custom config
RELAY_CONFIG=./relay-config.toml cargo run

# Release build
cargo build --release
./target/release/atm-relay
```

## Configuration

The server loads configuration in this order:

1. Path specified by the `RELAY_CONFIG` environment variable
2. `relay-config.toml` in the current working directory
3. Built-in defaults (same values as the sample config)

See `relay-config.toml` for all available options:

| Key                        | Default          | Description                                   |
|----------------------------|------------------|-----------------------------------------------|
| `listen_addr`              | `127.0.0.1:8080` | Address and port to bind                     |
| `max_rooms`                | `500`            | Maximum concurrent rooms                      |
| `max_connections`          | `2000`           | Maximum total WebSocket connections            |
| `room_ttl_secs`            | `300`            | Seconds before an unpaired room expires        |
| `idle_timeout_secs`        | `1800`           | Seconds of inactivity before a paired room closes |
| `max_message_size`         | `65536`          | Maximum WebSocket message size in bytes        |
| `per_ip_max_connections`   | `5`              | Max concurrent connections from one IP         |
| `per_ip_max_rooms_per_hour`| `10`             | Max rooms a single IP can create per hour      |
| `msg_rate_limit_per_sec`   | `100`            | Max forwarded messages per second per connection |

## Docker

```bash
# Build the image
docker build -t atm-relay .

# Run with defaults
docker run -p 8080:8080 atm-relay

# Run with a custom config mounted in
docker run -p 8080:8080 \
  -v /path/to/relay-config.toml:/etc/atm-relay/relay-config.toml:ro \
  atm-relay
```

The Dockerfile uses a multi-stage build (Rust builder + Debian slim runtime) and
runs as a non-root `atm-relay` user.

## Production deployment (systemd + Caddy)

Template files live in the `deploy/` directory.

### 1. Install the binary

```bash
sudo mkdir -p /opt/atm-relay/bin
sudo cp target/release/atm-relay /opt/atm-relay/bin/
sudo cp relay-config.toml /opt/atm-relay/
```

### 2. Create the service user

```bash
sudo useradd -r -s /bin/false -M atm-relay
sudo mkdir -p /var/log/atm-relay
sudo chown atm-relay:atm-relay /var/log/atm-relay
```

### 3. Install the systemd unit

```bash
sudo cp deploy/atm-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now atm-relay
```

### 4. Set up Caddy reverse proxy

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy automatically provisions TLS certificates for the configured domain.

### Verify

```bash
# Check service status
sudo systemctl status atm-relay

# Health check
curl http://localhost:8080/health

# Tail logs
journalctl -u atm-relay -f
```

## WebSocket protocol

### Desktop creates a room

```json
{ "type": "create_room", "desktop_public_key": "<base64>" }
```

Server responds:

```json
{ "type": "room_created", "room_code": "ATM-a3Bx9K" }
```

### Mobile joins a room

```json
{ "type": "join_room", "room_code": "ATM-a3Bx9K", "mobile_public_key": "<base64>" }
```

Server sends to mobile:

```json
{ "type": "room_joined", "desktop_public_key": "<base64>" }
```

Server sends to desktop:

```json
{ "type": "peer_joined", "mobile_public_key": "<base64>" }
```

### Relay phase

After pairing, all subsequent WebSocket messages are forwarded opaquely to the
peer.  The relay does not inspect or modify message content.

### Error

```json
{ "type": "error", "message": "room not found" }
```

## License

Part of the ATM project.  See the top-level LICENSE file.
