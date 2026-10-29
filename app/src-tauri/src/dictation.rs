//! Chat dictation: Hermes' recorder and local speech recognition in a short-lived
//! process of its own, so it works with any chat target, not only agent sessions.
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tauri::{AppHandle, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout},
    sync::Mutex,
};

struct Session {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
}

#[derive(Default)]
pub struct Dictation(Mutex<Option<Session>>);

impl Session {
    async fn ask(&mut self, command: &str, wait: Duration) -> Result<Value, String> {
        self.stdin
            .write_all(format!("{command}\n").as_bytes())
            .await
            .map_err(|_| "voice-failed")?;
        self.read(wait).await
    }
    async fn read(&mut self, wait: Duration) -> Result<Value, String> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let line = tokio::time::timeout_at(deadline, self.stdout.next_line())
                .await
                .map_err(|_| "voice-timeout")?
                .map_err(|_| "voice-failed")?
                .ok_or("voice-failed")?;
            // Native libraries can still print to stdout; only JSON lines are replies.
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                return Ok(value);
            }
        }
    }
}

#[tauri::command]
pub async fn dictation_start(
    app: AppHandle,
    state: State<'_, Dictation>,
    language: String,
) -> Result<Value, String> {
    let mut current = state.0.lock().await;
    if current.is_some() {
        return Err("voice-busy".into());
    }
    let (root, python) = crate::hermes::agent_runtime().ok_or("voice-not-installed")?;
    let home = app
        .path()
        .app_data_dir()
        .map_err(|_| "voice-failed")?
        .join("hermes-dictation");
    let mut command = tokio::process::Command::new(python);
    command
        .args(["-X", "utf8", "-c", include_str!("dictation.py")])
        .current_dir(root)
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "voice-failed")?;
    let mut session = Session {
        stdin: child.stdin.take().ok_or("voice-failed")?,
        stdout: BufReader::new(child.stdout.take().ok_or("voice-failed")?).lines(),
        child,
    };
    let language = if language.starts_with("ru") {
        "ru"
    } else {
        "en"
    };
    session
        .stdin
        .write_all(format!("{}\n", json!({"home": home, "language": language})).as_bytes())
        .await
        .map_err(|_| "voice-failed")?;
    // Importing Hermes and opening the microphone takes a few seconds on a cold start.
    let ready = session.read(Duration::from_secs(60)).await?;
    if ready["status"] != "recording" {
        let _ = session.child.kill().await;
        return Err(format!(
            "voice-unavailable: {}",
            ready["error"]
                .as_str()
                .unwrap_or("audio dependencies unavailable")
        ));
    }
    *current = Some(session);
    Ok(ready)
}

#[tauri::command]
pub async fn dictation_level(state: State<'_, Dictation>) -> Result<Value, String> {
    let mut current = state.0.lock().await;
    let session = current.as_mut().ok_or("voice-idle")?;
    session.ask("level", Duration::from_secs(5)).await
}

/// Stops recording and returns the transcript; the first run also loads the Whisper model.
#[tauri::command]
pub async fn dictation_stop(state: State<'_, Dictation>) -> Result<String, String> {
    let mut session = state.0.lock().await.take().ok_or("voice-idle")?;
    let result = session.ask("stop", Duration::from_secs(600)).await;
    let _ = session.child.kill().await;
    Ok(result?["text"].as_str().unwrap_or_default().to_owned())
}

#[tauri::command]
pub async fn dictation_cancel(state: State<'_, Dictation>) -> Result<(), String> {
    if let Some(mut session) = state.0.lock().await.take() {
        let _ = session.ask("cancel", Duration::from_secs(5)).await;
        let _ = session.child.kill().await;
    }
    Ok(())
}
