use crate::db::{record_event, DbState};
use serde::{Deserialize, Serialize};
use std::{
    process::Stdio,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
    time::{timeout, Duration},
};
use uuid::Uuid;

pub struct ProcessState(pub Mutex<ProcessRegistry>);
impl Default for ProcessState {
    fn default() -> Self {
        Self(Mutex::new(ProcessRegistry::default()))
    }
}
#[derive(Default)]
pub struct ProcessRegistry {
    pub current: Option<ManagedProcess>,
    pub generation: u64,
    pub last_exit_code: Option<i32>,
    pub last_error: Option<String>,
}
pub struct ManagedProcess {
    pub child: Child,
    pub started_at_ms: u64,
    pub backend: String,
}

#[derive(Debug, Clone, Deserialize)]
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
    #[serde(default)]
    pub qwfn_mtp_gpu: Option<bool>,
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
fn control_log(app: &AppHandle, message: impl Into<String>, level: &str) {
    let _ = app.emit(
        "llama://log",
        LogLine {
            id: Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            level: level.into(),
            source: "control".into(),
            message: message.into(),
        },
    );
}
pub(crate) async fn pump<R>(reader: R, app: AppHandle, source: &'static str)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(message)) = lines.next_line().await {
        let _ = app.emit(
            "llama://log",
            LogLine {
                id: Uuid::new_v4().to_string(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                level: level(&message, source == "stderr"),
                source: source.into(),
                message,
            },
        );
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

async fn stop_inner(app: &AppHandle, state: &ProcessState) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    guard.generation = guard.generation.wrapping_add(1);
    if let Some(mut managed) = guard.current.take() {
        let _ = app.emit("llama://state", "stopping");
        let pid = managed.child.id();
        control_log(
            app,
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
        let _ = app.emit("llama://state", "stopped");
        control_log(app, "Server stopped", "INFO");
    }
    guard.last_error = None;
    guard.last_exit_code = None;
    Ok(())
}

pub async fn stop_managed(app: &AppHandle, state: &ProcessState) -> Result<(), String> {
    stop_inner(app, state).await
}

async fn start_inner(
    app: &AppHandle,
    state: &ProcessState,
    request: StartServerRequest,
) -> Result<StartServerResponse, String> {
    if request.backend.as_deref() != Some("strata") {
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
            return Err("A managed llama-server process is already running".into());
        }
    }
    let mut command = Command::new(&request.binary_path);
    command
        .args(&request.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(directory) = request.working_directory.as_deref() {
        command.current_dir(directory);
    }
    if request.backend.as_deref() == Some("qwfnfer") {
        if request.qwfn_mtp_gpu.unwrap_or(false) {
            command.env("QWFN_MTP_EXPERTS_VRAM", "1");
        } else {
            command.env_remove("QWFN_MTP_EXPERTS_VRAM");
        }
        match request.api_key.as_deref().filter(|key| !key.is_empty()) {
            Some(key) => {
                command.env("QWFN_API_KEY", key);
            }
            None => {
                command.env_remove("QWFN_API_KEY");
            }
        }
    } else if request.backend.as_deref() == Some("strata") {
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
        .map_err(|e| format!("Failed to start llama-server: {e}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "Process started without PID".to_string())?;
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(pump(stdout, app.clone(), "stdout"));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(pump(stderr, app.clone(), "stderr"));
    }
    guard.last_error = None;
    guard.last_exit_code = None;
    let backend = request.backend.unwrap_or_else(|| "llama-server".into());
    guard.generation = guard.generation.wrapping_add(1);
    guard.current = Some(ManagedProcess {
        child,
        started_at_ms: now_ms(),
        backend: backend.clone(),
    });
    let _ = app.emit("llama://state", "starting");
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
    let r = start_inner(&app, &state, request).await;
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
    let result = start_inner(&app, &state, request).await;
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
    let _ = app.emit("llama://state", "restarting");
    stop_managed(&app, &state).await?;
    let r = start_inner(&app, &state, request).await;
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
    let result = start_inner(&app, &state, request).await;
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

#[tauri::command]
pub async fn start_qwfn_server(
    app: AppHandle,
    state: State<'_, ProcessState>,
    db: State<'_, DbState>,
    settings: crate::qwfnfer::QwfnSettings,
) -> Result<StartServerResponse, String> {
    let request = crate::qwfnfer::build_start_request(settings)?;
    let result = start_inner(&app, &state, request).await;
    record_event(
        &db,
        "server_start",
        result
            .as_ref()
            .ok()
            .map(|v| serde_json::json!({"pid":v.pid,"backend":"qwfnfer"})),
    )
    .await;
    result
}
#[tauri::command]
pub async fn restart_qwfn_server(
    app: AppHandle,
    state: State<'_, ProcessState>,
    db: State<'_, DbState>,
    settings: crate::qwfnfer::QwfnSettings,
) -> Result<StartServerResponse, String> {
    let request = crate::qwfnfer::build_start_request(settings)?;
    stop_managed(&app, &state).await?;
    let result = start_inner(&app, &state, request).await;
    record_event(
        &db,
        "server_restart",
        result
            .as_ref()
            .ok()
            .map(|v| serde_json::json!({"pid":v.pid,"backend":"qwfnfer"})),
    )
    .await;
    result
}

#[cfg(test)]
mod log_tests {
    use super::level;
    #[test]
    fn stderr_is_not_a_warning_by_itself() {
        assert_eq!(level("llama server: model loaded", true), "INFO");
        assert_eq!(level("level=DEBUG checking request", true), "DEBUG");
        assert_eq!(level("warning: not enough GPU memory", true), "WARN");
        assert_eq!(level("error: model loading failed", true), "ERROR");
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
