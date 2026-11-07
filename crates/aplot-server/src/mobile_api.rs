//! Authenticated mobile web API and same-origin static shell.
//!
//! The public UI assets contain no credentials. Every `/api/*` route is
//! bearer-authenticated and bound to the configured Host/Origin; the old
//! loopback metadata router remains a separate entry point.
use crate::mobile_host::MobileHost;
use axum::{
    body::{to_bytes, Body},
    extract::{OriginalUri, Path, Request, State},
    http::{
        header::{self, HeaderName, HeaderValue},
        uri::Uri,
        StatusCode,
    },
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    net::IpAddr,
    path::{Path as FsPath, PathBuf},
};

const MAX_JSON_BODY_BYTES: usize = 96 * 1024;
const MAX_STATIC_FILE_BYTES: u64 = 32 * 1024 * 1024;

/// Configuration for the mobile shell and its bearer-protected API.
/// `access_token` is hashed during router construction and is not retained.
pub struct MobileApiConfig {
    pub public_origin: String,
    pub access_token: String,
    pub assets_dir: PathBuf,
    pub allow_private_http: bool,
}

#[derive(Clone)]
struct MobileApiState {
    host: MobileHost,
    public_origin: String,
    scheme: String,
    authority: String,
    token_hash: [u8; 32],
    assets_root: PathBuf,
}

/// Build the mobile shell and private API after validating all startup inputs.
pub fn mobile_router(host: MobileHost, config: MobileApiConfig) -> io::Result<Router> {
    let (public_origin, authority) =
        validate_origin(&config.public_origin, config.allow_private_http)?;
    if config.access_token.len() < 32
        || !config
            .access_token
            .bytes()
            .all(|byte| byte.is_ascii_graphic())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "mobile-access-token-invalid",
        ));
    }
    let assets_root = config.assets_dir.canonicalize().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "mobile-assets-directory-invalid",
        )
    })?;
    if !assets_root.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "mobile-assets-directory-invalid",
        ));
    }
    let index = assets_root
        .join("index.html")
        .canonicalize()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "mobile-assets-index-invalid"))?;
    let index_metadata = fs::metadata(&index)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "mobile-assets-index-invalid"))?;
    if !index.starts_with(&assets_root) || !index_metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "mobile-assets-index-invalid",
        ));
    }

    let state = MobileApiState {
        host,
        scheme: public_origin
            .split_once("://")
            .expect("validated origin has a scheme")
            .0
            .to_owned(),
        public_origin,
        authority,
        token_hash: sha256(config.access_token.as_bytes()),
        assets_root,
    };
    Ok(Router::new()
        .route("/", get(|| async { Redirect::temporary("/mobile/") }))
        .route("/mobile", get(|| async { Redirect::temporary("/mobile/") }))
        .route("/mobile/", get(mobile_shell))
        .route("/mobile/{*asset}", get(mobile_asset))
        .route("/api/v1/workspace", get(get_workspace))
        .route("/api/v1/tasks/{id}", get(get_task))
        .route("/api/v1/tasks/{id}/access", post(change_access_mode))
        .route("/api/v1/projects/{id}/tasks", post(create_task))
        .route("/api/v1/tasks/{id}/messages", post(send_message))
        .route("/api/v1/commands/{id}/cancel", post(cancel_command))
        .route("/api/v1/tasks/{id}/interrupt", post(interrupt_task))
        .layer(middleware::from_fn_with_state(state.clone(), mobile_gate))
        .with_state(state))
}

fn validate_origin(value: &str, allow_private_http: bool) -> io::Result<(String, String)> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidInput, "mobile-origin-invalid");
    if value.is_empty() || value.trim() != value || !value.is_ascii() || value.contains('*') {
        return Err(invalid());
    }
    let (_, raw_authority) = value.split_once("://").ok_or_else(invalid)?;
    if raw_authority.is_empty()
        || raw_authority
            .bytes()
            .any(|byte| matches!(byte, b'/' | b'?' | b'#'))
    {
        return Err(invalid());
    }
    let uri = value.parse::<Uri>().map_err(|_| invalid())?;
    let scheme = uri.scheme_str().ok_or_else(invalid)?;
    let authority = uri.authority().ok_or_else(invalid)?;
    if authority.as_str().contains('@')
        || authority.as_str().contains('*')
        || authority.as_str().contains('%')
        || authority.host().is_empty()
    {
        return Err(invalid());
    }
    let raw_authority = authority.as_str();
    let (host, raw_port) = if raw_authority.starts_with('[') {
        let close = raw_authority.find(']').ok_or_else(invalid)?;
        let literal = &raw_authority[..=close];
        let address = literal[1..close]
            .parse::<std::net::Ipv6Addr>()
            .map_err(|_| invalid())?;
        if literal != format!("[{}]", address) {
            return Err(invalid());
        }
        (literal.to_owned(), &raw_authority[close + 1..])
    } else {
        let host = authority.host();
        if raw_authority.strip_prefix(host).is_none() {
            return Err(invalid());
        }
        (host.to_owned(), &raw_authority[host.len()..])
    };
    if host != host.to_ascii_lowercase() {
        return Err(invalid());
    }
    let ip_host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(&host);
    let address = if host.starts_with('[') {
        Some(ip_host.parse::<IpAddr>().map_err(|_| invalid())?)
    } else if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        if ip.to_string() != host {
            return Err(invalid());
        }
        Some(IpAddr::V4(ip))
    } else {
        if !valid_dns_host(&host) || looks_like_noncanonical_ipv4(&host) {
            return Err(invalid());
        }
        None
    };
    if address.is_some_and(|ip| ip.is_unspecified()) {
        return Err(invalid());
    }
    let port = match raw_port {
        "" => {
            if authority.port().is_some() {
                return Err(invalid());
            }
            None
        }
        suffix if suffix.starts_with(':') && suffix.len() > 1 => {
            let port_text = &suffix[1..];
            if !port_text.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(invalid());
            }
            let port = port_text.parse::<u16>().map_err(|_| invalid())?;
            if port.to_string() != port_text || authority.port_u16() != Some(port) {
                return Err(invalid());
            }
            Some(port)
        }
        _ => return Err(invalid()),
    };
    if port == Some(443) && scheme == "https" || port == Some(80) && scheme == "http" {
        return Err(invalid());
    }
    let is_private_ipv4 = matches!(address, Some(IpAddr::V4(ip)) if is_rfc1918(ip));
    if scheme == "http" && !is_loopback_host(ip_host) && !(allow_private_http && is_private_ipv4) {
        return Err(invalid());
    }
    if scheme != "https" && scheme != "http" {
        return Err(invalid());
    }
    let canonical = format!("{scheme}://{}", authority.as_str());
    if canonical != value {
        return Err(invalid());
    }
    Ok((canonical, authority.as_str().to_owned()))
}

fn valid_dns_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    let host = host.strip_suffix('.').unwrap_or(host);
    !host.is_empty()
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

fn looks_like_noncanonical_ipv4(host: &str) -> bool {
    host.trim_end_matches('.').split('.').all(|part| {
        !part.is_empty()
            && (part.bytes().all(|byte| byte.is_ascii_digit())
                || part.strip_prefix("0x").is_some_and(|digits| {
                    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
                }))
    })
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn is_rfc1918(ip: std::net::Ipv4Addr) -> bool {
    let [first, second, _, _] = ip.octets();
    first == 10 || first == 172 && (16..=31).contains(&second) || first == 192 && second == 168
}

async fn mobile_gate(
    State(state): State<MobileApiState>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_owned();
    let is_api = path == "/api" || path.starts_with("/api/");
    let host_ok = request.headers().get_all(header::HOST).iter().count() == 1
        && request
            .headers()
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            == Some(state.authority.as_str())
        && request
            .uri()
            .authority()
            .is_none_or(|authority| authority.as_str() == state.authority)
        && request
            .uri()
            .scheme_str()
            .is_none_or(|scheme| scheme == state.scheme);
    if !host_ok {
        return error_response(StatusCode::FORBIDDEN, "host-forbidden");
    }
    let origins = request.headers().get_all(header::ORIGIN);
    if origins.iter().count() > 1
        || origins
            .iter()
            .next()
            .is_some_and(|origin| origin.to_str().ok() != Some(state.public_origin.as_str()))
    {
        return error_response(StatusCode::FORBIDDEN, "origin-forbidden");
    }
    if is_api {
        if !bearer_matches(request.headers(), &state.token_hash) {
            return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
        }
        if request.uri().query().is_some() {
            return error_response(StatusCode::BAD_REQUEST, "query-not-supported");
        }
    }

    let mut response = next.run(request).await;
    apply_security_headers(&mut response, is_api, &path);
    response
}

fn bearer_matches(headers: &axum::http::HeaderMap, expected: &[u8; 32]) -> bool {
    let authorization = headers.get_all(header::AUTHORIZATION);
    let one_value = authorization.iter().count() == 1;
    let raw = authorization
        .iter()
        .next()
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let (scheme, token) = raw.split_once(' ').unwrap_or(("", ""));
    let syntax_ok = one_value
        && scheme.eq_ignore_ascii_case("Bearer")
        && !token.is_empty()
        && !token.bytes().any(|byte| byte.is_ascii_whitespace());
    let supplied = sha256(token.as_bytes());
    syntax_ok & constant_time_equal(&supplied, expected)
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(bytes);
    let mut result = [0; 32];
    result.copy_from_slice(&digest);
    result
}

fn constant_time_equal(left: &[u8; 32], right: &[u8; 32]) -> bool {
    let mut difference = 0u8;
    for index in 0..32 {
        difference |= left[index] ^ right[index];
    }
    difference == 0
}

fn apply_security_headers(response: &mut Response, is_api: bool, path: &str) {
    let status_is_success = response.status().is_success();
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    if is_api {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        headers.insert(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
        );
        return;
    }
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"),
    );
    if status_is_success && (path == "/mobile/" || path == "/mobile/index.html") {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=0, must-revalidate"),
        );
    } else if status_is_success
        && path
            .rsplit('/')
            .next()
            .is_some_and(|name| name == "sw.js" || name == "service-worker.js")
    {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=0, must-revalidate"),
        );
    } else if status_is_success && path.starts_with("/mobile/") {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=3600"),
        );
    } else {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
}

fn error_response(status: StatusCode, code: &str) -> Response {
    let mut response = (status, Json(json!({"error":code}))).into_response();
    if status == StatusCode::UNAUTHORIZED {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    }
    apply_security_headers(&mut response, true, "");
    response
}

async fn mobile_shell(State(state): State<MobileApiState>) -> Response {
    serve_asset(&state, "index.html", true).await
}

async fn mobile_asset(
    State(state): State<MobileApiState>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    let Some(relative) = safe_asset_relative(uri.path()) else {
        return error_response(StatusCode::NOT_FOUND, "not-found");
    };
    serve_asset(&state, &relative, relative == "index.html").await
}

fn safe_asset_relative(path: &str) -> Option<String> {
    let relative = path.strip_prefix("/mobile/")?;
    if relative.is_empty() || relative.len() > 1024 || relative.contains('%') {
        return None;
    }
    let segments: Vec<_> = relative.split('/').collect();
    if segments.len() > 12
        || segments.iter().any(|segment| {
            segment.is_empty()
                || *segment == "."
                || *segment == ".."
                || segment.starts_with('.')
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
    {
        return None;
    }
    let extension = FsPath::new(relative)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "html"
            | "js"
            | "mjs"
            | "css"
            | "json"
            | "webmanifest"
            | "svg"
            | "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "avif"
            | "gif"
            | "ico"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
            | "wasm"
            | "txt"
    )
    .then(|| relative.to_owned())
}

async fn serve_asset(state: &MobileApiState, relative: &str, _shell: bool) -> Response {
    let root = state.assets_root.clone();
    let relative = relative.to_owned();
    let result = tokio::task::spawn_blocking(move || {
        let candidate = root.join(&relative);
        let path = candidate.canonicalize().ok()?;
        if !path.starts_with(&root) {
            return None;
        }
        let extension = path.extension()?.to_str()?.to_ascii_lowercase();
        let content_type = content_type(&extension)?;
        let metadata = fs::metadata(&path).ok()?;
        if !metadata.is_file() || metadata.len() > MAX_STATIC_FILE_BYTES {
            return None;
        }
        let bytes = fs::read(path).ok()?;
        Some((bytes, content_type))
    })
    .await;
    match result {
        Ok(Some((bytes, content_type))) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .body(Body::from(bytes))
            .unwrap_or_else(|_| {
                error_response(StatusCode::INTERNAL_SERVER_ERROR, "internal-error")
            }),
        _ => error_response(StatusCode::NOT_FOUND, "not-found"),
    }
}

fn content_type(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => return None,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateTaskRequest {
    command_id: String,
    title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendMessageRequest {
    command_id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChangeAccessModeRequest {
    command_id: String,
    expected_revision: u64,
    access_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EmptyRequest {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InterruptRequest {
    command_id: String,
    expected_generation: u64,
    expected_turn_id: String,
}

async fn get_workspace(State(state): State<MobileApiState>) -> Response {
    match call_host(state.host, |host| host.workspace()).await {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn get_task(State(state): State<MobileApiState>, Path(id): Path<String>) -> Response {
    let Some(id) = canonical_uuid(&id) else {
        return ApiError::new(StatusCode::BAD_REQUEST, "invalid-task-id").into_response();
    };
    match call_host(state.host, move |host| host.task(&id)).await {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn create_task(
    State(state): State<MobileApiState>,
    Path(project_id): Path<String>,
    request: Request,
) -> Response {
    let Some(project_id) = canonical_uuid(&project_id) else {
        return ApiError::new(StatusCode::BAD_REQUEST, "invalid-project-id").into_response();
    };
    let request: CreateTaskRequest = match decode_json(request).await {
        Ok(request) => request,
        Err(error) => return error.into_response(),
    };
    let Some(command_id) = canonical_uuid(&request.command_id) else {
        return ApiError::new(StatusCode::BAD_REQUEST, "mobile-command-id-invalid").into_response();
    };
    let title = request.title.trim().to_owned();
    if title.is_empty() || title.chars().count() > 120 {
        return ApiError::new(StatusCode::BAD_REQUEST, "title-invalid").into_response();
    }
    match call_host(state.host, move |host| {
        host.create_task(&project_id, &command_id, &title)
    })
    .await
    {
        Ok(value) => (StatusCode::CREATED, Json(value)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn send_message(
    State(state): State<MobileApiState>,
    Path(task_id): Path<String>,
    request: Request,
) -> Response {
    let Some(task_id) = canonical_uuid(&task_id) else {
        return ApiError::new(StatusCode::BAD_REQUEST, "invalid-task-id").into_response();
    };
    let request: SendMessageRequest = match decode_json(request).await {
        Ok(request) => request,
        Err(error) => return error.into_response(),
    };
    let Some(command_id) = canonical_uuid(&request.command_id) else {
        return ApiError::new(StatusCode::BAD_REQUEST, "mobile-command-id-invalid").into_response();
    };
    let text = request.text;
    if text.trim().is_empty() || text.len() > 64_000 {
        return ApiError::new(StatusCode::BAD_REQUEST, "prompt-invalid").into_response();
    }
    // Let the host replay durable receipts before checking whether NEW work
    // can run. Runtime availability can change after a response was lost.
    match call_host(state.host, move |host| {
        host.send(&task_id, &command_id, &text)
    })
    .await
    {
        Ok(value) => (StatusCode::ACCEPTED, Json(value)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn change_access_mode(
    State(state): State<MobileApiState>,
    Path(task_id): Path<String>,
    request: Request,
) -> Response {
    let Some(task_id) = canonical_uuid(&task_id) else {
        return ApiError::new(StatusCode::BAD_REQUEST, "invalid-task-id").into_response();
    };
    let request: ChangeAccessModeRequest = match decode_json(request).await {
        Ok(request) => request,
        Err(error) => return error.into_response(),
    };
    let Some(command_id) = canonical_uuid(&request.command_id) else {
        return ApiError::new(StatusCode::BAD_REQUEST, "mobile-command-id-invalid").into_response();
    };
    if !matches!(request.access_mode.as_str(), "restricted" | "full") {
        return ApiError::new(StatusCode::BAD_REQUEST, "mobile-access-mode-invalid")
            .into_response();
    }
    let expected_revision = request.expected_revision;
    let access_mode = request.access_mode;
    match call_host(state.host, move |host| {
        host.change_access_mode(&task_id, &command_id, expected_revision, &access_mode)
    })
    .await
    {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn cancel_command(
    State(state): State<MobileApiState>,
    Path(command_id): Path<String>,
    request: Request,
) -> Response {
    let Some(command_id) = canonical_uuid(&command_id) else {
        return ApiError::new(StatusCode::BAD_REQUEST, "mobile-command-id-invalid").into_response();
    };
    if let Err(error) = decode_json::<EmptyRequest>(request).await {
        return error.into_response();
    }
    match call_host(state.host, move |host| host.cancel_command(&command_id)).await {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn interrupt_task(
    State(state): State<MobileApiState>,
    Path(task_id): Path<String>,
    request: Request,
) -> Response {
    let Some(task_id) = canonical_uuid(&task_id) else {
        return ApiError::new(StatusCode::BAD_REQUEST, "invalid-task-id").into_response();
    };
    let request: InterruptRequest = match decode_json(request).await {
        Ok(request) => request,
        Err(error) => return error.into_response(),
    };
    let Some(command_id) = canonical_uuid(&request.command_id) else {
        return ApiError::new(StatusCode::BAD_REQUEST, "mobile-command-id-invalid").into_response();
    };
    let Some(expected_turn_id) = canonical_uuid(&request.expected_turn_id) else {
        return ApiError::new(StatusCode::BAD_REQUEST, "mobile-turn-id-invalid").into_response();
    };
    if request.expected_generation == 0 {
        return ApiError::new(StatusCode::BAD_REQUEST, "mobile-generation-invalid").into_response();
    }
    let generation = request.expected_generation;
    match call_host(state.host, move |host| {
        host.interrupt(&task_id, &command_id, generation, &expected_turn_id)
    })
    .await
    {
        Ok(value) => (StatusCode::ACCEPTED, Json(value)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn call_host<F>(host: MobileHost, call: F) -> Result<Value, ApiError>
where
    F: FnOnce(MobileHost) -> Result<Value, String> + Send + 'static,
{
    tokio::task::spawn_blocking(move || call(host))
        .await
        .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal-error"))?
        .map_err(ApiError::from_host)
}

async fn decode_json<T: DeserializeOwned>(request: Request) -> Result<T, ApiError> {
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim);
    if content_type != Some("application/json") {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "json-required",
        ));
    }
    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_JSON_BODY_BYTES)
    {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "body-too-large",
        ));
    }
    let bytes = to_bytes(request.into_body(), MAX_JSON_BODY_BYTES)
        .await
        .map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "body-too-large"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "invalid-json"))
}

fn canonical_uuid(value: &str) -> Option<String> {
    uuid::Uuid::parse_str(value)
        .ok()
        .filter(|id| !id.is_nil())
        .map(|id| id.to_string())
}

#[derive(Clone, Copy)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str) -> Self {
        Self { status, code }
    }

    fn from_host(code: String) -> Self {
        let (status, safe_code) = match code.as_str() {
            "project-not-found" | "project-missing" => (StatusCode::NOT_FOUND, "project-not-found"),
            "task-not-found" | "task-missing" => (StatusCode::NOT_FOUND, "task-not-found"),
            "mobile-command-not-found" | "command-not-found" => {
                (StatusCode::NOT_FOUND, "mobile-command-not-found")
            }
            "mobile-command-id-invalid" => (StatusCode::BAD_REQUEST, "mobile-command-id-invalid"),
            "mobile-access-mode-invalid" | "codex-access-mode-invalid" => {
                (StatusCode::BAD_REQUEST, "mobile-access-mode-invalid")
            }
            "prompt-invalid" => (StatusCode::BAD_REQUEST, "prompt-invalid"),
            "mobile-command-conflict" | "command-conflict" => {
                (StatusCode::CONFLICT, "mobile-command-conflict")
            }
            "mobile-command-capacity" => (StatusCode::TOO_MANY_REQUESTS, "mobile-command-capacity"),
            "task-runtime-unsupported" => (StatusCode::CONFLICT, "task-runtime-unsupported"),
            "task-archived" => (StatusCode::GONE, "task-archived"),
            "mobile-task-busy" => (StatusCode::CONFLICT, "mobile-task-busy"),
            "mobile-task-revision-stale" => (StatusCode::CONFLICT, "mobile-task-revision-stale"),
            "mobile-task-not-interruptible" => {
                (StatusCode::CONFLICT, "mobile-task-not-interruptible")
            }
            "mobile-generation-stale" => (StatusCode::CONFLICT, "mobile-generation-stale"),
            "mobile-turn-stale" => (StatusCode::CONFLICT, "mobile-turn-stale"),
            "mobile-active-worker-unavailable" => (
                StatusCode::SERVICE_UNAVAILABLE,
                "mobile-active-worker-unavailable",
            ),
            "mobile-host-send-disabled" => {
                (StatusCode::SERVICE_UNAVAILABLE, "mobile-host-send-disabled")
            }
            "mobile-execution-profile-invalid" => {
                (StatusCode::CONFLICT, "mobile-execution-profile-invalid")
            }
            "mobile-execution-profile-changed" => {
                (StatusCode::CONFLICT, "mobile-execution-profile-changed")
            }
            "runtime-binding-changed"
            | "runtime-binding-invalid"
            | "runtime-session-binding-mismatch"
            | "runtime-session-binding-missing" => {
                (StatusCode::CONFLICT, "mobile-execution-profile-changed")
            }
            _ => (StatusCode::INTERNAL_SERVER_ERROR, "internal-error"),
        };
        Self::new(status, safe_code)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error":self.code}))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_are_pathless_canonical_and_loopback_http_is_development_only() {
        assert_eq!(
            validate_origin("https://example.com", false).unwrap(),
            ("https://example.com".into(), "example.com".into())
        );
        assert_eq!(
            validate_origin("http://127.0.0.1:8123", false).unwrap(),
            ("http://127.0.0.1:8123".into(), "127.0.0.1:8123".into())
        );
        for origin in [
            "https://example.com/",
            "https://example.com/path",
            "https://example.com?token=secret",
            "https://user@example.com",
            "https://*.example.com",
            "https://0.0.0.0",
            "http://example.com",
            "https://EXAMPLE.com",
            "https://example.com:443",
            "https://example.com:0444",
            "https://example.com:",
            "https://127.1",
            "https://0x7f000001",
            "https://[0:0:0:0:0:0:0:1]",
            "https://exa_mple.com",
            "https://éxample.com",
        ] {
            assert!(validate_origin(origin, false).is_err(), "accepted {origin}");
        }
        assert!(validate_origin("http://192.168.1.20:4180", false).is_err());
        assert_eq!(
            validate_origin("http://192.168.1.20:4180", true).unwrap(),
            (
                "http://192.168.1.20:4180".into(),
                "192.168.1.20:4180".into()
            )
        );
        for origin in [
            "http://10.0.0.2:4180",
            "http://172.16.0.2:4180",
            "http://172.31.255.254:4180",
            "http://192.168.255.254:4180",
        ] {
            assert!(validate_origin(origin, true).is_ok(), "rejected {origin}");
        }
        for origin in [
            "http://example.com",
            "http://8.8.8.8",
            "http://172.15.1.1",
            "http://172.32.1.1",
            "http://192.167.1.1",
            "http://169.254.1.1",
        ] {
            assert!(validate_origin(origin, true).is_err(), "accepted {origin}");
        }
    }

    #[test]
    fn public_asset_paths_are_extension_limited_and_reject_traversal_encodings() {
        assert_eq!(
            safe_asset_relative("/mobile/index.html").as_deref(),
            Some("index.html")
        );
        assert_eq!(
            safe_asset_relative("/mobile/assets/app-abc123.js").as_deref(),
            Some("assets/app-abc123.js")
        );
        assert_eq!(
            safe_asset_relative("/mobile/icons/app.png").as_deref(),
            Some("icons/app.png")
        );
        for path in [
            "/mobile/../server.json",
            "/mobile/%2e%2e/server.json",
            "/mobile/assets%2fsecret.js",
            "/mobile/assets\\secret.js",
            "/mobile/.env",
            "/mobile/server.sqlite3",
            "/mobile/assets/",
        ] {
            assert!(safe_asset_relative(path).is_none(), "accepted {path}");
        }
    }
}
