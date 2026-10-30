use serde::Serialize;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock},
};

/// A single lease prevents Strata model preparation, a native server, and a
/// component update from changing the same runtime files at the same time.
#[derive(Default)]
pub struct StrataEngineOperationLock(Arc<RwLock<()>>);

impl StrataEngineOperationLock {
    pub(crate) fn try_prepare(&self) -> Result<OwnedRwLockWriteGuard<()>, String> {
        self.0
            .clone()
            .try_write_owned()
            .map_err(|_| "Stop Strata and wait for the current engine operation to finish before preparing a model".into())
    }

    pub(crate) fn try_serve(&self) -> Result<OwnedRwLockReadGuard<()>, String> {
        self.0.clone().try_read_owned().map_err(|_| {
            "A Strata engine update is in progress; wait for it to finish before starting Strata"
                .into()
        })
    }

    pub(crate) fn try_update(&self) -> Result<OwnedRwLockWriteGuard<()>, String> {
        self.0.clone().try_write_owned().map_err(|_| {
            "Stop Strata and wait for model preparation to finish before updating its engine".into()
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrataEngineUpdateResult {
    pub family: String,
    pub status: String,
    pub previous_version: Option<String>,
    pub current_version: Option<String>,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEvent {
    family: String,
    phase: String,
    percent: Option<u8>,
    message: String,
}

fn emit_event(app: &AppHandle, family: &str, phase: &str, percent: Option<u8>, message: &str) {
    let _ = app.emit(
        "strata://engine-update",
        UpdateEvent {
            family: family.to_string(),
            phase: phase.to_string(),
            percent,
            message: message.to_string(),
        },
    );
}

fn append_bounded(target: &mut String, line: &str) {
    target.push_str(line);
    target.push('\n');
    if target.len() > 64 * 1024 {
        let remove_before = target.len() - 48 * 1024;
        let boundary = target
            .char_indices()
            .find(|(index, _)| *index >= remove_before)
            .map(|(index, _)| index)
            .unwrap_or(0);
        target.drain(..boundary);
    }
}

fn python_path(root: &Path) -> PathBuf {
    root.join(".venv").join("Scripts").join("python.exe")
}

fn run_family(family: &str) -> Result<&'static str, String> {
    match family.trim().to_ascii_lowercase().as_str() {
        "qwen" => Ok("qwen"),
        "deepseek" => Ok("deepseek"),
        _ => Err("Choose the Qwen or DeepSeek Strata engine".into()),
    }
}

fn control_environment(command: &mut Command, root: &Path) {
    command
        .env("STRATA_CONTROL_INSTALL", "1")
        .env("STRATA_INSTALL_DIR", root)
        .env("STRATA_COMPONENTS_DIR", root.join("components"))
        .env("STRATA_REQUIRE_SIGNED_COMPONENTS", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .env_remove("STRATA_ALLOW_UNPINNED")
        .env_remove("STRATA_NO_ACQUIRE");
}

fn qwen_command(root: &Path, python: &Path) -> Result<Command, String> {
    let entry = root.join("strata.py");
    if !entry.is_file() {
        return Err("This Strata installation has no updater entry point (strata.py).".into());
    }
    let mut command = Command::new(python);
    command
        .arg("-B")
        .arg("-u")
        .arg(entry)
        .args([
            "update",
            "--no-control",
            "--output",
            "jsonl",
            "--components-dir",
        ])
        .arg(root.join("components"))
        .current_dir(root)
        .kill_on_drop(true);
    control_environment(&mut command, root);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    Ok(command)
}

const DEEPSEEK_UPDATE_SCRIPT: &str = r#"
import argparse, json, sys
from pathlib import Path
from strata_control import dsv41_engine, feed as feedmod, signing, updater
from strata_cli import update_cmd

root = Path(sys.argv[1]).resolve()
check = len(sys.argv) > 2 and sys.argv[2] == "check"
dest = root / "engine-dsv41"
def output(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)
def emit(message):
    output({"event":"phase", "phase":"deepseek", "message":str(message)[:1000]})

old = dsv41_engine.find(dest)
if old is None and check:
    output({"event":"result", "ok":True, "status":"notInstalled", "message":"DeepSeek engine is not installed yet."})
    raise SystemExit(0)
if old is None:
    # Strata fetches this engine only when a DeepSeek model is chosen; Aplot can install it on its own, then update it as usual.
    source = update_cmd._feed_source(argparse.Namespace(feed=None), root)
    if not dsv41_engine.source_reachable(source):
        output({"event":"result", "ok":False, "status":"failed", "message":"The signed Strata update feed is unavailable; the DeepSeek engine was not installed."})
        raise SystemExit(5)
    messages = []
    def collect(message):
        messages.append(str(message))
        emit(message)
    new = dsv41_engine.install(dest, source, emit=collect)
    if new is None:
        output({"event":"result", "ok":False, "status":"failed", "message":messages[-1] if messages else "The DeepSeek engine could not be installed."})
        raise SystemExit(6)
    after = new.parent.name.split("-", 1)[0]
    output({"event":"result", "ok":True, "status":"installed", "currentVersion":after, "currentExecutable":str(new),
            "message":messages[-1] if messages else "DeepSeek engine installed."})
    raise SystemExit(0)
before = old.parent.name.split("-", 1)[0]
serving = [] if check else updater.serving_now()
if serving:
    profiles = ", ".join(item.get("profile", "Strata") for item in serving)
    output({"event":"result", "ok":False, "status":"busy", "previousVersion":before,
            "currentVersion":before, "message":"Stop the running Strata engine before updating: " + profiles})
    raise SystemExit(7)
source = update_cmd._feed_source(argparse.Namespace(feed=None), root)
if not dsv41_engine.source_reachable(source):
    output({"event":"result", "ok":True, "status":"unavailable", "previousVersion":before,
            "currentVersion":before, "message":"The signed Strata update feed is unavailable; no files were changed."})
    raise SystemExit(0)
hardware = updater.detect_hardware()
work = dest.parent / (dsv41_engine.DIR + ".work")
ctx = updater.Context(components=work, source=source, trusted=signing.load_trusted_keys(),
                      hardware=hardware, cancel=None, emit=lambda event: None)
try:
    signed_feed = updater.open_feed(ctx, updater.State(work))
except (updater.UpdateError, feedmod.FeedError, signing.SignatureError, OSError) as error:
    detail = str(error)
    if "could not be read" in detail.lower() or "no internet" in detail.lower():
        output({"event":"result", "ok":True, "status":"unavailable", "previousVersion":before,
                "currentVersion":before, "message":"The signed Strata update feed is unavailable: " + detail})
        raise SystemExit(0)
    output({"event":"result", "ok":False, "status":"failed", "previousVersion":before,
            "currentVersion":before, "message":"The signed Strata update feed could not be verified: " + detail})
    raise SystemExit(5)
offered, reasons = feedmod.select_engine(list(signed_feed.dsv41), hardware)
if offered is None:
    note = "; ".join(reasons[:3]) if reasons else "no package for this computer"
    output({"event":"result", "ok":True, "status":"unavailable", "previousVersion":before,
            "currentVersion":before, "message":"No compatible DeepSeek engine is in the signed feed: " + note})
    raise SystemExit(0)
if check:
    newer = feedmod.version_key(offered.version) > feedmod.version_key(before)
    output({"event":"result", "ok":True, "status":"available" if newer else "upToDate", "previousVersion":before,
            "currentVersion":before, "offeredVersion":offered.version, "message":""})
    raise SystemExit(0)
if feedmod.version_key(offered.version) <= feedmod.version_key(before):
    output({"event":"result", "ok":True, "status":"upToDate", "previousVersion":before,
            "currentVersion":before, "message":"DeepSeek engine is up to date."})
    raise SystemExit(0)
messages = []
def collect(message):
    messages.append(str(message))
    emit(message)
new = dsv41_engine.upgrade(dest, source, installed=old, hardware=hardware, emit=collect)
current = dsv41_engine.find(dest)
after = current.parent.name.split("-", 1)[0] if current else None
if new is not None:
    output({"event":"result", "ok":True, "status":"updated", "previousVersion":before,
            "currentVersion":after, "previousExecutable":str(old), "currentExecutable":str(new),
            "message":messages[-1] if messages else "DeepSeek engine updated."})
elif after == before and not messages:
    output({"event":"result", "ok":True, "status":"unavailable", "previousVersion":before,
            "currentVersion":after,
            "message":"A newer package was in the signed feed but the updater did not switch engines; no files were changed."})
elif after == before and any("could not" in message.lower() or "failed" in message.lower() for message in messages):
    output({"event":"result", "ok":False, "status":"failed", "previousVersion":before,
            "currentVersion":after, "message":messages[-1], "previousExecutable":str(old)})
    raise SystemExit(6)
elif after == before and any("no package" in message.lower() or "no deepseek engine" in message.lower() for message in messages):
    output({"event":"result", "ok":True, "status":"unavailable", "previousVersion":before,
            "currentVersion":after, "message":messages[-1]})
else:
    output({"event":"result", "ok":False, "status":"failed", "previousVersion":before,
            "currentVersion":after or before,
            "message":messages[-1] if messages else "A newer signed DeepSeek package was offered but not installed; the previous engine remains in place."})
    raise SystemExit(6)
"#;

fn deepseek_command(root: &Path, python: &Path) -> Command {
    let mut command = Command::new(python);
    command
        .args(["-B", "-u", "-c", DEEPSEEK_UPDATE_SCRIPT])
        .arg(root)
        .current_dir(root)
        .kill_on_drop(true);
    control_environment(&mut command, root);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

async fn read_output(
    app: AppHandle,
    family: String,
    stream: impl tokio::io::AsyncRead + Unpin,
) -> (Option<Value>, String) {
    let mut lines = BufReader::new(stream).lines();
    let mut result = None;
    let mut tail = String::new();
    while let Ok(Some(line)) = lines.next_line().await {
        append_bounded(&mut tail, &line);
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let event = value
            .get("event")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if event == "result" || value.get("results").is_some() || value.get("ok").is_some() {
            result = Some(value.clone());
        }
        if matches!(event, "progress" | "phase" | "waiting") || value.get("message").is_some() {
            let phase = value.get("phase").and_then(Value::as_str).unwrap_or(event);
            let percent = value
                .get("percent")
                .and_then(Value::as_u64)
                .and_then(|number| u8::try_from(number).ok());
            let message = value
                .get("message")
                .or_else(|| value.get("label"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    if let Some(percent) = percent {
                        format!("{phase}: {percent}%")
                    } else {
                        phase.to_string()
                    }
                });
            emit_event(&app, &family, phase, percent, &message);
        }
    }
    (result, tail)
}

fn qwen_result(
    value: &Value,
    family: &str,
    root: &Path,
) -> Result<StrataEngineUpdateResult, String> {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("The signed Qwen engine update failed.");
        let normalized = message.to_ascii_lowercase();
        if [
            "could not be read",
            "no internet",
            "network",
            "connection timed out",
        ]
        .iter()
        .any(|needle| normalized.contains(needle))
        {
            return Ok(StrataEngineUpdateResult {
                family: family.into(),
                status: "unavailable".into(),
                previous_version: None,
                current_version: None,
                message: message.to_string(),
            });
        }
        return Err(message.to_string());
    }
    let engine = value
        .get("results")
        .and_then(Value::as_array)
        .and_then(|results| {
            results
                .iter()
                .find(|result| result.get("component").and_then(Value::as_str) == Some("engine"))
        });
    let Some(engine) = engine else {
        return Ok(StrataEngineUpdateResult {
            family: family.into(),
            status: "unavailable".into(),
            previous_version: None,
            current_version: None,
            message: "The signed update feed has no Qwen engine package for this computer.".into(),
        });
    };
    let status = engine
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("current");
    let previous_version = engine
        .pointer("/installed_before/version")
        .and_then(Value::as_str)
        .map(str::to_string);
    let current_version = engine
        .pointer("/installed_after/version")
        .or_else(|| engine.pointer("/installed/version"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let message = engine
        .get("note")
        .or_else(|| engine.get("error"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| match status {
            "updated" => "Signed Qwen engine update installed and tested.".into(),
            "current" => "Qwen engine is up to date.".into(),
            "install" => "Qwen engine installed and tested.".into(),
            _ => format!("Qwen engine update: {status}."),
        });
    let status = match status {
        "updated" | "install" => "updated",
        "current" => "upToDate",
        "not-in-feed" | "none-for-this-pc" | "wrong-make" => "unavailable",
        other => other,
    };
    if matches!(status, "updated" | "upToDate") {
        update_qwen_config_paths(root)?;
    }
    Ok(StrataEngineUpdateResult {
        family: family.into(),
        status: status.into(),
        previous_version,
        current_version,
        message,
    })
}

fn normalize_path(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn update_qwen_config_paths(root: &Path) -> Result<(), String> {
    let root_prefix = format!("{}\\engine\\", normalize_path(&root.to_string_lossy()));
    for entry in std::fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if !path.is_file() || !filename.starts_with("strata-") || !filename.ends_with(".json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(mut config) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if config.get("arch").and_then(Value::as_str) == Some("deepseek41") {
            continue;
        }
        let Some(exe) = config.get("exe").and_then(Value::as_str) else {
            continue;
        };
        if exe == "component:strata-engine" {
            continue;
        }
        let resolved = if Path::new(exe).is_absolute() {
            exe.to_string()
        } else {
            let cwd = config
                .get("cwd")
                .and_then(Value::as_str)
                .map(|value| {
                    let path = PathBuf::from(value);
                    if path.is_absolute() {
                        path
                    } else {
                        root.join(path)
                    }
                })
                .unwrap_or_else(|| root.to_path_buf());
            cwd.join(exe).to_string_lossy().into_owned()
        };
        let is_qwen_executable = Path::new(&resolved)
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("strata.exe"));
        if !is_qwen_executable || !normalize_path(&resolved).starts_with(&root_prefix) {
            continue;
        }
        config["exe"] = Value::String("component:strata-engine".into());
        let data = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
        crate::connection_profiles::atomic_write(&path, &data)?;
    }
    Ok(())
}

fn update_deepseek_config_paths(root: &Path, old_exe: &str, new_exe: &str) -> Result<(), String> {
    let old = normalize_path(old_exe);
    for entry in std::fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if !path.is_file() || !filename.starts_with("strata-") || !filename.ends_with(".json") {
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                return Err(format!(
                    "Cannot read Strata model configuration {}: {error}",
                    path.display()
                ))
            }
        };
        let Ok(mut config) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let Some(exe) = config.get("exe").and_then(Value::as_str) else {
            continue;
        };
        let resolved = if Path::new(exe).is_absolute() {
            exe.to_string()
        } else {
            let cwd = config
                .get("cwd")
                .and_then(Value::as_str)
                .map(|value| {
                    let path = PathBuf::from(value);
                    if path.is_absolute() {
                        path
                    } else {
                        root.join(path)
                    }
                })
                .unwrap_or_else(|| root.to_path_buf());
            cwd.join(exe).to_string_lossy().into_owned()
        };
        if normalize_path(&resolved) != old {
            continue;
        }
        config["exe"] = Value::String(new_exe.to_string());
        let data = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
        crate::connection_profiles::atomic_write(&path, &data)?;
    }
    Ok(())
}

fn deepseek_result(value: &Value, root: &Path) -> Result<StrataEngineUpdateResult, String> {
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The signed DeepSeek engine update failed.");
        return Err(message.to_string());
    }
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unavailable");
    if status == "updated" {
        let old = value
            .get("previousExecutable")
            .and_then(Value::as_str)
            .ok_or("The DeepSeek updater omitted its previous executable path")?;
        let new = value
            .get("currentExecutable")
            .and_then(Value::as_str)
            .ok_or("The DeepSeek updater omitted its new executable path")?;
        update_deepseek_config_paths(root, old, new)?;
    }
    Ok(StrataEngineUpdateResult {
        family: "deepseek".into(),
        status: status.into(),
        previous_version: value
            .get("previousVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
        current_version: value
            .get("currentVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
        message: value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("DeepSeek engine checked against the signed Strata feed.")
            .into(),
    })
}

async fn run_update(
    app: &AppHandle,
    family: &str,
    root: &Path,
) -> Result<StrataEngineUpdateResult, String> {
    let python = python_path(root);
    if !python.is_file() {
        return Err("The selected Strata installation has no prepared Python environment.".into());
    }
    let mut command = if family == "qwen" {
        qwen_command(root, &python)?
    } else {
        deepseek_command(root, &python)
    };
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start Strata's signed updater: {error}"))?;
    let job = crate::owned_job::OwnedJob::assign(&child).map_err(|error| {
        let _ = child.start_kill();
        error
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Strata updater output is unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Strata updater error output is unavailable")?;
    let family_owned = family.to_string();
    let app_stdout = app.clone();
    let stdout_task =
        tokio::spawn(async move { read_output(app_stdout, family_owned, stdout).await });
    let stderr_task = tokio::spawn(async move {
        let mut text = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            append_bounded(&mut text, &line);
        }
        text
    });
    emit_event(
        app,
        family,
        "starting",
        None,
        "Checking the signed Strata engine feed…",
    );
    let exit = child.wait().await.map_err(|error| error.to_string())?;
    drop(job);
    let (result, stdout_tail) = stdout_task.await.map_err(|error| error.to_string())?;
    let stderr_tail = stderr_task.await.map_err(|error| error.to_string())?;
    let result = result.ok_or_else(|| {
        let detail = if stderr_tail.trim().is_empty() {
            stdout_tail
        } else {
            stderr_tail.clone()
        };
        format!(
            "Strata updater returned no result{}",
            detail
                .lines()
                .last()
                .map(|line| format!(": {line}"))
                .unwrap_or_default()
        )
    })?;
    if !exit.success() && result.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = result
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| result.get("message").and_then(Value::as_str))
            .or_else(|| stderr_tail.lines().last())
            .unwrap_or("The signed Strata engine update failed.");
        return Err(message.to_string());
    }
    if family == "qwen" {
        qwen_result(&result, family, root)
    } else {
        deepseek_result(&result, root)
    }
}

#[tauri::command]
pub async fn update_strata_engine(
    app: AppHandle,
    operations: State<'_, StrataEngineOperationLock>,
    legacy: State<'_, crate::process::ProcessState>,
    runs: State<'_, crate::runs::RunManager>,
    root_path: String,
    family: String,
) -> Result<StrataEngineUpdateResult, String> {
    let family = run_family(&family)?;
    let root = crate::strata::root_path(&root_path)?;
    ensure_strata_stopped(legacy.inner(), runs.inner()).await?;
    let _update_lease = operations.try_update()?;
    emit_event(
        &app,
        family,
        "starting",
        None,
        "Preparing a signed engine update…",
    );
    let result = run_update(&app, family, &root).await?;
    emit_event(&app, family, "complete", Some(100), &result.message);
    Ok(result)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StrataEngineInfo {
    family: String,
    installed_version: Option<String>,
    path: Option<String>,
    available_version: Option<String>,
    update_available: bool,
    download_bytes: Option<u64>,
    /// The signed feed was read; without it only the installed version is known.
    checked: bool,
}

fn numeric_version(version: &str) -> Vec<u64> {
    version
        .split(['.', '-'])
        .map_while(|part| part.parse().ok())
        .collect()
}

/// The newest installed engine folder of one family, read from disk without starting Python.
fn installed_engine(root: &Path, family: &str) -> Option<(String, PathBuf)> {
    let (dir, marker) = if family == "qwen" {
        (
            root.join("components").join("engine"),
            "engine-component.json",
        )
    } else {
        (root.join("engine-dsv41"), "strata-dsv41.exe")
    };
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join(marker).is_file())
        .filter_map(|path| {
            let name = path.file_name()?.to_string_lossy().into_owned();
            let version = if family == "qwen" {
                std::fs::read_to_string(path.join(marker))
                    .ok()
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    .and_then(|value| value["version"].as_str().map(str::to_string))
                    .unwrap_or_else(|| name.split('-').next().unwrap_or_default().to_string())
            } else {
                name.split('-').next().unwrap_or_default().to_string()
            };
            Some((version, path))
        })
        .max_by_key(|(version, _)| numeric_version(version))
}

/// The last JSON object a read-only feed check prints.
async fn check_output(mut command: Command) -> Option<Value> {
    command.stdin(std::process::Stdio::null());
    let output = tokio::time::timeout(std::time::Duration::from_secs(90), command.output())
        .await
        .ok()?
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
}

async fn engine_info(root: &Path, family: &str, check: bool) -> StrataEngineInfo {
    let installed = installed_engine(root, family);
    let mut info = StrataEngineInfo {
        family: family.into(),
        installed_version: installed.as_ref().map(|(version, _)| version.clone()),
        // Canonical roots carry the verbatim \\?\ prefix, which means nothing to a person.
        path: installed.as_ref().map(|(_, path)| {
            let text = path.to_string_lossy();
            text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
        }),
        ..Default::default()
    };
    let python = python_path(root);
    if !check || installed.is_none() || !python.is_file() {
        return info;
    }
    if family == "qwen" {
        let Ok(update) = qwen_command(root, &python) else {
            return info;
        };
        // The update's own entry point and environment with `--check`, which only reads the signed feed.
        let args: Vec<_> = update
            .as_std()
            .get_args()
            .map(|arg| arg.to_os_string())
            .collect();
        let mut command = Command::new(&python);
        command
            .args(&args[..3])
            .args(["update", "--check"])
            .args(&args[4..])
            .current_dir(root)
            .kill_on_drop(true);
        control_environment(&mut command, root);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        if let Some(value) = check_output(command).await {
            if value["ok"].as_bool() == Some(true) {
                info.checked = true;
                info.available_version = value
                    .pointer("/engine/offered/version")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                info.update_available =
                    value.pointer("/engine/status").and_then(Value::as_str) == Some("available");
                info.download_bytes = value
                    .pointer("/engine/download_bytes")
                    .and_then(Value::as_u64);
            }
        }
    } else {
        let mut command = deepseek_command(root, &python);
        command.arg("check");
        if let Some(value) = check_output(command).await {
            if matches!(value["status"].as_str(), Some("available" | "upToDate")) {
                info.checked = true;
                info.available_version = value["offeredVersion"].as_str().map(str::to_string);
                info.update_available = value["status"] == "available";
            }
        }
    }
    info
}

/// Installed Qwen and DeepSeek engines of a Strata folder; with `check`, also what the signed feed offers.
#[tauri::command]
pub async fn strata_engine_status(
    root_path: String,
    check: bool,
) -> Result<Vec<StrataEngineInfo>, String> {
    let root = crate::strata::root_path(&root_path)?;
    let (qwen, deepseek) = tokio::join!(
        engine_info(&root, "qwen", check),
        engine_info(&root, "deepseek", check)
    );
    Ok(vec![qwen, deepseek])
}

/// Engine files may change only while no Strata server or run uses them.
pub(crate) async fn ensure_strata_stopped(
    legacy: &crate::process::ProcessState,
    runs: &crate::runs::RunManager,
) -> Result<(), String> {
    {
        let mut registry = legacy.0.lock().await;
        if let Some(process) = registry.current.as_mut() {
            if process.backend == "strata"
                && process
                    .child
                    .try_wait()
                    .map_err(|e| e.to_string())?
                    .is_none()
            {
                return Err("Stop the Strata server before updating its engine".into());
            }
        }
        if registry
            .current
            .as_ref()
            .is_some_and(|process| process.backend == "strata")
        {
            registry.current.take();
        }
    }
    if runs
        .resource_requests()
        .await?
        .iter()
        .any(|(request, _)| request.engine == "strata")
    {
        return Err("Stop all Strata runs before updating their engine".into());
    }
    Ok(())
}
