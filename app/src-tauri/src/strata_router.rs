//! Shared address for Strata models. Strata serves one model per process, so
//! this listener sits in front of the Strata runs: a request for another model
//! waits for in-flight requests, stops the loaded run and starts the requested
//! one through the run manager, then forwards the request unchanged.
use crate::runs::{RunInfo, RunManager, RunRequest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpListener,
    sync::{oneshot, Mutex, RwLock, RwLockReadGuard},
};

const MAX_HEAD: usize = 64 * 1024;
const MAX_BODY: usize = 64 * 1024 * 1024;
const LOAD_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// Hop-by-hop and framing headers that the proxy sets itself.
const SKIPPED: [&str; 8] = [
    "host",
    "connection",
    "keep-alive",
    "content-length",
    "transfer-encoding",
    "expect",
    "proxy-authorization",
    "authorization",
];

#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouterMember {
    /// The name clients send in the `model` field.
    pub model: String,
    pub request: RunRequest,
}

#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouterConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub members: Vec<RouterMember>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterStatus {
    pub listening: bool,
    pub endpoint: Option<String>,
    pub models: Vec<String>,
    pub loaded: Option<String>,
}

struct Shared {
    api_key: String,
    members: RwLock<Vec<RouterMember>>,
    /// Forwarded requests hold a read guard; a switch takes the write guard so
    /// it never unloads a model in the middle of an answer.
    serving: RwLock<()>,
    switching: Mutex<()>,
    loaded: Mutex<Option<String>>,
}

struct Listening {
    host: String,
    port: u16,
    shared: Arc<Shared>,
    _stop: oneshot::Sender<()>,
}

#[derive(Default)]
pub struct StrataRouter {
    state: Mutex<Option<Listening>>,
}

fn loopback(host: &str) -> bool {
    matches!(
        host.trim_matches(['[', ']']),
        "localhost" | "127.0.0.1" | "::1"
    )
}

fn validate(config: &RouterConfig) -> Result<(), String> {
    if config.host.trim().is_empty() || config.port == 0 {
        return Err("Enter a host and port for the shared Strata address".into());
    }
    if !loopback(&config.host) && config.api_key.trim().is_empty() {
        return Err("Set a Strata API key before sharing the address outside this PC".into());
    }
    let mut names = std::collections::BTreeSet::new();
    let mut runs = std::collections::BTreeSet::new();
    for member in &config.members {
        if member.request.engine != "strata" {
            return Err("Only Strata models can use the shared Strata address".into());
        }
        if member.model.trim().is_empty() || !names.insert(member.model.to_lowercase()) {
            return Err(format!("Model names must be unique: {}", member.model));
        }
        if !runs.insert(member.request.run_id.clone()) {
            return Err("Each Strata model needs its own run".into());
        }
    }
    Ok(())
}

impl StrataRouter {
    async fn configure(&self, app: &AppHandle, config: RouterConfig) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if !config.enabled {
            // Dropping the sender ends the accept loop; loaded runs keep going.
            state.take();
            return Ok(());
        }
        validate(&config)?;
        if let Some(current) = state.as_ref() {
            if current.host == config.host
                && current.port == config.port
                && current.shared.api_key == config.api_key
            {
                *current.shared.members.write().await = config.members;
                return Ok(());
            }
        }
        state.take();
        let listener = TcpListener::bind((config.host.trim_matches(['[', ']']), config.port))
            .await
            .map_err(|error| format!("Port {} is not available: {error}", config.port))?;
        let shared = Arc::new(Shared {
            api_key: config.api_key.clone(),
            members: RwLock::new(config.members),
            serving: RwLock::new(()),
            switching: Mutex::new(()),
            loaded: Mutex::new(None),
        });
        let (stop, mut stopped) = oneshot::channel();
        let (events, accepted) = (app.clone(), shared.clone());
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    connection = listener.accept() => {
                        let Ok((stream, _)) = connection else { continue };
                        let (app, shared) = (events.clone(), accepted.clone());
                        tauri::async_runtime::spawn(async move {
                            let mut stream = stream;
                            let _ = serve(&app, &shared, &mut stream).await;
                        });
                    }
                }
            }
        });
        *state = Some(Listening {
            host: config.host,
            port: config.port,
            shared,
            _stop: stop,
        });
        Ok(())
    }

    async fn status(&self) -> RouterStatus {
        let state = self.state.lock().await;
        let Some(current) = state.as_ref() else {
            return RouterStatus {
                listening: false,
                endpoint: None,
                models: Vec::new(),
                loaded: None,
            };
        };
        let host = if current.host.contains(':') && !current.host.starts_with('[') {
            format!("[{}]", current.host)
        } else {
            current.host.clone()
        };
        let models = current
            .shared
            .members
            .read()
            .await
            .iter()
            .map(|member| member.model.clone())
            .collect();
        let loaded = current.shared.loaded.lock().await.clone();
        RouterStatus {
            listening: true,
            endpoint: Some(format!("http://{host}:{}", current.port)),
            models,
            loaded,
        }
    }
}

#[tauri::command]
pub async fn configure_strata_router(
    app: AppHandle,
    router: State<'_, StrataRouter>,
    config: RouterConfig,
) -> Result<RouterStatus, String> {
    router.configure(&app, config).await?;
    Ok(router.status().await)
}

#[tauri::command]
pub async fn strata_router_status(router: State<'_, StrataRouter>) -> Result<RouterStatus, String> {
    Ok(router.status().await)
}

struct Request {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or("/")
    }
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
    /// The model a request asks for: the JSON `model` field, else `?model=`.
    fn model(&self) -> Option<String> {
        serde_json::from_slice::<Value>(&self.body)
            .ok()
            .and_then(|body| body.get("model")?.as_str().map(str::to_owned))
            .or_else(|| {
                let query = self.target.split_once('?')?.1;
                reqwest::Url::parse(&format!("http://local/?{query}"))
                    .ok()?
                    .query_pairs()
                    .find(|(key, _)| key == "model")
                    .map(|(_, value)| value.into_owned())
            })
            .filter(|model| !model.trim().is_empty())
    }
}

async fn read_request<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Request, (u16, String)> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break index;
        }
        if buffer.len() > MAX_HEAD {
            return Err((431, "Request headers are too large".into()));
        }
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| (400, error.to_string()))?;
        if read == 0 {
            return Err((400, "Incomplete request".into()));
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut start = lines.next().unwrap_or_default().split(' ');
    let (method, target) = match (start.next(), start.next()) {
        (Some(method), Some(target)) if target.starts_with('/') => {
            (method.to_owned(), target.to_owned())
        }
        _ => return Err((400, "Malformed request line".into())),
    };
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_owned(), value.trim().to_owned()))
        .collect();
    let mut request = Request {
        method,
        target,
        headers,
        body: buffer[head_end + 4..].to_vec(),
    };
    if request
        .header("transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
    {
        return Err((411, "Send the request body with a Content-Length".into()));
    }
    let length = match request.header("content-length") {
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| (400, "Invalid Content-Length".to_string()))?,
        None => 0,
    };
    if length > MAX_BODY {
        return Err((413, "Request body is too large".into()));
    }
    while request.body.len() < length {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| (400, error.to_string()))?;
        if read == 0 {
            return Err((400, "Incomplete request body".into()));
        }
        request.body.extend_from_slice(&chunk[..read]);
    }
    request.body.truncate(length);
    Ok(request)
}

async fn respond<S: AsyncWrite + Unpin>(
    stream: &mut S,
    status: u16,
    body: &Value,
) -> Result<(), String> {
    let body = body.to_string();
    let reason = reqwest::StatusCode::from_u16(status)
        .ok()
        .and_then(|code| code.canonical_reason())
        .unwrap_or("");
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|error| error.to_string())
}

fn error(message: &str) -> Value {
    json!({ "error": { "message": message } })
}

fn authorized(shared: &Shared, request: &Request) -> bool {
    if shared.api_key.is_empty() {
        return true;
    }
    let expected = format!("Bearer {}", shared.api_key);
    request.header("authorization") == Some(expected.as_str())
        || request.header("x-api-key") == Some(shared.api_key.as_str())
}

async fn serve<S: AsyncRead + AsyncWrite + Unpin>(
    app: &AppHandle,
    shared: &Shared,
    stream: &mut S,
) -> Result<(), String> {
    let request = match read_request(stream).await {
        Ok(request) => request,
        Err((status, message)) => return respond(stream, status, &error(&message)).await,
    };
    if request.method == "OPTIONS" {
        let preflight = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nConnection: close\r\n\r\n";
        return stream
            .write_all(preflight.as_bytes())
            .await
            .map_err(|error| error.to_string());
    }
    if request.path() == "/health" {
        return respond(stream, 200, &json!({ "status": "ok" })).await;
    }
    if !authorized(shared, &request) {
        return respond(stream, 401, &error("Invalid API key")).await;
    }
    if request.method == "GET" && matches!(request.path(), "/v1/models" | "/models") {
        let loaded = shared.loaded.lock().await.clone();
        let data: Vec<Value> = shared
            .members
            .read()
            .await
            .iter()
            .map(|member| {
                let state = if loaded.as_deref() == Some(member.model.as_str()) { "loaded" } else { "unloaded" };
                json!({ "id": member.model, "object": "model", "owned_by": "strata", "status": { "value": state } })
            })
            .collect();
        return respond(stream, 200, &json!({ "object": "list", "data": data })).await;
    }
    let member = match pick(shared, request.model()).await {
        Ok(member) => member,
        Err((status, message)) => return respond(stream, status, &error(&message)).await,
    };
    let (guard, endpoint) = match ensure_loaded(app, shared, &member).await {
        Ok(loaded) => loaded,
        Err(message) => return respond(stream, 503, &error(&message)).await,
    };
    let key = member.request.launch["apiKey"].as_str().unwrap_or_default();
    let result = forward(stream, &request, &endpoint, key).await;
    drop(guard);
    result
}

async fn pick(shared: &Shared, asked: Option<String>) -> Result<RouterMember, (u16, String)> {
    let members = shared.members.read().await;
    if let Some(asked) = asked {
        return members
            .iter()
            .find(|member| member.model.eq_ignore_ascii_case(asked.trim()))
            .cloned()
            .ok_or((404, format!("Model not found: {asked}")));
    }
    let loaded = shared.loaded.lock().await.clone();
    members
        .iter()
        .find(|member| Some(&member.model) == loaded.as_ref())
        .or(if members.len() == 1 {
            members.first()
        } else {
            None
        })
        .cloned()
        .ok_or((400, "Name a model in the `model` field".into()))
}

async fn run_info(app: &AppHandle, run_id: &str) -> Result<Option<RunInfo>, String> {
    Ok(app
        .state::<RunManager>()
        .list()
        .await?
        .into_iter()
        .find(|info| info.run_id == run_id))
}

fn active(info: &RunInfo) -> bool {
    !["stopped", "crashed"].contains(&info.state.as_str())
}

/// The member's endpoint when its run is up and answers health checks.
async fn ready(app: &AppHandle, member: &RouterMember) -> Option<String> {
    let info = run_info(app, &member.request.run_id).await.ok()??;
    let key = member.request.launch["apiKey"].as_str();
    (active(&info) && crate::llama::health(&info.endpoint, key).await.ready)
        .then_some(info.endpoint)
}

async fn ensure_loaded<'a>(
    app: &AppHandle,
    shared: &'a Shared,
    member: &RouterMember,
) -> Result<(RwLockReadGuard<'a, ()>, String), String> {
    for _ in 0..3 {
        {
            let guard = shared.serving.read().await;
            if let Some(endpoint) = ready(app, member).await {
                *shared.loaded.lock().await = Some(member.model.clone());
                return Ok((guard, endpoint));
            }
        }
        let _switching = shared.switching.lock().await;
        // A request queued behind the same switch finds the model loaded.
        if ready(app, member).await.is_some() {
            continue;
        }
        let _exclusive = shared.serving.write().await;
        switch_to(app, shared, member).await?;
    }
    Err(format!("{} did not stay loaded", member.model))
}

async fn switch_to(app: &AppHandle, shared: &Shared, member: &RouterMember) -> Result<(), String> {
    let manager = app.state::<RunManager>();
    let others: Vec<String> = shared
        .members
        .read()
        .await
        .iter()
        .filter(|other| other.request.run_id != member.request.run_id)
        .map(|other| other.request.run_id.clone())
        .collect();
    for info in manager.list().await? {
        if others.contains(&info.run_id) && active(&info) {
            manager.stop(Some(app), &info.run_id).await?;
        }
    }
    *shared.loaded.lock().await = None;
    if manager
        .start(Some(app), member.request.clone())
        .await
        .is_err()
    {
        // A run started by hand with other settings: restart it as configured here.
        manager.stop(Some(app), &member.request.run_id).await?;
        manager.start(Some(app), member.request.clone()).await?;
    }
    let _ = app.emit("runs://changed", ());
    let deadline = tokio::time::Instant::now() + LOAD_TIMEOUT;
    loop {
        if ready(app, member).await.is_some() {
            *shared.loaded.lock().await = Some(member.model.clone());
            let _ = app.emit("runs://changed", ());
            return Ok(());
        }
        let info = run_info(app, &member.request.run_id).await?;
        if let Some(info) = info.filter(|info| !active(info)) {
            let _ = app.emit("runs://changed", ());
            return Err(info
                .last_error
                .unwrap_or_else(|| format!("{} stopped while loading", member.model)));
        }
        if tokio::time::Instant::now() > deadline {
            return Err(format!("{} took too long to load", member.model));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn forward<S: AsyncWrite + Unpin>(
    stream: &mut S,
    request: &Request,
    endpoint: &str,
    api_key: &str,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?;
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut upstream = client.request(
        method,
        format!("{}{}", endpoint.trim_end_matches('/'), request.target),
    );
    for (name, value) in &request.headers {
        if !SKIPPED.contains(&name.to_ascii_lowercase().as_str())
            && !name.eq_ignore_ascii_case("x-api-key")
        {
            upstream = upstream.header(name, value);
        }
    }
    if !api_key.is_empty() {
        upstream = upstream.bearer_auth(api_key);
    }
    let mut response = match upstream.body(request.body.clone()).send().await {
        Ok(response) => response,
        Err(failure) => return respond(stream, 502, &error(&failure.to_string())).await,
    };
    let status = response.status();
    let mut head = format!(
        "HTTP/1.1 {} {}\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("")
    );
    for (name, value) in response.headers() {
        if !SKIPPED.contains(&name.as_str()) {
            head.push_str(&format!(
                "{}: {}\r\n",
                name,
                String::from_utf8_lossy(value.as_bytes())
            ));
        }
    }
    // The body is close-delimited, so streamed answers pass through as they arrive.
    head.push_str("Connection: close\r\n\r\n");
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        stream
            .write_all(&chunk)
            .await
            .map_err(|error| error.to_string())?;
        stream.flush().await.map_err(|error| error.to_string())?;
    }
    stream.shutdown().await.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn member(model: &str, run_id: &str) -> RouterMember {
        RouterMember {
            model: model.into(),
            request: RunRequest {
                run_id: run_id.into(),
                name: model.into(),
                engine: "strata".into(),
                mode: "single".into(),
                model_id: String::new(),
                context_tokens: 0,
                auto_port: true,
                launch: json!({ "apiKey": "upstream" }),
            },
        }
    }

    fn shared(members: Vec<RouterMember>) -> Shared {
        Shared {
            api_key: "secret".into(),
            members: RwLock::new(members),
            serving: RwLock::new(()),
            switching: Mutex::new(()),
            loaded: Mutex::new(None),
        }
    }

    #[tokio::test]
    async fn reads_the_model_from_the_body_or_the_query() {
        let raw = b"POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Length: 26\r\n\r\n{\"model\":\"Qwen\",\"x\":[1,2]}";
        let request = read_request(&mut &raw[..]).await.unwrap();
        assert_eq!(request.path(), "/v1/chat/completions");
        assert_eq!(request.model().as_deref(), Some("Qwen"));
        let raw = b"GET /slots?model=Deep%20Seek HTTP/1.1\r\n\r\n";
        assert_eq!(
            read_request(&mut &raw[..])
                .await
                .unwrap()
                .model()
                .as_deref(),
            Some("Deep Seek")
        );
        let raw = b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n";
        assert_eq!(
            read_request(&mut &raw[..]).await.err().map(|e| e.0),
            Some(411)
        );
    }

    #[tokio::test]
    async fn picks_named_loaded_or_only_model() {
        let both = shared(vec![member("Qwen", "a"), member("DeepSeek", "b")]);
        assert_eq!(
            pick(&both, Some("deepseek".into()))
                .await
                .unwrap()
                .request
                .run_id,
            "b"
        );
        assert_eq!(
            pick(&both, Some("other".into())).await.err().map(|e| e.0),
            Some(404)
        );
        assert_eq!(pick(&both, None).await.err().map(|e| e.0), Some(400));
        *both.loaded.lock().await = Some("Qwen".into());
        assert_eq!(pick(&both, None).await.unwrap().request.run_id, "a");
        let one = shared(vec![member("Qwen", "a")]);
        assert_eq!(pick(&one, None).await.unwrap().model, "Qwen");
    }

    #[test]
    fn rejects_duplicate_models_and_open_addresses_without_a_key() {
        let mut config = RouterConfig {
            enabled: true,
            host: "127.0.0.1".into(),
            port: 8090,
            api_key: String::new(),
            members: vec![member("Qwen", "a"), member("qwen", "b")],
        };
        assert!(validate(&config).is_err());
        config.members.pop();
        assert!(validate(&config).is_ok());
        config.host = "0.0.0.0".into();
        assert!(validate(&config).is_err());
        config.api_key = "key".into();
        assert!(validate(&config).is_ok());
    }

    #[test]
    fn checks_the_router_key_but_not_health() {
        let state = shared(vec![]);
        let request = |header: &str| Request {
            method: "GET".into(),
            target: "/v1/models".into(),
            headers: vec![("Authorization".into(), header.into())],
            body: Vec::new(),
        };
        assert!(authorized(&state, &request("Bearer secret")));
        assert!(!authorized(&state, &request("Bearer upstream")));
    }

    #[tokio::test]
    async fn forwards_with_the_upstream_key_and_streams_the_answer() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let upstream = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut received = Vec::new();
            let mut buffer = [0u8; 4096];
            while !String::from_utf8_lossy(&received).contains("{\"model\":\"Qwen\"}") {
                let read = socket.read(&mut buffer).unwrap();
                received.extend_from_slice(&buffer[..read]);
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 11\r\n\r\ndata: hello")
                .unwrap();
            String::from_utf8_lossy(&received).to_lowercase()
        });
        let request = Request {
            method: "POST".into(),
            target: "/v1/chat/completions".into(),
            headers: vec![
                ("Authorization".into(), "Bearer secret".into()),
                ("Content-Type".into(), "application/json".into()),
            ],
            body: b"{\"model\":\"Qwen\"}".to_vec(),
        };
        let mut output = Vec::new();
        forward(
            &mut output,
            &request,
            &format!("http://{address}"),
            "upstream",
        )
        .await
        .unwrap();
        let sent = upstream.join().unwrap();
        assert!(sent.contains("authorization: bearer upstream") && !sent.contains("secret"));
        let output = String::from_utf8(output).unwrap();
        assert!(output.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(output.contains("content-type: text/event-stream\r\n"));
        assert!(output.ends_with("Connection: close\r\n\r\ndata: hello"));
    }
}
