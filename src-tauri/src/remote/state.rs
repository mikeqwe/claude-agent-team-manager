use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::{broadcast, RwLock};

/// Configuration for the remote access server.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RemoteConfig {
    pub port: u16,
    pub enabled: bool,
    pub expose_on_network: bool,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self {
            port: 5175,
            enabled: false,
            expose_on_network: false,
        }
    }
}

/// A WebSocket message that can be broadcast to all connected clients.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WsMessage {
    pub event: String,
    pub payload: serde_json::Value,
}

/// Shared application state accessible by the server and all WebSocket clients.
pub struct AppState {
    nodes: RwLock<HashMap<String, serde_json::Value>>,
    layouts: RwLock<serde_json::Value>,
    settings: RwLock<serde_json::Value>,
    config: RwLock<RemoteConfig>,
    broadcast_tx: broadcast::Sender<String>,
}

impl AppState {
    /// Create a new AppState with the given config and broadcast channel sender.
    pub fn new(config: RemoteConfig, broadcast_tx: broadcast::Sender<String>) -> Self {
        Self {
            nodes: RwLock::new(HashMap::new()),
            layouts: RwLock::new(serde_json::Value::Null),
            settings: RwLock::new(serde_json::Value::Null),
            config: RwLock::new(config),
            broadcast_tx,
        }
    }

    /// Get the current remote config.
    pub async fn get_config(&self) -> RemoteConfig {
        self.config.read().await.clone()
    }

    /// Replace all nodes with a new map (full sync).
    pub async fn replace_all_nodes(&self, map: HashMap<String, serde_json::Value>) {
        let mut nodes = self.nodes.write().await;
        *nodes = map;
    }

    /// Set the layouts data.
    pub async fn set_layouts(&self, layouts: serde_json::Value) {
        let mut current = self.layouts.write().await;
        *current = layouts;
    }

    /// Set the settings data.
    pub async fn set_settings(&self, settings: serde_json::Value) {
        let mut current = self.settings.write().await;
        *current = settings;
    }

    /// Broadcast a WsMessage to all connected WebSocket clients.
    pub fn broadcast(&self, msg: WsMessage) {
        let envelope = serde_json::json!({
            "type": msg.event,
            "payload": msg.payload,
            "timestamp": chrono::Utc::now().timestamp_millis(),
        });
        if let Ok(json) = serde_json::to_string(&envelope) {
            let _ = self.broadcast_tx.send(json);
        }
    }

    /// Subscribe to the broadcast channel (one receiver per WebSocket client).
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.broadcast_tx.subscribe()
    }

    /// Get a clone of the nodes map.
    pub async fn get_nodes(&self) -> HashMap<String, serde_json::Value> {
        self.nodes.read().await.clone()
    }

    /// Get the layouts data.
    pub async fn get_layouts(&self) -> serde_json::Value {
        self.layouts.read().await.clone()
    }

    /// Get the settings data.
    pub async fn get_settings(&self) -> serde_json::Value {
        self.settings.read().await.clone()
    }

    /// Get a reference to the broadcast sender.
    pub fn broadcast_tx(&self) -> &broadcast::Sender<String> {
        &self.broadcast_tx
    }
}
