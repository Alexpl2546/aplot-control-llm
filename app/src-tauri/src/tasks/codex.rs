//! Codex adapter for host-owned tasks. The shared app-server reader hands
//! every notification to [`route`]; notifications for a thread owned by a
//! host task are applied here and are not forwarded to the window.
use super::codex_protocol::{self, Frame};
use super::driver::{self, Live};
use super::store::{TaskConfig, TaskState};
use super::TaskHost;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// Returns true when the notification belongs to a host task.
pub(crate) async fn route(app: &AppHandle, value: &Value) -> bool {
    let Some(host) = app.try_state::<TaskHost>() else {
        return false;
    };
    let method = value["method"].as_str().unwrap_or("");
    let connection = value["aplotConnectionId"].as_str().unwrap_or("").to_owned();
    let signed_out =
        method == "account/updated" && value["params"].get("authMode") == Some(&Value::Null);
    if method == "aplot/closed" || signed_out {
        let generation = value["aplotGeneration"].as_u64();
        driver::closed(app, &host, |l| {
            l.runtime == "codex"
                && (connection.is_empty() || l.connection_id == connection)
                && generation.is_none_or(|g| g >= l.generation)
        })
        .await;
        return false;
    }
    let Some(thread) = value["params"]["threadId"].as_str() else {
        return false;
    };
    let Some(task_id) = host.sessions.task_for(&connection, thread) else {
        return false;
    };
    let generation = value["aplotGeneration"].as_u64().unwrap_or(0);
    let item = &value["params"]["item"];
    let child = {
        let mut live = host.sessions.live.lock().unwrap();
        let Some(live) = live.get_mut(&task_id) else {
            return true;
        };
        live.generation = generation.max(live.generation);
        if item["type"] == "collabAgentToolCall" {
            for id in item["receiverThreadIds"].as_array().into_iter().flatten() {
                if live.children.len() < 32 {
                    live.children
                        .insert(id.as_str().unwrap_or_default().to_owned());
                }
            }
        }
        if method == "turn/started" && live.native == thread {
            live.native_turn = value["params"]["turn"]["id"].as_str().map(str::to_owned);
        }
        live.native != thread
    };
    let frames = if !child || value.get("id").is_some() {
        // Sub-agent threads only report progress; their requests still need an answer.
        codex_protocol::frames(value)
    } else if method == "turn/completed" {
        vec![Frame::Event {
            kind: "agent.update",
            payload: json!({"id":thread,"name":"Codex","status":value["params"]["turn"]["status"].as_str().unwrap_or("unknown")}),
        }]
    } else {
        Vec::new()
    };
    let request = json!({"method":value["method"],"params":value["params"]});
    if let Err(error) = driver::apply_frames(
        app,
        &host,
        &task_id,
        &connection,
        generation,
        &request,
        frames,
    )
    .await
    {
        eprintln!("agent task {task_id}: {error}");
    }
    true
}

pub(crate) fn instructions(config: &TaskConfig, skills_label: &str) -> String {
    let language = if config.language.as_deref() == Some("ru") {
        "Общайся с пользователем на русском языке."
    } else {
        "Use the user’s language."
    };
    let skills = config
        .skills
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| format!("{skills_label}: {s}"));
    [
        Some(language.to_owned()),
        config.context.clone().filter(|s| !s.is_empty()),
        skills,
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n")
}

pub(crate) async fn start_session(
    app: &AppHandle,
    cwd: &str,
    config: &TaskConfig,
    state: &TaskState,
) -> Result<Live, String> {
    let policy = codex_protocol::policy(config.access_mode.as_deref().unwrap_or("manual"), cwd);
    let resume = state.native_session_id.clone().filter(|_| {
        state.native_connection_id == config.connection_id || config.connection_id.is_none()
    });
    let mut params = json!({"cwd":cwd,"model":config.model_id,"approvalPolicy":policy.approval_policy,"sandbox":policy.sandbox,
        "developerInstructions":instructions(config, "Project skill references selected by the user")});
    if let Some(connection) = &config.connection_id {
        params["aplotConnectionId"] = json!(connection);
    }
    if let Some(thread) = &resume {
        params["threadId"] = json!(thread);
    }
    let codex = app.state::<crate::codex_agent::CodexManager>();
    let (result, (connection_id, generation)) = codex
        .call(
            app,
            if resume.is_some() {
                "thread/resume"
            } else {
                "thread/start"
            },
            params,
        )
        .await?;
    let thread_id = result["thread"]["id"]
        .as_str()
        .ok_or("protocol")?
        .to_owned();
    Ok(Live::new("codex", thread_id, connection_id, generation))
}

/// Starts a turn; returns the native turn ID.
pub(crate) async fn start_turn(
    app: &AppHandle,
    thread: &str,
    connection: &str,
    cwd: &str,
    input: &Value,
    config: &TaskConfig,
) -> Result<Option<String>, String> {
    let policy = codex_protocol::policy(config.access_mode.as_deref().unwrap_or("manual"), cwd);
    let attachments = input["attachments"].as_array().cloned().unwrap_or_default();
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
    let mut items = vec![json!({"type":"text","text":text})];
    items.extend(
        attachments
            .iter()
            .filter(|a| a["kind"] == "image")
            .map(|a| json!({"type":"localImage","path":a["path"]})),
    );
    let mut params = json!({"aplotConnectionId":connection,"threadId":thread,"input":items,"model":config.model_id,
        "approvalPolicy":policy.approval_policy,"sandboxPolicy":policy.sandbox_policy});
    // Codex takes the reasoning level per turn, so a change applies to the next message.
    if let Some(effort) = config.reasoning.as_deref().filter(|s| !s.is_empty()) {
        params["effort"] = json!(effort);
    }
    let codex = app.state::<crate::codex_agent::CodexManager>();
    let (result, _) = codex.call(app, "turn/start", params).await?;
    Ok(result["turn"]["id"].as_str().map(str::to_owned))
}

pub(crate) async fn interrupt(
    app: &AppHandle,
    connection: &str,
    thread: &str,
    turn: &str,
) -> Result<(), String> {
    let codex = app.state::<crate::codex_agent::CodexManager>();
    codex
        .call(
            app,
            "turn/interrupt",
            json!({"aplotConnectionId":connection,"threadId":thread,"turnId":turn}),
        )
        .await?;
    Ok(())
}
