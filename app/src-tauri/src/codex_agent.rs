//! Owned Codex app-server broker. No terminal scraping and no shared Desktop auth home.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
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

static NEXT_RPC_ID: AtomicU64 = AtomicU64::new(1);
/// Each spawned app-server gets a new generation. Host-owned approvals are bound
/// to it and never answered on a restarted worker.
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
type Reply = oneshot::Sender<Result<Value, String>>;
struct Worker {
    job: crate::owned_job::OwnedJob,
    input: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, Reply>>,
    approvals: Mutex<HashMap<String, Value>>,
    dead: std::sync::atomic::AtomicBool,
    retiring: std::sync::atomic::AtomicBool,
    token_hash: Vec<u8>,
    connection_id: String,
    active: Mutex<HashSet<String>>,
    loaded: Mutex<HashSet<String>>,
    generation: u64,
}
#[derive(Default)]
pub struct CodexManager {
    workers: Mutex<HashMap<String, Arc<Worker>>>,
}
fn candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for root in std::env::split_paths(&path) {
            paths.push(root.join("codex.exe"));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let root = PathBuf::from(local).join("OpenAI/Codex/bin");
        if let Ok(entries) = std::fs::read_dir(root) {
            let mut dirs: Vec<_> = entries.flatten().collect();
            dirs.sort_by_key(|e| std::cmp::Reverse(e.metadata().and_then(|m| m.modified()).ok()));
            for dir in dirs {
                paths.push(dir.path().join("codex.exe"));
            }
        }
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let root = PathBuf::from(appdata).join("npm/node_modules/@openai");
        for package in ["codex", "codex-win32-x64", "codex-win32-arm64"] {
            for target in ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"] {
                paths.push(
                    root.join(package)
                        .join("vendor")
                        .join(target)
                        .join("codex/codex.exe"),
                );
            }
        }
    }
    paths
}
pub(crate) fn discovered_executable() -> Option<PathBuf> {
    candidates().into_iter().find(|p| p.is_file())
}
pub(crate) fn configured(app: &AppHandle) -> Result<PathBuf, String> {
    let config = crate::db::connection_data_dir(app)?.join("codex-executable.txt");
    if let Ok(p) = std::fs::read_to_string(config) {
        let path = PathBuf::from(p.trim());
        if path.is_file()
            && path
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("exe"))
        {
            return Ok(path);
        }
    }
    if let Some(component) = crate::components::managed_locations()
        .into_iter()
        .find(|c| c.id == "codex")
    {
        return Ok(PathBuf::from(component.path));
    }
    candidates()
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| "not-installed".into())
}
#[tauri::command]
pub fn codex_available(app: AppHandle) -> Value {
    match configured(&app) {
        Ok(p) => json!({"installed":true,"path":p}),
        Err(_) => json!({"installed":false}),
    }
}
#[tauri::command]
pub async fn codex_set_executable(
    app: AppHandle,
    state: State<'_, CodexManager>,
    path: String,
) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !p.is_absolute()
        || !p.is_file()
        || !p.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe"))
    {
        return Err("executable".into());
    }
    // Changing an executable requires closing the explicitly owned runtime first.
    state.shutdown().await;
    app.state::<crate::codex_limits::CodexLimits>()
        .shutdown()
        .await;
    let root = crate::db::connection_data_dir(&app)?;
    std::fs::create_dir_all(&root).map_err(|_| "storage")?;
    std::fs::write(
        root.join("codex-executable.txt"),
        p.to_string_lossy().as_bytes(),
    )
    .map_err(|_| "storage".into())
}
impl Worker {
    async fn write(&self, value: Value) -> Result<(), String> {
        if self.dead.load(Ordering::Acquire) {
            return Err("closed".into());
        }
        let mut bytes = serde_json::to_vec(&value).map_err(|_| "protocol")?;
        bytes.push(b'\n');
        self.input
            .lock()
            .await
            .write_all(&bytes)
            .await
            .map_err(|_| "closed".into())
    }
    async fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = NEXT_RPC_ID.fetch_add(1, Ordering::Relaxed);
        let (send, receive) = oneshot::channel();
        self.pending.lock().await.insert(id, send);
        if let Err(e) = self
            .write(json!({"id":id,"method":method,"params":params}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        let result = tokio::time::timeout(Duration::from_secs(90), receive).await;
        self.pending.lock().await.remove(&id);
        result.map_err(|_| "timeout")?.map_err(|_| "closed")?
    }
}
impl CodexManager {
    pub async fn shutdown(&self) {
        let workers = std::mem::take(&mut *self.workers.lock().await);
        for worker in workers.into_values() {
            Self::close(worker).await;
        }
    }
    pub async fn shutdown_connection(&self, id: &str) {
        let worker = self.workers.lock().await.remove(id);
        if let Some(w) = worker {
            Self::close(w).await;
        }
    }
    async fn close(worker: Arc<Worker>) {
        worker.dead.store(true, Ordering::Release);
        worker.job.terminate();
        let _ = worker.child.lock().await.kill().await;
        for (_, send) in worker.pending.lock().await.drain() {
            let _ = send.send(Err("closed".into()));
        }
    }
    async fn ensure(
        &self,
        app: &AppHandle,
        expected: Option<&str>,
        inference: bool,
    ) -> Result<Arc<Worker>, String> {
        let plan = crate::openai_connection::plan_session(app, expected).await?;
        let mut slot = self.workers.lock().await;
        let token_hash = Sha256::digest(plan.token.as_bytes()).to_vec();
        if let Some(w) = slot
            .get(&plan.connection_id)
            .filter(|w| !w.dead.load(Ordering::Acquire))
        {
            if w.connection_id == plan.connection_id && w.token_hash == token_hash {
                return Ok(w.clone());
            }
            if !w.active.lock().await.is_empty() && w.connection_id == plan.connection_id {
                if inference {
                    return Err("renewal-busy".into());
                }
                return Ok(w.clone());
            }
            w.retiring.store(true, Ordering::Release);
            w.job.terminate();
            let _ = w.child.lock().await.kill().await;
        }
        let executable = configured(app)?;
        let profile =
            crate::connection_profiles::for_connection(app, "openai", Some(&plan.connection_id))?;
        let home = if profile.id == "legacy-openai" {
            crate::db::connection_data_dir(app)?.join("codex-home")
        } else {
            crate::connection_profiles::home(app, &profile)?.join("codex-home")
        };
        std::fs::create_dir_all(&home).map_err(|_| "storage")?;
        let mut command = Command::new(executable);
        command
            .args([
                "app-server",
                "--listen",
                "stdio://",
                "-c",
                "analytics.enabled=false",
                "-c",
                "cli_auth_credentials_store=\"ephemeral\"",
                "-c",
                "features.prefer_mxc=true",
                "-c",
                "model_provider=\"openai_chatgpt_plan\"",
                "-c",
                "model_providers.openai_chatgpt_plan.name=\"ChatGPT plan\"",
                "-c",
                "model_providers.openai_chatgpt_plan.base_url=\"https://api.openai.com/v1\"",
                "-c",
                "model_providers.openai_chatgpt_plan.env_key=\"APLOT_OPENAI_ACCESS_TOKEN\"",
                "-c",
                "model_providers.openai_chatgpt_plan.wire_api=\"responses\"",
                "-c",
                "model_providers.openai_chatgpt_plan.requires_openai_auth=false",
                "-c",
                "model_providers.openai_chatgpt_plan.supports_websockets=false",
            ])
            .env("CODEX_HOME", &home)
            .env("APLOT_OPENAI_ACCESS_TOKEN", &plan.token)
            .env_remove("OPENAI_API_KEY")
            .env_remove("OPENAI_BASE_URL")
            .env_remove("CODEX_API_KEY")
            .env_remove("CODEX_ACCESS_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|_| "not-installed")?;
        let job = match crate::owned_job::OwnedJob::assign(&child) {
            Ok(j) => j,
            Err(e) => {
                let _ = child.kill().await;
                return Err(e);
            }
        };
        let input = child.stdin.take().ok_or("closed")?;
        let output = child.stdout.take().ok_or("closed")?;
        let worker = Arc::new(Worker {
            job,
            input: Mutex::new(input),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
            dead: std::sync::atomic::AtomicBool::new(false),
            retiring: std::sync::atomic::AtomicBool::new(false),
            token_hash,
            connection_id: plan.connection_id,
            active: Mutex::new(HashSet::new()),
            loaded: Mutex::new(HashSet::new()),
            generation: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
        });
        let reader = worker.clone();
        let app_events = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(output).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.len() > 16_000_000 {
                    break;
                }
                let Ok(mut value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                value["aplotConnectionId"] = json!(reader.connection_id);
                value["aplotGeneration"] = json!(reader.generation);
                if let Some(method) = value["method"].as_str() {
                    if method == "turn/started" {
                        if let Some(id) = value["params"]["threadId"].as_str() {
                            reader.active.lock().await.insert(id.into());
                        }
                    }
                    if method == "turn/completed" {
                        if let Some(id) = value["params"]["threadId"].as_str() {
                            reader.active.lock().await.remove(id);
                        }
                    }
                    if reader.retiring.load(Ordering::Acquire) {
                        continue;
                    }
                    if let Some(id) = value.get("id") {
                        if [
                            "item/commandExecution/requestApproval",
                            "item/fileChange/requestApproval",
                            "item/tool/requestUserInput",
                        ]
                        .contains(&method)
                        {
                            reader
                                .approvals
                                .lock()
                                .await
                                .insert(id.to_string(), value.clone());
                            if !crate::tasks::codex::route(&app_events, &value).await {
                                let _ = app_events.emit("codex://event", &value);
                            }
                        } else {
                            let _=reader.write(json!({"id":id,"error":{"code":-32601,"message":"Unsupported host request"}})).await;
                        }
                    } else if method.starts_with("item/")
                        || method.starts_with("turn/")
                        || method.starts_with("thread/")
                        || method.starts_with("account/")
                        || method.starts_with("windowsSandbox/")
                        || method == "error"
                    {
                        // Threads owned by host tasks are handled here and never reach the window.
                        if !crate::tasks::codex::route(&app_events, &value).await {
                            let _ = app_events.emit("codex://event", &value);
                        }
                    }
                } else if let Some(id) = value["id"].as_u64() {
                    if let Some(send) = reader.pending.lock().await.remove(&id) {
                        let result = if value.get("error").is_some() {
                            Err(value["error"]["message"]
                                .as_str()
                                .unwrap_or("Codex protocol error")
                                .chars()
                                .take(1000)
                                .collect())
                        } else {
                            Ok(value["result"].clone())
                        };
                        let _ = send.send(result);
                    }
                }
            }
            reader.dead.store(true, Ordering::Release);
            for (_, send) in reader.pending.lock().await.drain() {
                let _ = send.send(Err("closed".into()));
            }
            if !reader.retiring.load(Ordering::Acquire) {
                let closed = json!({"method":"aplot/closed","aplotConnectionId":reader.connection_id,"aplotGeneration":reader.generation});
                crate::tasks::codex::route(&app_events, &closed).await;
                let _ = app_events.emit("codex://event", &closed);
            }
        });
        if let Err(e)=worker.rpc("initialize",json!({"clientInfo":{"name":"aplot_control_llm","title":"Aplot Control LLM","version":env!("CARGO_PKG_VERSION")}})).await{let _=worker.child.lock().await.kill().await;return Err(e)}
        worker.write(json!({"method":"initialized"})).await?;
        slot.insert(worker.connection_id.clone(), worker.clone());
        Ok(worker)
    }
}
fn allowed(method: &str) -> bool {
    [
        "account/read",
        "account/rateLimits/read",
        "model/list",
        "thread/start",
        "thread/resume",
        "thread/read",
        "turn/start",
        "turn/interrupt",
        "skills/list",
        "windowsSandbox/setupStart",
    ]
    .contains(&method)
}
#[tauri::command]
pub async fn codex_rpc(
    app: AppHandle,
    state: State<'_, CodexManager>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    if !allowed(&method) {
        return Err("unsupported-method".into());
    }
    state
        .call(&app, &method, params)
        .await
        .map(|(value, _)| value)
}
impl CodexManager {
    /// Runs an allowed app-server method. Also returns the worker's connection
    /// and generation so host tasks can bind sessions and approvals to it.
    pub(crate) async fn call(
        &self,
        app: &AppHandle,
        method: &str,
        params: Value,
    ) -> Result<(Value, (String, u64)), String> {
        let state = self;
        let method = method.to_owned();
        let mut params = params;
        let expected = params
            .as_object_mut()
            .and_then(|p| p.remove("aplotConnectionId"))
            .and_then(|v| v.as_str().map(str::to_owned));
        let worker = if method == "turn/interrupt" {
            let slots = state.workers.lock().await;
            let w = if let Some(id) = &expected {
                slots.get(id).cloned()
            } else {
                let thread = params["threadId"].as_str().unwrap_or("");
                let mut found = None;
                for w in slots.values() {
                    if w.loaded.lock().await.contains(thread) {
                        found = Some(w.clone());
                        break;
                    }
                }
                found
            }
            .ok_or("closed")?;
            if expected.as_ref().is_some_and(|id| id != &w.connection_id) {
                return Err("changed".into());
            }
            w
        } else {
            state
                .ensure(app, expected.as_deref(), method == "turn/start")
                .await?
        };
        let owner = (worker.connection_id.clone(), worker.generation);
        if method == "account/read" {
            return Ok((
                json!({"account":{"type":"chatgpt","connectionId":worker.connection_id}}),
                owner,
            ));
        }
        if ["thread/start", "thread/resume"].contains(&method.as_str()) {
            params["modelProvider"] = json!("openai_chatgpt_plan");
        }
        if method == "turn/start" {
            let id = params["threadId"].as_str().ok_or("thread")?.to_owned();
            if !worker.loaded.lock().await.contains(&id) {
                worker
                    .rpc(
                        "thread/resume",
                        json!({"threadId":id,"modelProvider":"openai_chatgpt_plan"}),
                    )
                    .await?;
                worker.loaded.lock().await.insert(id.clone());
            }
            if !worker.active.lock().await.insert(id.clone()) {
                return Err("busy".into());
            }
            let result = worker.rpc(&method, params).await;
            // A timeout is ambiguous: keep the turn active until its native completion/close.
            if result.as_ref().err().is_some_and(|e| e != "timeout") {
                worker.active.lock().await.remove(&id);
            }
            return result.map(|value| (value, owner));
        }
        let result = worker.rpc(&method, params).await?;
        if ["thread/start", "thread/resume"].contains(&method.as_str()) {
            if let Some(id) = result["thread"]["id"].as_str() {
                worker.loaded.lock().await.insert(id.into());
            }
        }
        Ok((result, owner))
    }
    /// Answers a host-owned approval on the exact worker generation that asked.
    pub(crate) async fn respond_native(
        &self,
        connection_id: &str,
        generation: u64,
        native_id: &str,
        result: Value,
    ) -> Result<(), String> {
        let worker = self
            .live_worker(connection_id, generation)
            .await
            .ok_or("stale")?;
        let request = worker
            .approvals
            .lock()
            .await
            .remove(native_id)
            .ok_or("expired")?;
        worker
            .write(json!({"id":request["id"],"result":result}))
            .await
    }
    /// The worker still waits for this request in its protocol.
    pub(crate) async fn has_request(
        &self,
        connection_id: &str,
        generation: u64,
        native_id: &str,
    ) -> bool {
        match self.live_worker(connection_id, generation).await {
            Some(worker) => worker.approvals.lock().await.contains_key(native_id),
            None => false,
        }
    }
    async fn live_worker(&self, connection_id: &str, generation: u64) -> Option<Arc<Worker>> {
        self.workers
            .lock()
            .await
            .get(connection_id)
            .filter(|w| w.generation == generation && !w.dead.load(Ordering::Acquire))
            .cloned()
    }
}
#[tauri::command]
pub async fn codex_respond(
    state: State<'_, CodexManager>,
    request_id: String,
    result: Value,
) -> Result<(), String> {
    let slots = state.workers.lock().await;
    let mut found = None;
    for w in slots.values() {
        if w.approvals.lock().await.contains_key(&request_id) {
            found = Some(w.clone());
            break;
        }
    }
    let worker = found.ok_or("expired")?;
    drop(slots);
    let request = worker
        .approvals
        .lock()
        .await
        .remove(&request_id)
        .ok_or("expired")?;
    worker
        .write(json!({"id":request["id"],"result":result}))
        .await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rpc_allowlist() {
        assert!(allowed("turn/interrupt"));
        assert!(!allowed("command/exec"));
        assert!(!allowed("account/login/start"));
        assert!(!allowed("account/logout"));
        assert!(!allowed("config/value/write"));
        assert!(!allowed("account/rateLimitResetCredit/consume"));
    }
}
