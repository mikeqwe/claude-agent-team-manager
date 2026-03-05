use axum::extract::State;
use axum::response::Json;
use serde::Serialize;
use std::sync::Arc;
use std::time::Instant;

use crate::room::RoomManager;

/// Shared state needed by the health endpoint.
pub struct HealthState {
    pub room_manager: Arc<RoomManager>,
    pub started_at: Instant,
}

/// JSON body returned by `GET /health`.
#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub rooms: usize,
    pub connections: usize,
    pub uptime_seconds: u64,
}

/// Handler for `GET /health`.
pub async fn health_handler(
    State(state): State<Arc<HealthState>>,
) -> Json<HealthResponse> {
    let uptime = Instant::now()
        .duration_since(state.started_at)
        .as_secs();

    Json(HealthResponse {
        status: "ok",
        rooms: state.room_manager.room_count(),
        connections: state.room_manager.connection_count(),
        uptime_seconds: uptime,
    })
}
