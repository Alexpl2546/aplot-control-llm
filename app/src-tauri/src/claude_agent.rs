//! Host the unmodified Claude Code CLI. Authentication remains owned by that CLI.
use crate::owned_job::OwnedJob;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
};

type Reply = oneshot::Sender<Result<Value, String>>;
/// Each CLI process gets a new generation; host approvals are bound to it.
static NEXT_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
struct Worker {
    profile_id: String,
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, Reply>>,
    requests: Mutex<HashMap<String, Value>>,
    dead: AtomicBool,
    busy: AtomicBool,
    job: OwnedJob,
    generation: u64,
}
#[derive(Default)]
pub struct ClaudeManager {
    workers: Mutex<HashMap<String, Arc<Worker>>>,
    auth: Mutex<()>,
    login: Mutex<Option<(Child, std::time::Instant, String)>>,
}
pub(crate) fn discovered_executable() -> Option<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE") {
        paths.push(PathBuf::from(home).join(".local/bin/claude.exe"));
    }
    if let Some(value) = std::env::var_os("PATH") {
        for root in std::env::split_paths(&value) {
            paths.push(root.join("claude.exe"));
        }
    }
    paths.into_iter().find(|p| p.is_file())
}
fn executable(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) =
        std::fs::read_to_string(crate::db::connection_data_dir(app)?.join("claude-executable.txt"))
    {
        let p = PathBuf::from(p.trim());
        if p.is_absolute()
            && p.is_file()
            && p.extension().is_some_and(|s| s.eq_ignore_ascii_case("exe"))
        {
            return Ok(p);
        }
    }
    if let Some(c) = crate::components::managed_locations()
        .into_iter()
        .find(|c| c.id == "claude")
    {
        return Ok(PathBuf::from(c.path));
    }
    discovered_executable().ok_or_else(|| "not-installed".into())
}
fn command(
    app: &AppHandle,
    profile: &crate::connection_profiles::Profile,
) -> Result<Command, String> {
    let home = crate::connection_profiles::home(app, profile)?;
    std::fs::create_dir_all(&home).map_err(|_| "storage")?;
    let mut c = Command::new(executable(app)?);
    c.env("CLAUDE_CONFIG_DIR", home)
        .env("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS", "1")
        .kill_on_drop(true)
        .stderr(Stdio::null());
    for key in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_PROFILE",
        "CLAUDECODE",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
        "CLAUDE_CODE_OAUTH_SCOPES",
        "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    ] {
        c.env_remove(key);
    }
    if let Some(path) = git_bash() {
        c.env("CLAUDE_CODE_GIT_BASH_PATH", path);
    }
    #[cfg(windows)]
    c.creation_flags(0x08000000);
    Ok(c)
}
fn git_bash() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH") {
        let p = PathBuf::from(path);
        if p.is_file() {
            return Some(p);
        }
    }
    let mut candidates = Vec::new();
    for (name, suffix) in [
        ("ProgramFiles", "Git/bin/bash.exe"),
        ("LOCALAPPDATA", "Programs/Git/bin/bash.exe"),
    ] {
        if let Some(root) = std::env::var_os(name) {
            candidates.push(PathBuf::from(root).join(suffix));
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for p in std::env::split_paths(&paths) {
            if let Some(root) = p.parent() {
                candidates.push(root.join("bin/bash.exe"));
            }
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}
async fn identity(
    app: &AppHandle,
    profile: &crate::connection_profiles::Profile,
) -> Result<Value, String> {
    let mut c = command(app, profile)?;
    c.args(["auth", "status"])
        .stdout(Stdio::piped())
        .stdin(Stdio::null());
    let output = tokio::time::timeout(Duration::from_secs(20), c.output())
        .await
        .map_err(|_| "timeout")?
        .map_err(|_| "not-installed")?;
    if output.stdout.len() > 100000 {
        return Err("protocol".into());
    }
    let v: Value = serde_json::from_slice(&output.stdout).map_err(|_| "auth-status")?;
    let connected = v["loggedIn"] == true && v["authMethod"] == "claude.ai";
    let key = if connected {
        Some(format!(
            "claude:{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!([
                    v["email"],
                    v["orgId"],
                    v["accountUuid"],
                    v["authMethod"]
                ]))
                .map_err(|_| "protocol")?
            )
        ))
    } else {
        None
    };
    let key = key.map(|key| crate::connection_profiles::key(profile, &key));
    crate::connection_profiles::remember(
        app,
        &profile.id,
        key.clone(),
        v["email"].as_str().map(str::to_owned),
    )?;
    Ok(
        json!({"installed":true,"connected":connected,"email":v["email"],"planType":v["subscriptionType"],"connectionId":key}),
    )
}
impl Worker {
    async fn write(&self, v: Value) -> Result<(), String> {
        if self.dead.load(Ordering::Acquire) {
            return Err("closed".into());
        }
        let mut b = serde_json::to_vec(&v).map_err(|_| "protocol")?;
        b.push(b'\n');
        self.input
            .lock()
            .await
            .write_all(&b)
            .await
            .map_err(|_| "closed".into())
    }
    async fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (send, recv) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), send);
        let mut request = params;
        request["subtype"] = json!(method);
        if let Err(e) = self
            .write(json!({"type":"control_request","request_id":id,"request":request}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        let r = tokio::time::timeout(Duration::from_secs(30), recv).await;
        self.pending.lock().await.remove(&id);
        r.map_err(|_| "timeout")?.map_err(|_| "closed")?
    }
    async fn close(&self) {
        self.dead.store(true, Ordering::Release);
        self.job.terminate();
        let _ = self.child.lock().await.kill().await;
    }
}
impl ClaudeManager {
    pub async fn shutdown(&self) {
        let workers = std::mem::take(&mut *self.workers.lock().await);
        for w in workers.into_values() {
            w.close().await;
        }
        if let Some((mut login, _, _)) = self.login.lock().await.take() {
            let _ = login.kill().await;
        }
    }
}
#[tauri::command]
pub async fn claude_status(
    app: AppHandle,
    state: State<'_, ClaudeManager>,
    profile_id: Option<String>,
) -> Result<Value, String> {
    let profile = crate::connection_profiles::profile(&app, "claude", profile_id.as_deref())?;
    let mut login = state.login.lock().await;
    let mut finished = false;
    let pending = if let Some((child, start, id)) = login.as_mut() {
        if start.elapsed() > Duration::from_secs(300) {
            let _ = child.kill().await;
            *login = None;
            false
        } else if child.try_wait().map_err(|_| "closed")?.is_some() {
            *login = None;
            finished = true;
            false
        } else {
            Some(id.as_str()) == profile.as_ref().map(|p| p.id.as_str())
        }
    } else {
        false
    };
    drop(login);
    let installed = executable(&app).is_ok();
    let mut status = if installed {
        match profile.filter(|p| p.enabled) {
            Some(p) => identity(&app, &p).await?,
            None => json!({"installed":true,"connected":false}),
        }
    } else {
        json!({"installed":false,"connected":false})
    };
    status["pending"] = json!(pending);
    if finished {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
    Ok(status)
}
pub(crate) async fn close_profile(
    app: &AppHandle,
    p: &crate::connection_profiles::Profile,
    disconnect: bool,
) -> Result<(), String> {
    let state = app.state::<ClaudeManager>();
    let _auth = state.auth.lock().await;
    let mut login = state.login.lock().await;
    if login.as_ref().is_some_and(|(_, _, id)| id == &p.id) {
        if let Some((mut c, _, _)) = login.take() {
            let _ = c.kill().await;
        }
    }
    drop(login);
    let mut workers = state.workers.lock().await;
    let ids: Vec<_> = workers
        .iter()
        .filter(|(_, w)| w.profile_id == p.id)
        .map(|(id, _)| id.clone())
        .collect();
    let closing: Vec<_> = ids
        .into_iter()
        .filter_map(|id| workers.remove(&id))
        .collect();
    drop(workers);
    for w in closing {
        w.close().await;
    }
    if disconnect && executable(app).is_err() && p.connection_id.is_none() {
        crate::connection_profiles::remember(app, &p.id, None, None)?;
        return Ok(());
    }
    if disconnect {
        let mut c = command(app, p)?;
        c.args(["auth", "logout"])
            .stdin(Stdio::null())
            .stdout(Stdio::null());
        let result = tokio::time::timeout(Duration::from_secs(20), c.status())
            .await
            .map_err(|_| "timeout")?
            .map_err(|_| "closed")?;
        if !result.success() {
            return Err("auth".into());
        }
        crate::connection_profiles::remember(app, &p.id, None, None)?;
    }
    let _ = app.emit("claude://changed", ());
    Ok(())
}
#[tauri::command]
pub async fn claude_login(
    app: AppHandle,
    state: State<'_, ClaudeManager>,
    action: String,
    profile_id: Option<String>,
) -> Result<(), String> {
    let p = crate::connection_profiles::profile(&app, "claude", profile_id.as_deref())?
        .ok_or("profile")?;
    if action == "logout" {
        return close_profile(&app, &p, true).await;
    }
    let _auth = state.auth.lock().await;
    if action == "cancel" {
        let mut login = state.login.lock().await;
        if login.as_ref().is_some_and(|(_, _, id)| id == &p.id) {
            if let Some((mut c, _, _)) = login.take() {
                let _ = c.kill().await;
            }
        }
        return Ok(());
    }
    if action != "login" {
        return Err("unsupported-auth".into());
    }
    if !p.enabled {
        return Err("profile-disabled".into());
    }
    if state.login.lock().await.is_some() {
        return Err("busy".into());
    }
    if state
        .workers
        .lock()
        .await
        .values()
        .any(|w| w.profile_id == p.id)
    {
        return Err("profile-busy".into());
    }
    let mut c = command(&app, &p)?;
    c.args(["auth", "login"])
        .stdin(Stdio::null())
        .stdout(Stdio::null());
    let child = c.spawn().map_err(|_| "not-installed")?;
    *state.login.lock().await = Some((child, std::time::Instant::now(), p.id));
    let _ = app.emit("claude://changed", ());
    Ok(())
}
#[tauri::command]
pub async fn claude_set_executable(
    app: AppHandle,
    state: State<'_, ClaudeManager>,
    path: String,
) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !p.is_absolute()
        || !p.is_file()
        || !p.extension().is_some_and(|s| s.eq_ignore_ascii_case("exe"))
    {
        return Err("executable".into());
    }
    state.shutdown().await;
    std::fs::write(
        crate::db::connection_data_dir(&app)?.join("claude-executable.txt"),
        p.to_string_lossy().as_bytes(),
    )
    .map_err(|_| "storage".into())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    pub(crate) id: String,
    pub(crate) cwd: String,
    pub(crate) model: String,
    pub(crate) connection_id: String,
    pub(crate) mode: String,
    pub(crate) chat: bool,
    pub(crate) session_id: Option<String>,
    pub(crate) instructions: Option<String>,
    #[serde(default)]
    pub(crate) effort: Option<String>,
}
fn args(r: &Start) -> Result<Vec<String>, String> {
    if r.id.len() > 100
        || r.model.len() > 160
        || r.model.is_empty()
        || !r.model.as_bytes()[0].is_ascii_alphanumeric()
        || !r
            .model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:/[]".contains(&b))
        || !matches!(r.mode.as_str(), "manual" | "restricted" | "full")
    {
        return Err("request".into());
    }
    if r.session_id
        .as_ref()
        .is_some_and(|v| uuid::Uuid::parse_str(v).is_err())
    {
        return Err("session".into());
    }
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        "--model",
        &r.model,
        "--permission-mode",
        if r.mode == "full" && !r.chat {
            "bypassPermissions"
        } else {
            "default"
        },
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    if r.chat || r.mode == "restricted" {
        args.extend(
            [
                "--safe-mode",
                "--tools",
                if r.chat { "" } else { "Read,Glob,Grep" },
                "--strict-mcp-config",
                "--mcp-config",
                "{\"mcpServers\":{}}",
                "--disallowedTools",
                if r.chat {
                    "*"
                } else {
                    "Bash,Edit,Write,NotebookEdit,Agent,Task,mcp__*"
                },
            ]
            .into_iter()
            .map(str::to_owned),
        );
    }
    if let Some(id) = &r.session_id {
        args.extend(["--resume".into(), id.clone()]);
    }
    match r.effort.as_deref() {
        None | Some("") => {}
        Some(level) if crate::reasoning::plausible_level(level) => {
            args.extend(["--effort".into(), level.into()]);
        }
        Some(_) => return Err("request".into()),
    }
    if let Some(text) = &r.instructions {
        if text.len() > 64000 {
            return Err("limit".into());
        }
        args.extend(["--append-system-prompt".into(), text.clone()]);
    }
    Ok(args)
}
#[tauri::command]
pub async fn claude_start(
    app: AppHandle,
    state: State<'_, ClaudeManager>,
    request: Start,
) -> Result<Value, String> {
    let _auth = state.auth.lock().await;
    let profile =
        crate::connection_profiles::for_connection(&app, "claude", Some(&request.connection_id))?;
    if identity(&app, &profile).await?["connectionId"].as_str()
        != Some(request.connection_id.as_str())
    {
        return Err("changed".into());
    }
    let folder = if request.chat {
        let p = crate::db::connection_data_dir(&app)?.join("claude-chat");
        std::fs::create_dir_all(&p).map_err(|_| "storage")?;
        p
    } else {
        PathBuf::from(&request.cwd)
    };
    if !folder.is_absolute() || !folder.is_dir() {
        return Err("folder".into());
    }
    let mut workers = state.workers.lock().await;
    if workers.contains_key(&request.id) {
        return Err("busy".into());
    }
    if workers.len() >= 16 {
        return Err("limit".into());
    }
    let mut c = command(&app, &profile)?;
    c.args(args(&request)?)
        .current_dir(folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = c.spawn().map_err(|_| "not-installed")?;
    let job = match OwnedJob::assign(&child) {
        Ok(j) => j,
        Err(e) => {
            let _ = child.kill().await;
            return Err(e);
        }
    };
    let input = child.stdin.take().ok_or("closed")?;
    let output = child.stdout.take().ok_or("closed")?;
    let worker = Arc::new(Worker {
        profile_id: profile.id,
        child: Mutex::new(child),
        input: Mutex::new(input),
        pending: Mutex::new(HashMap::new()),
        requests: Mutex::new(HashMap::new()),
        dead: AtomicBool::new(false),
        busy: AtomicBool::new(false),
        job,
        generation: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
    });
    workers.insert(request.id.clone(), worker.clone());
    drop(workers);
    let reader = worker.clone();
    let id = request.id.clone();
    let generation = worker.generation;
    let events = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(output).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.len() > 16_000_000 {
                break;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if v["type"] == "control_response" {
                if let Some(key) = v["response"]["request_id"].as_str() {
                    if let Some(send) = reader.pending.lock().await.remove(key) {
                        let _ = send.send(if v["response"]["subtype"] == "error" {
                            Err("control-rejected".into())
                        } else {
                            Ok(v["response"]["response"].clone())
                        });
                    }
                }
            } else {
                if v["type"] == "control_request" && v["request"]["subtype"] != "can_use_tool" {
                    let _=reader.write(json!({"type":"control_response","response":{"subtype":"error","request_id":v["request_id"],"error":"Unsupported host request"}})).await;
                    continue;
                }
                if v["type"] == "control_request" {
                    if let Some(key) = v["request_id"].as_str() {
                        reader.requests.lock().await.insert(key.into(), v.clone());
                    }
                }
                if v["type"] == "result" {
                    reader.busy.store(false, Ordering::Release);
                }
                // Sessions owned by host tasks are handled there and never reach the window.
                if !crate::tasks::claude::route(&events, &id, generation, &v).await {
                    let _ = events.emit("claude://event", json!({"id":id,"packet":v}));
                }
            }
        }
        reader.dead.store(true, Ordering::Release);
        for (_, send) in reader.pending.lock().await.drain() {
            let _ = send.send(Err("closed".into()));
        }
        crate::tasks::claude::route(&events, &id, generation, &json!({"type":"aplot_closed"}))
            .await;
        let _ = events.emit(
            "claude://event",
            json!({"id":id,"packet":{"type":"aplot_closed"}}),
        );
        let state = events.state::<ClaudeManager>();
        let mut workers = state.workers.lock().await;
        if workers.get(&id).is_some_and(|w| Arc::ptr_eq(w, &reader)) {
            workers.remove(&id);
        }
    });
    match worker.rpc("initialize", json!({"hooks":{}})).await {
        Ok(mut result) => {
            if let Some(object) = result.as_object_mut() {
                object.insert("aplotGeneration".into(), json!(generation));
            }
            Ok(result)
        }
        Err(e) => {
            worker.close().await;
            state.workers.lock().await.remove(&request.id);
            Err(e)
        }
    }
}
#[tauri::command]
pub fn claude_images(paths: Vec<String>) -> Result<Value, String> {
    image_blocks(paths)
}
pub(crate) fn image_blocks(paths: Vec<String>) -> Result<Value, String> {
    use base64::Engine;
    use std::io::Read;
    if paths.len() > 8 {
        return Err("attachment-limit".into());
    }
    let mut blocks = Vec::new();
    for path in paths {
        let file = std::fs::File::open(path).map_err(|_| "attachment-missing")?;
        if !file.metadata().map_err(|_| "attachment-missing")?.is_file() {
            return Err("attachment-data".into());
        }
        let mut bytes = Vec::new();
        file.take(5 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "attachment-data")?;
        if bytes.len() > 5 * 1024 * 1024 {
            return Err("attachment-limit".into());
        }
        let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else if bytes.starts_with(&[255, 216, 255]) {
            "image/jpeg"
        } else if bytes.starts_with(b"GIF8") {
            "image/gif"
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            "image/webp"
        } else {
            return Err("attachment-format".into());
        };
        blocks.push(json!({"type":"image","source":{"type":"base64","media_type":mime,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}}));
    }
    Ok(json!(blocks))
}
#[tauri::command]
pub async fn claude_send(
    state: State<'_, ClaudeManager>,
    id: String,
    packet: Value,
) -> Result<(), String> {
    state.send_packet(&id, packet).await
}
impl ClaudeManager {
    pub(crate) async fn send_packet(&self, id: &str, packet: Value) -> Result<(), String> {
        let state = self;
        let w = state
            .workers
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or("closed")?;
        if packet["type"] != "user" || packet["message"]["role"] != "user" {
            return Err("unsupported-method".into());
        }
        if serde_json::to_vec(&packet).map_err(|_| "protocol")?.len() > 20_000_000 {
            return Err("limit".into());
        }
        if w.busy.swap(true, Ordering::AcqRel) {
            return Err("busy".into());
        }
        if let Err(e) = w.write(packet).await {
            w.busy.store(false, Ordering::Release);
            return Err(e);
        }
        Ok(())
    }
    /// Answers a host-owned approval on the exact process generation that asked.
    pub(crate) async fn respond_native(
        &self,
        id: &str,
        generation: u64,
        request_id: &str,
        response: Value,
    ) -> Result<(), String> {
        let w = self.live_worker(id, generation).await.ok_or("stale")?;
        w.requests
            .lock()
            .await
            .remove(request_id)
            .ok_or("expired")?;
        w.write(json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,"response":response}})).await
    }
    pub(crate) async fn has_request(&self, id: &str, generation: u64, request_id: &str) -> bool {
        match self.live_worker(id, generation).await {
            Some(w) => w.requests.lock().await.contains_key(request_id),
            None => false,
        }
    }
    async fn live_worker(&self, id: &str, generation: u64) -> Option<Arc<Worker>> {
        self.workers
            .lock()
            .await
            .get(id)
            .filter(|w| w.generation == generation && !w.dead.load(Ordering::Acquire))
            .cloned()
    }
    pub(crate) async fn stop(&self, id: &str, close: bool) -> Result<(), String> {
        let w = self.workers.lock().await.get(id).cloned();
        if let Some(w) = w {
            if close {
                w.close().await;
                self.workers.lock().await.remove(id);
            } else {
                w.rpc("interrupt", json!({})).await?;
            }
        }
        Ok(())
    }
}
#[tauri::command]
pub async fn claude_respond(
    state: State<'_, ClaudeManager>,
    id: String,
    request_id: String,
    response: Value,
) -> Result<(), String> {
    let w = state
        .workers
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or("closed")?;
    let request = w
        .requests
        .lock()
        .await
        .remove(&request_id)
        .ok_or("expired")?;
    if request["request"]["subtype"] != "can_use_tool" {
        return Err("unsupported-request".into());
    }
    w.write(json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,"response":response}})).await
}
#[tauri::command]
pub async fn claude_stop(
    state: State<'_, ClaudeManager>,
    id: String,
    close: bool,
) -> Result<(), String> {
    state.stop(&id, close).await
}
#[tauri::command]
pub async fn claude_catalog(
    app: AppHandle,
    connection_id: Option<String>,
) -> Result<Value, String> {
    let p = crate::connection_profiles::for_connection(&app, "claude", connection_id.as_deref())?;
    let status = identity(&app, &p).await?;
    let connection_id = status["connectionId"].as_str().ok_or("auth")?.to_owned();
    let cwd = crate::db::connection_data_dir(&app)?.join("claude-chat");
    std::fs::create_dir_all(&cwd).map_err(|_| "storage")?;
    let id = uuid::Uuid::new_v4().to_string();
    let result = claude_start(
        app.clone(),
        app.state(),
        Start {
            id: id.clone(),
            cwd: cwd.to_string_lossy().into(),
            model: "sonnet".into(),
            connection_id,
            mode: "restricted".into(),
            chat: true,
            session_id: None,
            instructions: None,
            effort: None,
        },
    )
    .await;
    let _ = claude_stop(app.state(), id, true).await;
    let v = result?;
    Ok(
        json!({"models":v.get("models").or_else(||v.get("supportedModels")).or_else(||v.get("supported_models")).cloned().unwrap_or(json!([]))}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Start {
        Start {
            id: "s".into(),
            cwd: "C:/work".into(),
            model: "sonnet".into(),
            connection_id: "c".into(),
            mode: "full".into(),
            chat: true,
            session_id: None,
            instructions: None,
            effort: None,
        }
    }
    #[test]
    fn chat_disables_tools_even_with_full_access() {
        let a = args(&request()).unwrap();
        assert!(a.windows(2).any(|w| w == ["--tools", ""]));
        assert!(a.contains(&"--safe-mode".into()));
        assert!(!a.contains(&"bypassPermissions".into()));
        assert!(a.windows(2).any(|w| w == ["--disallowedTools", "*"]));
    }
    #[test]
    fn restricted_is_not_a_prompt_only_policy() {
        let mut r = request();
        r.chat = false;
        r.mode = "restricted".into();
        let a = args(&r).unwrap();
        assert!(a.windows(2).any(|w| w == ["--tools", "Read,Glob,Grep"]));
        assert!(a.contains(&"--strict-mcp-config".into()));
    }
    #[test]
    fn session_id_cannot_be_a_transcript_path() {
        let mut r = request();
        r.session_id = Some("C:/other/transcript".into());
        assert!(args(&r).is_err());
    }
}
