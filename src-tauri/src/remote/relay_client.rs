use std::sync::Arc;
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter};

/// Relay client connection state
pub struct RelayClient {
    /// Channel to send messages to the relay WebSocket
    tx: mpsc::UnboundedSender<String>,
    /// Shutdown signal
    shutdown: Arc<Notify>,
    /// Room code assigned by relay
    pub room_code: String,
}

/// Status returned to frontend
#[derive(serde::Serialize, Clone)]
pub struct RelayStatus {
    pub connected: bool,
    pub room_code: Option<String>,
    pub client_connected: bool,
}

impl RelayClient {
    /// Connect to the relay server, create a room, and start message forwarding.
    pub async fn connect(
        relay_url: &str,
        public_key: &str,
        app: AppHandle,
    ) -> Result<Self, String> {
        let url = format!("{}/ws", relay_url.trim_end_matches('/'));

        let (ws_stream, _) = connect_async(&url)
            .await
            .map_err(|e| format!("WebSocket connection failed: {}", e))?;

        let (mut write, mut read) = ws_stream.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let shutdown = Arc::new(Notify::new());

        // Send create_room message
        let create_msg = serde_json::json!({
            "type": "create_room",
            "desktop_public_key": public_key,
        });
        write
            .send(Message::Text(create_msg.to_string().into()))
            .await
            .map_err(|e| format!("Failed to send create_room: {}", e))?;

        // Wait for room_created response
        let room_code = loop {
            match read.next().await {
                Some(Ok(Message::Text(text))) => {
                    let msg: serde_json::Value = serde_json::from_str(&text)
                        .map_err(|e| format!("Invalid JSON from relay: {}", e))?;

                    match msg.get("type").and_then(|t| t.as_str()) {
                        Some("room_created") => {
                            let code = msg
                                .get("room_code")
                                .and_then(|c| c.as_str())
                                .ok_or("Missing room_code")?
                                .to_string();
                            break code;
                        }
                        Some("relay_error") => {
                            let error_msg = msg
                                .get("message")
                                .and_then(|m| m.as_str())
                                .unwrap_or("Unknown relay error");
                            return Err(format!("Relay error: {}", error_msg));
                        }
                        _ => continue,
                    }
                }
                Some(Ok(Message::Close(_))) | None => {
                    return Err("Connection closed before room creation".to_string());
                }
                Some(Err(e)) => {
                    return Err(format!("WebSocket error: {}", e));
                }
                _ => continue,
            }
        };

        let app_read = app.clone();
        let shutdown_read = shutdown.clone();
        let shutdown_write = shutdown.clone();

        // Spawn task to read from relay and emit Tauri events
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown_read.notified() => break,
                    msg = read.next() => {
                        match msg {
                            Some(Ok(Message::Text(text))) => {
                                // Try to parse as relay protocol message
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                                    match parsed.get("type").and_then(|t| t.as_str()) {
                                        Some("peer_joined") => {
                                            let _ = app_read.emit("relay:peer-joined", serde_json::json!({
                                                "mobile_public_key": parsed.get("mobile_public_key")
                                                    .and_then(|k| k.as_str())
                                                    .unwrap_or("")
                                            }));
                                            continue;
                                        }
                                        Some("peer_disconnected") => {
                                            let _ = app_read.emit("relay:peer-disconnected", serde_json::json!({}));
                                            continue;
                                        }
                                        Some("relay_error") => {
                                            log::warn!("Relay error: {:?}", parsed.get("message"));
                                            continue;
                                        }
                                        _ => {
                                            // Forward encrypted blob to frontend
                                            let _ = app_read.emit("relay:message", serde_json::json!({
                                                "data": text.to_string()
                                            }));
                                        }
                                    }
                                }
                            }
                            Some(Ok(Message::Close(_))) | None => {
                                let _ = app_read.emit("relay:disconnected", serde_json::json!({}));
                                break;
                            }
                            Some(Err(e)) => {
                                log::warn!("Relay read error: {}", e);
                                let _ = app_read.emit("relay:disconnected", serde_json::json!({}));
                                break;
                            }
                            _ => continue,
                        }
                    }
                }
            }
            // Signal the write task to stop when the read task exits
            shutdown_read.notify_waiters();
        });

        // Spawn task to write from channel to relay
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown_write.notified() => break,
                    msg = rx.recv() => {
                        match msg {
                            Some(data) => {
                                if let Err(e) = write.send(Message::Text(data.into())).await {
                                    log::warn!("Relay write error: {}", e);
                                    break;
                                }
                            }
                            None => break,
                        }
                    }
                }
            }
            // Signal the read task to stop when the write task exits
            shutdown_write.notify_waiters();
        });

        Ok(RelayClient {
            tx,
            shutdown,
            room_code,
        })
    }

    /// Send an encrypted blob to the relay (forwarded to the mobile peer)
    pub fn send(&self, data: &str) -> Result<(), String> {
        self.tx
            .send(data.to_string())
            .map_err(|e| format!("Failed to send to relay: {}", e))
    }

    /// Disconnect from the relay
    pub fn disconnect(&self) {
        self.shutdown.notify_waiters();
    }
}
