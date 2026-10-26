use crate::runs::{self, RunManager};
use serde::Serialize;
use std::{path::PathBuf, process::Stdio};
use tauri::State;
use tokio::io::AsyncWriteExt;

pub(crate) struct Installation {
    home: PathBuf,
    pub(crate) root: PathBuf,
    pub(crate) python: PathBuf,
    desktop: PathBuf,
}
pub(crate) fn agent_runtime() -> Option<(PathBuf, PathBuf)> {
    if let Some(root) = crate::components::location("hermes") {
        let python = [
            root.join(".venv/Scripts/python.exe"),
            root.join("venv/Scripts/python.exe"),
        ]
        .into_iter()
        .find(|path| path.is_file())?;
        return Some((root, python));
    }
    let legacy = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("hermes/hermes-agent");
    let root = if legacy.join("venv/Scripts/python.exe").is_file()
        || legacy.join(".venv/Scripts/python.exe").is_file()
    {
        legacy
    } else {
        crate::components::location("hermes")?
    };
    let python = [
        root.join("venv/Scripts/python.exe"),
        root.join(".venv/Scripts/python.exe"),
    ]
    .into_iter()
    .find(|p| p.is_file())?;
    Some((root, python))
}
pub(crate) fn installation() -> Option<Installation> {
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
    let home = local.join("hermes");
    let root = home.join("hermes-agent");
    let python = [
        root.join("venv/Scripts/python.exe"),
        root.join(".venv/Scripts/python.exe"),
    ]
    .into_iter()
    .find(|p| p.is_file())?;
    let desktop = [
        root.join("apps/desktop/release/win-unpacked/Hermes.exe"),
        local.join("Programs/hermes-desktop/Hermes.exe"),
        local.join("Programs/Hermes/Hermes.exe"),
    ]
    .into_iter()
    .find(|p| p.is_file())?;
    Some(Installation {
        home,
        root,
        python,
        desktop,
    })
}

#[tauri::command]
pub fn hermes_available() -> bool {
    installation().is_some()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesOpened {
    session_id: String,
    model_id: String,
}

#[tauri::command]
pub async fn open_in_hermes(
    manager: State<'_, RunManager>,
    run_id: String,
) -> Result<HermesOpened, String> {
    static OPEN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = OPEN_LOCK.lock().await;
    let installed = installation().ok_or("not-installed")?;
    // Resolve the current native target again; never accept a URL, model or credential from the UI.
    let info = runs::list_runs(manager.clone())
        .await?
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or("server-unavailable")?;
    let target = runs::run_connection(manager.clone(), run_id.clone())
        .await
        .map_err(|_| "server-unavailable")?;
    if !runs::chat_generation_current(&manager, &run_id, info.generation).await {
        return Err("server-changed".into());
    }
    let payload = serde_json::json!({"home": installed.home, "target": target});
    let mut command = tokio::process::Command::new(&installed.python);
    command
        .args(["-X", "utf8", "-c", include_str!("hermes_bridge.py")])
        .current_dir(&installed.root)
        .env("HERMES_HOME", &installed.home)
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "configuration-failed")?;
    child
        .stdin
        .take()
        .ok_or("configuration-failed")?
        .write_all(payload.to_string().as_bytes())
        .await
        .map_err(|_| "configuration-failed")?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(45), child.wait_with_output())
        .await
        .map_err(|_| "configuration-failed")?
        .map_err(|_| "configuration-failed")?;
    if !result.status.success() {
        return Err("configuration-failed".into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&result.stdout).map_err(|_| "configuration-failed")?;
    let session_id = value["sessionId"]
        .as_str()
        .filter(|s| s.len() == 32 && s.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or("configuration-failed")?
        .to_owned();
    if !runs::chat_generation_current(&manager, &run_id, info.generation).await {
        return Err("server-changed".into());
    }
    let mut open = std::process::Command::new(&installed.desktop);
    open.arg(format!("hermes://open/{session_id}"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        open.creation_flags(0x08000000);
    }
    open.spawn().map_err(|_| "launch-failed")?;
    Ok(HermesOpened {
        session_id,
        model_id: target.model_id,
    })
}
