use tokio::sync::broadcast;

/// Manages bidirectional communication between the Tauri webview and remote clients.
///
/// Desktop -> Remote: The frontend emits Tauri events, the Rust listener picks them
/// up, and this bridge broadcasts to all WebSocket clients.
///
/// Remote -> Desktop: Remote clients send commands via WebSocket, this bridge routes
/// them as Tauri events to the webview for execution.
#[derive(Clone)]
pub struct BridgeState {
    /// Broadcast channel: serialized JSON strings sent to all WebSocket clients.
    ws_tx: broadcast::Sender<String>,
    /// Tauri app handle for emitting events to the frontend.
    app_handle: tauri::AppHandle,
}

impl BridgeState {
    pub fn new(app_handle: tauri::AppHandle, ws_tx: broadcast::Sender<String>) -> Self {
        Self {
            ws_tx,
            app_handle,
        }
    }

    /// Subscribe to the WebSocket broadcast channel (one per client).
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.ws_tx.subscribe()
    }

    /// Broadcast a pre-serialized JSON string to all WebSocket clients.
    pub fn broadcast_raw(&self, json: String) {
        let _ = self.ws_tx.send(json);
    }

    /// Broadcast a RemoteMessage to all connected WebSocket clients.
    pub fn broadcast_event(&self, event_type: &str, id: &str, payload: serde_json::Value) {
        let msg = serde_json::json!({
            "type": event_type,
            "id": id,
            "payload": payload,
            "timestamp": chrono::Utc::now().timestamp_millis(),
        });
        if let Ok(json) = serde_json::to_string(&msg) {
            self.broadcast_raw(json);
        }
    }

    /// Request a full state sync from the frontend (triggers `remote:request-sync` event).
    pub async fn request_full_sync(&self) {
        use tauri::Emitter;
        let _ = self
            .app_handle
            .emit("remote:request-sync", serde_json::json!({}));
    }

    /// Request a specific node from the frontend.
    pub async fn request_node(&self, node_id: &str) {
        use tauri::Emitter;
        let _ = self.app_handle.emit(
            "remote:request-node",
            serde_json::json!({ "id": node_id }),
        );
    }

    /// Store the full app state from the frontend (for REST API access).
    /// This is called by the `sync_state_to_remote` Tauri command.
    pub async fn store_full_state(
        &self,
        nodes: serde_json::Value,
        layouts: serde_json::Value,
        settings: serde_json::Value,
    ) {
        // Emit as a Tauri event so any Rust-side listener can consume it,
        // and broadcast to WebSocket clients as a full_sync event.
        let id = uuid::Uuid::new_v4().to_string();
        self.broadcast_event("full_sync", &id, serde_json::json!({
            "nodes": nodes,
            "layouts": layouts,
            "settings": settings,
        }));
    }

    /// Request a pipeline deployment from the frontend.
    /// The frontend handles the actual deployment logic; we just route the command.
    pub async fn request_deploy(&self, node_id: &str, request_id: &str) {
        use tauri::Emitter;
        let _ = self.app_handle.emit(
            "remote:deploy-pipeline",
            serde_json::json!({ "nodeId": node_id, "requestId": request_id }),
        );
    }

    /// Get the Tauri app handle for registering event listeners.
    pub fn app_handle(&self) -> &tauri::AppHandle {
        &self.app_handle
    }
}
