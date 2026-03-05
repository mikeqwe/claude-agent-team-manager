use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

const MAX_FAILED_ATTEMPTS: u32 = 5;
const LOCKOUT_DURATION: Duration = Duration::from_secs(300); // 5 minutes
const SESSION_TIMEOUT: Duration = Duration::from_secs(1800); // 30 minutes
const MAX_SESSIONS: usize = 2;

#[derive(Clone)]
pub struct AuthManager {
    inner: Arc<RwLock<AuthState>>,
}

struct IpAttempts {
    failed_attempts: u32,
    lockout_until: Option<Instant>,
}

struct AuthState {
    pin: String,
    sessions: HashMap<String, Session>,
    ip_attempts: HashMap<String, IpAttempts>,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub session_id: String,
    pub token: String,
    pub created_at: Instant,
    pub last_activity: Instant,
    pub remote_address: String,
}

#[derive(Debug, Serialize)]
pub enum AuthError {
    LockedOut { seconds_remaining: u64 },
    InvalidPin { attempts_remaining: u32 },
    SessionLimit,
    InvalidToken,
    SessionExpired,
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::LockedOut { seconds_remaining } => {
                write!(f, "Locked out. Try again in {} seconds", seconds_remaining)
            }
            AuthError::InvalidPin { attempts_remaining } => {
                write!(f, "Invalid PIN. {} attempts remaining", attempts_remaining)
            }
            AuthError::SessionLimit => write!(f, "Maximum concurrent sessions reached"),
            AuthError::InvalidToken => write!(f, "Invalid or unknown session token"),
            AuthError::SessionExpired => write!(f, "Session expired"),
        }
    }
}

impl AuthManager {
    pub fn new() -> Self {
        let pin = generate_pin();
        log::info!("Remote access PIN generated");
        Self {
            inner: Arc::new(RwLock::new(AuthState {
                pin,
                sessions: HashMap::new(),
                ip_attempts: HashMap::new(),
            })),
        }
    }

    pub async fn get_pin(&self) -> String {
        self.inner.read().await.pin.clone()
    }

    pub async fn regenerate_pin(&self) -> String {
        let mut state = self.inner.write().await;
        state.pin = generate_pin();
        state.ip_attempts.clear();
        log::info!("Remote access PIN regenerated");
        state.pin.clone()
    }

    pub async fn verify_pin(
        &self,
        submitted_pin: &str,
        remote_address: String,
    ) -> Result<Session, AuthError> {
        let mut state = self.inner.write().await;

        // Per-IP rate limiting: check lockout first.
        if let Some(ip_state) = state.ip_attempts.get_mut(&remote_address) {
            if let Some(lockout) = ip_state.lockout_until {
                if Instant::now() < lockout {
                    let remaining = (lockout - Instant::now()).as_secs();
                    return Err(AuthError::LockedOut { seconds_remaining: remaining });
                }
                ip_state.lockout_until = None;
                ip_state.failed_attempts = 0;
            }
        }

        if submitted_pin != state.pin {
            let ip_state = state.ip_attempts.entry(remote_address.clone()).or_insert(IpAttempts {
                failed_attempts: 0,
                lockout_until: None,
            });
            ip_state.failed_attempts += 1;
            let remaining = MAX_FAILED_ATTEMPTS.saturating_sub(ip_state.failed_attempts);
            if ip_state.failed_attempts >= MAX_FAILED_ATTEMPTS {
                ip_state.lockout_until = Some(Instant::now() + LOCKOUT_DURATION);
                log::warn!(
                    "Remote auth locked out after {} failed attempts from {}",
                    MAX_FAILED_ATTEMPTS, remote_address
                );
            }
            return Err(AuthError::InvalidPin { attempts_remaining: remaining });
        }

        let now = Instant::now();
        state.sessions.retain(|_, s| now.duration_since(s.last_activity) < SESSION_TIMEOUT);

        if state.sessions.len() >= MAX_SESSIONS {
            return Err(AuthError::SessionLimit);
        }

        let token = generate_token();
        let session_id = generate_session_id();
        let session = Session {
            session_id: session_id.clone(),
            token: token.clone(),
            created_at: now,
            last_activity: now,
            remote_address: remote_address.clone(),
        };
        state.sessions.insert(token.clone(), session.clone());

        state.pin = generate_pin();
        // Clear attempts for this IP on successful auth.
        state.ip_attempts.remove(&remote_address);

        log::info!("Remote session established: {}", session_id);
        Ok(session)
    }

    pub async fn validate_token(&self, token: &str) -> Result<Session, AuthError> {
        let mut state = self.inner.write().await;
        let now = Instant::now();

        match state.sessions.get_mut(token) {
            Some(session) => {
                if now.duration_since(session.last_activity) >= SESSION_TIMEOUT {
                    let session_id = session.session_id.clone();
                    state.sessions.remove(token);
                    log::info!("Remote session expired: {}", session_id);
                    return Err(AuthError::SessionExpired);
                }
                session.last_activity = now;
                Ok(session.clone())
            }
            None => Err(AuthError::InvalidToken),
        }
    }

    pub async fn revoke_session(&self, token: &str) -> bool {
        let mut state = self.inner.write().await;
        if let Some(session) = state.sessions.remove(token) {
            log::info!("Remote session revoked: {}", session.session_id);
            true
        } else {
            false
        }
    }

    pub async fn revoke_all_sessions(&self) {
        let mut state = self.inner.write().await;
        let count = state.sessions.len();
        state.sessions.clear();
        log::info!("Revoked {} remote session(s)", count);
    }

    pub async fn active_sessions(&self) -> Vec<SessionInfo> {
        let state = self.inner.read().await;
        let now = Instant::now();
        state
            .sessions
            .values()
            .filter(|s| now.duration_since(s.last_activity) < SESSION_TIMEOUT)
            .map(|s| SessionInfo {
                session_id: s.session_id.clone(),
                remote_address: s.remote_address.clone(),
                connected_seconds: now.duration_since(s.created_at).as_secs(),
                idle_seconds: now.duration_since(s.last_activity).as_secs(),
            })
            .collect()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub remote_address: String,
    pub connected_seconds: u64,
    pub idle_seconds: u64,
}

fn generate_pin() -> String {
    let mut rng = rand::rng();
    let n: u32 = rng.random_range(0..1_000_000);
    format!("{:06}", n)
}

fn generate_token() -> String {
    let mut rng = rand::rng();
    let bytes: [u8; 32] = rng.random();
    hex::encode(bytes)
}

fn generate_session_id() -> String {
    let mut rng = rand::rng();
    let bytes: [u8; 8] = rng.random();
    hex::encode(bytes)
}
