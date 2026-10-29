//! Claude Code adapter for host-owned tasks. Each task gets its own CLI
//! process keyed `host:<task>`; its reader hands packets to [`route`].
use super::claude_protocol;
use super::codex::instructions;
use super::driver::{self, Live};
use super::store::{TaskConfig, TaskState};
use super::TaskHost;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const PREFIX: &str = "host:";

pub(crate) fn worker_key(task_id: &str) -> String {
    format!("{PREFIX}{task_id}")
}

/// Returns true when the packet belongs to a host task.
pub(crate) async fn route(app: &AppHandle, worker: &str, generation: u64, packet: &Value) -> bool {
    let Some(task_id) = worker.strip_prefix(PREFIX) else {
        return false;
    };
    let Some(host) = app.try_state::<TaskHost>() else {
        return false;
    };
    if packet["type"] == "aplot_closed" {
        driver::closed(app, &host, |l| {
            l.runtime == "claude" && l.native == worker && l.generation == generation
        })
        .await;
        return true;
    }
    let (connection, frames) = {
        let mut live = host.sessions.live.lock().unwrap();
        let Some(live) = live
            .get_mut(task_id)
            .filter(|l| l.native == worker && l.generation == generation)
        else {
            return true;
        };
        (
            live.connection_id.clone(),
            claude_protocol::packet(packet, &mut live.claude),
        )
    };
    if let Err(error) =
        driver::apply_frames(app, &host, task_id, &connection, generation, packet, frames).await
    {
        eprintln!("agent task {task_id}: {error}");
    }
    true
}

pub(crate) async fn start_session(
    app: &AppHandle,
    task_id: &str,
    cwd: &str,
    config: &TaskConfig,
    state: &TaskState,
) -> Result<Live, String> {
    let connection = config.connection_id.clone().ok_or("changed")?;
    let model = config.model_id.clone().ok_or("model")?;
    let resume = state
        .native_session_id
        .clone()
        .filter(|_| state.native_connection_id.as_deref() == Some(connection.as_str()));
    let key = worker_key(task_id);
    let start = crate::claude_agent::Start {
        id: key.clone(),
        cwd: cwd.into(),
        model,
        connection_id: connection.clone(),
        mode: config
            .access_mode
            .clone()
            .unwrap_or_else(|| "manual".into()),
        chat: false,
        session_id: resume,
        instructions: Some(instructions(
            config,
            "User-selected project skill references",
        )),
        effort: config.reasoning.clone().filter(|s| !s.is_empty()),
    };
    let result = crate::claude_agent::claude_start(app.clone(), app.state(), start).await?;
    let generation = result["aplotGeneration"].as_u64().ok_or("protocol")?;
    Ok(Live::new("claude", key, connection, generation))
}

/// Sends the user's message. Claude has no turn ID.
pub(crate) async fn start_turn(
    app: &AppHandle,
    worker: &str,
    input: &Value,
) -> Result<Option<String>, String> {
    let attachments = input["attachments"].as_array().cloned().unwrap_or_default();
    let images = attachments
        .iter()
        .filter(|a| a["kind"] == "image")
        .filter_map(|a| a["path"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let files = attachments
        .iter()
        .filter(|a| a["kind"] != "image")
        .filter_map(|a| a["path"].as_str())
        .collect::<Vec<_>>();
    let mut text = input["text"].as_str().unwrap_or("").to_owned();
    if !files.is_empty() {
        text.push_str(&format!(
            "\n\nFiles explicitly attached by the user:\n{}",
            files.join("\n")
        ));
    }
    let mut content = vec![json!({"type":"text","text":text})];
    if !images.is_empty() {
        content.extend(
            crate::claude_agent::image_blocks(images)?
                .as_array()
                .cloned()
                .unwrap_or_default(),
        );
    }
    let packet = json!({"type":"user","uuid":uuid::Uuid::new_v4().to_string(),"message":{"role":"user","content":content}});
    app.state::<crate::claude_agent::ClaudeManager>()
        .send_packet(worker, packet)
        .await?;
    Ok(None)
}

pub(crate) async fn interrupt(app: &AppHandle, worker: &str) -> Result<(), String> {
    app.state::<crate::claude_agent::ClaudeManager>()
        .stop(worker, false)
        .await
}

pub(crate) async fn close(app: &AppHandle, worker: &str) -> Result<(), String> {
    app.state::<crate::claude_agent::ClaudeManager>()
        .stop(worker, true)
        .await
}

#[cfg(test)]
mod tests {
    #[test]
    fn worker_keys_fit_the_cli_limit() {
        let key = super::worker_key(&uuid::Uuid::new_v4().to_string());
        assert!(key.len() <= 100 && key.starts_with("host:"));
    }
}
