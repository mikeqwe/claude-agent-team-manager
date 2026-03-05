use axum::{
    extract::{ConnectInfo, Json, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use axum_server::tls_rustls::RustlsConfig;
use rcgen::generate_simple_self_signed;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::{broadcast, oneshot};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

use super::auth::AuthManager;
use super::bridge::BridgeState;
use super::ws::{self, RemoteState};

/// Configuration passed to start the server.
#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub port: u16,
    pub expose_on_network: bool,
    pub static_dir: Option<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: 5175,
            expose_on_network: false,
            static_dir: None,
        }
    }
}

/// Handle returned from `start_server` to control the running server.
pub struct ServerHandle {
    shutdown_tx: Option<oneshot::Sender<()>>,
    pub actual_port: u16,
    pub cert_fingerprint: String,
    pub auth: AuthManager,
    pub bridge: BridgeState,
}

impl ServerHandle {
    /// Signal the server to shut down gracefully.
    pub fn shutdown(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
            log::info!("Remote server shutdown signal sent");
        }
    }
}

/// Generate a self-signed TLS certificate and return (cert_pem, key_pem, sha256_fingerprint).
fn generate_tls_cert() -> Result<(String, String, String), String> {
    let mut sans = vec!["localhost".to_string(), "127.0.0.1".to_string()];
    if let Ok(ip) = local_ip_address::local_ip() {
        sans.push(ip.to_string());
    }

    let cert = generate_simple_self_signed(sans)
        .map_err(|e| format!("Certificate generation failed: {}", e))?;

    let cert_pem = cert.cert.pem();
    let key_pem = cert.key_pair.serialize_pem();

    let cert_der = cert.cert.der();
    let mut hasher = Sha256::new();
    hasher.update(cert_der.as_ref());
    let fingerprint_bytes = hasher.finalize();
    let fingerprint = fingerprint_bytes
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(":");

    Ok((cert_pem, key_pem, fingerprint))
}

/// Find an available port starting from the desired port.
fn find_available_port(desired: u16) -> u16 {
    for port in desired..desired.saturating_add(100) {
        if std::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).is_ok() {
            return port;
        }
    }
    0
}

/// Start the embedded HTTPS + WebSocket server.
pub async fn start_server(
    config: ServerConfig,
    app_handle: tauri::AppHandle,
) -> Result<ServerHandle, String> {
    let actual_port = find_available_port(config.port);
    if actual_port == 0 {
        return Err(format!(
            "Could not find an available port starting from {}",
            config.port
        ));
    }

    // Generate TLS certificate.
    let (cert_pem, key_pem, cert_fingerprint) = generate_tls_cert()?;

    let tls_config = RustlsConfig::from_pem(
        cert_pem.as_bytes().to_vec(),
        key_pem.as_bytes().to_vec(),
    )
    .await
    .map_err(|e| format!("TLS config failed: {}", e))?;

    // Create broadcast channel shared between BridgeState instances.
    let (broadcast_tx, _) = broadcast::channel::<String>(256);

    // Build auth manager and bridge.
    let auth = AuthManager::new();
    let bridge = BridgeState::new(app_handle, broadcast_tx);

    let bind_addr: [u8; 4] = if config.expose_on_network {
        [0, 0, 0, 0]
    } else {
        [127, 0, 0, 1]
    };

    let server_origin = if config.expose_on_network {
        if let Ok(ip) = local_ip_address::local_ip() {
            format!("https://{}:{}", ip, actual_port)
        } else {
            format!("https://127.0.0.1:{}", actual_port)
        }
    } else {
        format!("https://127.0.0.1:{}", actual_port)
    };

    let remote_state = Arc::new(RemoteState {
        auth: auth.clone(),
        bridge: bridge.clone(),
        server_origin: server_origin.clone(),
    });

    // Build CORS layer.
    let cors = CorsLayer::new()
        .allow_origin(
            server_origin
                .parse::<axum::http::HeaderValue>()
                .unwrap_or_else(|_| axum::http::HeaderValue::from_static("https://localhost")),
        )
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::AUTHORIZATION,
        ])
        .allow_credentials(true);

    // Build router with restricted API surface (M5): no open_terminal, fetch_url, etc.
    let mut app = Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/auth", post(auth_handler))
        .route("/api/status", get(status_handler))
        .route("/api/sessions", get(sessions_handler))
        .route("/ws", get(ws::ws_handler))
        .layer(cors)
        .with_state(remote_state.clone());

    // Serve static files for mobile web UI if directory exists.
    if let Some(dir) = config.static_dir {
        if std::path::Path::new(&dir).exists() {
            app = app.fallback_service(ServeDir::new(dir));
        }
    }

    let addr = SocketAddr::from((bind_addr, actual_port));
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    // Spawn the HTTPS server.
    tokio::spawn(async move {
        log::info!("Remote server listening on https://{}", addr);
        axum_server::bind_rustls(addr, tls_config)
            .serve(app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap_or_else(|e| log::error!("Remote server error: {}", e));
    });

    // Spawn a task to handle graceful shutdown.
    tokio::spawn(async move {
        let _ = shutdown_rx.await;
        log::info!("Remote server shutdown received");
    });

    // Log connection info.
    let display_addr = if config.expose_on_network {
        if let Ok(ip) = local_ip_address::local_ip() {
            format!("https://{}:{}", ip, actual_port)
        } else {
            format!("https://0.0.0.0:{}", actual_port)
        }
    } else {
        format!("https://127.0.0.1:{}", actual_port)
    };
    log::info!("Remote access URL: {}", display_addr);
    log::info!("TLS cert fingerprint: {}", cert_fingerprint);

    Ok(ServerHandle {
        shutdown_tx: Some(shutdown_tx),
        actual_port,
        cert_fingerprint,
        auth,
        bridge,
    })
}

// ─── Route Handlers ─────────────────────────────────────────────────

/// GET /api/health -- public, no auth required.
async fn health_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "app": "ATM",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

/// POST /api/auth -- validate PIN and return session token.
#[derive(Deserialize)]
struct AuthRequest {
    pin: String,
}

async fn auth_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<RemoteState>>,
    Json(body): Json<AuthRequest>,
) -> impl IntoResponse {
    match state.auth.verify_pin(&body.pin, addr.ip().to_string()).await {
        Ok(session) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "sessionId": session.session_id,
                "token": session.token,
            })),
        )
            .into_response(),
        Err(e) => {
            let status = match &e {
                super::auth::AuthError::LockedOut { .. } => StatusCode::TOO_MANY_REQUESTS,
                super::auth::AuthError::InvalidPin { .. } => StatusCode::UNAUTHORIZED,
                super::auth::AuthError::SessionLimit => StatusCode::SERVICE_UNAVAILABLE,
                _ => StatusCode::UNAUTHORIZED,
            };
            (
                status,
                Json(serde_json::json!({
                    "ok": false,
                    "error": e.to_string(),
                })),
            )
                .into_response()
        }
    }
}

/// GET /api/status -- returns server status (requires auth via Bearer token).
async fn status_handler(
    headers: HeaderMap,
    State(state): State<Arc<RemoteState>>,
) -> impl IntoResponse {
    match extract_and_validate_token(&headers, &state.auth).await {
        Ok(_) => {
            let sessions = state.auth.active_sessions().await;
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "status": "ok",
                    "activeSessions": sessions.len(),
                })),
            )
                .into_response()
        }
        Err(resp) => resp,
    }
}

/// GET /api/sessions -- list active sessions (requires auth).
async fn sessions_handler(
    headers: HeaderMap,
    State(state): State<Arc<RemoteState>>,
) -> impl IntoResponse {
    match extract_and_validate_token(&headers, &state.auth).await {
        Ok(_) => {
            let sessions = state.auth.active_sessions().await;
            (StatusCode::OK, Json(serde_json::json!({ "sessions": sessions }))).into_response()
        }
        Err(resp) => resp,
    }
}

/// Extract Bearer token from Authorization header and validate it.
async fn extract_and_validate_token(
    headers: &HeaderMap,
    auth: &AuthManager,
) -> Result<super::auth::Session, axum::response::Response> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");

    auth.validate_token(token).await.map_err(|e| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "ok": false,
                "error": e.to_string(),
            })),
        )
            .into_response()
    })
}
