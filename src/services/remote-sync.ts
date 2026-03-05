import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AuiNode } from "@/types/aui-node";
import type {
  RedactedRemoteNode,
  RemoteMessage,
  ServerEventType,
} from "@/types/remote";
import { redactNode } from "@/types/remote";

// ── Serialization helpers ────────────────────────────

/**
 * Convert an AuiNode to a RedactedRemoteNode (strips sourcePath) and redact
 * sensitive variable values (api-key, password) to prevent leaking secrets
 * over the wire.
 */
export function nodeToRemote(node: AuiNode): RedactedRemoteNode {
  return redactNode({
    id: node.id,
    name: node.name,
    kind: node.kind,
    parentId: node.parentId,
    team: node.team,
    config: node.config,
    promptBody: node.promptBody,
    tags: node.tags,
    lastModified: node.lastModified,
    validationErrors: node.validationErrors,
    assignedSkills: node.assignedSkills,
    variables: node.variables,
    launchPrompt: node.launchPrompt,
    pipelineSteps: node.pipelineSteps,
  });
}

/** Convert a Map<string, AuiNode> to a RedactedRemoteNode array. */
export function serializeNodes(nodes: Map<string, AuiNode>): RedactedRemoteNode[] {
  const result: RedactedRemoteNode[] = [];
  for (const node of nodes.values()) {
    result.push(nodeToRemote(node));
  }
  return result;
}

// ── Remote Sync Service ──────────────────────────────

type PushHandler = (msg: RemoteMessage) => void;
type ConnectionHandler = (connected: boolean, clientCount: number) => void;

/**
 * Bridges the desktop frontend with the Rust remote access server using
 * Tauri commands and events (NOT WebSocket -- the desktop communicates
 * with the Rust backend via IPC, not over the network).
 *
 * Communication flow:
 *   Local store change -> broadcastEvent() -> invoke("broadcast_to_remote") -> Rust bridge -> WS fan-out to mobiles
 *   Mobile command -> WS -> Rust bridge -> Tauri event ("remote:request-sync") -> onPush handler -> local store
 */
class RemoteSyncService {
  private pushHandlers: Set<PushHandler> = new Set();
  private connectionHandlers: Set<ConnectionHandler> = new Set();
  private reconnectHandlers: Set<() => void> = new Set();
  private _connected: boolean = false;
  private _clientCount: number = 0;
  /** When true, the next state mutation was triggered by a remote command -- skip broadcasting. */
  private _remoteOrigin: boolean = false;
  /** Cleanup functions for all Tauri event listeners. */
  private _unlisteners: Array<() => void> = [];

  get connected(): boolean {
    return this._connected;
  }

  get clientCount(): number {
    return this._clientCount;
  }

  /** Check and consume the remote-origin flag (prevents echo loops). */
  consumeRemoteOrigin(): boolean {
    if (this._remoteOrigin) {
      this._remoteOrigin = false;
      return true;
    }
    return false;
  }

  /** Mark the next store mutation as originating from a remote client. */
  markRemoteOrigin(): void {
    this._remoteOrigin = true;
  }

  /** Register a handler for incoming push events from the server. */
  onPush(handler: PushHandler): () => void {
    this.pushHandlers.add(handler);
    return () => this.pushHandlers.delete(handler);
  }

  /** Register a handler for connection status changes. */
  onConnectionChange(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  /** Register a handler called on reconnect (not first connect). Used to push full resync. */
  onReconnect(handler: () => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }

  /**
   * Broadcast a server event to all connected remote clients via the Rust bridge.
   * No-op if the server is not running.
   */
  broadcastEvent(type: ServerEventType, payload: unknown): void {
    if (!this._connected) return;

    invoke("broadcast_to_remote", {
      eventType: type,
      payload,
    }).catch((err) => {
      console.warn("[RemoteSync] Failed to broadcast:", err);
    });
  }

  /**
   * Initialize: listen for Tauri events from the Rust server.
   *
   * Events handled:
   * - "remote-server-started" — server is up, mark connected
   * - "remote-server-stopped" — server is down, mark disconnected
   * - "remote:request-sync" — mobile client requested full tree, forward to push handlers
   * - "remote:request-node" — mobile client requested a specific node
   */
  async init(): Promise<void> {
    if (this._unlisteners.length > 0) return;

    const u1 = await listen<{ port: number; url: string; pin: string }>(
      "remote-server-started",
      (event) => {
        console.log("[RemoteSync] Server started on port", event.payload?.port);
        this._connected = true;
        this.notifyConnectionChange();

        // Fire reconnect handlers to push full state
        for (const handler of this.reconnectHandlers) {
          try {
            handler();
          } catch (err) {
            console.warn("[RemoteSync] Reconnect handler error:", err);
          }
        }
      },
    );

    const u2 = await listen("remote-server-stopped", () => {
      console.log("[RemoteSync] Server stopped");
      this._connected = false;
      this._clientCount = 0;
      this.notifyConnectionChange();
    });

    // Bridge event: mobile client requested full tree sync
    const u3 = await listen("remote:request-sync", () => {
      const msg: RemoteMessage = {
        type: "get_tree",
        id: crypto.randomUUID(),
        payload: {},
        timestamp: Date.now(),
      };
      for (const handler of this.pushHandlers) {
        try {
          handler(msg);
        } catch (err) {
          console.warn("[RemoteSync] Push handler error:", err);
        }
      }
    });

    // Bridge event: mobile client requested a specific node
    const u4 = await listen<{ id: string }>("remote:request-node", (event) => {
      const nodeId = event.payload?.id;
      if (!nodeId) return;
      const msg: RemoteMessage = {
        type: "get_node",
        id: crypto.randomUUID(),
        payload: { id: nodeId },
        timestamp: Date.now(),
      };
      for (const handler of this.pushHandlers) {
        try {
          handler(msg);
        } catch (err) {
          console.warn("[RemoteSync] Push handler error:", err);
        }
      }
    });

    this._unlisteners.push(u1, u2, u3, u4);
  }

  /**
   * Push the full app state to the Rust shared state so the REST API
   * and new WebSocket clients can access it.
   */
  async syncFullState(
    nodes: Map<string, AuiNode>,
    layouts: unknown,
    settings: unknown,
  ): Promise<void> {
    const nodesObj: Record<string, RedactedRemoteNode> = {};
    for (const [id, node] of nodes) {
      nodesObj[id] = nodeToRemote(node);
    }
    await invoke("sync_state_to_remote", {
      nodes: nodesObj,
      layouts: layouts ?? null,
      settings: settings ?? null,
    }).catch((err) => {
      console.warn("[RemoteSync] syncFullState failed:", err);
    });
  }

  /** Tear down the service and clean up all resources. */
  dispose(): void {
    this._connected = false;
    this._clientCount = 0;
    this.pushHandlers.clear();
    this.connectionHandlers.clear();
    this.reconnectHandlers.clear();
    for (const unlisten of this._unlisteners) {
      unlisten();
    }
    this._unlisteners = [];
  }

  // ── Private ──────────────────────────────────────

  private notifyConnectionChange(): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(this._connected, this._clientCount);
      } catch (err) {
        console.warn("[RemoteSync] Connection handler error:", err);
      }
    }
  }
}

/** Singleton instance shared across the app. */
export const remoteSync = new RemoteSyncService();
