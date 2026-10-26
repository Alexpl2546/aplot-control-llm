//! One shutdown path for Quit and window close. Tray close keeps runs alive.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

#[derive(Default)]
pub(crate) struct ShutdownState {
    operation: Mutex<()>,
    complete: AtomicBool,
    workspace_flush: Mutex<Option<tokio::sync::oneshot::Sender<bool>>>,
}

#[tauri::command]
pub(crate) async fn workspace_shutdown_flushed(app: AppHandle, saved: bool) {
    if let Some(reply) = app
        .state::<ShutdownState>()
        .workspace_flush
        .lock()
        .await
        .take()
    {
        let _ = reply.send(saved);
    }
}

pub(crate) fn is_complete(app: &AppHandle) -> bool {
    app.state::<ShutdownState>()
        .complete
        .load(Ordering::Acquire)
}

pub(crate) async fn shutdown(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ShutdownState>();
    let _operation = state.operation.lock().await;
    if state.complete.load(Ordering::Acquire) {
        return Ok(());
    }
    app.state::<crate::model_preparation::ModelPreparation>()
        .shutdown()
        .await;
    app.state::<crate::downloads::DownloadManager>()
        .shutdown(app)
        .await?;
    app.state::<crate::claude_agent::ClaudeManager>()
        .shutdown()
        .await;
    // Cancellation records evidence and releases measurement leases first.
    app.state::<crate::codex_agent::CodexManager>()
        .shutdown()
        .await;
    app.state::<crate::codex_limits::CodexLimits>()
        .shutdown()
        .await;
    app.state::<crate::jobs::JobManager>().shutdown().await?;
    app.state::<crate::hermes_agent::HermesAgents>()
        .shutdown()
        .await;
    let mut errors = Vec::new();
    if let Err(error) = app
        .state::<crate::runs::RunManager>()
        .shutdown(Some(app))
        .await
    {
        errors.push(error);
    }
    if let Err(error) =
        crate::process::stop_managed(app, &app.state::<crate::process::ProcessState>()).await
    {
        errors.push(error);
    }
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    // Persist the final closed/interrupted events before disposing the renderer.
    // A missing renderer is bounded; an explicit save failure keeps the app open.
    let (reply, received) = tokio::sync::oneshot::channel();
    *state.workspace_flush.lock().await = Some(reply);
    let _ = app.emit("app://before-shutdown", ());
    let saved = tokio::time::timeout(std::time::Duration::from_secs(2), received).await;
    state.workspace_flush.lock().await.take();
    if matches!(saved, Ok(Ok(false))) {
        return Err("Agent Workspace could not save its latest snapshot".into());
    }
    state.complete.store(true, Ordering::Release);
    Ok(())
}

pub(crate) fn request_exit(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        match shutdown(&app).await {
            Ok(()) => app.exit(0),
            Err(error) => {
                // Keep a window available for diagnosis/retry instead of exiting
                // while an owned child or a benchmark still needs cleanup.
                let _ = app.emit("app://shutdown-error", &error);
                let _ = app.emit(
                    "llama://log",
                    crate::process::LogLine {
                        id: uuid::Uuid::new_v4().to_string(),
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        level: "ERROR".into(),
                        source: "control".into(),
                        message: format!("Shutdown failed: {error}"),
                    },
                );
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }
    });
}
