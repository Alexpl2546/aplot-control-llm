//! Runtime-neutral host sessions for agent tasks.
//!
//! Runtime adapters ([`super::codex`], [`super::claude`]) translate their
//! protocol into frames and hand them to [`apply_frames`]. Frames are applied
//! to the task here (messages, state, approvals, the turn queue) and never
//! reach the window directly, so a reloaded or hidden window cannot lose or
//! duplicate them.
use super::approvals::{self, Event, Outcome, Status};
use super::codex_protocol::{self, Frame};
use super::store::{self, ApprovalRow, Journal, TaskConfig};
use super::TaskHost;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager};

/// Streaming text is written to the database and journal at most this often.
const FLUSH_INTERVAL: Duration = Duration::from_millis(150);
const TOOL_TEXT_LIMIT: usize = 60_000;

pub(crate) struct Live {
    pub runtime: &'static str,
    /// Codex thread ID, or the Claude CLI process key.
    pub native: String,
    pub connection_id: String,
    pub generation: u64,
    pub children: HashSet<String>,
    /// Host turn currently executing on this session.
    pub turn: Option<String>,
    pub native_turn: Option<String>,
    /// Assistant message receiving deltas.
    cursor: Option<String>,
    /// Pending appends: (message id, text, reasoning, tail limit).
    buffer: Vec<(String, String, String, Option<usize>)>,
    flush_scheduled: bool,
    pub claude: super::claude_protocol::Stream,
}

impl Live {
    pub(crate) fn new(
        runtime: &'static str,
        native: String,
        connection_id: String,
        generation: u64,
    ) -> Self {
        Self {
            runtime,
            native,
            connection_id,
            generation,
            children: HashSet::new(),
            turn: None,
            native_turn: None,
            cursor: None,
            buffer: Vec::new(),
            flush_scheduled: false,
            claude: Default::default(),
        }
    }
}

#[derive(Default)]
pub(crate) struct Sessions {
    pub(crate) live: Mutex<HashMap<String, Live>>,
    /// Tasks whose next turn is being started; at most one driver per task.
    driving: Mutex<HashSet<String>>,
    /// Stop requests that arrived while a session or turn was still starting.
    stopping: Mutex<HashSet<String>>,
}

fn display(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}
fn clip(value: String, limit: usize) -> String {
    value.chars().take(limit).collect()
}
/// Same public error codes the renderer used, so the composer shows the same notices.
pub(crate) fn error_code(error: &str) -> String {
    let code = error.trim_start_matches("Error: ");
    if [
        "not-installed",
        "changed",
        "unavailable",
        "folder",
        "closed",
        "limit",
        "busy",
        "expired",
        "context",
        "runtime-failed",
    ]
    .contains(&code)
    {
        code.to_owned()
    } else {
        "agent-error".to_owned()
    }
}

impl Sessions {
    pub(crate) fn task_for(&self, connection: &str, thread: &str) -> Option<String> {
        self.live
            .lock()
            .unwrap()
            .iter()
            .find(|(_, live)| {
                live.runtime == "codex"
                    && live.connection_id == connection
                    && (live.native == thread || live.children.contains(thread))
            })
            .map(|(id, _)| id.clone())
    }
    pub(crate) fn is_live(&self, task_id: &str) -> bool {
        self.live.lock().unwrap().contains_key(task_id)
    }
    /// Writes buffered deltas for a task. Must run inside the write that follows them.
    fn drain(&self, j: &mut Journal, task_id: &str) -> Result<(), String> {
        let buffer = self
            .live
            .lock()
            .unwrap()
            .get_mut(task_id)
            .map(|live| {
                live.flush_scheduled = false;
                std::mem::take(&mut live.buffer)
            })
            .unwrap_or_default();
        for (id, text, reasoning, limit) in buffer {
            j.append_message(task_id, &id, &text, &reasoning, limit)?;
        }
        Ok(())
    }
    /// Buffers a delta that extends an existing message. Returns false when a write is needed.
    fn buffer_delta(&self, task_id: &str, kind: &str, payload: &Value) -> Option<bool> {
        let chunk = payload["text"].as_str().unwrap_or("");
        let mut live = self.live.lock().unwrap();
        let live = live.get_mut(task_id)?;
        let (id, text, reasoning, limit) = match kind {
            "tool.output" => (
                payload["tool_id"].as_str()?.to_owned(),
                chunk,
                "",
                Some(TOOL_TEXT_LIMIT),
            ),
            "message.delta" => (live.cursor.clone()?, chunk, "", None),
            "reasoning.delta" => (live.cursor.clone()?, "", chunk, None),
            _ => return None,
        };
        match live.buffer.last_mut() {
            Some(last) if last.0 == id => {
                last.1.push_str(text);
                last.2.push_str(reasoning);
            }
            _ => live.buffer.push((id, text.into(), reasoning.into(), limit)),
        }
        let schedule = !live.flush_scheduled;
        live.flush_scheduled = true;
        Some(schedule)
    }
}

/// Applies a runtime's frames for a task: streamed text is buffered, the rest
/// is written in one transaction. `request` is the raw runtime request kept
/// with any approval it creates.
pub(crate) async fn apply_frames(
    app: &AppHandle,
    host: &TaskHost,
    task_id: &str,
    connection: &str,
    generation: u64,
    request: &Value,
    frames: Vec<Frame>,
) -> Result<(), String> {
    if frames.is_empty() {
        return Ok(());
    }
    if let [Frame::Event { kind, payload }] = frames.as_slice() {
        if let Some(schedule) = host.sessions.buffer_delta(task_id, kind, payload) {
            if schedule {
                let app = app.clone();
                let task_id = task_id.to_owned();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(FLUSH_INTERVAL).await;
                    let host = app.state::<TaskHost>();
                    let _ = host.write(&app, |j| host.sessions.drain(j, &task_id)).await;
                });
            }
            return Ok(());
        }
    }
    let advance = host
        .write(app, |j| {
            host.sessions.drain(j, task_id)?;
            let mut advance = false;
            for frame in frames {
                advance |= apply_frame(host, j, task_id, connection, generation, request, frame)?;
            }
            Ok(advance)
        })
        .await?;
    if advance {
        drive(app.clone(), task_id.to_owned());
    }
    Ok(())
}

/// Applies one frame inside a write. Returns true when the queue may advance.
fn apply_frame(
    host: &TaskHost,
    j: &mut Journal,
    task_id: &str,
    connection: &str,
    generation: u64,
    request: &Value,
    frame: Frame,
) -> Result<bool, String> {
    let set_cursor = |cursor: Option<String>| {
        if let Some(live) = host.sessions.live.lock().unwrap().get_mut(task_id) {
            live.cursor = cursor;
        }
    };
    match frame {
        Frame::Request { id, method, params } => {
            let (turn, runtime) = host
                .sessions
                .live
                .lock()
                .unwrap()
                .get(task_id)
                .map(|l| (l.turn.clone(), l.runtime))
                .unwrap_or((None, "codex"));
            j.insert_approval(&ApprovalRow {
                id: uuid::Uuid::new_v4().to_string(),
                task_id: task_id.into(),
                turn_id: turn,
                runtime: runtime.into(),
                connection_id: connection.into(),
                generation,
                native_id: id,
                method: method.into(),
                params,
                request: request.clone(),
                status: "pending".into(),
                decision: None,
                delivery: None,
                resolved_by: None,
            })?;
        }
        Frame::Error { code, detail } => {
            set_cursor(None);
            j.close_approvals(task_id, Event::Expire)?;
            j.edit_state(task_id, |s| {
                s.pending = false;
                s.starting = false;
                s.error = code;
                if detail.is_some() {
                    s.io_error = detail;
                }
            })?;
        }
        Frame::Event { kind, payload } => {
            match kind {
                "agent.update" => {
                    let Some(id) = payload["id"].as_str() else {
                        return Ok(false);
                    };
                    let child = json!({"id":id,"name":clip(payload["name"].as_str().unwrap_or("Agent").into(),120),
                    "activity":clip(payload["activity"].as_str().unwrap_or("").into(),600),"status":payload["status"].as_str().unwrap_or("unknown")});
                    j.edit_state(task_id, |s| {
                        s.children.retain(|c| c["id"] != id);
                        s.children.push(child);
                        let extra = s.children.len().saturating_sub(32);
                        s.children.drain(..extra);
                    })?;
                }
                "session.usage" => {
                    let mut usage = payload["usage"].clone();
                    // Hermes reports a breakdown; provider usage alone has none.
                    for (key, empty) in [
                        ("categories", json!([])),
                        ("context_files", json!([])),
                        ("estimated_total", json!(0)),
                    ] {
                        if usage.get(key).is_none() {
                            usage[key] = empty;
                        }
                    }
                    j.edit_state(task_id, |s| s.context = Some(usage))?;
                }
                "tool.output" => {
                    let id = payload["tool_id"].as_str().unwrap_or_default();
                    j.append_message(
                        task_id,
                        id,
                        payload["text"].as_str().unwrap_or(""),
                        "",
                        Some(TOOL_TEXT_LIMIT),
                    )?;
                }
                "message.interim" => {
                    let chunk = payload["text"].as_str().unwrap_or("");
                    set_cursor(None);
                    if payload["already_streamed"] != true && !chunk.is_empty() {
                        j.upsert_message(task_id, &json!({"id":uuid::Uuid::new_v4().to_string(),"kind":"assistant","text":chunk,"time":store::millis()}))?;
                    }
                }
                "reasoning.available" => {
                    let chunk = payload["text"].as_str().unwrap_or("");
                    let cursor = host
                        .sessions
                        .live
                        .lock()
                        .unwrap()
                        .get(task_id)
                        .and_then(|l| l.cursor.clone());
                    match cursor.and_then(|id| j.message(task_id, &id).ok().flatten()) {
                        Some(mut entry) => {
                            entry["reasoning"] = json!(chunk);
                            j.upsert_message(task_id, &entry)?;
                        }
                        None if !chunk.is_empty() => {
                            let id = uuid::Uuid::new_v4().to_string();
                            j.upsert_message(task_id, &json!({"id":id,"kind":"assistant","text":"","reasoning":chunk,"time":store::millis()}))?;
                            set_cursor(Some(id));
                        }
                        None => {}
                    }
                }
                "error" => {
                    set_cursor(None);
                    j.close_approvals(task_id, Event::Expire)?;
                    j.edit_state(task_id, |s| {
                        s.pending = false;
                        s.starting = false;
                        s.error = "agent-error".into();
                    })?;
                }
                "message.delta" | "reasoning.delta" => {
                    let chunk = payload["text"].as_str().unwrap_or("");
                    if chunk.is_empty() {
                        return Ok(false);
                    }
                    let id = uuid::Uuid::new_v4().to_string();
                    let reasoning = kind == "reasoning.delta";
                    j.upsert_message(task_id, &json!({"id":id,"kind":"assistant","text":if reasoning { "" } else { chunk },
                    "reasoning":if reasoning { Some(chunk) } else { None },"time":store::millis()}))?;
                    set_cursor(Some(id));
                }
                "tool.start" | "tool.complete" => {
                    let Some(id) = payload["tool_id"].as_str() else {
                        return Ok(false);
                    };
                    set_cursor(None);
                    let existing = j.message(task_id, id)?.unwrap_or(Value::Null);
                    let result = [
                        &payload["result"],
                        &payload["result_text"],
                        &payload["summary"],
                        &payload["preview"],
                    ]
                    .into_iter()
                    .find(|v| !v.is_null())
                    .cloned()
                    .unwrap_or(Value::Null);
                    let mut entry = if existing.is_object() {
                        existing.clone()
                    } else {
                        json!({"id":id,"kind":"tool","time":store::millis()})
                    };
                    entry["kind"] = json!("tool");
                    entry["text"] = json!(clip(display(&result), TOOL_TEXT_LIMIT));
                    if let Some(name) = payload["name"].as_str().filter(|s| !s.is_empty()) {
                        entry["name"] = json!(name);
                    }
                    if !payload["args"].is_null() {
                        entry["details"] = json!(clip(display(&payload["args"]), TOOL_TEXT_LIMIT));
                        entry["args"] = payload["args"].clone();
                    }
                    entry["result"] = payload["result"].clone();
                    if let Some(diff) = payload["inline_diff"].as_str().filter(|s| !s.is_empty()) {
                        entry["diff"] = json!(diff);
                    }
                    if let Some(duration) = payload["duration_s"].as_f64() {
                        entry["duration"] = json!(duration);
                    }
                    entry["status"] = json!(if kind == "tool.start" {
                        "running"
                    } else {
                        codex_protocol::tool_outcome(&result)
                    });
                    j.upsert_message(task_id, &entry)?;
                }
                "session.created" => {
                    let session = payload["sessionId"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned);
                    let model = payload["modelId"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned);
                    let tokens = payload["contextTokens"].as_u64();
                    let hermes = j.task(task_id)?.is_some_and(|t| t.runtime == "hermes");
                    j.edit_state(task_id, |s| {
                        // A Hermes session cannot be resumed by a new process; keep it apart.
                        if hermes {
                            s.hermes_session_id = session;
                            s.actual_context_tokens = tokens;
                        } else if session.is_some() {
                            s.native_session_id = session;
                        }
                        if model.is_some() {
                            s.actual_model_id = model;
                        }
                    })?;
                }
                "request.cancel" => {
                    let native = payload["id"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| payload["id"].to_string());
                    for approval in j.approvals(task_id, "pending")? {
                        if approval.native_id == native {
                            j.transition_approval(
                                &approval.id,
                                Status::Expired.as_str(),
                                None,
                                None,
                                Some("runtime"),
                            )?;
                        }
                    }
                }
                "message.complete" => return finish_turn(host, j, task_id, &payload),
                _ => {}
            }
        }
    }
    Ok(false)
}

fn finish_turn(
    host: &TaskHost,
    j: &mut Journal,
    task_id: &str,
    payload: &Value,
) -> Result<bool, String> {
    let status = payload["status"].as_str().unwrap_or("error");
    // Hermes sends the full final text and reasoning with the completion.
    let text = payload["text"].as_str().unwrap_or("");
    let reasoning = payload["reasoning"].as_str().unwrap_or("");
    if !text.is_empty() || !reasoning.is_empty() {
        let cursor = host
            .sessions
            .live
            .lock()
            .unwrap()
            .get(task_id)
            .and_then(|l| l.cursor.clone());
        let mut entry = cursor
            .and_then(|id| j.message(task_id, &id).ok().flatten())
            .unwrap_or_else(|| json!({"id":uuid::Uuid::new_v4().to_string(),"kind":"assistant","text":"","time":store::millis()}));
        if !text.is_empty() {
            entry["text"] = json!(text);
        }
        if !reasoning.is_empty() {
            entry["reasoning"] = json!(reasoning);
        }
        j.upsert_message(task_id, &entry)?;
    }
    let partial = payload["partial"] == true;
    let turn = host
        .sessions
        .live
        .lock()
        .unwrap()
        .get_mut(task_id)
        .and_then(|live| {
            live.cursor = None;
            live.native_turn = None;
            live.turn.take()
        });
    j.settle_running_tools(
        task_id,
        if status == "interrupted" {
            "interrupted"
        } else {
            "unknown"
        },
    )?;
    j.close_approvals(task_id, Event::Expire)?;
    if let Some(turn) = turn {
        let outcome = match status {
            "complete" => "completed",
            "interrupted" => "interrupted",
            _ => "failed",
        };
        j.set_turn(&turn, outcome, None, payload["errorDetail"].as_str())?;
    }
    let usage = payload.get("usage").filter(|u| u.is_object()).map(|u| {
        let mut usage = u.clone();
        usage["categories"] = json!([]);
        usage["context_files"] = json!([]);
        usage["estimated_total"] = json!(0);
        usage
    });
    let state = j.edit_state(task_id, |s| {
        if usage.is_some() {
            s.context = usage;
        }
        s.pending = false;
        s.starting = false;
        s.stopped = status == "interrupted";
        if status == "error" || partial {
            s.error = "agent-error".into();
        }
        if let Some(detail) = payload["errorDetail"].as_str() {
            s.io_error = Some(detail.into());
        }
    })?;
    Ok(status == "complete" && state.error.is_empty() && !state.ended && !state.stopped)
}

/// Worker exit or sign-out: the matching sessions end, running work has an
/// unknown outcome and waiting approvals can no longer be answered.
pub(crate) async fn closed(app: &AppHandle, host: &TaskHost, matches: impl Fn(&Live) -> bool) {
    let tasks: Vec<String> = {
        let mut live = host.sessions.live.lock().unwrap();
        let ids = live
            .iter()
            .filter(|(_, l)| matches(l))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in &ids {
            live.remove(id);
        }
        ids
    };
    for task_id in tasks {
        let _ = host
            .write(app, |j| {
                end_session(j, &task_id, "closed")?;
                Ok(())
            })
            .await;
    }
}

/// Marks a task's session as ended. The live entry must already be removed.
fn end_session(j: &mut Journal, task_id: &str, reason: &str) -> Result<(), String> {
    for turn in j.turns(task_id, "running")? {
        j.set_turn(&turn.id, "interrupted", None, Some(reason))?;
    }
    j.settle_running_tools(task_id, "unknown")?;
    j.close_approvals(task_id, Event::Invalidate)?;
    j.edit_state(task_id, |s| {
        s.live = false;
        s.pending = false;
        s.starting = false;
        s.ended = true;
        if s.error.is_empty() {
            s.error = "closed".into();
        }
    })?;
    Ok(())
}

/// Starts the next queued turn of a task if none is running. Safe to call repeatedly.
pub(crate) fn drive(app: AppHandle, task_id: String) {
    tauri::async_runtime::spawn(async move {
        let host = app.state::<TaskHost>();
        if !host
            .sessions
            .driving
            .lock()
            .unwrap()
            .insert(task_id.clone())
        {
            return;
        }
        let result = run_next(&app, &host, &task_id).await;
        host.sessions.driving.lock().unwrap().remove(&task_id);
        if let Err(error) = result {
            eprintln!("agent task {task_id}: {error}");
        }
    });
}

async fn run_next(app: &AppHandle, host: &TaskHost, task_id: &str) -> Result<(), String> {
    host.sessions.stopping.lock().unwrap().remove(task_id);
    let live = host.sessions.is_live(task_id);
    let picked = host
        .write(app, |j| {
            let Some(task) = j.task(task_id)? else {
                return Ok(None);
            };
            if task.state.ended || !j.turns(task_id, "running")?.is_empty() {
                return Ok(None);
            }
            let Some(turn) = j.turns(task_id, "queued")?.into_iter().next() else {
                return Ok(None);
            };
            j.set_turn(&turn.id, "running", None, None)?;
            j.upsert_message(
                task_id,
                &json!({"id":turn.message_id,"kind":"user","text":turn.input["text"],
                "attachments":turn.input["attachments"],"time":store::millis()}),
            )?;
            j.edit_state(task_id, |s| {
                s.pending = true;
                s.starting = !live;
                s.error.clear();
                s.io_error = None;
                s.stopped = false;
            })?;
            Ok(Some((turn, task.runtime, task.config, task.state)))
        })
        .await?;
    let Some((turn, runtime, config, state)) = picked else {
        return Ok(());
    };
    let started = async {
        ensure_session(app, host, task_id, &runtime, &config, &state).await?;
        if host.sessions.stopping.lock().unwrap().remove(task_id) {
            return Err("interrupted".to_owned());
        }
        start_turn(app, host, task_id, &turn.id, &turn.input, &config).await
    }
    .await;
    if let Err(error) = started {
        let stopped = error == "interrupted";
        host.write(app, |j| {
            j.delete_message(task_id, &turn.message_id)?;
            j.set_turn(
                &turn.id,
                if stopped { "interrupted" } else { "failed" },
                None,
                Some(&error),
            )?;
            j.edit_state(task_id, |s| {
                s.pending = false;
                s.starting = false;
                s.stopped = stopped;
                if !stopped {
                    s.error = error_code(&error);
                    s.io_error = Some(clip(error.clone(), 1000));
                }
            })?;
            Ok(())
        })
        .await?;
    }
    Ok(())
}

/// Opens the task's runtime session if none is live. Also used before voice
/// input, which needs a Hermes session without a turn.
pub(crate) async fn ensure_session(
    app: &AppHandle,
    host: &TaskHost,
    task_id: &str,
    runtime: &str,
    config: &TaskConfig,
    state: &store::TaskState,
) -> Result<(), String> {
    if host.sessions.is_live(task_id) {
        return Ok(());
    }
    let cwd = host
        .read(app, |conn| crate::agent_workspace::task_root(conn, task_id))
        .await?;
    let live = match runtime {
        "codex" => super::codex::start_session(app, &cwd, &config, &state).await?,
        "claude" => super::claude::start_session(app, task_id, &cwd, &config, &state).await?,
        "hermes" => super::hermes::start_session(app, task_id, &cwd, config, state).await?,
        _ => return Err("runtime-not-hosted".to_owned()),
    };
    let (native, connection) = (live.native.clone(), live.connection_id.clone());
    let codex = live.runtime == "codex";
    host.sessions
        .live
        .lock()
        .unwrap()
        .insert(task_id.into(), live);
    let model = config.model_id.clone();
    host.write(app, |j| {
        j.edit_state(task_id, |s| {
            s.live = true;
            s.starting = false;
            s.ended = false;
            // Claude reports its own session ID in its first `init` packet.
            if codex {
                s.native_session_id = Some(native);
            }
            s.native_connection_id = Some(connection);
            if model.is_some() {
                s.actual_model_id = model;
            }
        })?;
        Ok(())
    })
    .await?;
    Ok(())
}

async fn start_turn(
    app: &AppHandle,
    host: &TaskHost,
    task_id: &str,
    turn_id: &str,
    input: &Value,
    config: &TaskConfig,
) -> Result<(), String> {
    let (runtime, native, connection) = {
        let mut live = host.sessions.live.lock().unwrap();
        let live = live.get_mut(task_id).ok_or("closed")?;
        live.turn = Some(turn_id.into());
        live.native_turn = None;
        live.claude.stop_requested = false;
        (
            live.runtime,
            live.native.clone(),
            live.connection_id.clone(),
        )
    };
    let cwd = host
        .read(app, |conn| crate::agent_workspace::task_root(conn, task_id))
        .await?;
    let started = match runtime {
        "codex" => super::codex::start_turn(app, &native, &connection, &cwd, input, config).await,
        "claude" => super::claude::start_turn(app, &native, input).await,
        _ => super::hermes::start_turn(app, &native, input).await,
    };
    let native_turn = match started {
        Ok(native_turn) => native_turn,
        Err(error) => {
            if let Some(live) = host.sessions.live.lock().unwrap().get_mut(task_id) {
                if live.turn.as_deref() == Some(turn_id) {
                    live.turn = None;
                }
            }
            return Err(error);
        }
    };
    let still_running = {
        let mut live = host.sessions.live.lock().unwrap();
        match live.get_mut(task_id) {
            Some(live) if live.turn.as_deref() == Some(turn_id) => {
                // Claude has no turn ID; the host turn stands in for it.
                live.native_turn = native_turn.clone().or(Some(turn_id.into()));
                true
            }
            _ => false,
        }
    };
    if still_running {
        host.write(app, |j| {
            j.set_turn(turn_id, "running", native_turn.as_deref(), None)?;
            Ok(())
        })
        .await?;
        if host.sessions.stopping.lock().unwrap().remove(task_id) {
            let _ = interrupt_native(app, host, task_id).await;
        }
    }
    Ok(())
}

async fn interrupt_native(app: &AppHandle, host: &TaskHost, task_id: &str) -> Result<bool, String> {
    let target = host
        .sessions
        .live
        .lock()
        .unwrap()
        .get_mut(task_id)
        .and_then(|l| {
            let turn = l.native_turn.clone()?;
            l.claude.stop_requested = true;
            Some((l.runtime, l.connection_id.clone(), l.native.clone(), turn))
        });
    let Some((runtime, connection, native, turn)) = target else {
        return Ok(false);
    };
    match runtime {
        "codex" => super::codex::interrupt(app, &connection, &native, &turn).await?,
        "claude" => super::claude::interrupt(app, &native).await?,
        _ => super::hermes::stop(app, &native, false).await?,
    }
    Ok(true)
}

/// Ends the native session when it is per task (Claude, Hermes); a shared
/// Codex app-server keeps the thread for a later resume.
async fn close_native(app: &AppHandle, live: Option<Live>) {
    match live {
        Some(live) if live.runtime == "claude" => {
            let _ = super::claude::close(app, &live.native).await;
        }
        Some(live) if live.runtime == "hermes" => {
            let _ = super::hermes::stop(app, &live.native, true).await;
        }
        _ => {}
    }
}

/// Stops the running turn. With `close`, also ends the session and cancels the queue.
pub(crate) async fn interrupt(
    app: &AppHandle,
    host: &TaskHost,
    task_id: &str,
    close: bool,
) -> Result<(), String> {
    let interrupted = interrupt_native(app, host, task_id).await;
    if !matches!(interrupted, Ok(true)) && host.sessions.driving.lock().unwrap().contains(task_id) {
        // Still starting: the driver checks this before and after `turn/start`.
        host.sessions
            .stopping
            .lock()
            .unwrap()
            .insert(task_id.into());
    }
    if let Err(error) = &interrupted {
        if !close {
            return Err(error.clone());
        }
    }
    let pending = host
        .read(app, |conn| store::approvals(conn, task_id, "pending"))
        .await?;
    for approval in pending {
        let _ = resolve(
            app,
            host,
            &approval.id,
            &json!({"choice":"deny","answers":{}}),
            "interrupt",
        )
        .await;
    }
    if close {
        let live = host.sessions.live.lock().unwrap().remove(task_id);
        close_native(app, live).await;
        host.write(app, |j| {
            if j.task(task_id)?.is_none() {
                return Ok(());
            }
            for turn in j.turns(task_id, "queued")? {
                j.set_turn(&turn.id, "cancelled", None, Some("closed"))?;
            }
            end_session(j, task_id, "closed")
        })
        .await?;
    }
    Ok(())
}

/// Answers an approval once. Repeats and other clients get the recorded result.
pub(crate) async fn resolve(
    app: &AppHandle,
    host: &TaskHost,
    approval_id: &str,
    answer: &Value,
    by: &str,
) -> Result<Value, String> {
    let approval = host
        .read(app, |conn| store::approval(conn, approval_id))
        .await?
        .ok_or("expired")?;
    let current = Status::parse(&approval.status).ok_or("approval-invalid")?;
    let alive = current == Status::Pending && runtime_waits(app, host, &approval).await;
    let target = match approvals::transition(
        current,
        Event::Resolve {
            decision: answer,
            runtime_alive: alive,
        },
    ) {
        Outcome::AlreadyResolved(status) => {
            return Ok(
                json!({"status":status.as_str(),"alreadyResolved":true,"approval":approval.view()}),
            )
        }
        Outcome::Moved(Status::Stale) => {
            host.write(app, |j| {
                j.transition_approval(approval_id, "stale", None, None, Some("host"))
            })
            .await?;
            return Err("stale".into());
        }
        Outcome::Moved(status) => status,
    };
    let result = match approval.runtime.as_str() {
        "codex" => codex_protocol::approval_result(&approval.request, answer)?,
        "claude" => super::claude_protocol::approval_result(&approval.request, answer)?,
        _ => super::hermes::approval_result(&approval.request, answer)?,
    };
    // The decision is durable before delivery, so a failed delivery is visible instead of retried as a new permission.
    let won = host
        .write(app, |j| {
            j.transition_approval(
                approval_id,
                target.as_str(),
                Some(answer),
                Some("pending"),
                Some(by),
            )
        })
        .await?;
    if !won {
        let now = host
            .read(app, |conn| store::approval(conn, approval_id))
            .await?
            .ok_or("expired")?;
        return Ok(json!({"status":now.status,"alreadyResolved":true,"approval":now.view()}));
    }
    let delivered = match approval.runtime.as_str() {
        "codex" => {
            app.state::<crate::codex_agent::CodexManager>()
                .respond_native(
                    &approval.connection_id,
                    approval.generation,
                    &approval.native_id,
                    result,
                )
                .await
        }
        runtime => match session_key(host, &approval) {
            Some(key) if runtime == "claude" => {
                app.state::<crate::claude_agent::ClaudeManager>()
                    .respond_native(&key, approval.generation, &approval.native_id, result)
                    .await
            }
            Some(key) => {
                super::hermes::respond(app, &key, approval.generation, &approval.native_id, result)
                    .await
            }
            None => Err("stale".into()),
        },
    };
    let delivery = if delivered.is_ok() {
        "delivered"
    } else {
        "failed"
    };
    host.write(app, |j| j.set_delivery(approval_id, delivery))
        .await?;
    Ok(json!({"status":target.as_str(),"delivery":delivery,"alreadyResolved":false}))
}

/// Process key of a per-task runtime session that may still hold the request.
fn session_key(host: &TaskHost, approval: &store::ApprovalRow) -> Option<String> {
    host.sessions
        .live
        .lock()
        .unwrap()
        .get(&approval.task_id)
        .filter(|l| l.runtime == approval.runtime && l.runtime != "codex")
        .map(|l| l.native.clone())
}

/// The runtime process that asked is still running and still waits for this answer.
async fn runtime_waits(app: &AppHandle, host: &TaskHost, approval: &store::ApprovalRow) -> bool {
    match approval.runtime.as_str() {
        "codex" => {
            app.state::<crate::codex_agent::CodexManager>()
                .has_request(
                    &approval.connection_id,
                    approval.generation,
                    &approval.native_id,
                )
                .await
        }
        runtime => match session_key(host, approval) {
            Some(key) if runtime == "claude" => {
                app.state::<crate::claude_agent::ClaudeManager>()
                    .has_request(&key, approval.generation, &approval.native_id)
                    .await
            }
            Some(key) => {
                super::hermes::has_request(app, &key, approval.generation, &approval.native_id)
                    .await
            }
            None => false,
        },
    }
}

/// Closes the session and forgets the native thread, keeping the history.
pub(crate) async fn reset_session(
    app: &AppHandle,
    host: &TaskHost,
    task_id: &str,
) -> Result<(), String> {
    if host.sessions.is_live(task_id) || host.sessions.driving.lock().unwrap().contains(task_id) {
        interrupt(app, host, task_id, true).await?;
    }
    host.write(app, |j| {
        if j.task(task_id)?.is_none() {
            return Ok(());
        }
        j.edit_state(task_id, |s| {
            *s = store::TaskState::default();
        })?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_match_the_renderer() {
        assert_eq!(error_code("Error: not-installed"), "not-installed");
        assert_eq!(error_code("busy"), "busy");
        assert_eq!(error_code("something odd"), "agent-error");
    }

    #[test]
    fn deltas_need_a_cursor_and_coalesce() {
        let tasks = Sessions::default();
        assert_eq!(
            tasks.buffer_delta("t", "message.delta", &json!({"text":"a"})),
            None
        );
        tasks
            .live
            .lock()
            .unwrap()
            .insert("t".into(), Live::new("codex", "th".into(), "c".into(), 1));
        assert_eq!(
            tasks.buffer_delta("t", "message.delta", &json!({"text":"a"})),
            None
        );
        tasks.live.lock().unwrap().get_mut("t").unwrap().cursor = Some("m".into());
        assert_eq!(
            tasks.buffer_delta("t", "message.delta", &json!({"text":"a"})),
            Some(true)
        );
        assert_eq!(
            tasks.buffer_delta("t", "message.delta", &json!({"text":"b"})),
            Some(false)
        );
        assert_eq!(
            tasks.buffer_delta("t", "reasoning.delta", &json!({"text":"r"})),
            Some(false)
        );
        assert_eq!(
            tasks.live.lock().unwrap()["t"].buffer,
            vec![("m".to_owned(), "ab".to_owned(), "r".to_owned(), None)]
        );
        assert_eq!(tasks.task_for("c", "th").as_deref(), Some("t"));
        assert_eq!(tasks.task_for("other", "th"), None);
    }
}
