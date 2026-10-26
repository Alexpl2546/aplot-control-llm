use crate::db::{record_event, DbState};
use serde::{Deserialize, Serialize};
use std::{
    process::Stdio,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
    time::{timeout, Duration},
};
use uuid::Uuid;

#[derive(Clone)]
pub struct ProcessState(pub std::sync::Arc<Mutex<ProcessRegistry>>);
impl Default for ProcessState {
    fn default() -> Self {
        Self(std::sync::Arc::new(Mutex::new(ProcessRegistry::default())))
    }
}
#[derive(Default)]
pub struct ProcessRegistry {
    pub run_id: Option<String>,
    pub current: Option<ManagedProcess>,
    pub generation: u64,
    pub last_exit_code: Option<i32>,
    pub last_error: Option<String>,
}
pub struct ManagedProcess {
    pub child: Child,
    // Own the complete runtime tree (Strata's Python server also spawns the
    // native engine). Closing the app or reaping a crashed parent closes this
    // job and releases GPU/CPU resources held by any surviving descendants.
    _job: crate::owned_job::OwnedJob,
    // A running Strata server holds a shared lease. The signed component
    // updater takes the exclusive lease and therefore cannot replace its files.
    _strata_operation_lease: Option<tokio::sync::OwnedRwLockReadGuard<()>>,
    pub started_at_ms: u64,
    pub backend: String,
    pub endpoint: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartServerRequest {
    pub binary_path: String,
    pub args: Vec<String>,
    pub endpoint: Option<String>,
    pub profile_id: Option<String>,
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub working_directory: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
}

/// Wildcard bind interfaces cannot be used as client destinations on Windows.
/// Keep the CLI host intact while using the matching loopback address for all
/// of the application's health, metrics, chat and Web UI requests.
pub(crate) fn connection_endpoint(value: &str) -> Result<String, String> {
    let mut endpoint = crate::domain::http::server_endpoint(value)?;
    match endpoint.host_str() {
        Some("0.0.0.0") => endpoint
            .set_host(Some("127.0.0.1"))
            .map_err(|_| "Invalid local engine host")?,
        Some("[::]") | Some("::") => endpoint
            .set_host(Some("[::1]"))
            .map_err(|_| "Invalid local engine host")?,
        _ => {}
    }
    Ok(endpoint.to_string().trim_end_matches('/').to_string())
}

fn ensure_bind_available(request: &StartServerRequest) -> Result<(), String> {
    let endpoint = crate::domain::http::server_endpoint(
        request
            .endpoint
            .as_deref()
            .unwrap_or("http://127.0.0.1:8080"),
    )?;
    let host = crate::engine_adapters::argument_value(&request.args, &["--host"])
        .unwrap_or_else(|| endpoint.host_str().unwrap_or("127.0.0.1"))
        .trim_matches(['[', ']']);
    let port = endpoint
        .port_or_known_default()
        .ok_or("Missing engine port")?;
    // This is only a preflight: a different process can still race the native
    // engine's actual bind. Fail before launching instead of momentarily using
    // an unrelated server's health/model API on an occupied port.
    std::net::TcpListener::bind((host, port))
        .map(drop)
        .map_err(|error| format!("Cannot start the engine on {host}:{port}: {error}"))
}

fn normalized_backend(backend: Option<&str>) -> Result<&'static str, String> {
    match backend.unwrap_or("llama-server") {
        "llama-server" | "llama.cpp" | "llama" => Ok("llama-server"),
        "strata" => Ok("strata"),
        unsupported => Err(format!("Unsupported server backend: {unsupported}")),
    }
}

#[derive(Debug, Serialize)]
pub struct StartServerResponse {
    pub pid: u32,
}
#[derive(Debug, Serialize, Clone)]
pub struct LogLine {
    pub id: String,
    pub timestamp: String,
    pub level: String,
    pub source: String,
    pub message: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn level(message: &str, _stderr: bool) -> String {
    let m = message.to_ascii_lowercase();
    if m.contains("error") || m.contains("failed") {
        "ERROR".into()
    } else if m.contains("warn") {
        "WARN".into()
    } else if m.contains("debug") {
        "DEBUG".into()
    } else {
        "INFO".into()
    }
}
fn state_event(app: Option<&AppHandle>, registry: &ProcessRegistry, value: &str) {
    if let Some(app) = app {
        if let Some(run_id) = registry.run_id.as_deref() {
            let _ = app.emit(
                "run://state",
                serde_json::json!({"runId":run_id,"generation":registry.generation,"state":value}),
            );
        } else {
            let _ = app.emit("llama://state", value);
        }
    }
}
fn control_log(
    app: Option<&AppHandle>,
    registry: &ProcessRegistry,
    message: impl Into<String>,
    severity: &str,
) {
    let line = LogLine {
        id: Uuid::new_v4().to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        level: severity.into(),
        source: "control".into(),
        message: message.into(),
    };
    if let Some(app) = app {
        if let Some(run_id) = registry.run_id.as_deref() {
            let _ = app.emit(
                "run://log",
                serde_json::json!({"runId":run_id,"generation":registry.generation,"line":line}),
            );
        } else {
            let _ = app.emit("llama://log", line);
        }
    }
}
pub(crate) async fn pump_scoped<R>(
    reader: R,
    app: Option<AppHandle>,
    source: &'static str,
    run_id: Option<String>,
    generation: u64,
    redactions: Vec<String>,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(mut message)) = lines.next_line().await {
        for secret in &redactions {
            message = message.replace(secret, "[redacted]");
        }
        let line = LogLine {
            id: Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            level: level(&message, source == "stderr"),
            source: source.into(),
            message,
        };
        if let Some(app) = app.as_ref() {
            if let Some(run_id) = run_id.as_deref() {
                let _ = app.emit(
                    "run://log",
                    serde_json::json!({"runId":run_id,"generation":generation,"line":line}),
                );
            } else {
                let _ = app.emit("llama://log", line);
            }
        }
    }
}

pub(crate) async fn terminate(child: &mut Child) -> Result<(), String> {
    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    let pid = child.id();
    #[cfg(windows)]
    if let Some(pid) = pid {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T"]);
        command.creation_flags(0x08000000);
        let _ = timeout(Duration::from_secs(1), command.kill_on_drop(true).output()).await;
    }
    if matches!(
        timeout(Duration::from_secs(2), child.wait()).await,
        Ok(Ok(_))
    ) {
        return Ok(());
    }
    #[cfg(windows)]
    if let Some(pid) = pid {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        command.creation_flags(0x08000000);
        let _ = timeout(Duration::from_secs(2), command.kill_on_drop(true).output()).await;
    }
    let _ = child.start_kill();
    match timeout(Duration::from_secs(5), child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(format!("Failed to wait for server exit: {error}")),
        Err(_) => Err("Server did not exit within the shutdown timeout".into()),
    }
}

pub(crate) async fn stop_inner(
    app: Option<&AppHandle>,
    state: &ProcessState,
) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    guard.generation = guard.generation.wrapping_add(1);
    if let Some(mut managed) = guard.current.take() {
        state_event(app, &guard, "stopping");
        let pid = managed.child.id();
        control_log(
            app,
            &guard,
            format!(
                "Stopping managed {}{}",
                managed.backend,
                pid.map(|x| format!(" (PID {x})")).unwrap_or_default()
            ),
            "INFO",
        );
        if let Err(error) = terminate(&mut managed.child).await {
            guard.current = Some(managed);
            return Err(error);
        }
        let exit = managed
            .child
            .try_wait()
            .ok()
            .flatten()
            .and_then(|s| s.code());
        guard.last_exit_code = exit;
        state_event(app, &guard, "stopped");
        control_log(app, &guard, "Server stopped", "INFO");
    }
    guard.last_error = None;
    guard.last_exit_code = None;
    Ok(())
}

pub async fn stop_managed(app: &AppHandle, state: &ProcessState) -> Result<(), String> {
    stop_inner(Some(app), state).await
}

pub(crate) async fn start_inner(
    app: Option<&AppHandle>,
    state: &ProcessState,
    mut request: StartServerRequest,
) -> Result<StartServerResponse, String> {
    // Validate the IPC-provided backend before taking a process lock or doing
    // any spawn, environment, event, or state work.
    let backend = normalized_backend(request.backend.as_deref())?;
    let strata_operation_lease = if backend == "strata" {
        app.map(|app| {
            app.state::<crate::strata_engine_update::StrataEngineOperationLock>()
                .try_serve()
        })
        .transpose()?
    } else {
        None
    };
    if backend != "strata" {
        if let Some(pair) = request
            .args
            .windows(2)
            .find(|pair| pair[0] == "--model" || pair[0] == "-m")
        {
            crate::models::validate_generation_model(&pair[1])?;
        }
    }
    let mut guard = state.0.lock().await;
    if let Some(existing) = guard.current.as_mut() {
        if existing
            .child
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Err(format!(
                "A managed {} process is already running",
                existing.backend
            ));
        }
    }
    // A crashed wrapper may still have descendants. Close its ownership job
    // before testing or reusing the previous port.
    guard.current.take();
    request.endpoint = Some(connection_endpoint(
        request
            .endpoint
            .as_deref()
            .unwrap_or("http://127.0.0.1:8080"),
    )?);
    ensure_bind_available(&request)?;
    let mut command = Command::new(&request.binary_path);
    command
        .args(&request.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(directory) = request.working_directory.as_deref() {
        command.current_dir(directory);
    }
    if backend == "strata" {
        if let Some(root) = request.working_directory.as_deref() {
            command
                .env("STRATA_CONTROL_INSTALL", "1")
                .env("STRATA_INSTALL_DIR", root)
                .env(
                    "STRATA_COMPONENTS_DIR",
                    std::path::Path::new(root).join("components"),
                )
                .env("STRATA_REQUIRE_SIGNED_COMPONENTS", "1")
                .env("STRATA_NO_ACQUIRE", "1")
                .env_remove("STRATA_ALLOW_UNPINNED");
        }
        match request.api_key.as_deref().filter(|key| !key.is_empty()) {
            Some(api_key) => {
                command.env("STRATA_API_KEY", api_key);
            }
            None => {
                command.env_remove("STRATA_API_KEY");
            }
        }
    } else {
        match request.api_key.as_deref() {
            Some("") => {
                command.env_remove("LLAMA_API_KEY");
            }
            Some(api_key) => {
                command.env("LLAMA_API_KEY", api_key);
            }
            None => {}
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start {backend}: {e}"))?;
    let job = match crate::owned_job::OwnedJob::assign(&child) {
        Ok(job) => job,
        Err(error) => {
            let cleanup = terminate(&mut child).await;
            return Err(match cleanup {
                Ok(()) => format!("Cannot supervise the {backend} process tree: {error}"),
                Err(cleanup) => format!(
                    "Cannot supervise the {backend} process tree: {error}; cleanup failed: {cleanup}"
                ),
            });
        }
    };
    let pid = child
        .id()
        .ok_or_else(|| "Process started without PID".to_string())?;
    let generation = guard.generation.wrapping_add(1);
    let mut redactions: Vec<String> = request
        .api_key
        .iter()
        .filter(|key| !key.is_empty())
        .cloned()
        .collect();
    for (index, arg) in request.args.iter().enumerate() {
        if let Some((key, value)) = arg.split_once('=') {
            if crate::domain::secrets::is_secret_field(key.trim_start_matches('-'))
                && !value.is_empty()
            {
                redactions.push(value.to_string());
            }
        } else if arg.starts_with('-')
            && crate::domain::secrets::is_secret_field(arg.trim_start_matches('-'))
        {
            if let Some(value) = request
                .args
                .get(index + 1)
                .filter(|value| !value.is_empty())
            {
                redactions.push(value.clone());
            }
        }
    }
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(pump_scoped(
            stdout,
            app.cloned(),
            "stdout",
            guard.run_id.clone(),
            generation,
            redactions.clone(),
        ));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(pump_scoped(
            stderr,
            app.cloned(),
            "stderr",
            guard.run_id.clone(),
            generation,
            redactions,
        ));
    }
    guard.last_error = None;
    guard.last_exit_code = None;
    let backend = backend.to_string();
    guard.generation = guard.generation.wrapping_add(1);
    guard.current = Some(ManagedProcess {
        endpoint: request
            .endpoint
            .clone()
            .unwrap_or_else(|| "http://127.0.0.1:8080".into()),
        child,
        _job: job,
        _strata_operation_lease: strata_operation_lease,
        started_at_ms: now_ms(),
        backend: backend.clone(),
    });
    state_event(app, &guard, "starting");
    let endpoint = request
        .endpoint
        .as_deref()
        .unwrap_or("http://127.0.0.1:8080");
    let profile = request
        .profile_id
        .as_deref()
        .map(|id| format!(" using profile {id}"))
        .unwrap_or_default();
    control_log(
        app,
        &guard,
        format!("Started {backend} (PID {pid}) at {endpoint}{profile}"),
        "INFO",
    );
    Ok(StartServerResponse { pid })
}

#[tauri::command]
pub async fn start_server(
    app: AppHandle,
    state: State<'_, ProcessState>,
    db: State<'_, DbState>,
    request: StartServerRequest,
) -> Result<StartServerResponse, String> {
    normalized_backend(request.backend.as_deref())?;
    let r = start_inner(Some(&app), &state, request).await;
    record_event(
        &db,
        "server_start",
        r.as_ref().ok().map(|x| serde_json::json!({"pid":x.pid})),
    )
    .await;
    r
}

#[tauri::command]
pub async fn start_strata_server(
    app: AppHandle,
    state: State<'_, ProcessState>,
    db: State<'_, DbState>,
    request: crate::strata::StartStrataServerRequest,
) -> Result<StartServerResponse, String> {
    let request = crate::strata::build_start_request(request)?;
    let result = start_inner(Some(&app), &state, request).await;
    record_event(
        &db,
        "server_start",
        result
            .as_ref()
            .ok()
            .map(|value| serde_json::json!({"pid": value.pid, "backend": "strata"})),
    )
    .await;
    result
}
#[tauri::command]
pub async fn stop_server(
    app: AppHandle,
    state: State<'_, ProcessState>,
    db: State<'_, DbState>,
) -> Result<(), String> {
    let r = stop_managed(&app, &state).await;
    record_event(&db, "server_stop", None).await;
    r
}
#[tauri::command]
pub async fn restart_server(
    app: AppHandle,
    state: State<'_, ProcessState>,
    db: State<'_, DbState>,
    request: StartServerRequest,
) -> Result<StartServerResponse, String> {
    normalized_backend(request.backend.as_deref())?;
    let _ = app.emit("llama://state", "restarting");
    stop_managed(&app, &state).await?;
    let r = start_inner(Some(&app), &state, request).await;
    record_event(
        &db,
        "server_restart",
        r.as_ref().ok().map(|x| serde_json::json!({"pid":x.pid})),
    )
    .await;
    r
}

#[tauri::command]
pub async fn restart_strata_server(
    app: AppHandle,
    state: State<'_, ProcessState>,
    db: State<'_, DbState>,
    request: crate::strata::StartStrataServerRequest,
) -> Result<StartServerResponse, String> {
    let request = crate::strata::build_start_request(request)?;
    let _ = app.emit("llama://state", "restarting");
    stop_managed(&app, &state).await?;
    let result = start_inner(Some(&app), &state, request).await;
    record_event(
        &db,
        "server_restart",
        result
            .as_ref()
            .ok()
            .map(|value| serde_json::json!({"pid": value.pid, "backend": "strata"})),
    )
    .await;
    result
}
#[tauri::command]
pub async fn process_pid(state: State<'_, ProcessState>) -> Result<Option<u32>, String> {
    let mut g = state.0.lock().await;
    if let Some(p) = g.current.as_mut() {
        if p.child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok(p.child.id());
        }
    }
    Ok(None)
}

#[cfg(test)]
mod log_tests {
    use super::{level, normalized_backend, start_inner, ProcessState, StartServerRequest};
    #[test]
    fn stderr_is_not_a_warning_by_itself() {
        assert_eq!(level("llama server: model loaded", true), "INFO");
        assert_eq!(level("level=DEBUG checking request", true), "DEBUG");
        assert_eq!(level("warning: not enough GPU memory", true), "WARN");
        assert_eq!(level("error: model loading failed", true), "ERROR");
    }

    #[test]
    fn normalizes_only_supported_server_backends() {
        assert_eq!(normalized_backend(None).unwrap(), "llama-server");
        assert_eq!(
            normalized_backend(Some("llama-server")).unwrap(),
            "llama-server"
        );
        assert_eq!(
            normalized_backend(Some("llama.cpp")).unwrap(),
            "llama-server"
        );
        assert_eq!(normalized_backend(Some("llama")).unwrap(), "llama-server");
        assert_eq!(normalized_backend(Some("strata")).unwrap(), "strata");
        assert!(normalized_backend(Some("ollama")).is_err());
        assert!(normalized_backend(Some("qwfnfer")).is_err());
        assert!(normalized_backend(Some("infernix")).is_err());
    }

    #[test]
    fn wildcard_bind_addresses_use_loopback_for_local_api_requests() {
        assert_eq!(
            super::connection_endpoint("http://0.0.0.0:8133").unwrap(),
            "http://127.0.0.1:8133"
        );
        assert_eq!(
            super::connection_endpoint("http://[::]:8133").unwrap(),
            "http://[::1]:8133"
        );
        assert_eq!(
            super::connection_endpoint("http://192.168.1.23:8133").unwrap(),
            "http://192.168.1.23:8133"
        );
        assert!(super::connection_endpoint("http://localhost:8133/v1").is_err());
    }

    #[tokio::test]
    async fn occupied_external_port_is_rejected_before_spawn() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = ProcessState::default();
        let result = start_inner(
            None,
            &state,
            StartServerRequest {
                binary_path: "__this_process_must_not_be_spawned__".into(),
                args: vec![
                    "--host".into(),
                    "127.0.0.1".into(),
                    "--port".into(),
                    port.to_string(),
                ],
                endpoint: Some(format!("http://127.0.0.1:{port}")),
                profile_id: None,
                backend: Some("strata".into()),
                working_directory: None,
                api_key: None,
            },
        )
        .await;
        assert!(result.unwrap_err().contains("Cannot start the engine on"));
        let registry = state.0.lock().await;
        assert!(registry.current.is_none());
        assert_eq!(registry.generation, 0);
        // The unrelated listener remains owned and usable by its caller.
        assert_eq!(listener.local_addr().unwrap().port(), port);
    }

    #[cfg(windows)]
    async fn managed_tree() -> (ProcessState, sysinfo::Pid, sysinfo::Pid) {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let state = ProcessState::default();
        let launched = start_inner(
            None,
            &state,
            StartServerRequest {
                binary_path: "cmd.exe".into(),
                args: vec![
                    "/C".into(),
                    "ping".into(),
                    "-n".into(),
                    "30".into(),
                    "127.0.0.1".into(),
                ],
                endpoint: Some(format!("http://127.0.0.1:{port}")),
                profile_id: None,
                backend: Some("strata".into()),
                working_directory: None,
                api_key: None,
            },
        )
        .await
        .unwrap();
        let parent = sysinfo::Pid::from_u32(launched.pid);
        let descendant = tokio::time::timeout(super::Duration::from_secs(5), async {
            loop {
                let mut system = sysinfo::System::new();
                system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
                if let Some((&pid, _)) = system
                    .processes()
                    .iter()
                    .find(|(_, process)| process.parent() == Some(parent))
                {
                    break pid;
                }
                tokio::time::sleep(super::Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap();
        (state, parent, descendant)
    }

    #[cfg(windows)]
    async fn tree_has_exited(pids: &[sysinfo::Pid]) {
        tokio::time::timeout(super::Duration::from_secs(5), async {
            loop {
                let mut system = sysinfo::System::new();
                system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
                if pids.iter().all(|pid| system.process(*pid).is_none()) {
                    return;
                }
                tokio::time::sleep(super::Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("managed process tree must not survive its owner");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn dropping_a_managed_runtime_reaps_its_native_descendants_and_preserves_peers() {
        let (a, parent_a, descendant_a) = managed_tree().await;
        let (b, parent_b, descendant_b) = managed_tree().await;
        drop(a);
        tree_has_exited(&[parent_a, descendant_a]).await;
        assert!(b
            .0
            .lock()
            .await
            .current
            .as_mut()
            .unwrap()
            .child
            .try_wait()
            .unwrap()
            .is_none());
        drop(b);
        tree_has_exited(&[parent_b, descendant_b]).await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn stopping_a_crashed_wrapper_also_reaps_its_native_descendants() {
        let (state, parent, descendant) = managed_tree().await;
        {
            let mut registry = state.0.lock().await;
            let process = registry.current.as_mut().unwrap();
            process.child.start_kill().unwrap();
            process.child.wait().await.unwrap();
        }
        super::stop_inner(None, &state).await.unwrap();
        tree_has_exited(&[parent, descendant]).await;
    }

    #[tokio::test]
    async fn retired_server_backend_is_rejected_before_spawn_or_state_changes() {
        for backend in ["ollama", "qwfnfer", "infernix", "unknown-engine"] {
            let state = ProcessState::default();
            let result = start_inner(
                None,
                &state,
                StartServerRequest {
                    binary_path: "__this_process_must_not_be_spawned__".into(),
                    args: Vec::new(),
                    endpoint: None,
                    profile_id: None,
                    backend: Some(backend.into()),
                    working_directory: None,
                    api_key: Some("private-key".into()),
                },
            )
            .await;
            assert!(result.unwrap_err().contains("Unsupported server backend"));
            let registry = state.0.lock().await;
            assert!(registry.current.is_none());
            assert_eq!(registry.generation, 0);
            assert!(registry.last_error.is_none());
            assert!(registry.last_exit_code.is_none());
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn shutdown_waits_for_the_process_and_its_child_to_exit() {
        use super::{terminate, Command, Duration, Stdio};
        let mut child = Command::new("cmd.exe")
            .args(["/C", "ping", "-n", "30", "127.0.0.1"])
            .creation_flags(0x08000000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = sysinfo::Pid::from_u32(child.id().unwrap());
        let mut system = sysinfo::System::new();
        let descendant = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
                if let Some((&pid, _)) = system
                    .processes()
                    .iter()
                    .find(|(_, p)| p.parent() == Some(pid))
                {
                    break pid;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        terminate(&mut child).await.unwrap();
        assert!(child.try_wait().unwrap().is_some());
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        assert!(system.process(descendant).is_none());
        // Repeated shutdown of the same exited process is harmless.
        terminate(&mut child).await.unwrap();
    }
}
