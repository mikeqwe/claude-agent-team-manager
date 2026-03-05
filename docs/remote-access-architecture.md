# ATM Remote Access Architecture Proposal

**Author:** ATM Sprint Lead
**Date:** 2026-03-04
**Version:** 1.1 (revised per Devil's Advocate critique)
**GitHub Issue:** #14 — Remote control from web or app

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-04 | Initial proposal |
| 1.1 | 2026-03-04 | Incorporated Devil's Advocate critique: mandatory TLS, optimistic locking, server-off-by-default, redacted node types, default bind to 127.0.0.1, v0.8 scoped to read-only + deploy, state bridge specification added |

---

## 1. Problem Statement

Users want to monitor and control their AI agent teams remotely from iPhones and Android phones while the ATM desktop app runs on their workstation. The solution must work cross-platform, require minimal setup, and not compromise the security of agent configurations (which may contain API keys, passwords, and deployment scripts).

## 2. Approaches Evaluated

### Approach A: Embedded Web Server (axum inside Tauri)

Embed a lightweight HTTP + WebSocket server (using `axum` or `warp`) directly in the Tauri Rust backend. The server hosts a mobile-optimized web client that phones access via a browser. Connection is established by scanning a QR code displayed in the desktop app.

| Dimension | Assessment |
|---|---|
| **Implementation complexity** | Medium-High. Add axum + tokio to the Rust side. Build a separate lightweight web client. Requires state bridge between webview and Rust server, TLS cert generation, and a second Vite build pipeline. |
| **User experience** | Good. Scan QR code on phone, accept self-signed cert once, instant access. No account signup. |
| **Security** | Strong. Mandatory TLS, token-based auth, sensitive field redaction. No data leaves the network. |
| **Cross-platform** | Excellent. Any device with a browser works — iPhone Safari, Android Chrome, tablets, other PCs. |
| **Offline/LAN** | Fully offline. Works without internet. Requires same LAN (or tailnet/VPN for remote). |

### Approach B: Cloud Relay Service

Deploy a relay server (e.g., on Cloudflare Workers or AWS) that mediates WebSocket connections between the desktop app and mobile clients. Desktop app connects outbound to the relay; phone connects to the relay via a web URL.

| Dimension | Assessment |
|---|---|
| **Implementation complexity** | High. Must build and maintain a cloud service, handle auth, billing, uptime, GDPR. |
| **User experience** | Best for true remote access (different networks). Requires account creation. |
| **Security** | Concerning. Sensitive agent configs (API keys, prompts) transit through a third-party server. Requires E2E encryption at minimum. |
| **Cross-platform** | Excellent. Works from anywhere with internet. |
| **Offline/LAN** | Does not work offline. Adds latency. Ongoing hosting cost. |

### Approach C: Tauri Mobile (Native iOS/Android Apps)

Use Tauri v2's mobile compilation targets to build native iOS and Android apps that replicate the desktop UI.

| Dimension | Assessment |
|---|---|
| **Implementation complexity** | Very High. Tauri mobile is still maturing. Must handle iOS App Store and Google Play publishing, code signing, platform-specific plugins. The existing tauri-plugin-fs, tauri-plugin-shell calls are desktop-specific. |
| **User experience** | Best native feel, but the full tree canvas may not translate well to small screens. |
| **Security** | Good — data stays on device — but now you have two copies of the data to sync. |
| **Cross-platform** | Limited. Must maintain two app store listings. Slow iteration. |
| **Offline/LAN** | Fully offline per device, but no real-time sync with the desktop. |

### Approach D: Hybrid — Embedded Server + Optional Tunnel

Combine Approach A (embedded web server) with an optional secure tunnel (e.g., a built-in Cloudflare Tunnel or SSH tunnel helper) for true remote access beyond the LAN. Default is LAN-only; power users can enable the tunnel.

| Dimension | Assessment |
|---|---|
| **Implementation complexity** | Medium+. Same as Approach A, with a small optional tunnel feature. |
| **User experience** | Great. LAN works out-of-the-box. Remote access is opt-in for advanced users. |
| **Security** | Best balance. LAN mode has zero cloud exposure. Tunnel mode uses encrypted tunnels. |
| **Cross-platform** | Excellent. Browser-based. |
| **Offline/LAN** | Full LAN support. Remote requires internet but no third-party data relay. |

## 3. Recommendation: Approach A — Embedded Web Server

**We recommend Approach A (Embedded Web Server)** for the v0.8 implementation, with the door open to add tunnel support (Approach D) in a future release.

**Justification:**

1. **Lowest risk, fastest delivery.** Adding axum to the existing Rust backend is straightforward. No cloud infrastructure to build or maintain.
2. **Security-first.** Agent configurations containing API keys and passwords never leave the local network. Mandatory TLS ensures encrypted transport even on shared WiFi.
3. **Zero friction.** No account signup, no app store, no cloud dependency. Open ATM, enable remote access, scan QR, done.
4. **Universal compatibility.** Every phone has a browser. Works on iPhone, Android, tablets, and even other laptops on the network.
5. **Same-network is the primary use case.** Most users will control agents from their phone while sitting at their desk or in the same building.

**v0.8 Scope:** Read-only monitoring + pipeline deployment only. Full write operations (edit nodes, reparent, create/delete) deferred to v0.9 to reduce risk and implementation surface.

## 4. Component Architecture

```
+------------------------------------------------------------------+
|                     ATM Desktop App (Tauri)                       |
|                                                                   |
|  +-------------------+    +-----------------------------------+   |
|  |   React Frontend  |    |   Rust Backend (lib.rs)           |   |
|  |   (Webview)       |    |                                   |   |
|  |                   |    |   +---------------------------+   |   |
|  |   Existing UI     |<-->|   | Tauri Command Handlers    |   |   |
|  |   TreeCanvas,     |IPC |   | (open_terminal, etc.)     |   |   |
|  |   Inspector, etc  |    |   +---------------------------+   |   |
|  |                   |    |                                   |   |
|  |   Remote State    |    |   +---------------------------+   |   |
|  |   Emitter (NEW)   |--->|   | Remote Access Module      |   |   |
|  |   (Tauri events)  |    |   | (NEW — lazy-started)      |   |   |
|  |                   |    |   |                           |   |   |
|  +-------------------+    |   | +--------+ +----------+  |   |   |
|                           |   | | axum   | | WebSocket|  |   |   |
|                           |   | | HTTPS  | | Server   |  |   |   |
|                           |   | | Server | | (TLS)    |  |   |   |
|                           |   | +--------+ +----------+  |   |   |
|                           |   |                           |   |   |
|                           |   | +--------+ +----------+  |   |   |
|                           |   | | Auth + | | State    |  |   |   |
|                           |   | | TLS    | | Bridge   |  |   |   |
|                           |   | +--------+ +----------+  |   |   |
|                           |   +---------------------------+   |   |
|                           +-----------------------------------+   |
+------------------------------------------------------------------+
          |                              |
          |  Port 5175 (HTTPS + WSS)     |
          |  Default: 127.0.0.1          |
          |  Opt-in: 0.0.0.0             |
          |                              |
     +----v------------------------------v----+
     |        Local Network (LAN / WiFi)       |
     +----+------------------------------+----+
          |                              |
   +------v-------+            +---------v------+
   |  iPhone       |            |  Android       |
   |  Safari       |            |  Chrome        |
   |               |            |                |
   |  Mobile Web   |            |  Mobile Web    |
   |  Client       |            |  Client        |
   |  (React SPA)  |            |  (React SPA)   |
   +--------------+            +----------------+
```

### Data Flow

```
Phone Browser                 ATM Desktop
    |                             |
    |--- GET /api/health -------->|  (connection check, over HTTPS)
    |<-- 200 OK ------------------|
    |                             |
    |--- WSS /ws/remote --------->|  (upgrade to secure WebSocket)
    |<-- WSS handshake -----------|
    |                             |
    |--- auth { token } --------->|  (one-time auth, token from QR)
    |<-- auth_ok { sessionId } ---|  (session cookie set via HTTP-only)
    |                             |
    |<-- full_sync { nodes } -----|  (redacted tree state)
    |                             |
    |<-- node_updated { delta } --|  (desktop changed something)
    |                             |
    |--- deploy_pipeline -------->|  (user triggers deploy)
    |<-- deploy_status -----------|  (streaming deploy output)
    |                             |
```

## 5. API Surface

### 5.1 REST Endpoints (axum, all over HTTPS)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Returns server status, app version, project name |
| `GET` | `/api/auth/qr` | Returns QR code data (token + TLS cert fingerprint + server URL) |
| `POST` | `/api/auth/token` | Validates a session token, sets HTTP-only session cookie |
| `GET` | `/` | Serves the mobile web client SPA (static files) |

All REST endpoints include CORS headers restricting origin to the server's own address. State-changing endpoints require a CSRF token provided at session establishment.

### 5.2 WebSocket Messages (`/ws/remote`, over WSS)

**Client -> Server (Commands) — v0.8 (read-only + deploy)**

| Message Type | Payload | Description |
|---|---|---|
| `auth` | `{ token: string }` | Authenticate the WebSocket connection (sent once) |
| `get_tree` | `{}` | Request full redacted tree state |
| `get_node` | `{ id: string }` | Request single redacted node details |
| `deploy_pipeline` | `{ id: string }` | Trigger pipeline deployment |
| `ping` | `{}` | Keep-alive |

**Client -> Server (Commands) — v0.9 (write operations, deferred)**

| Message Type | Payload | Description |
|---|---|---|
| `update_node` | `{ id, updates, expectedLastModified }` | Edit a node (requires optimistic lock) |
| `reparent_node` | `{ id, newParentId, expectedLastModified }` | Move a node in the tree |
| `add_node` | `{ node: AuiNode }` | Create a new node |
| `remove_node` | `{ id: string }` | Delete a node |

**Server -> Client (Events)**

| Message Type | Payload | Description |
|---|---|---|
| `auth_ok` | `{ sessionId: string }` | Authentication succeeded (session cookie also set) |
| `auth_fail` | `{ reason: string }` | Authentication failed |
| `full_sync` | `{ nodes: RedactedAuiNode[], metadata }` | Complete redacted tree snapshot |
| `node_updated` | `{ id, node: RedactedAuiNode }` | A node was modified (lastModified serves as version) |
| `node_added` | `{ node: RedactedAuiNode }` | A node was created |
| `node_removed` | `{ id: string }` | A node was deleted |
| `deploy_status` | `{ pipelineId, status, output, step }` | Streaming deploy progress (output batched every 500ms, not per-line) |
| `conflict` | `{ id, yourLastModified, currentLastModified, currentNode }` | Write rejected due to stale version (v0.9) |
| `error` | `{ code: string, message: string }` | Operation error |
| `pong` | `{}` | Keep-alive response |

### 5.3 Shared Type Contract

All WebSocket messages use this envelope:

```typescript
interface RemoteMessage {
  type: string;       // message type from tables above
  id: string;         // request ID for correlation
  payload: unknown;   // type-specific payload
  timestamp: number;  // Unix ms
}
```

**Authentication note:** The initial `auth` message carries the token from the QR code. After `auth_ok`, the server sets an HTTP-only session cookie on the underlying connection. All subsequent WebSocket frames are authenticated by the session cookie associated with the TCP connection — no auth fields appear in the message envelope.

### 5.4 Redacted Node Type

Remote clients receive `RedactedAuiNode` instead of raw `AuiNode`:

```typescript
interface RedactedNodeVariable {
  name: string;
  value: string;          // actual value for type "text" and "note"
  redacted: boolean;      // true for "api-key" and "password" types
  type: VariableKind;
}
// When redacted === true, value is replaced with "********"

interface RedactedAuiNode {
  id: string;
  name: string;
  kind: NodeKind;
  parentId: string | null;
  team: string | null;
  sourcePath: string;
  promptBody: string;
  tags: string[];
  lastModified: number;   // millisecond timestamp, doubles as optimistic lock version
  validationErrors: string[];
  assignedSkills: string[];
  variables: RedactedNodeVariable[];  // sensitive values redacted
  launchPrompt: string;
  pipelineSteps: PipelineStep[];
}
```

**Optimistic locking note:** The existing `lastModified` field (Unix ms) serves as the optimistic lock version. Write commands (v0.9) must include `expectedLastModified` matching the node's current `lastModified`. Millisecond granularity is sufficient to distinguish concurrent edits. No new version field is needed — this reuses the existing `AuiNode.lastModified` that the tree-store already maintains.
```

## 6. Security Considerations

### 6.1 Authentication

- **QR Code + Token:** The desktop app generates a cryptographically random 256-bit token. The QR code encodes the token, the server's LAN IP, port, and TLS certificate fingerprint (SHA-256). The phone scans the QR to obtain all connection parameters securely.
- **Certificate pinning:** On first connect, the mobile client validates the server's TLS certificate fingerprint against the fingerprint embedded in the QR code. If it does not match, the connection is refused. The fingerprint is pinned for the duration of the session, preventing MITM attacks where an attacker presents their own self-signed cert on the same network.
- **Session management:** After initial token-based auth over WebSocket, the server issues an HTTP-only session cookie. Subsequent messages are authenticated via the session, not by repeating the token.
- **Token rotation:** Tokens expire after a configurable period (default: 24 hours). User can regenerate at any time from the desktop UI.
- **Session limit:** Maximum of 3 concurrent remote sessions. Each new connection beyond the limit rejects with an error.
- **Auth failure lockout:** After 5 failed auth attempts from the same IP within 5 minutes, that IP is blocked for 15 minutes.

### 6.2 Transport Security

- **Mandatory TLS:** The server generates a self-signed TLS certificate on first start (using `rustls` + `rcgen`). All HTTP and WebSocket traffic is encrypted. The certificate fingerprint is included in the QR code so the phone can verify it.
- **No plaintext mode.** There is no option to disable TLS. This prevents accidental exposure of tokens and agent data on shared networks.
- **Default bind to `127.0.0.1`:** The server listens only on localhost by default. To enable LAN access, the user must explicitly toggle "Enable Network Access" in the Remote Access settings panel, which switches the bind address to `0.0.0.0`.
- **Network binding warning:** When the user enables network access, the UI displays: "This will make ATM accessible to all devices on your network. Ensure you trust your current network."
- **No internet exposure by default:** No port forwarding, no UPnP, no cloud relay.

### 6.3 Data Protection

- **Sensitive field redaction:** API keys and passwords (`NodeVariable` with type `api-key` or `password`) are replaced with `"********"` in all remote responses. The `RedactedAuiNode` type enforces this at the serialization boundary in Rust, not in the frontend.
- **v0.8 is read-only:** Remote clients cannot modify any data. This eliminates write-path security concerns for the initial release.
- **Audit log:** All remote connections and commands are logged with timestamp, source IP, session ID, and action type. Logs are written to `{projectPath}/.aui/remote-audit.log`.
- **Rate limiting:** Commands are rate-limited to 60/minute per session to prevent abuse.

### 6.4 Threat Model

| Threat | Mitigation |
|---|---|
| Unauthorized access from LAN neighbor | Token-based auth (256-bit random); default bind to localhost only |
| Token interception (network sniffing) | Mandatory TLS; QR code is optical transfer only; session cookie replaces token after auth |
| QR code shoulder surfing | Token expires (24h); user can regenerate anytime; session limit of 3 |
| Brute-force token guessing | 256-bit token space; rate limit on auth attempts; IP lockout after 5 failures |
| Denial of service | Session limit (3); rate limiting; axum connection limits |
| Stale session | Token expiration (24h default); manual revoke from desktop UI |
| CSRF on REST endpoints | CSRF token issued at session establishment; CORS headers restrict origin |
| Sensitive data leakage | `RedactedAuiNode` strips api-key/password values at Rust serialization boundary |

### 6.5 CORS and CSRF

- **CORS:** The `tower-http` CORS layer restricts `Access-Control-Allow-Origin` to the server's own origin (e.g., `https://192.168.1.100:5175`). No wildcard origins.
- **CSRF:** State-changing REST endpoints (POST) require an `X-CSRF-Token` header. The CSRF token is provided in the initial session establishment response and rotates with each session.

## 7. State Bridge Specification

This section defines the bidirectional communication between the Tauri webview (where tree-store lives) and the Rust remote access module (where axum/WebSocket lives).

### 7.1 Desktop -> Remote Clients (State Broadcasting)

The tree-store emits Tauri events whenever state changes. The remote module listens for these events and broadcasts to all connected WebSocket clients.

**Tauri Events emitted by the frontend:**

| Event Name | Payload | Triggered By |
|---|---|---|
| `remote:tree-loaded` | `{ nodes: AuiNode[], metadata: TreeMetadata }` | `loadProject()` completion |
| `remote:node-updated` | `{ id: string, node: AuiNode }` | `updateNode()`, `saveNode()` |
| `remote:node-added` | `{ node: AuiNode }` | `addNode()`, `createAgentNode()`, `createSkillNode()`, etc. |
| `remote:node-removed` | `{ id: string }` | `removeNode()`, `deleteNodeFromDisk()` |
| `remote:node-reparented` | `{ id: string, newParentId: string }` | `reparentNode()` |
| `remote:metadata-saved` | `{ metadata: TreeMetadata }` | `saveTreeMetadata()` |
| `remote:layout-changed` | `{ layoutId: string }` | `switchLayout()` |
| `remote:pipeline-deployed` | `{ nodeId: string, status: string, output: string }` | `deployPipeline()` |
| ~~`remote:disk-sync`~~ | *(removed — redundant, see Section 7.4)* | Disk changes produce per-node `remote:node-updated` events instead |

**Processing pipeline:**
1. Frontend tree-store action executes
2. After successful state mutation, `emit('remote:<event>', payload)` is called
3. Rust remote module receives the event via `app.listen()`
4. Rust applies redaction (strips sensitive variable values)
5. Rust serializes to `RemoteMessage` JSON
6. Rust broadcasts to all authenticated WebSocket clients

### 7.2 Remote Clients -> Desktop (Command Routing) — v0.9

When remote clients send write commands, the Rust server routes them to the webview for execution:

1. WebSocket client sends `update_node` with `expectedVersion`
2. Rust server validates auth, rate limit, and version check
3. If version matches, Rust emits Tauri event `remote:cmd-update-node` to the webview
4. Frontend receives the event, executes `updateNode()` on tree-store
5. Tree-store action triggers `remote:node-updated` event back to Rust
6. Rust broadcasts the update to all remote clients (including the originator as confirmation)

**Error cases:**
- If version mismatch: Rust responds with `conflict` message immediately (no webview round-trip)
- If webview is unresponsive (no response within 5 seconds): Rust responds with `error { code: "BRIDGE_TIMEOUT" }`
- If tree-store action throws: Frontend emits `remote:cmd-error` event; Rust forwards as `error` message

### 7.3 Project Reload Handling

When `loadProject()` is called (app startup, project switch, manual reload):
1. Frontend emits `remote:tree-loading` (clients show loading indicator)
2. Tree reconstruction completes
3. Frontend emits `remote:tree-loaded` with full state
4. Rust sends `full_sync` to all connected clients with the new redacted state

### 7.4 File Watcher Integration

When `syncFromDisk()` fires (external file changes detected):
1. Frontend processes disk changes and updates tree-store
2. For each affected node, the standard `remote:node-updated` events fire (no separate `remote:disk-sync` event needed)
3. Remote clients receive incremental per-node updates, not a full resync

## 8. Implementation Plan

### Phase 1: Core Server (Task #5)
- Add `axum`, `tokio`, `tower`, `tower-http`, `rustls`, `rcgen` to Cargo.toml
- Create `src-tauri/src/remote/` module with:
  - `server.rs` — axum router with TLS, starts on configurable port (default 5175), binds to `127.0.0.1` by default
  - `tls.rs` — self-signed certificate generation and management
  - `auth.rs` — token generation, validation, QR code data (including cert fingerprint)
  - `ws.rs` — WebSocket handler over WSS, message routing
  - `bridge.rs` — bidirectional bridge between Tauri events and remote clients
  - `redact.rs` — `AuiNode` -> `RedactedAuiNode` conversion at serialization boundary
- **Server is OFF by default.** Only starts when user enables "Remote Access" in Settings panel.
- Start/stop server via Tauri commands (`start_remote_server`, `stop_remote_server`, `get_remote_status`)
- Display network binding warning when user toggles LAN access

### Phase 2: API Layer (Task #6)
- Implement all REST endpoints (with CORS and CSRF)
- Implement read-only WebSocket message handlers (v0.8 scope)
- Serialize using `RedactedAuiNode` for all outbound node data
- Add audit logging to `{projectPath}/.aui/remote-audit.log`

### Phase 3: State Synchronization (Task #7)
- Add Tauri event emission to all tree-store actions (per Section 7.1)
- Implement Rust-side event listener and WebSocket broadcast pipeline
- Implement project reload and file watcher integration (Sections 7.3, 7.4)
- Defer write command routing (Section 7.2) to v0.9

### Phase 4: Mobile Web Client (Task #8)
- Build a separate lightweight React SPA in `src-remote/`
- Shares types from `src/types/` but has its own entry point optimized for mobile
- Mobile-first responsive design: minimum 44pt touch targets per Apple HIG
- Connects via secure WebSocket (WSS) to the desktop app
- Connection status indicator with automatic reconnection (exponential backoff, max 30s)
- Bundled into the Tauri binary as static assets served by axum
- Separate Vite build configuration for the remote client

### Phase 5: Mobile Tree Visualization (Task #9)
- Simplified tree view for small screens (list + expandable cards, no full canvas)
- Touch-friendly node inspection (read-only in v0.8)
- Quick actions: deploy pipeline, view node details, view prompts
- Streaming deploy output display (terminal-like view)
- Designed as monitoring + quick-action tool, not a full editor

## 9. New Dependencies

### Rust (Cargo.toml additions)
```toml
tokio = { version = "1", features = ["full"] }
axum = { version = "0.8", features = ["ws"] }
tower = "0.5"
tower-http = { version = "0.6", features = ["fs", "cors"] }
rustls = "0.23"         # TLS implementation
rcgen = "0.13"          # self-signed certificate generation
rand = "0.9"            # token generation
base64 = "0.22"         # QR code token encoding
```

### Frontend (package.json — for mobile web client)
- No new frontend dependencies needed. The mobile client reuses React + Zustand. It connects via native browser WebSocket API.

## 10. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Tauri + tokio runtime conflict | Low | High | Tauri v2 already uses tokio internally; axum integrates cleanly |
| Binary size increase (~5-10MB) | Low | Low | Server is lazy-started; binary size acceptable for a desktop app |
| State sync desync (missed events) | Medium | Medium | Full resync on reconnect; audit log for debugging; integration tests for all 30+ store actions |
| Users exposing server to internet | Medium | High | Default bind to 127.0.0.1; explicit opt-in for 0.0.0.0; prominent UI warning; mandatory TLS |
| Phone disconnects mid-deploy | Medium | Low | Deploy continues on desktop; reconnect shows current status; streaming output resumes |
| Self-signed cert UX friction | Medium | Low | Cert fingerprint in QR code; one-time browser warning; clear instructions in UI |
| Conflict on concurrent edits (v0.9) | Medium | Medium | Optimistic locking with version numbers; reject stale writes; conflict notification UI |

## 11. Future Enhancements (Post v0.8)

- **v0.9: Write operations** — Full edit capabilities with optimistic locking and conflict resolution UI
- **Secure tunnel:** Built-in Cloudflare Tunnel or WireGuard integration for remote access beyond LAN
- **Push notifications:** Notify phone when pipeline completes or agent errors occur
- **Voice commands:** Use phone microphone for voice-to-text agent prompts
- **Multi-user:** Support multiple users with role-based access (admin/viewer)
- **Native mobile app:** If demand warrants, build native apps using the same API surface

---

**Summary:** Embed an axum HTTPS + WebSocket server in the Tauri Rust backend. The server is off by default, lazy-started when the user enables remote access. Mobile phones connect via browser on the same network after scanning a QR code that includes the auth token and TLS cert fingerprint. v0.8 ships read-only monitoring + deploy; v0.9 adds write operations with optimistic locking. Sensitive variables are redacted at the Rust serialization boundary. This approach delivers the fastest time-to-value with the strongest security posture, while keeping the door open for cloud tunneling in a future release.
