use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Query, State,
    },
    http::HeaderMap,
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;

use super::auth::AuthManager;
use super::bridge::BridgeState;

#[derive(Deserialize)]
pub struct WsQuery {
    pub token: String,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<RemoteState>>,
) -> impl IntoResponse {
    if let Some(origin) = headers.get("origin") {
        let origin_str = origin.to_str().unwrap_or("");
        if !is_allowed_origin(origin_str, &state.server_origin) {
            log::warn!("WebSocket rejected: invalid origin {} from {}", origin_str, addr);
            return axum::http::StatusCode::FORBIDDEN.into_response();
        }
    }

    match state.auth.validate_token(&query.token).await {
        Ok(session) => {
            log::info!("WebSocket upgraded for session {} from {}", session.session_id, addr);
            let token = query.token.clone();
            ws.on_upgrade(move |socket| handle_socket(socket, state, token))
                .into_response()
        }
        Err(e) => {
            log::warn!("WebSocket auth failed from {}: {}", addr, e);
            axum::http::StatusCode::UNAUTHORIZED.into_response()
        }
    }
}

async fn handle_socket(socket: WebSocket, state: Arc<RemoteState>, token: String) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.bridge.subscribe();

    let send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let state_clone = state.clone();
    let token_clone = token.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    let _ = state_clone.auth.validate_token(&token_clone).await;
                    handle_client_message(&state_clone, &text).await;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }
}

async fn handle_client_message(state: &RemoteState, text: &str) {
    let msg: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            log::warn!("Invalid JSON from WebSocket client");
            return;
        }
    };

    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let msg_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();

    match msg_type {
        "ping" => {
            let reply = serde_json::json!({
                "type": "pong",
                "id": msg_id,
                "payload": { "serverTime": chrono::Utc::now().timestamp_millis() },
                "timestamp": chrono::Utc::now().timestamp_millis(),
            });
            state.bridge.broadcast_raw(serde_json::to_string(&reply).unwrap_or_default());
        }
        "get_tree" => {
            state.bridge.request_full_sync().await;
        }
        "get_node" => {
            if let Some(id) = msg.get("payload").and_then(|p| p.get("id")).and_then(|v| v.as_str()) {
                state.bridge.request_node(id).await;
            }
        }
        "deploy_pipeline" => {
            if let Some(payload) = msg.get("payload") {
                if let Some(node_id) = payload.get("nodeId").and_then(|v| v.as_str()) {
                    state.bridge.request_deploy(node_id, &msg_id).await;
                }
            }
        }
        _ => {
            log::debug!("Unknown WebSocket message type: {}", msg_type);
        }
    }
}

fn is_allowed_origin(origin: &str, server_origin: &str) -> bool {
    if origin == server_origin {
        return true;
    }
    if origin.is_empty() {
        return true;
    }
    false
}

pub struct RemoteState {
    pub auth: AuthManager,
    pub bridge: BridgeState,
    pub server_origin: String,
}
