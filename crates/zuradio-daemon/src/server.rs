use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::Context;
use axum::Router;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path as AxumPath, Request, State};
use axum::http::header::{
    ACCEPT_RANGES, AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
    COOKIE, HOST, ORIGIN, RANGE, SET_COOKIE,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Json, Redirect, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use ring::pbkdf2;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, oneshot};
use tokio_util::io::ReaderStream;
use tower_http::services::ServeDir;
use uuid::Uuid;
use zuradio_core::{
    ActionRequest, ActionResult, Actor, AppSnapshot, CoreError, ErrorCode, Role, ZuradioCore,
};

use crate::client::RuntimeFile;
use crate::upload::{UploadError, UploadManager, UploadOperation, UploadOutcome};

const MAX_BODY_BYTES: usize = 32 * 1024;
const GRANT_TTL: Duration = Duration::from_hours(8);
const PASSWORD_ITERATIONS: u32 = 210_000;
const RENDEZVOUS_SALT: &[u8] = b"zuradio-rendezvous-v1|georgefejer91-zuradio";

#[derive(Debug)]
pub struct ServeOptions {
    pub data_dir: PathBuf,
    pub music_roots: Vec<PathBuf>,
    pub port: u16,
    pub web_root: PathBuf,
    pub open_browser: bool,
    pub companion_url: String,
    pub remote_password_file: Option<PathBuf>,
}

#[derive(Clone)]
struct AppState {
    core: Arc<Mutex<ZuradioCore>>,
    launch_token: Arc<str>,
    cli_token: Arc<str>,
    session_token: Arc<str>,
    music_roots: Arc<Vec<PathBuf>>,
    broadcast: Arc<Mutex<Option<BroadcastSession>>>,
    grants: Arc<Mutex<HashMap<String, Grant>>>,
    remote_password: Option<Arc<str>>,
    uploads: Arc<Mutex<UploadManager>>,
    events: broadcast::Sender<AppSnapshot>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BroadcastSession {
    session_id: String,
    epoch: u64,
    listen_room: String,
    listen_stream: String,
    listen_transport_key: String,
    rendezvous_room: String,
    rendezvous_stream: String,
    rendezvous_transport_key: String,
    controller_room: String,
    controller_stream: String,
    controller_transport_key: String,
    password_salt: String,
    password_iterations: u32,
    #[serde(skip)]
    password_key: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RemoteMode {
    Listen,
    Control,
    Upload,
}

impl RemoteMode {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Listen => "listen",
            Self::Control => "control",
            Self::Upload => "upload",
        }
    }
}

#[derive(Debug, Clone)]
struct Grant {
    session_id: String,
    peer_id: String,
    mode: RemoteMode,
    next_sequence: u64,
    expires_at: Instant,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireError {
    code: ErrorCode,
    message: String,
    revision: Option<u64>,
}

type ApiResult<T> = Result<T, (StatusCode, Json<WireError>)>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BootstrapRequest {
    token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapResponse {
    snapshot: AppSnapshot,
    capabilities: Vec<&'static str>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScanRequest {
    roots: Vec<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerifyRequest {
    session_id: String,
    mode: RemoteMode,
    peer_id: String,
    client_nonce: String,
    proof: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyResponse {
    grant_id: String,
    server_proof: String,
    expires_in_seconds: u64,
    scopes: Vec<&'static str>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteActionRequest {
    grant_id: String,
    peer_id: String,
    sequence: u64,
    request: ActionRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteUploadRequest {
    grant_id: String,
    peer_id: String,
    sequence: u64,
    operation: UploadOperation,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteUploadResponse {
    outcome: UploadOutcome,
    snapshot: Option<AppSnapshot>,
}

#[derive(Debug)]
enum BlockingScanError {
    Lock,
    Core(CoreError),
}

/// Runs the loopback authority until the process receives an interrupt signal.
///
/// # Errors
///
/// Returns an error if authority initialization or serving fails.
pub async fn serve(options: ServeOptions) -> anyhow::Result<()> {
    serve_with_shutdown(options, None, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}

/// Runs the loopback authority until `shutdown` resolves and optionally reports
/// the protected runtime handshake after the listener is ready.
///
/// # Errors
///
/// Returns an error if the catalog, listener, runtime handshake, or HTTP server
/// cannot be initialized or operated.
pub async fn serve_with_shutdown<F>(
    options: ServeOptions,
    ready: Option<oneshot::Sender<RuntimeFile>>,
    shutdown: F,
) -> anyhow::Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    fs::create_dir_all(&options.data_dir).context("creating Zuradio data folder")?;
    let uploads = UploadManager::new(&options.data_dir)
        .map_err(|error| anyhow::anyhow!("initializing upload repository: {error}"))?;
    let library_root = uploads.library_root().to_path_buf();
    let mut music_roots = options.music_roots;
    if !music_roots.contains(&library_root) {
        music_roots.push(library_root);
    }
    let remote_password = options
        .remote_password_file
        .as_deref()
        .map(read_remote_password)
        .transpose()?;
    let database_path = options.data_dir.join("zuradio.db");
    let core = ZuradioCore::open(&database_path).context("opening Zuradio catalog")?;
    let launch_token = random_secret();
    let cli_token = random_secret();
    let session_token = random_secret();
    let (events, _) = broadcast::channel(64);
    let state = AppState {
        core: Arc::new(Mutex::new(core)),
        launch_token: Arc::from(launch_token.clone()),
        cli_token: Arc::from(cli_token.clone()),
        session_token: Arc::from(session_token),
        music_roots: Arc::new(music_roots),
        broadcast: Arc::new(Mutex::new(None)),
        grants: Arc::new(Mutex::new(HashMap::new())),
        remote_password: remote_password.map(Arc::from),
        uploads: Arc::new(Mutex::new(uploads)),
        events,
    };

    let web_root = options
        .web_root
        .canonicalize()
        .with_context(|| format!("web build not found at {}", options.web_root.display()))?;
    let app = Router::new()
        .route("/", get(|| async { Redirect::temporary("/host/") }))
        .route("/api/v1/health", get(health))
        .route("/api/v1/bootstrap", post(bootstrap))
        .route("/api/v1/snapshot", get(snapshot))
        .route("/api/v1/action", post(action))
        .route("/api/v1/scan", post(scan))
        .route("/api/v1/events", get(events_socket))
        .route("/api/v1/media/{track_id}", get(media))
        .route("/api/v1/artwork/{track_id}", get(artwork))
        .route("/api/v1/broadcast", get(broadcast_status))
        .route("/api/v1/broadcast/start", post(start_broadcast))
        .route("/api/v1/broadcast/stop", post(stop_broadcast))
        .route("/api/v1/remote/verify", post(remote_verify))
        .route("/api/v1/remote/action", post(remote_action))
        .route("/api/v1/remote/upload", post(remote_upload))
        .fallback_service(ServeDir::new(web_root).append_index_html_on_directories(true))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(middleware::from_fn(security_headers))
        .layer(middleware::from_fn(validate_host))
        .with_state(state.clone());

    let listener = TcpListener::bind(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        options.port,
    ))
    .await
    .context("binding Zuradio loopback server")?;
    let address = listener.local_addr()?;
    let base_url = format!("http://{address}");
    let host_url = format!("{base_url}/host/#bootstrap={launch_token}");
    let runtime = RuntimeFile {
        base_url: base_url.clone(),
        cli_token,
        host_url: host_url.clone(),
    };
    write_runtime_file(&options.data_dir, &runtime)?;
    if let Some(ready) = ready {
        let _ = ready.send(runtime);
    }
    tracing::info!(url = %base_url, "Zuradio is ready");
    if options.open_browser {
        open_browser(&host_url)?;
    }

    let shutdown_data_dir = options.data_dir.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;
    let _ = fs::remove_file(shutdown_data_dir.join("runtime.json"));
    Ok(())
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok": true, "name": "Zuradio", "protocol": 1}))
}

async fn bootstrap(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<BootstrapRequest>,
) -> ApiResult<Response> {
    validate_origin(&headers)?;
    if !constant_time_equal(&request.token, &state.launch_token) {
        return Err(wire_error(
            StatusCode::UNAUTHORIZED,
            ErrorCode::Forbidden,
            "invalid bootstrap token",
            None,
        ));
    }
    let snapshot = core(&state)?
        .snapshot()
        .map_err(|error| map_core_error(&error))?;
    let body = Json(BootstrapResponse {
        snapshot,
        capabilities: vec!["library", "playlists", "player", "broadcast"],
    });
    let cookie = format!(
        "zuradio_session={}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200",
        state.session_token
    );
    let mut response = body.into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(SET_COOKIE, value);
    }
    Ok(response)
}

async fn snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<AppSnapshot>> {
    authorize_local(&headers, &state)?;
    Ok(Json(
        core(&state)?
            .snapshot()
            .map_err(|error| map_core_error(&error))?,
    ))
}

async fn action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut request): Json<ActionRequest>,
) -> ApiResult<Json<ActionResult>> {
    authorize_local(&headers, &state)?;
    validate_origin(&headers)?;
    request.actor = Actor::local();
    let result = core(&state)?
        .execute(request)
        .map_err(|error| map_core_error(&error))?;
    publish_snapshot(&state)?;
    Ok(Json(result))
}

async fn scan(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ScanRequest>,
) -> ApiResult<Json<AppSnapshot>> {
    authorize_local(&headers, &state)?;
    validate_origin(&headers)?;
    let roots = if request.roots.is_empty() {
        state.music_roots.as_ref().clone()
    } else {
        request.roots
    };
    let core_state = Arc::clone(&state.core);
    let scan_result = tokio::task::spawn_blocking(move || {
        let mut core = core_state.lock().map_err(|_| BlockingScanError::Lock)?;
        core.scan(&roots).map_err(BlockingScanError::Core)
    })
    .await
    .map_err(|_| {
        wire_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCode::Media,
            "library scan worker stopped unexpectedly",
            None,
        )
    })?;
    let new_snapshot = match scan_result {
        Ok(snapshot) => snapshot,
        Err(BlockingScanError::Core(error)) => return Err(map_core_error(&error)),
        Err(BlockingScanError::Lock) => {
            return Err(wire_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                ErrorCode::Storage,
                "internal state lock failed",
                None,
            ));
        }
    };
    let _ = state.events.send(new_snapshot.clone());
    Ok(Json(new_snapshot))
}

async fn events_socket(
    State(state): State<AppState>,
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
) -> ApiResult<Response> {
    authorize_local(&headers, &state)?;
    Ok(websocket.on_upgrade(move |socket| event_loop(socket, state)))
}

async fn event_loop(mut socket: WebSocket, state: AppState) {
    let initial = core(&state)
        .ok()
        .and_then(|guard| guard.snapshot().ok())
        .and_then(|value| serde_json::to_string(&value).ok());
    if let Some(json) = initial {
        let _ = socket.send(Message::Text(json.into())).await;
    }
    let mut receiver = state.events.subscribe();
    loop {
        tokio::select! {
            update = receiver.recv() => {
                let Ok(update) = update else { break };
                let Ok(json) = serde_json::to_string(&update) else { continue };
                if socket.send(Message::Text(json.into())).await.is_err() { break; }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Ping(bytes))) => {
                        if socket.send(Message::Pong(bytes)).await.is_err() { break; }
                    }
                    Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }
}

async fn media(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(track_id): AxumPath<String>,
) -> ApiResult<Response> {
    authorize_local(&headers, &state)?;
    let path = core(&state)?
        .track_path(&track_id)
        .map_err(|error| map_core_error(&error))?;
    let metadata = tokio::fs::metadata(&path).await.map_err(|_| {
        wire_error(
            StatusCode::NOT_FOUND,
            ErrorCode::NotFound,
            "media file is unavailable",
            None,
        )
    })?;
    let total = metadata.len();
    let (start, end, partial) = parse_range(headers.get(RANGE), total)?;
    let length = end.saturating_sub(start).saturating_add(1);
    let mut file = tokio::fs::File::open(&path).await.map_err(|_| {
        wire_error(
            StatusCode::NOT_FOUND,
            ErrorCode::NotFound,
            "media file is unavailable",
            None,
        )
    })?;
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|_| {
            wire_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                ErrorCode::Media,
                "media seek failed",
                None,
            )
        })?;
    let stream = ReaderStream::new(file.take(length));
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let response_headers = response.headers_mut();
    response_headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response_headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(
            mime_guess::from_path(&path)
                .first_or_octet_stream()
                .as_ref(),
        )
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    if let Ok(value) = HeaderValue::from_str(&length.to_string()) {
        response_headers.insert(CONTENT_LENGTH, value);
    }
    if partial && let Ok(value) = HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")) {
        response_headers.insert(CONTENT_RANGE, value);
    }
    Ok(response)
}

async fn artwork(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(track_id): AxumPath<String>,
) -> ApiResult<Response> {
    authorize_local(&headers, &state)?;
    let artwork = core(&state)?
        .track_artwork(&track_id)
        .map_err(|error| map_core_error(&error))?
        .ok_or_else(|| {
            wire_error(
                StatusCode::NOT_FOUND,
                ErrorCode::NotFound,
                "embedded artwork is unavailable",
                None,
            )
        })?;
    let mut response = Response::new(Body::from(artwork.data));
    let response_headers = response.headers_mut();
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    if let Ok(value) = HeaderValue::from_str(&artwork.mime_type) {
        response_headers.insert(CONTENT_TYPE, value);
    }
    Ok(response)
}

async fn broadcast_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Option<BroadcastSession>>> {
    authorize_local(&headers, &state)?;
    Ok(Json(lock(&state.broadcast)?.clone()))
}

async fn start_broadcast(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<BroadcastSession>> {
    authorize_local(&headers, &state)?;
    validate_origin(&headers)?;
    let password = state.remote_password.as_deref().ok_or_else(|| {
        wire_error(
            StatusCode::PRECONDITION_FAILED,
            ErrorCode::Forbidden,
            "remote password file is not configured",
            None,
        )
    })?;
    let session_id = random_id();
    let epoch = random_epoch();
    let listen_room = random_id();
    let listen_stream = random_id();
    let listen_transport_key = random_secret();
    let mut rendezvous_key = derive_password_key(password.as_bytes(), RENDEZVOUS_SALT)?;
    let rendezvous_room = rendezvous_component(&rendezvous_key, b"room")?;
    let rendezvous_stream = rendezvous_component(&rendezvous_key, b"stream")?;
    let rendezvous_transport_key = rendezvous_component(&rendezvous_key, b"transport")?;
    rendezvous_key.fill(0);
    let controller_room = random_id();
    let controller_stream = random_id();
    let controller_transport_key = random_secret();
    let password_salt_bytes = rand::random::<[u8; 24]>();
    let password_salt = URL_SAFE_NO_PAD.encode(password_salt_bytes);
    let password_iterations = PASSWORD_ITERATIONS;
    let password_key = derive_password_key(password.as_bytes(), &password_salt_bytes)?;
    let session = BroadcastSession {
        session_id,
        epoch,
        listen_room,
        listen_stream,
        listen_transport_key,
        rendezvous_room,
        rendezvous_stream,
        rendezvous_transport_key,
        controller_room,
        controller_stream,
        controller_transport_key,
        password_salt,
        password_iterations,
        password_key,
    };
    *lock(&state.broadcast)? = Some(session.clone());
    lock(&state.grants)?.clear();
    lock(&state.uploads)?.revoke_all();
    Ok(Json(session))
}

async fn stop_broadcast(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    authorize_local(&headers, &state)?;
    validate_origin(&headers)?;
    *lock(&state.broadcast)? = None;
    lock(&state.grants)?.clear();
    lock(&state.uploads)?.revoke_all();
    Ok(StatusCode::NO_CONTENT)
}

async fn remote_verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<VerifyRequest>,
) -> ApiResult<Json<VerifyResponse>> {
    authorize_local(&headers, &state)?;
    validate_origin(&headers)?;
    validate_bounded(&request.peer_id, 128, "peer ID")?;
    validate_bounded(&request.client_nonce, 128, "nonce")?;
    let session = lock(&state.broadcast)?.clone().ok_or_else(|| {
        wire_error(
            StatusCode::CONFLICT,
            ErrorCode::Conflict,
            "broadcast is not active",
            None,
        )
    })?;
    if request.session_id != session.session_id {
        return Err(wire_error(
            StatusCode::FORBIDDEN,
            ErrorCode::Forbidden,
            "session is not authorized",
            None,
        ));
    }
    let transcript = format!(
        "zuradio/2|{}|{}|{}|{}|{}",
        session.session_id,
        session.epoch,
        request.mode.as_str(),
        request.peer_id,
        request.client_nonce
    );
    let expected = hmac_bytes(&session.password_key, transcript.as_bytes())?;
    let received = URL_SAFE_NO_PAD
        .decode(request.proof.as_bytes())
        .map_err(|_| {
            wire_error(
                StatusCode::UNAUTHORIZED,
                ErrorCode::Forbidden,
                "invalid proof",
                None,
            )
        })?;
    if expected.as_slice().ct_eq(received.as_slice()).unwrap_u8() != 1 {
        return Err(wire_error(
            StatusCode::UNAUTHORIZED,
            ErrorCode::Forbidden,
            "invalid proof",
            None,
        ));
    }
    let grant_id = random_secret();
    lock(&state.grants)?.insert(
        grant_id.clone(),
        Grant {
            session_id: session.session_id,
            peer_id: request.peer_id,
            mode: request.mode,
            next_sequence: 1,
            expires_at: Instant::now() + GRANT_TTL,
        },
    );
    let server_proof = URL_SAFE_NO_PAD.encode(hmac_bytes(
        &session.password_key,
        format!("{transcript}|accepted").as_bytes(),
    )?);
    let scopes = match request.mode {
        RemoteMode::Listen => vec!["stream:listen", "now-playing:read"],
        RemoteMode::Control => vec![
            "stream:listen",
            "state:read",
            "player:control",
            "queue:write",
            "playlists:write",
        ],
        RemoteMode::Upload => vec!["library:upload", "library:read"],
    };
    Ok(Json(VerifyResponse {
        grant_id,
        server_proof,
        expires_in_seconds: GRANT_TTL.as_secs(),
        scopes,
    }))
}

async fn remote_action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut remote): Json<RemoteActionRequest>,
) -> ApiResult<Json<ActionResult>> {
    authorize_local(&headers, &state)?;
    validate_origin(&headers)?;
    authorize_remote_grant(
        &state,
        &remote.grant_id,
        &remote.peer_id,
        remote.sequence,
        RemoteMode::Control,
    )?;
    remote.request.actor = Actor {
        role: Role::Controller,
        peer_id: Some(remote.peer_id),
    };
    let result = core(&state)?
        .execute(remote.request)
        .map_err(|error| map_core_error(&error))?;
    publish_snapshot(&state)?;
    Ok(Json(result))
}

async fn remote_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(remote): Json<RemoteUploadRequest>,
) -> ApiResult<Json<RemoteUploadResponse>> {
    authorize_local(&headers, &state)?;
    validate_origin(&headers)?;
    authorize_remote_grant(
        &state,
        &remote.grant_id,
        &remote.peer_id,
        remote.sequence,
        RemoteMode::Upload,
    )?;
    let is_commit = matches!(&remote.operation, UploadOperation::Commit { .. });
    let uploads = Arc::clone(&state.uploads);
    let operation = remote.operation;
    let outcome = tokio::task::spawn_blocking(move || {
        uploads
            .lock()
            .map_err(|_| UploadError::Storage)?
            .execute(operation)
    })
    .await
    .map_err(|_| upload_worker_error())?
    .map_err(|error| map_upload_error(&error))?;

    let snapshot = if is_commit {
        let core_state = Arc::clone(&state.core);
        let roots = state.music_roots.as_ref().clone();
        let scanned = tokio::task::spawn_blocking(move || {
            core_state
                .lock()
                .map_err(|_| BlockingScanError::Lock)?
                .scan(&roots)
                .map_err(BlockingScanError::Core)
        })
        .await
        .map_err(|_| upload_worker_error())?;
        let snapshot = match scanned {
            Ok(value) => value,
            Err(BlockingScanError::Core(error)) => return Err(map_core_error(&error)),
            Err(BlockingScanError::Lock) => return Err(upload_worker_error()),
        };
        let _ = state.events.send(snapshot.clone());
        Some(snapshot)
    } else {
        None
    };
    Ok(Json(RemoteUploadResponse { outcome, snapshot }))
}

async fn validate_host(request: Request, next: Next) -> Response {
    let valid = request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| {
            host.starts_with("127.0.0.1:")
                || host.starts_with("localhost:")
                || host.starts_with("[::1]:")
        });
    if !valid {
        return (StatusCode::MISDIRECTED_REQUEST, "invalid host").into_response();
    }
    next.run(request).await
}

async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss://wss.vdo.ninja https://turnservers.vdo.ninja; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        ),
    );
    response
}

fn authorize_local(headers: &HeaderMap, state: &AppState) -> ApiResult<()> {
    let bearer = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let session = headers
        .get(COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| {
            cookies.split(';').find_map(|cookie| {
                cookie
                    .trim()
                    .strip_prefix("zuradio_session=")
                    .map(str::to_owned)
            })
        });
    let authorized = bearer.is_some_and(|token| constant_time_equal(token, &state.cli_token))
        || session.is_some_and(|token| constant_time_equal(&token, &state.session_token));
    if authorized {
        Ok(())
    } else {
        Err(wire_error(
            StatusCode::UNAUTHORIZED,
            ErrorCode::Forbidden,
            "local session required",
            None,
        ))
    }
}

fn validate_origin(headers: &HeaderMap) -> ApiResult<()> {
    let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) else {
        return Ok(());
    };
    let host = headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if origin == format!("http://{host}") {
        Ok(())
    } else {
        Err(wire_error(
            StatusCode::FORBIDDEN,
            ErrorCode::Forbidden,
            "origin is not allowed",
            None,
        ))
    }
}

fn parse_range(header: Option<&HeaderValue>, total: u64) -> ApiResult<(u64, u64, bool)> {
    if total == 0 {
        return Ok((0, 0, false));
    }
    let Some(value) = header.and_then(|header| header.to_str().ok()) else {
        return Ok((0, total - 1, false));
    };
    let Some(spec) = value.strip_prefix("bytes=") else {
        return Err(range_error(total));
    };
    if spec.contains(',') {
        return Err(range_error(total));
    }
    let (start, end) = spec.split_once('-').ok_or_else(|| range_error(total))?;
    let start = start.parse::<u64>().map_err(|_| range_error(total))?;
    let end = if end.is_empty() {
        total - 1
    } else {
        end.parse::<u64>()
            .map_err(|_| range_error(total))?
            .min(total - 1)
    };
    if start >= total || start > end {
        return Err(range_error(total));
    }
    Ok((start, end, true))
}

fn range_error(total: u64) -> (StatusCode, Json<WireError>) {
    wire_error(
        StatusCode::RANGE_NOT_SATISFIABLE,
        ErrorCode::InvalidInput,
        &format!("invalid byte range for {total} bytes"),
        None,
    )
}

fn publish_snapshot(state: &AppState) -> ApiResult<()> {
    let snapshot = core(state)?
        .snapshot()
        .map_err(|error| map_core_error(&error))?;
    let _ = state.events.send(snapshot);
    Ok(())
}

fn authorize_remote_grant(
    state: &AppState,
    grant_id: &str,
    peer_id: &str,
    sequence: u64,
    required_mode: RemoteMode,
) -> ApiResult<()> {
    let active_session = lock(&state.broadcast)?
        .as_ref()
        .map(|session| session.session_id.clone())
        .unwrap_or_default();
    let mut grants = lock(&state.grants)?;
    grants.retain(|_, grant| grant.expires_at > Instant::now());
    let grant = grants.get_mut(grant_id).ok_or_else(|| {
        wire_error(
            StatusCode::UNAUTHORIZED,
            ErrorCode::Forbidden,
            "grant expired",
            None,
        )
    })?;
    if grant.session_id != active_session
        || grant.peer_id != peer_id
        || grant.mode != required_mode
        || sequence != grant.next_sequence
    {
        return Err(wire_error(
            StatusCode::FORBIDDEN,
            ErrorCode::Forbidden,
            "grant scope, binding, or sequence is invalid",
            None,
        ));
    }
    grant.next_sequence = grant.next_sequence.saturating_add(1);
    Ok(())
}

fn core(state: &AppState) -> ApiResult<MutexGuard<'_, ZuradioCore>> {
    lock(&state.core)
}

fn lock<T>(mutex: &Mutex<T>) -> ApiResult<MutexGuard<'_, T>> {
    mutex.lock().map_err(|_| {
        wire_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCode::Storage,
            "internal state lock failed",
            None,
        )
    })
}

fn map_core_error(error: &CoreError) -> (StatusCode, Json<WireError>) {
    let status = match error.code() {
        ErrorCode::InvalidInput => StatusCode::BAD_REQUEST,
        ErrorCode::NotFound => StatusCode::NOT_FOUND,
        ErrorCode::Conflict => StatusCode::CONFLICT,
        ErrorCode::Forbidden => StatusCode::FORBIDDEN,
        ErrorCode::Storage | ErrorCode::Media => StatusCode::INTERNAL_SERVER_ERROR,
    };
    wire_error(status, error.code(), &error.to_string(), None)
}

fn map_upload_error(error: &UploadError) -> (StatusCode, Json<WireError>) {
    let (status, code) = match error {
        UploadError::Invalid => (StatusCode::BAD_REQUEST, ErrorCode::InvalidInput),
        UploadError::NotFound => (StatusCode::NOT_FOUND, ErrorCode::NotFound),
        UploadError::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, ErrorCode::InvalidInput),
        UploadError::Unsupported => (StatusCode::UNSUPPORTED_MEDIA_TYPE, ErrorCode::InvalidInput),
        UploadError::Integrity | UploadError::Media => {
            (StatusCode::UNPROCESSABLE_ENTITY, ErrorCode::Media)
        }
        UploadError::Storage => (StatusCode::INTERNAL_SERVER_ERROR, ErrorCode::Storage),
    };
    wire_error(status, code, &error.to_string(), None)
}

fn upload_worker_error() -> (StatusCode, Json<WireError>) {
    wire_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        ErrorCode::Storage,
        "upload worker stopped unexpectedly",
        None,
    )
}

fn wire_error(
    status: StatusCode,
    code: ErrorCode,
    message: &str,
    revision: Option<u64>,
) -> (StatusCode, Json<WireError>) {
    (
        status,
        Json(WireError {
            code,
            message: message.to_owned(),
            revision,
        }),
    )
}

fn validate_bounded(value: &str, max: usize, label: &str) -> ApiResult<()> {
    if value.is_empty() || value.len() > max {
        Err(wire_error(
            StatusCode::BAD_REQUEST,
            ErrorCode::InvalidInput,
            &format!("invalid {label}"),
            None,
        ))
    } else {
        Ok(())
    }
}

fn hmac_bytes(key: &[u8], data: &[u8]) -> ApiResult<Vec<u8>> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| {
        wire_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCode::Storage,
            "authentication setup failed",
            None,
        )
    })?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn derive_password_key(password: &[u8], salt: &[u8]) -> ApiResult<[u8; 32]> {
    let iterations = NonZeroU32::new(PASSWORD_ITERATIONS).ok_or_else(|| {
        wire_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCode::Storage,
            "authentication setup failed",
            None,
        )
    })?;
    let mut key = [0_u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        salt,
        password,
        &mut key,
    );
    Ok(key)
}

fn rendezvous_component(key: &[u8; 32], label: &[u8]) -> ApiResult<String> {
    Ok(URL_SAFE_NO_PAD.encode(hmac_bytes(key, label)?))
}

fn read_remote_password(path: &Path) -> anyhow::Result<String> {
    let bytes = fs::read(path).with_context(|| "reading remote password file")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)?.permissions().mode();
        anyhow::ensure!(
            mode.trailing_zeros() >= 6,
            "remote password file must not be readable by group or other users"
        );
    }
    let password = String::from_utf8(bytes).context("remote password file is not UTF-8")?;
    let password = password.trim_end_matches(['\r', '\n']).to_owned();
    anyhow::ensure!(
        (8..=256).contains(&password.len()),
        "remote password must contain 8 to 256 bytes"
    );
    Ok(password)
}

fn random_secret() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

fn random_id() -> String {
    Uuid::new_v4().simple().to_string()
}

fn random_epoch() -> u64 {
    const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    (rand::random::<u64>() % JAVASCRIPT_MAX_SAFE_INTEGER) + 1
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    left.as_bytes().ct_eq(right.as_bytes()).unwrap_u8() == 1
}

fn write_runtime_file(data_dir: &Path, runtime: &RuntimeFile) -> anyhow::Result<()> {
    let path = data_dir.join("runtime.json");
    fs::write(&path, serde_json::to_vec_pretty(runtime)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Opens a protected Zuradio host URL in the operating system's browser.
///
/// # Errors
///
/// Returns an error if the platform browser launcher cannot be spawned.
pub fn open_browser(url: &str) -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    command
        .arg(url)
        .spawn()
        .context("opening Zuradio in the browser")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parser_accepts_single_range() -> Result<(), String> {
        let header = HeaderValue::from_static("bytes=10-19");
        let parsed = parse_range(Some(&header), 100).map_err(|_| "range was rejected")?;
        assert_eq!(parsed, (10, 19, true));
        Ok(())
    }

    #[test]
    fn range_parser_rejects_multiple_ranges() {
        let header = HeaderValue::from_static("bytes=0-1,4-5");
        assert!(parse_range(Some(&header), 100).is_err());
    }

    #[test]
    fn broadcast_epochs_are_nonzero_and_javascript_safe() {
        const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
        for _ in 0..1_024 {
            let epoch = random_epoch();
            assert!((1..=JAVASCRIPT_MAX_SAFE_INTEGER).contains(&epoch));
        }
    }

    #[test]
    fn password_rendezvous_is_deterministic_and_domain_separated() -> Result<(), String> {
        let key = derive_password_key(b"a-long-test-password", RENDEZVOUS_SALT)
            .map_err(|_| "key derivation failed")?;
        let room = rendezvous_component(&key, b"room").map_err(|_| "room failed")?;
        let stream = rendezvous_component(&key, b"stream").map_err(|_| "stream failed")?;
        let transport = rendezvous_component(&key, b"transport").map_err(|_| "transport failed")?;
        assert_eq!(room, "5UFNZ02OXYjjziKttJgsh8cUfLnvc6VxwLbKvbl36s4");
        assert_eq!(stream, "5RQiiZWIVPGFyJG29PIHWPZQZUjVXv8RPLdOkrQTOo8");
        assert_eq!(transport, "NyPZYj4WqcG63U708i6bw35Mclif3LIJ7kHVw75EUEw");
        assert_ne!(room, stream);
        assert_ne!(stream, transport);
        assert_eq!(
            room,
            rendezvous_component(&key, b"room").map_err(|_| "room failed")?
        );
        Ok(())
    }
}
