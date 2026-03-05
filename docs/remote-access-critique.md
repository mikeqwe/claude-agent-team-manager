# Devil's Advocate: Critique of Remote Access Architecture Proposal

**Reviewer:** Devils Advocate
**Date:** 2026-03-04
**Document Under Review:** `docs/remote-access-architecture.md` v1.0

---

## Executive Summary

The embedded web server (axum inside Tauri) approach is defensible, but the proposal underestimates implementation complexity, glosses over critical security gaps, and risks destabilizing the core desktop app for a feature with uncertain demand. Below are 8 specific concerns with severity ratings, followed by a final recommendation.

---

## Concern #1: The Proposal Understates Implementation Complexity
**Severity: HIGH**

The proposal calls the embedded server approach "Medium" complexity. This is misleading. Consider what must actually be built:

1. **A full Rust web server module** (`server.rs`, `auth.rs`, `ws.rs`, `bridge.rs`) -- this is not trivial. Axum + tokio + WebSocket handling + connection management + auth + rate limiting is a substantial Rust codebase, arguably rivaling the existing `lib.rs` in size.

2. **A complete second React application** (`src-remote/`) -- even if it "shares types," it needs its own routing, its own state management, its own WebSocket client, its own responsive UI components, and its own build pipeline. The proposal says "No new frontend dependencies needed" but then requires building an entire SPA from scratch.

3. **A bidirectional state synchronization system** between the Tauri webview (desktop) and the axum WebSocket server (remote). This means every tree-store mutation must now be intercepted, serialized, and broadcast. The tree-store currently has 30+ actions -- each one needs a sync pathway.

4. **The mobile web client must be bundled as static assets inside the Tauri binary.** This means a separate Vite build step, embedding in the Rust binary, and serving via axum's `tower-http::fs`. This is doable but adds build complexity that the proposal hand-waves.

5. **The existing `tree-store.ts` has no abstraction for external consumers.** It's 700+ lines of tightly coupled Zustand state with direct Tauri FS calls. Making it remotely observable requires either: (a) duplicating business logic in Rust, or (b) routing remote commands through the Tauri webview via IPC, which adds latency and fragility.

**Estimated actual effort:** This is closer to a 4-6 week feature, not a "medium complexity" addition. For a single-developer project (per the README: "Built by one person"), this is a significant commitment.

### Suggested Mitigation
Be honest about scope. Consider a phased v0.8 that ships read-only remote monitoring first, deferring write operations (edit, deploy, reparent) to v0.9. This cuts the surface area roughly in half.

---

## Concern #2: Security Model Has Critical Gaps
**Severity: HIGH**

### 2a. No TLS by default is unacceptable

The proposal says "For users on trusted home/office WiFi, this is acceptable without TLS." This is wrong. Here's why:

- **Shared WiFi networks (coffee shops, coworking spaces, hotel WiFi)** are common attack vectors. The proposal assumes users are always on trusted networks.
- **The QR code contains the auth token.** If someone photographs the QR code (shoulder surfing, screen sharing), they have full access. The token is the only authentication layer.
- **WebSocket traffic is plaintext without TLS.** Any device on the same network can sniff WebSocket frames containing `AuiNode` payloads -- which include `promptBody` (agent instructions), `variables` (containing API keys and passwords), and `launchPrompt` (deployment commands).
- **The proposal says variables are "redacted by default"** but the `RemoteNodeSchema` in `src/types/remote.ts` includes `variables: z.array(NodeVariableSchema)` with the full `value` field. Where is the redaction enforced? There's no `RedactedNodeVariableSchema` defined. This is a design gap.

The threat model table says "Token interception (network sniffing) -- QR code is optical (not transmitted over network)." But the **token IS transmitted over the network** in every WebSocket message via `WsClientMessage.sessionId`. Anyone sniffing the WebSocket connection gets the session ID.

### 2b. Session tokens in every WebSocket message

The `WsClientMessage` schema requires `sessionId` in every message. This means the session token is transmitted repeatedly over the wire. If an attacker intercepts any single WebSocket frame, they can hijack the session. This is exactly the threat that TLS is designed to prevent.

### 2c. No CSRF protection for REST endpoints

The REST endpoints (`/api/auth/token`, `/api/health`) have no CSRF mitigation documented. Since the mobile client is a browser-based SPA, a malicious page on the same network could make cross-origin requests to the ATM server.

### Suggested Mitigation
- **Mandate TLS with auto-generated self-signed certificates.** The Rust server should generate a self-signed cert on first start and include the cert fingerprint in the QR code. The mobile browser will show a certificate warning once, then trust it.
- **Use HTTP-only cookies for session management** instead of passing tokens in WebSocket messages.
- **Add CORS headers** restricting origins. Add CSRF tokens for state-changing REST endpoints.
- **Create a `RedactedRemoteNode` type** that strips `variables[].value` for password/api-key types at the serialization layer.

---

## Concern #3: Conflict Resolution is Dangerously Naive
**Severity: MEDIUM-HIGH**

The proposal says: "Conflict resolution: last-write-wins with timestamp comparison."

This is a recipe for data loss. Consider:

1. **User edits an agent's prompt on desktop.** The edit triggers tree-store mutation, then Tauri event, then WebSocket broadcast.
2. **Simultaneously, the user edits the same agent's prompt on their phone.** The phone sends an `update_node` command over WebSocket.
3. **Whichever write arrives last "wins."** The other edit is silently lost. No merge, no notification, no conflict marker.

The proposal also says "desktop always wins on conflict," contradicting "last-write-wins." Which is it?

For a tool managing deployment configurations and API keys, silent data loss is dangerous. A user could unknowingly deploy with stale credentials or an incomplete prompt because their desktop edit was overwritten by a stale phone edit (or vice versa).

### Suggested Mitigation
- Implement **optimistic locking** with version numbers per node. Each `update_node` must include the expected `lastModified` timestamp. If it doesn't match, reject with a conflict error and send the current state back.
- Show a **conflict notification** on the mobile client: "This node was modified on the desktop. Your changes: X. Desktop changes: Y. Keep which?"
- At minimum, log all overwrites in the audit log so users can recover.

---

## Concern #4: Binding to 0.0.0.0 by Default is a Liability
**Severity: MEDIUM**

The proposal says: "The server binds to `0.0.0.0:{port}` on the LAN only."

Binding to `0.0.0.0` means listening on ALL network interfaces. There's no such thing as "LAN only" binding at the socket level -- the OS will accept connections from any routable interface, including:

- VPN interfaces (corporate VPN could expose the port to the entire company network)
- Docker bridge networks
- Hyper-V virtual switches
- Any port forwarding rules the user already has

The proposal says "No port forwarding, no UPnP" but the app has no control over the user's router or firewall configuration. If their router forwards port 5175, the server is internet-exposed with no TLS and a single 256-bit token as the only defense.

### Suggested Mitigation
- **Default to `127.0.0.1`** (localhost only). Require explicit user action to bind to `0.0.0.0`.
- **Display a prominent warning** in the UI when enabling network binding: "This will make ATM accessible to all devices on your network."
- **Add a firewall rule check** (or at least a warning) on Windows/macOS.

---

## Concern #5: The State Bridge Architecture is Underspecified
**Severity: MEDIUM**

The proposal's weakest section is Phase 3 (State Synchronization). It says:

> "When tree-store changes in the frontend, emit Tauri events that the remote module picks up and broadcasts to WebSocket clients."

This sounds simple, but the tree-store is a Zustand store running inside the Tauri webview (browser context). The axum server runs in the Rust process. The bridge between them is Tauri's IPC system. Consider the implications:

1. **Every tree-store action must emit a Tauri event.** The store has 30+ actions. Missing even one creates a desync between desktop and remote views.
2. **Remote commands must route through the webview.** When a phone sends `update_node`, the Rust server receives it, but the actual business logic (validation, file writing, skill assignment) lives in TypeScript. The Rust side must forward the command to the webview, wait for the result, then respond to the WebSocket client. This adds latency and a failure mode (what if the webview is busy or unresponsive?).
3. **No specification for what happens during project reload.** The desktop app calls `loadProject()` on mount, which reconstructs the entire tree from disk. What happens to connected remote clients during this operation? Do they get a full resync? How is the transition managed?
4. **File watcher events from disk changes.** The app already has `syncFromDisk` for file watcher events. Remote clients need these too. But the proposal doesn't mention this pathway.

### Suggested Mitigation
- Write a detailed **state bridge specification** before implementing. Define every event type, the exact Tauri IPC messages, and error handling for each pathway.
- Consider an alternative: instead of bridging through the webview, **duplicate the tree loading logic in Rust** and have the Rust server be the source of truth, with the webview and remote clients both consuming from it. This is more work upfront but eliminates the webview-as-bottleneck problem.

---

## Concern #6: Binary Size and Resource Consumption Impact
**Severity: LOW-MEDIUM**

The proposal claims axum adds "~2MB" to the binary. This is optimistic. A full tokio runtime + axum + tower + tower-http (with static file serving) + WebSocket handling adds closer to 5-10MB in release mode. But the real concern is runtime resources:

- **Tokio spawns a thread pool.** Even idle, this consumes memory and CPU cycles. For users who never use remote access, they're paying this cost.
- **The WebSocket server maintains persistent connections.** Each connection holds a TCP socket, a read/write buffer, and the serialized state it's tracking.
- **The static file server holds the entire mobile SPA in memory** (or reads from the embedded binary).

For a desktop app that currently starts in <2 seconds and uses modest resources, adding an always-on web server is a regression.

### Suggested Mitigation
- **Lazy-start the server.** Don't start axum on app launch. Only start when the user explicitly enables remote access from the Settings panel. Stop when disabled.
- **The proposal mentions this** ("Start/stop server via Tauri commands") but doesn't make it clear this is the default behavior. Make it explicit: server is OFF by default.

---

## Concern #7: Mobile UX is Oversimplified
**Severity: LOW-MEDIUM**

The proposal says: "Simplified tree view for small screens (list + expandable cards rather than full canvas)."

But it doesn't address:

1. **What happens when the phone loses WiFi connection?** Is there a reconnection strategy? Backoff? Does the UI show a "disconnected" state? Can the user still view the last-known state while disconnected?
2. **Touch target sizing.** The desktop app uses React Flow with small connection handles and context menus. None of this translates to touch. The proposal doesn't spec minimum touch targets (Apple HIG says 44pt, Material says 48dp).
3. **The deploy action triggers a terminal launch on the desktop.** From the phone, the user taps "Deploy" and... nothing visible happens on their phone. How does the user know the deploy started? How do they see terminal output? The `WsDeployStatusEvent` only provides `status` and `message` strings -- is that enough?
4. **Editing agent prompts on a phone keyboard.** The desktop app uses Monaco Editor. The mobile client will need a textarea for editing potentially long markdown prompts with YAML frontmatter. This is a poor experience that the proposal doesn't acknowledge.

### Suggested Mitigation
- Add a **connection status indicator** with automatic reconnection (exponential backoff, max 30s).
- Design the mobile client as primarily a **monitoring + quick-action tool**, not a full editor. Deploy pipeline, view status, quick-edit names and short fields. Save full prompt editing for the desktop.
- Stream deploy output (stdout) through WebSocket for real-time terminal-like view on mobile.

---

## Concern #8: Process Concern -- Implementation Started Before Architecture Review
**Severity: META (Process)**

I observe that Tasks #4 (TypeScript schemas), #5 (Rust web server), and #7 (state sync) were started before this architecture critique was complete. The `src/types/remote.ts` file already exists with 347 lines of schema definitions. This means:

- **The architecture review is partially ceremonial.** If implementation is already underway, fundamental changes become politically and practically harder to make.
- **The schemas may need revision.** My security concerns (#2) suggest that `RemoteNodeSchema` needs a redacted variant, the auth flow needs rethinking, and the `WsClientMessage` envelope should not include raw session tokens. But these schemas are already being consumed downstream.

This is not a criticism of the architecture itself, but of the process. A Devil's Advocate review has value only if it can influence decisions.

---

## Final Recommendation

**The proposal should proceed with modifications.** The embedded web server approach is the right choice for ATM's use case, but the current proposal needs these changes before implementation continues:

### Must-Fix (Block Implementation)
1. **Mandatory TLS with auto-generated self-signed certificates.** No plaintext WebSocket connections carrying auth tokens and agent configurations.
2. **Optimistic locking for conflict resolution.** Version numbers per node, reject stale writes.
3. **Default to server OFF.** Lazy-start only when user enables remote access.
4. **Redacted node type for remote transmission.** `api-key` and `password` variable values must never be sent to remote clients by default.

### Should-Fix (Before v0.8 Release)
5. **Default bind to `127.0.0.1`**, require explicit opt-in for `0.0.0.0`.
6. **Detailed state bridge specification** defining every IPC pathway and error case.
7. **Scope v0.8 to read-only + deploy.** Defer full edit capabilities to v0.9 to reduce risk.

### Nice-to-Have (Post v0.8)
8. **Connection resilience** (reconnection strategy, offline cached state on mobile).
9. **CORS and CSRF protections** for REST endpoints.

The overall direction is sound. The execution plan needs hardening.

---

*Reviewed against: `docs/remote-access-architecture.md` v1.0, `src/types/remote.ts`, existing codebase at `src-tauri/src/lib.rs`, `src/store/tree-store.ts`, `src/store/ui-store.ts`, `src/types/aui-node.ts`.*
