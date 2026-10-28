//! Updates Aplot-owned components to the versions pinned in the bundled installer catalog.
//! The catalog ships with each Aplot release (URLs and SHA-256 reviewed together), so newer
//! component versions arrive with an application update and are installed by the same
//! Install-Components.ps1 that the setup wizard uses. External installations are never touched.
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::Mutex,
};

const CATALOG: &str = include_str!("../installer/components.json");
static UPDATING: Mutex<()> = Mutex::const_new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentUpdate {
    id: String,
    installed_version: Option<String>,
    available_version: String,
    update_available: bool,
    /// Known only when the component has a single download; Strata picks a GPU-specific build.
    download_bytes: Option<u64>,
    repository: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentUpdateState {
    reviewed_at: String,
    installer_available: bool,
    components: Vec<ComponentUpdate>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentUpdateResult {
    id: String,
    previous_version: Option<String>,
    version: String,
    path: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEvent {
    id: String,
    stage: String,
    title: String,
    percent: Option<f64>,
    downloaded: Option<u64>,
    total: Option<u64>,
}

fn catalog() -> Value {
    serde_json::from_str(CATALOG).unwrap_or(Value::Null)
}
fn catalog_item<'a>(catalog: &'a Value, id: &str) -> Option<&'a Value> {
    catalog["components"]
        .as_array()?
        .iter()
        .find(|item| item["id"] == id)
}
/// "b11723", "v0.1.50" and "2.1.292" compare by their numeric parts.
fn version_key(version: &str) -> Option<Vec<u64>> {
    let parts: Vec<u64> = version
        .trim_start_matches(|c: char| c.is_ascii_alphabetic())
        .split(['.', '-', '+'])
        .map_while(|part| part.parse().ok())
        .collect();
    (!parts.is_empty()).then_some(parts)
}
fn is_newer(available: &str, installed: &str) -> bool {
    match (version_key(available), version_key(installed)) {
        (Some(a), Some(b)) => a > b,
        _ => available != installed,
    }
}
/// The active Aplot-owned version. "existing" marks a reused external installation.
fn installed_version(id: &str) -> Option<String> {
    crate::components::managed_locations()
        .into_iter()
        .find(|item| item.id == id)
        .map(|item| item.version)
        .filter(|version| !version.is_empty() && version != "existing")
}
fn installer_dir(app: &AppHandle) -> Option<PathBuf> {
    let has_script = |dir: &PathBuf| dir.join("Install-Components.ps1").is_file();
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("installer"))
        .filter(has_script)
        .or_else(|| {
            cfg!(debug_assertions)
                .then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("installer"))
                .filter(has_script)
        })
}
fn state_for(catalog: &Value, installer_available: bool) -> ComponentUpdateState {
    let components = catalog["components"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item["id"].as_str()?.to_string();
                    let available = item["version"].as_str()?.to_string();
                    let installed = installed_version(&id);
                    let artifacts = item["artifacts"].as_object();
                    let download_bytes = artifacts
                        .filter(|map| map.len() == 1)
                        .and_then(|map| map.values().next()?["size"].as_u64())
                        .filter(|size| *size > 0);
                    Some(ComponentUpdate {
                        update_available: installed
                            .as_deref()
                            .is_some_and(|current| is_newer(&available, current)),
                        installed_version: installed,
                        available_version: available,
                        download_bytes,
                        repository: item["repository"].as_str().unwrap_or_default().into(),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    ComponentUpdateState {
        reviewed_at: catalog["reviewedAt"].as_str().unwrap_or_default().into(),
        installer_available,
        components,
    }
}

#[tauri::command]
pub async fn component_update_state(app: AppHandle) -> Result<ComponentUpdateState, String> {
    let available = installer_dir(&app).is_some();
    tauri::async_runtime::spawn_blocking(move || state_for(&catalog(), available))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_component(
    app: AppHandle,
    operations: State<'_, crate::strata_engine_update::StrataEngineOperationLock>,
    legacy: State<'_, crate::process::ProcessState>,
    runs: State<'_, crate::runs::RunManager>,
    id: String,
) -> Result<ComponentUpdateResult, String> {
    let _busy = UPDATING
        .try_lock()
        .map_err(|_| "component-maintenance-busy")?;
    let catalog = catalog();
    let item = catalog_item(&catalog, &id).ok_or("component-unknown")?;
    let version = item["version"].as_str().unwrap_or_default().to_string();
    let previous = installed_version(&id).ok_or("component-not-owned")?;
    if !is_newer(&version, &previous) {
        return Err("component-up-to-date".into());
    }
    let script = installer_dir(&app)
        .ok_or("component-installer-missing")?
        .join("Install-Components.ps1");
    let root = crate::components::store_root().ok_or("component-store-unavailable")?;
    // Strata's runtime files and shared Python must not change under a running server.
    let _strata_lease = if id == "strata" {
        crate::strata_engine_update::ensure_strata_stopped(legacy.inner(), runs.inner()).await?;
        Some(operations.try_update()?)
    } else {
        None
    };
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // Windows PowerShell 5.1, as in the NSIS installer. PSModulePath inherited from a
    // PowerShell 7 parent hides 5.1's built-in modules (Get-FileHash fails to load).
    let powershell = std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("powershell.exe"));
    let mut command = Command::new(powershell);
    command
        .env_remove("PSModulePath")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .args(["-Fresh", "-Components", &id, "-InstallRoot"])
        .arg(&root)
        .arg("-CacheRoot")
        .arg(&root)
        .arg("-AppPath")
        .arg(&exe)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|e| format!("component-installer-start: {e}"))?;
    let job = crate::owned_job::OwnedJob::assign(&child).inspect_err(|_| {
        let _ = child.start_kill();
    })?;
    let stdout = child.stdout.take().ok_or("installer output unavailable")?;
    let stderr = child.stderr.take().ok_or("installer output unavailable")?;
    let (app_events, event_id) = (app.clone(), id.clone());
    let stdout_task = tokio::spawn(async move {
        let mut tail = Vec::new();
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(json) = line.strip_prefix("APLOT_PROGRESS ") {
                if let Ok(value) = serde_json::from_str::<Value>(json) {
                    let _ = app_events.emit("components://update", progress_event(&event_id, &value));
                }
                continue;
            }
            tail.push(line);
            if tail.len() > 40 {
                tail.remove(0);
            }
        }
        tail
    });
    let stderr_task = tokio::spawn(async move {
        let mut text = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if text.len() < 16 * 1024 {
                text.push_str(&line);
                text.push('\n');
            }
        }
        text
    });
    let exit = child.wait().await.map_err(|e| e.to_string())?;
    drop(job);
    let tail = stdout_task.await.unwrap_or_default();
    let errors = stderr_task.await.unwrap_or_default();
    let outcome = std::fs::read_to_string(root.join("last-result.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            value["components"]
                .as_array()?
                .iter()
                .find(|entry| entry["id"] == id.as_str())
                .cloned()
        });
    let installed = outcome
        .as_ref()
        .filter(|entry| entry["status"] == "installed")
        .and_then(|entry| entry["path"].as_str().map(str::to_string));
    match installed {
        Some(path) if exit.success() => {
            let _ = app.emit(
                "components://update",
                UpdateEvent { id: id.clone(), stage: "complete".into(), title: String::new(), percent: Some(100.0), downloaded: None, total: None },
            );
            Ok(ComponentUpdateResult { id, previous_version: Some(previous), version, path })
        }
        _ => {
            let reason = outcome
                .as_ref()
                .and_then(|entry| entry["error"].as_str().map(str::to_string))
                .unwrap_or_default();
            Err(format!(
                "component-update-failed: {reason}\n{}\n{}",
                tail.join("\n"),
                errors.trim()
            )
            .trim()
            .to_string())
        }
    }
}

fn progress_event(id: &str, value: &Value) -> UpdateEvent {
    UpdateEvent {
        id: id.into(),
        stage: value["stage"].as_str().unwrap_or_default().into(),
        title: value["title"].as_str().unwrap_or_default().into(),
        percent: value["percent"].as_f64(),
        downloaded: value["downloaded"].as_f64().map(|n| n as u64),
        total: value["total"].as_f64().map(|n| n as u64).filter(|n| *n > 0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_release_tags_numerically() {
        assert!(is_newer("b11723", "b9800"));
        assert!(is_newer("0.1.50", "0.1.45"));
        assert!(is_newer("v2.1.292", "2.1.30"));
        assert!(!is_newer("0.1.45", "0.1.50"));
        assert!(!is_newer("0.22.2", "0.22.2"));
        assert!(is_newer("nightly", "stable"));
    }

    #[test]
    fn bundled_catalog_lists_every_removable_module() {
        let catalog = catalog();
        for id in ["llama_cpp", "strata", "hermes", "codex", "claude"] {
            let item = catalog_item(&catalog, id).expect(id);
            assert!(version_key(item["version"].as_str().unwrap()).is_some(), "{id}");
        }
    }

    #[test]
    fn reads_installer_progress_lines() {
        let value = serde_json::json!({"stage":"download","title":"Загружаем архив","percent":42.5,"downloaded":1024.0,"total":0});
        let event = progress_event("llama_cpp", &value);
        assert_eq!(event.percent, Some(42.5));
        assert_eq!(event.downloaded, Some(1024));
        assert_eq!(event.total, None);
    }
}
