//! Agent tasks owned by the host process instead of the window.
//!
//! The window is a client: it reads a snapshot with a cursor, then follows the
//! `task_events` journal through a Tauri channel. Sending a message, stopping,
//! answering an approval and resetting a session are commands; the host
//! drives the runtime and records the outcome. Runtimes move one at a time:
//! [`HOST_RUNTIMES`] lists the ones whose sessions are owned here; the others
//! still use the renderer path.
pub(crate) mod approvals;
pub(crate) mod claude;
pub(crate) mod claude_protocol;
pub(crate) mod codex;
pub(crate) mod codex_protocol;
pub(crate) mod driver;
pub(crate) mod hermes;
pub(crate) mod import;
pub(crate) mod store;

use crate::db::DbState;
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use tauri::{ipc::Channel, AppHandle, Manager, State, Webview};

/// Runtimes whose task sessions the host owns.
pub(crate) const HOST_RUNTIMES: &[&str] = &["codex", "claude", "hermes"];
/// Commands from the desktop window. Remote devices get their own scope later.
const LOCAL_SCOPE: &str = "local";
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_ATTACHMENTS: usize = 32;
const MAX_QUEUED: usize = 10;
const REPLAY_PAGE: i64 = 1000;

#[derive(Default)]
pub struct TaskHost {
    /// Serializes journal writes and fan-out so subscribers see events in `seq` order.
    publish: tokio::sync::Mutex<()>,
    /// One subscription per webview; a reload replaces the old channel.
    subscribers: std::sync::Mutex<HashMap<String, Channel<Value>>>,
    /// A command id is only allowed to dispatch once even if two windows send
    /// the same Codex control at the same time.
    codex_controls: tokio::sync::Mutex<()>,
    /// Task IDs whose Codex thread is being forked. Send holds this lock while
    /// it accepts a turn, so a fork cannot race a new turn onto its source or
    /// accidentally create an orphaned native thread for its destination.
    codex_fork_reservations: tokio::sync::Mutex<HashSet<String>>,
    pub(crate) sessions: driver::Sessions,
}

impl TaskHost {
    /// Runs `edit` in one transaction and publishes the events it recorded.
    pub(crate) async fn write<T>(
        &self,
        app: &AppHandle,
        edit: impl FnOnce(&mut store::Journal) -> Result<T, String>,
    ) -> Result<T, String> {
        let _order = self.publish.lock().await;
        let db = app.state::<DbState>();
        let (output, events) = {
            let mut conn = db.0.lock().await;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            let result = {
                let mut journal = store::Journal::new(&tx);
                edit(&mut journal).map(|output| (output, std::mem::take(&mut journal.events)))
            };
            let (output, events) = result?;
            tx.commit().map_err(|e| e.to_string())?;
            (output, events)
        };
        self.fan_out(events);
        Ok(output)
    }
    pub(crate) async fn read<T>(
        &self,
        app: &AppHandle,
        read: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let db = app.state::<DbState>();
        let conn = db.0.lock().await;
        read(&conn)
    }
    /// Live-only frames (voice capture) that change no stored state.
    pub(crate) fn transient(&self, task_id: &str, frame: &Value) {
        let message = json!({"type":"transient","taskId":task_id,"frame":frame});
        self.subscribers
            .lock()
            .unwrap()
            .retain(|_, channel| channel.send(message.clone()).is_ok());
    }
    fn fan_out(&self, events: Vec<Value>) {
        if events.is_empty() {
            return;
        }
        let message = json!({"type":"events","events":events});
        self.subscribers
            .lock()
            .unwrap()
            .retain(|_, channel| channel.send(message.clone()).is_ok());
    }
}

/// Creates nothing: schema comes from migration 3. Imports runtimes that just
/// moved to the host and settles work interrupted by the previous exit.
pub(crate) fn startup(conn: &mut Connection) -> Result<(), String> {
    store::recover(conn)?;
    for runtime in HOST_RUNTIMES {
        import::import(conn, runtime, false)?;
    }
    Ok(())
}

fn host_runtime(conn: &Connection, runtime: &str) -> Result<(), String> {
    if !HOST_RUNTIMES.contains(&runtime)
        || !store::server_runtimes(conn)?.iter().any(|r| r == runtime)
    {
        return Err("runtime-not-hosted".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_tasks_snapshot(
    app: AppHandle,
    host: State<'_, TaskHost>,
) -> Result<Value, String> {
    let _order = host.publish.lock().await;
    host.read(&app, |conn| {
        let mut tasks = Vec::new();
        for id in store::task_ids(conn, None)? {
            if let Some(view) = store::task_view(conn, &id)? {
                tasks.push(view);
            }
        }
        Ok(json!({"cursor":store::cursor(conn)?,"hostRuntimes":store::server_runtimes(conn)?,"tasks":tasks}))
    })
    .await
}

/// Replays events after `after`, then streams new ones. Replay and registration
/// happen under the publish lock, so no event falls between them.
#[tauri::command]
pub async fn agent_tasks_subscribe(
    app: AppHandle,
    webview: Webview,
    host: State<'_, TaskHost>,
    after: i64,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let _order = host.publish.lock().await;
    let mut cursor = after;
    loop {
        let page = host
            .read(&app, |conn| store::events_after(conn, cursor, REPLAY_PAGE))
            .await?;
        let Some(page) = page else {
            on_event
                .send(json!({"type":"resync"}))
                .map_err(|e| e.to_string())?;
            break;
        };
        let Some(last) = page.last().and_then(|e| e["seq"].as_i64()) else {
            break;
        };
        on_event
            .send(json!({"type":"events","events":page}))
            .map_err(|e| e.to_string())?;
        cursor = last;
    }
    host.subscribers
        .lock()
        .unwrap()
        .insert(webview.label().to_owned(), on_event);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendRequest {
    command_id: String,
    task_id: String,
    runtime: String,
    text: String,
    #[serde(default)]
    attachments: Vec<Value>,
    #[serde(default)]
    config: Option<store::TaskConfig>,
}

fn request_hash(request: &SendRequest) -> String {
    let canonical =
        json!({"taskId":request.task_id,"text":request.text,"attachments":request.attachments});
    Sha256::digest(canonical.to_string().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Accepts a message into the task's durable queue. The reply means the turn
/// is stored, not that it ran; progress follows as events. Repeating the same
/// `commandId` returns the first result; the same id with other content is refused.
pub(crate) fn accept_send(
    j: &mut store::Journal,
    request: &SendRequest,
) -> Result<(Value, bool), String> {
    let hash = request_hash(request);
    if let Some(result) = j.command(LOCAL_SCOPE, &request.command_id, &hash)? {
        return Ok((result, false));
    }
    if request.command_id.is_empty() || request.command_id.len() > 128 {
        return Err("command-id".into());
    }
    if request.text.len() > MAX_TEXT_BYTES
        || request.attachments.len() > MAX_ATTACHMENTS
        || (request.text.trim().is_empty() && request.attachments.is_empty())
    {
        return Err("message-limit".into());
    }
    host_runtime(j.tx, &request.runtime)?;
    crate::agent_workspace::task_root(j.tx, &request.task_id)?;
    let task = j.ensure_task(&request.task_id, &request.runtime)?;
    if task.state.ended {
        return Err("closed".into());
    }
    if j.turns(&request.task_id, "queued")?.len() >= MAX_QUEUED {
        return Err("queue-limit".into());
    }
    if let Some(config) = &request.config {
        j.set_config(&request.task_id, config)?;
    }
    let turn_id = uuid::Uuid::new_v4().to_string();
    j.insert_turn(&store::TurnRow {
        id: turn_id.clone(),
        task_id: request.task_id.clone(),
        status: "queued".into(),
        command_id: Some(request.command_id.clone()),
        message_id: uuid::Uuid::new_v4().to_string(),
        input: json!({"text":request.text.trim(),"attachments":request.attachments,"time":store::millis()}),
        native_turn_id: None,
        error: None,
        created_at: store::now(),
    })?;
    let revision = j.task(&request.task_id)?.map(|t| t.revision).unwrap_or(0);
    let result = json!({"commandId":request.command_id,"taskId":request.task_id,"turnId":turn_id,"status":"queued","aggregateRevision":revision});
    j.record_command(
        LOCAL_SCOPE,
        &request.command_id,
        "send",
        &request.task_id,
        &hash,
        &result,
    )?;
    Ok((result, true))
}

#[tauri::command]
pub async fn agent_task_send(
    app: AppHandle,
    host: State<'_, TaskHost>,
    request: SendRequest,
) -> Result<Value, String> {
    let fork_reservations = host.codex_fork_reservations.lock().await;
    if fork_reservations.contains(&request.task_id) {
        return Err("busy".into());
    }
    let (result, _) = host.write(&app, |j| accept_send(j, &request)).await?;
    drop(fork_reservations);
    driver::drive(app.clone(), request.task_id.clone());
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SteerRequest {
    command_id: String,
    task_id: String,
    expected_turn_id: String,
    expected_generation: u64,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewRequest {
    command_id: String,
    task_id: String,
    expected_generation: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForkRequest {
    command_id: String,
    source_task_id: String,
    task_id: String,
    expected_generation: u64,
}

#[derive(Clone)]
struct CodexBinding {
    thread_id: String,
    connection_id: String,
    generation: u64,
    cwd: String,
}

#[derive(Clone, Debug)]
struct WorkspaceTaskInfo {
    runtime: Option<String>,
    project_id: String,
    connection_id: Option<String>,
    model_id: Option<String>,
    parent_task_id: Option<String>,
}

fn workspace_task_info(conn: &Connection, task_id: &str) -> Result<WorkspaceTaskInfo, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM kv WHERE key=?1",
            [crate::agent_workspace::KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let saved: Value =
        serde_json::from_str(&raw.ok_or("project-missing")?).map_err(|_| "workspace-invalid")?;
    let task = saved["data"]["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id))
        .ok_or("task-missing")?;
    Ok(WorkspaceTaskInfo {
        runtime: task["runtime"].as_str().map(str::to_owned),
        project_id: task["projectId"].as_str().ok_or("task-missing")?.to_owned(),
        connection_id: task["connectionId"].as_str().map(str::to_owned),
        model_id: task["cloudModel"]
            .as_str()
            .or_else(|| task["codexModel"].as_str())
            .map(str::to_owned),
        parent_task_id: task["parentTaskId"].as_str().map(str::to_owned),
    })
}

fn same_workspace_path(left: &str, right: &str) -> bool {
    let normalize = |value: &str| value.replace('/', "\\").trim_end_matches('\\').to_owned();
    normalize(left).eq_ignore_ascii_case(&normalize(right))
}

fn command_hash(value: Value) -> String {
    Sha256::digest(value.to_string().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn valid_control_id(id: &str) -> bool {
    !id.trim().is_empty() && id.len() <= 128
}

async fn codex_binding(
    app: &AppHandle,
    host: &TaskHost,
    task_id: &str,
    expected_generation: u64,
) -> Result<(CodexBinding, store::TaskRow), String> {
    let (task, cwd, workspace) = host
        .read(app, |conn| {
            let task = store::read_task(conn, task_id)?.ok_or("task-missing")?;
            let cwd = crate::agent_workspace::task_root(conn, task_id)?;
            let workspace = workspace_task_info(conn, task_id)?;
            Ok((task, cwd, workspace))
        })
        .await?;
    if task.runtime != "codex" {
        return Err("runtime-changed".into());
    }
    if task.state.ended || !task.state.live {
        return Err("closed".into());
    }
    if task.state.native_generation != Some(expected_generation) {
        return Err("stale".into());
    }
    let connection_id = task.state.native_connection_id.clone().ok_or("closed")?;
    if workspace
        .runtime
        .as_deref()
        .is_some_and(|runtime| runtime != "codex")
    {
        return Err("runtime-changed".into());
    }
    if workspace
        .connection_id
        .as_deref()
        .is_some_and(|configured| configured != connection_id)
    {
        return Err("changed".into());
    }
    if task
        .config
        .connection_id
        .as_deref()
        .is_some_and(|configured| configured != connection_id)
    {
        return Err("changed".into());
    }
    if workspace
        .model_id
        .as_deref()
        .zip(task.config.model_id.as_deref())
        .is_some_and(|(configured, active)| configured != active)
    {
        return Err("changed".into());
    }
    let thread_id = task.state.native_session_id.clone().ok_or("closed")?;
    let binding = {
        let live_sessions = host.sessions.live.lock().unwrap();
        let live = live_sessions.get(task_id).ok_or("closed")?;
        if live.runtime != "codex"
            || live.generation != expected_generation
            || live.connection_id != connection_id
            || live.native != thread_id
            || live.cwd != cwd
        {
            return Err("stale".into());
        }
        CodexBinding {
            thread_id,
            connection_id,
            generation: live.generation,
            cwd,
        }
    };
    Ok((binding, task))
}

fn validate_steer_target(
    live: &driver::Live,
    expected_turn_id: &str,
    expected_generation: u64,
) -> Result<(), String> {
    if live.runtime != "codex" || live.generation != expected_generation {
        return Err("stale".into());
    }
    if live.turn.is_none() || live.native_turn.as_deref() != Some(expected_turn_id) {
        return Err("stale".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_task_steer(
    app: AppHandle,
    host: State<'_, TaskHost>,
    request: SteerRequest,
) -> Result<Value, String> {
    let _control = host.codex_controls.lock().await;
    if !valid_control_id(&request.command_id) {
        return Err("command-id".into());
    }
    let text = request.text.trim();
    if text.is_empty() || text.len() > MAX_TEXT_BYTES {
        return Err("message-limit".into());
    }
    let hash = command_hash(json!({
        "action":"codex-steer",
        "taskId":request.task_id,
        "expectedTurnId":request.expected_turn_id,
        "expectedGeneration":request.expected_generation,
        "text":text,
    }));
    if let Some(result) = host
        .read(&app, |conn| {
            store::command(conn, LOCAL_SCOPE, &request.command_id, &hash)
        })
        .await?
    {
        return Ok(result);
    }
    if request.expected_generation == 0 || request.expected_turn_id.trim().is_empty() {
        return Err("stale".into());
    }
    let (binding, task) =
        codex_binding(&app, &host, &request.task_id, request.expected_generation).await?;
    if !task.state.pending {
        return Err("stale".into());
    }
    let running = host
        .read(&app, |conn| store::turns(conn, &request.task_id, "running"))
        .await?;
    if running.len() != 1
        || running[0].native_turn_id.as_deref() != Some(request.expected_turn_id.as_str())
    {
        return Err("stale".into());
    }
    {
        let live_sessions = host.sessions.live.lock().unwrap();
        let live = live_sessions.get(&request.task_id).ok_or("closed")?;
        validate_steer_target(live, &request.expected_turn_id, binding.generation)?;
    }
    let codex = app.state::<crate::codex_agent::CodexManager>();
    codex
        .steer_on_generation(
            &binding.connection_id,
            binding.generation,
            &binding.thread_id,
            &request.expected_turn_id,
            &request.command_id,
            text,
        )
        .await?;
    let result = json!({
        "commandId":request.command_id,
        "taskId":request.task_id,
        "status":"accepted",
        "turnId":request.expected_turn_id,
    });
    host.write(&app, |j| {
        if let Some(saved) = j.command(LOCAL_SCOPE, &request.command_id, &hash)? {
            return Ok(saved);
        }
        j.upsert_message(
            &request.task_id,
            &json!({
                "id":format!("steer:{}", request.command_id),
                "kind":"user",
                "text":text,
                "time":store::millis(),
            }),
        )?;
        j.record_command(
            LOCAL_SCOPE,
            &request.command_id,
            "codex-steer",
            &request.task_id,
            &hash,
            &result,
        )?;
        Ok(result)
    })
    .await
}

fn accept_review(
    j: &mut store::Journal,
    request: &ReviewRequest,
    binding: &CodexBinding,
    hash: &str,
    local_turn_id: &str,
) -> Result<(Value, bool), String> {
    if let Some(saved) = j.command(LOCAL_SCOPE, &request.command_id, hash)? {
        return Ok((saved, false));
    }
    let task = j.task(&request.task_id)?.ok_or("task-missing")?;
    if task.runtime != "codex"
        || !task.state.live
        || task.state.ended
        || task.state.pending
        || task.state.native_generation != Some(binding.generation)
        || task.state.native_session_id.as_deref() != Some(binding.thread_id.as_str())
        || task.state.native_connection_id.as_deref() != Some(binding.connection_id.as_str())
        || crate::agent_workspace::task_root(j.tx, &request.task_id)? != binding.cwd
    {
        return Err("stale".into());
    }
    if !j.turns(&request.task_id, "running")?.is_empty()
        || !j.turns(&request.task_id, "queued")?.is_empty()
    {
        return Err("busy".into());
    }
    let message_id = format!("review:{}", request.command_id);
    let time = store::millis();
    j.upsert_message(
        &request.task_id,
        &json!({
            "id":message_id,
            "kind":"user",
            "text":"Review uncommitted changes",
            "time":time,
        }),
    )?;
    j.insert_turn(&store::TurnRow {
        id: local_turn_id.into(),
        task_id: request.task_id.clone(),
        status: "running".into(),
        command_id: Some(request.command_id.clone()),
        message_id,
        input: json!({"text":"Review uncommitted changes","attachments":[],"time":time}),
        native_turn_id: None,
        error: None,
        created_at: store::now(),
    })?;
    j.edit_state(&request.task_id, |state| {
        state.pending = true;
        state.starting = false;
        state.stopped = false;
        state.error.clear();
        state.io_error = None;
    })?;
    let result = json!({
        "commandId":request.command_id,
        "taskId":request.task_id,
        "status":"dispatching",
        "turnId":local_turn_id,
    });
    j.record_command(
        LOCAL_SCOPE,
        &request.command_id,
        "codex-review",
        &request.task_id,
        hash,
        &result,
    )?;
    Ok((result, true))
}

#[tauri::command]
pub async fn agent_task_review(
    app: AppHandle,
    host: State<'_, TaskHost>,
    request: ReviewRequest,
) -> Result<Value, String> {
    let _control = host.codex_controls.lock().await;
    if !valid_control_id(&request.command_id) {
        return Err("command-id".into());
    }
    if request.expected_generation == 0 {
        return Err("stale".into());
    }
    let hash = command_hash(json!({
        "action":"codex-review",
        "taskId":request.task_id,
        "expectedGeneration":request.expected_generation,
        "target":"uncommittedChanges",
    }));
    if let Some(result) = host
        .read(&app, |conn| {
            store::command(conn, LOCAL_SCOPE, &request.command_id, &hash)
        })
        .await?
    {
        return Ok(result);
    }
    let (binding, task) =
        codex_binding(&app, &host, &request.task_id, request.expected_generation).await?;
    if task.state.pending {
        return Err("busy".into());
    }
    {
        let live_sessions = host.sessions.live.lock().unwrap();
        let live = live_sessions.get(&request.task_id).ok_or("closed")?;
        if live.turn.is_some() || live.native_turn.is_some() {
            return Err("busy".into());
        }
    }
    let local_turn_id = uuid::Uuid::new_v4().to_string();
    let (receipt, fresh) = host
        .write(&app, |j| {
            accept_review(j, &request, &binding, &hash, &local_turn_id)
        })
        .await?;
    if !fresh {
        return Ok(receipt);
    }
    let reserved = {
        let mut live_sessions = host.sessions.live.lock().unwrap();
        match live_sessions.get_mut(&request.task_id) {
            Some(live)
                if live.runtime == "codex"
                    && live.generation == binding.generation
                    && live.connection_id == binding.connection_id
                    && live.native == binding.thread_id
                    && live.cwd == binding.cwd
                    && live.turn.is_none()
                    && live.native_turn.is_none() =>
            {
                live.turn = Some(local_turn_id.clone());
                true
            }
            _ => false,
        }
    };
    if !reserved {
        fail_review(&app, &host, &request, &hash, &local_turn_id, "stale").await?;
        return Err("stale".into());
    }
    let codex = app.state::<crate::codex_agent::CodexManager>();
    let response = match codex
        .review_on_generation(
            &binding.connection_id,
            binding.generation,
            &binding.thread_id,
        )
        .await
    {
        Ok(response) => response,
        Err(error) if error == "timeout" => {
            // A timed-out RPC can still have started the review. Give its
            // notification a moment to reach this host, then use the worker's
            // active-turn state to distinguish that case from a failed start.
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            match codex
                .thread_active_on_generation(
                    &binding.connection_id,
                    binding.generation,
                    &binding.thread_id,
                )
                .await
            {
                Ok(true) => match active_review_turn(&host, &request.task_id, &local_turn_id) {
                    Some(native_turn_id) => json!({
                        "turn":{"id":native_turn_id},
                        "reviewThreadId":binding.thread_id,
                    }),
                    // The start notification may be in transit; leave the
                    // reserved host turn pending so Stop can latch on it.
                    None => return Err(error),
                },
                _ => {
                    fail_review(&app, &host, &request, &hash, &local_turn_id, &error).await?;
                    return Err(error);
                }
            }
        }
        Err(error) => {
            fail_review(&app, &host, &request, &hash, &local_turn_id, &error).await?;
            return Err(error);
        }
    };
    let native_turn_id = response["turn"]["id"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| active_review_turn(&host, &request.task_id, &local_turn_id));
    let Some(native_turn_id) = native_turn_id else {
        fail_review(&app, &host, &request, &hash, &local_turn_id, "protocol").await?;
        return Err("protocol".into());
    };
    let Some(review_thread_id) = response["reviewThreadId"]
        .as_str()
        .filter(|id| *id == binding.thread_id)
    else {
        fail_review(&app, &host, &request, &hash, &local_turn_id, "protocol").await?;
        return Err("protocol".into());
    };
    let owns_review_turn = {
        let mut live_sessions = host.sessions.live.lock().unwrap();
        match live_sessions.get_mut(&request.task_id) {
            Some(live)
                if live.generation == binding.generation
                    && live.connection_id == binding.connection_id
                    && live.native == binding.thread_id
                    && live.turn.as_deref() == Some(local_turn_id.as_str()) =>
            {
                if live
                    .native_turn
                    .as_deref()
                    .is_some_and(|current| current != native_turn_id)
                {
                    false
                } else {
                    live.native_turn = Some(native_turn_id.clone());
                    true
                }
            }
            _ => false,
        }
    };
    let stop_requested = host
        .sessions
        .stopping
        .lock()
        .unwrap()
        .remove(&request.task_id);
    let should_stop = owns_review_turn && stop_requested;
    let result = json!({
        "commandId":request.command_id,
        "taskId":request.task_id,
        "status":"accepted",
        "turnId":native_turn_id,
        "reviewThreadId":review_thread_id,
    });
    host.write(&app, |j| {
        // The reader may have completed this turn before review/start replied.
        // Only annotate it while the host row is still active; never resurrect
        // a terminal turn from a late RPC response.
        if j.turn(&local_turn_id)?
            .is_some_and(|turn| matches!(turn.status.as_str(), "queued" | "running"))
        {
            j.set_turn(&local_turn_id, "running", Some(&native_turn_id), None)?;
        }
        j.update_command_result(LOCAL_SCOPE, &request.command_id, &hash, &result)?;
        Ok(())
    })
    .await?;
    if should_stop {
        let _ = codex
            .interrupt_on_generation(
                &binding.connection_id,
                binding.generation,
                &binding.thread_id,
                &native_turn_id,
            )
            .await;
    }
    Ok(result)
}

fn active_review_turn(host: &TaskHost, task_id: &str, local_turn_id: &str) -> Option<String> {
    host.sessions
        .live
        .lock()
        .unwrap()
        .get(task_id)
        .filter(|live| live.turn.as_deref() == Some(local_turn_id))
        .and_then(|live| live.native_turn.clone())
}

async fn fail_review(
    app: &AppHandle,
    host: &TaskHost,
    request: &ReviewRequest,
    hash: &str,
    local_turn_id: &str,
    error: &str,
) -> Result<(), String> {
    let can_fail = {
        let mut live_sessions = host.sessions.live.lock().unwrap();
        match live_sessions.get_mut(&request.task_id) {
            Some(live) if live.turn.as_deref() == Some(local_turn_id) => {
                if live.native_turn.is_some() {
                    // A native start event proves that Codex accepted the
                    // review; leave completion to the normal event path.
                    false
                } else {
                    live.turn = None;
                    true
                }
            }
            _ => true,
        }
    };
    if !can_fail {
        return Ok(());
    }
    host.sessions
        .stopping
        .lock()
        .unwrap()
        .remove(&request.task_id);
    let result = json!({
        "commandId":request.command_id,
        "taskId":request.task_id,
        "status":"failed",
        "error":error,
    });
    host.write(app, |j| {
        j.set_turn(local_turn_id, "failed", None, Some(error))?;
        j.edit_state(&request.task_id, |state| {
            state.pending = false;
            state.starting = false;
            state.error = driver::error_code(error);
            state.io_error = Some(error.chars().take(1000).collect());
        })?;
        j.update_command_result(LOCAL_SCOPE, &request.command_id, hash, &result)?;
        Ok(())
    })
    .await
}

fn validate_fork_workspace(
    conn: &Connection,
    source_task_id: &str,
    task_id: &str,
    binding: &CodexBinding,
    source: &store::TaskRow,
) -> Result<WorkspaceTaskInfo, String> {
    let source_workspace = workspace_task_info(conn, source_task_id)?;
    let target = workspace_task_info(conn, task_id)?;
    let source_root = crate::agent_workspace::task_root(conn, source_task_id)?;
    let target_root = crate::agent_workspace::task_root(conn, task_id)?;
    if source_workspace
        .runtime
        .as_deref()
        .is_some_and(|runtime| runtime != "codex")
        || target.runtime.as_deref() != Some("codex")
    {
        return Err("runtime-changed".into());
    }
    if source_workspace.project_id != target.project_id
        || target.parent_task_id.as_deref() != Some(source_task_id)
        || !same_workspace_path(&source_root, &binding.cwd)
        || !same_workspace_path(&target_root, &binding.cwd)
    {
        return Err("task-binding".into());
    }
    if source_workspace
        .connection_id
        .as_deref()
        .is_some_and(|id| id != binding.connection_id)
        || target.connection_id.as_deref() != Some(binding.connection_id.as_str())
    {
        return Err("changed".into());
    }
    let source_model = source
        .config
        .model_id
        .as_deref()
        .or(source.state.actual_model_id.as_deref());
    if source_model.is_some_and(|model| target.model_id.as_deref() != Some(model)) {
        return Err("changed".into());
    }
    Ok(target)
}

fn accept_fork(
    j: &mut store::Journal,
    request: &ForkRequest,
    binding: &CodexBinding,
    hash: &str,
) -> Result<(Value, bool, store::TaskConfig), String> {
    if let Some(saved) = j.command(LOCAL_SCOPE, &request.command_id, hash)? {
        let task = j.task(&request.task_id)?.ok_or("task-missing")?;
        return Ok((saved, false, task.config));
    }
    let source = j.task(&request.source_task_id)?.ok_or("task-missing")?;
    if source.runtime != "codex"
        || !source.state.live
        || source.state.pending
        || source.state.ended
        || source.state.native_generation != Some(binding.generation)
        || source.state.native_session_id.as_deref() != Some(binding.thread_id.as_str())
        || source.state.native_connection_id.as_deref() != Some(binding.connection_id.as_str())
    {
        return Err("stale".into());
    }
    validate_fork_workspace(
        j.tx,
        &request.source_task_id,
        &request.task_id,
        binding,
        &source,
    )?;
    if j.task(&request.task_id)?.is_some() {
        return Err("task-exists".into());
    }
    if !j.turns(&request.source_task_id, "running")?.is_empty()
        || !j.turns(&request.source_task_id, "queued")?.is_empty()
    {
        return Err("busy".into());
    }
    let mut config = source.config.clone();
    config.connection_id = Some(binding.connection_id.clone());
    if config.model_id.is_none() {
        config.model_id = source.state.actual_model_id.clone();
    }
    let child = j.ensure_task(&request.task_id, "codex")?;
    j.set_config(&request.task_id, &config)?;
    for message in store::messages(j.tx, &request.source_task_id)? {
        j.upsert_message(&request.task_id, &message)?;
    }
    j.edit_state(&request.task_id, |state| {
        state.starting = true;
        state.live = false;
        state.pending = false;
        state.ended = false;
        state.native_connection_id = Some(binding.connection_id.clone());
        state.actual_model_id = config.model_id.clone();
    })?;
    let result = json!({
        "commandId":request.command_id,
        "sourceTaskId":request.source_task_id,
        "taskId":request.task_id,
        "status":"dispatching",
    });
    j.record_command(
        LOCAL_SCOPE,
        &request.command_id,
        "codex-fork",
        &request.task_id,
        hash,
        &result,
    )?;
    let _ = child;
    Ok((result, true, config))
}

async fn fail_fork(
    app: &AppHandle,
    host: &TaskHost,
    request: &ForkRequest,
    hash: &str,
    error: &str,
) -> Result<(), String> {
    let result = json!({
        "commandId":request.command_id,
        "sourceTaskId":request.source_task_id,
        "taskId":request.task_id,
        "status":if error == "timeout" { "unknown" } else { "failed" },
        "error":error,
    });
    host.write(app, |j| {
        j.edit_state(&request.task_id, |state| {
            state.live = false;
            state.starting = false;
            state.pending = false;
            state.ended = true;
            state.native_session_id = None;
            state.native_generation = None;
            state.error = driver::error_code(error);
            state.io_error = Some(error.chars().take(1000).collect());
        })?;
        j.update_command_result(LOCAL_SCOPE, &request.command_id, hash, &result)?;
        Ok(())
    })
    .await
}

async fn fork_reserved(
    app: &AppHandle,
    host: &TaskHost,
    request: &ForkRequest,
    hash: &str,
) -> Result<Value, String> {
    let (binding, source) = codex_binding(
        app,
        host,
        &request.source_task_id,
        request.expected_generation,
    )
    .await?;
    if source.state.pending {
        return Err("busy".into());
    }
    let source_turns = host
        .read(app, |conn| {
            Ok((
                store::turns(conn, &request.source_task_id, "running")?,
                store::turns(conn, &request.source_task_id, "queued")?,
                store::read_task(conn, &request.task_id)?,
            ))
        })
        .await?;
    if !source_turns.0.is_empty() || !source_turns.1.is_empty() {
        return Err("busy".into());
    }
    if source_turns.2.is_some() {
        return Err("task-exists".into());
    }
    host.read(app, |conn| {
        validate_fork_workspace(
            conn,
            &request.source_task_id,
            &request.task_id,
            &binding,
            &source,
        )?;
        Ok(())
    })
    .await?;
    {
        let live_sessions = host.sessions.live.lock().unwrap();
        let live = live_sessions.get(&request.source_task_id).ok_or("closed")?;
        if live.turn.is_some() || live.native_turn.is_some() {
            return Err("busy".into());
        }
    }
    let codex = app.state::<crate::codex_agent::CodexManager>();
    if codex
        .thread_active_on_generation(
            &binding.connection_id,
            binding.generation,
            &binding.thread_id,
        )
        .await?
    {
        return Err("busy".into());
    }
    let mcp_config = codex::mcp_server_config(app, &request.task_id).await?;
    let (receipt, fresh, config) = host
        .write(app, |j| accept_fork(j, request, &binding, hash))
        .await?;
    if !fresh {
        return Ok(receipt);
    }
    let policy = codex_protocol::policy(
        config.access_mode.as_deref().unwrap_or("manual"),
        &binding.cwd,
    );
    let response = match codex
        .fork_on_generation(
            &binding.connection_id,
            binding.generation,
            &binding.thread_id,
            &binding.cwd,
            config.model_id.as_deref(),
            policy.approval_policy,
            policy.sandbox,
            mcp_config,
        )
        .await
    {
        Ok(response) => response,
        Err(error) => {
            fail_fork(app, host, request, hash, &error).await?;
            return Err(error);
        }
    };
    let Some(forked_thread) = response["thread"]["id"]
        .as_str()
        .filter(|id| !id.is_empty() && *id != binding.thread_id)
        .map(str::to_owned)
    else {
        fail_fork(app, host, request, hash, "protocol").await?;
        return Err("protocol".into());
    };
    let result = json!({
        "commandId":request.command_id,
        "sourceTaskId":request.source_task_id,
        "taskId":request.task_id,
        "status":"accepted",
        "nativeSessionId":forked_thread,
    });
    let live = driver::Live::new(
        "codex",
        forked_thread.clone(),
        binding.connection_id.clone(),
        binding.generation,
        binding.cwd.clone(),
    );
    let child_session_exists = host
        .sessions
        .live
        .lock()
        .unwrap()
        .contains_key(&request.task_id);
    if child_session_exists {
        fail_fork(app, host, request, hash, "task-exists").await?;
        return Err("task-exists".into());
    }
    host.sessions
        .live
        .lock()
        .unwrap()
        .insert(request.task_id.clone(), live);
    let accepted_result = result.clone();
    let write = host
        .write(app, |j| {
            let task = j.task(&request.task_id)?.ok_or("task-missing")?;
            let terminal = task.state.ended;
            let result = if terminal {
                json!({
                    "commandId":request.command_id,
                    "sourceTaskId":request.source_task_id,
                    "taskId":request.task_id,
                    "status":"unknown",
                    "error":"task-ended",
                })
            } else {
                accepted_result
            };
            if !terminal {
                // Notifications can arrive as soon as the new Live is visible.
                // Preserve any state they wrote; in particular, do not reset a
                // terminal or pending state from a late fork response.
                j.edit_state(&request.task_id, |state| {
                    state.live = true;
                    state.starting = false;
                    state.native_session_id = Some(forked_thread.clone());
                    state.native_connection_id = Some(binding.connection_id.clone());
                    state.native_generation = Some(binding.generation);
                    state.actual_model_id = config.model_id.clone();
                })?;
            }
            j.update_command_result(LOCAL_SCOPE, &request.command_id, hash, &result)?;
            Ok((result, !terminal))
        })
        .await;
    match write {
        Ok((result, true)) => Ok(result),
        Ok((result, false)) => {
            host.sessions.live.lock().unwrap().remove(&request.task_id);
            Ok(result)
        }
        Err(error) => {
            host.sessions.live.lock().unwrap().remove(&request.task_id);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn agent_task_fork(
    app: AppHandle,
    host: State<'_, TaskHost>,
    request: ForkRequest,
) -> Result<Value, String> {
    let _control = host.codex_controls.lock().await;
    if !valid_control_id(&request.command_id) {
        return Err("command-id".into());
    }
    if request.expected_generation == 0
        || request.source_task_id.is_empty()
        || request.task_id.is_empty()
        || request.task_id == request.source_task_id
    {
        return Err("task-binding".into());
    }
    let hash = command_hash(json!({
        "action":"codex-fork",
        "sourceTaskId":request.source_task_id,
        "taskId":request.task_id,
        "expectedGeneration":request.expected_generation,
    }));
    if let Some(result) = host
        .read(&app, |conn| {
            store::command(conn, LOCAL_SCOPE, &request.command_id, &hash)
        })
        .await?
    {
        return Ok(result);
    }
    if !driver::reserve_task_control(&host, &request.source_task_id) {
        return Err("busy".into());
    }
    {
        let mut reservations = host.codex_fork_reservations.lock().await;
        if reservations.contains(&request.source_task_id) || reservations.contains(&request.task_id)
        {
            driver::release_task_control(&app, &host, &request.source_task_id);
            return Err("busy".into());
        }
        reservations.insert(request.source_task_id.clone());
        reservations.insert(request.task_id.clone());
    }
    let result = fork_reserved(&app, &host, &request, &hash).await;
    {
        let mut reservations = host.codex_fork_reservations.lock().await;
        reservations.remove(&request.source_task_id);
        reservations.remove(&request.task_id);
    }
    driver::release_task_control(&app, &host, &request.source_task_id);
    result
}

/// Opens the task's runtime session without a turn (voice input needs a live
/// Hermes session). Returns the session handle the window shows.
#[tauri::command]
pub async fn agent_task_prepare(
    app: AppHandle,
    host: State<'_, TaskHost>,
    task_id: String,
    runtime: String,
    config: store::TaskConfig,
) -> Result<String, String> {
    let fork_reservations = host.codex_fork_reservations.lock().await;
    if fork_reservations.contains(&task_id) {
        return Err("busy".into());
    }
    let task = host
        .write(&app, |j| {
            host_runtime(j.tx, &runtime)?;
            crate::agent_workspace::task_root(j.tx, &task_id)?;
            let task = j.ensure_task(&task_id, &runtime)?;
            if task.state.ended {
                return Err("closed".into());
            }
            j.set_config(&task_id, &config)?;
            Ok(task)
        })
        .await?;
    drop(fork_reservations);
    driver::ensure_session(&app, &host, &task_id, &runtime, &config, &task.state).await?;
    Ok(format!("host:{task_id}"))
}

/// Starts the next queued message after a stop or error left the queue waiting.
#[tauri::command]
pub async fn agent_task_resume(app: AppHandle, task_id: String) -> Result<(), String> {
    driver::drive(app, task_id);
    Ok(())
}

#[tauri::command]
pub async fn agent_task_interrupt(
    app: AppHandle,
    host: State<'_, TaskHost>,
    task_id: String,
    close: bool,
) -> Result<(), String> {
    driver::interrupt(&app, &host, &task_id, close).await
}

#[tauri::command]
pub async fn agent_task_cancel_queued(
    app: AppHandle,
    host: State<'_, TaskHost>,
    task_id: String,
    turn_id: String,
) -> Result<(), String> {
    host.write(&app, |j| {
        match j.turn(&turn_id)? {
            Some(turn) if turn.task_id == task_id && turn.status == "queued" => {
                j.set_turn(&turn_id, "cancelled", None, Some("cancelled"))?;
            }
            _ => {}
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn agent_task_reset_session(
    app: AppHandle,
    host: State<'_, TaskHost>,
    task_id: String,
) -> Result<(), String> {
    driver::reset_session(&app, &host, &task_id).await
}

/// Codex takes the policy per turn, so a change applies to the next message.
/// Claude takes it at process start, so its live session is closed.
#[tauri::command]
pub async fn agent_task_access(
    app: AppHandle,
    host: State<'_, TaskHost>,
    task_id: String,
    mode: String,
) -> Result<(), String> {
    if !["manual", "full", "restricted"].contains(&mode.as_str()) {
        return Err("access-mode".into());
    }
    let requested = mode.clone();
    let runtime = host
        .write(&app, |j| {
            let Some(task) = j.task(&task_id)? else {
                return Ok(None);
            };
            j.set_config(
                &task_id,
                &store::TaskConfig {
                    access_mode: Some(mode),
                    ..task.config
                },
            )?;
            Ok(Some(task.runtime))
        })
        .await?;
    // Hermes switches between asking and full access live; a read-only sandbox needs a new session.
    if runtime.as_deref() == Some("hermes") && host.sessions.is_live(&task_id) {
        return crate::hermes_agent::set_access(
            &app.state(),
            &format!("host:{task_id}"),
            &requested,
        )
        .await;
    }
    // Claude fixes its permission mode at process start: the session must be restarted.
    if runtime.as_deref() == Some("claude") && host.sessions.is_live(&task_id) {
        driver::interrupt(&app, &host, &task_id, true).await?;
        return Err("new-session-required".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_approval_resolve(
    app: AppHandle,
    host: State<'_, TaskHost>,
    approval_id: String,
    result: Value,
) -> Result<Value, String> {
    driver::resolve(&app, &host, &approval_id, &result, "desktop").await
}

/// Hands a runtime's conversations back to the window (writes them into the
/// workspace snapshot). The window must reload afterwards.
#[tauri::command]
pub async fn agent_tasks_rollback(
    app: AppHandle,
    host: State<'_, TaskHost>,
    runtime: String,
) -> Result<usize, String> {
    let _order = host.publish.lock().await;
    let db = app.state::<DbState>();
    let mut conn = db.0.lock().await;
    import::rollback(&mut conn, &runtime)
}

/// Re-imports a rolled-back runtime from the current workspace snapshot.
#[tauri::command]
pub async fn agent_tasks_enable(
    app: AppHandle,
    host: State<'_, TaskHost>,
    runtime: String,
) -> Result<usize, String> {
    if !HOST_RUNTIMES.contains(&runtime.as_str()) {
        return Err("runtime-not-hosted".into());
    }
    let _order = host.publish.lock().await;
    let db = app.state::<DbState>();
    let mut conn = db.0.lock().await;
    import::import(&mut conn, &runtime, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn workspace(conn: &Connection) {
        let dir = std::env::temp_dir();
        let data = json!({"version":2,"revision":1,"data":{"projects":[{"id":"p","path":dir}],"tasks":[{"id":"t","projectId":"p","runtime":"codex"}],"threads":{},"memory":[]}});
        conn.execute(
            "INSERT INTO kv(key,value_json,updated_at) VALUES(?1,?2,'now')",
            params![crate::agent_workspace::KEY, data.to_string()],
        )
        .unwrap();
    }
    fn codex_fork_workspace(conn: &Connection, target_connection: &str, target_model: &str) {
        let raw: String = conn
            .query_row(
                "SELECT value_json FROM kv WHERE key=?1",
                [crate::agent_workspace::KEY],
                |row| row.get(0),
            )
            .unwrap();
        let mut saved: Value = serde_json::from_str(&raw).unwrap();
        let tasks = saved["data"]["tasks"].as_array_mut().unwrap();
        tasks[0]["connectionId"] = json!("profile-1");
        tasks[0]["cloudModel"] = json!("gpt-6");
        tasks.push(json!({
            "id":"child",
            "projectId":"p",
            "runtime":"codex",
            "parentTaskId":"t",
            "connectionId":target_connection,
            "cloudModel":target_model,
        }));
        conn.execute(
            "UPDATE kv SET value_json=?2 WHERE key=?1",
            params![crate::agent_workspace::KEY, saved.to_string()],
        )
        .unwrap();
    }
    fn send(conn: &mut Connection, id: &str, text: &str) -> Result<(Value, bool), String> {
        let tx = conn.transaction().unwrap();
        let request = SendRequest {
            command_id: id.into(),
            task_id: "t".into(),
            runtime: "codex".into(),
            text: text.into(),
            attachments: vec![],
            config: None,
        };
        let out = {
            let mut j = store::Journal::new(&tx);
            accept_send(&mut j, &request)
        };
        tx.commit().unwrap();
        out
    }

    #[test]
    fn repeating_a_command_returns_the_same_turn() {
        let mut conn = store::test_db();
        workspace(&conn);
        startup(&mut conn).unwrap();
        let (first, fresh) = send(&mut conn, "cmd-1", "hello").unwrap();
        assert!(fresh);
        let (again, fresh) = send(&mut conn, "cmd-1", "hello").unwrap();
        assert!(!fresh);
        assert_eq!(first, again);
        assert_eq!(
            send(&mut conn, "cmd-1", "different").unwrap_err(),
            "command-conflict"
        );
        let turns: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_turns", [], |r| r.get(0))
            .unwrap();
        assert_eq!(turns, 1);
        assert_eq!(first["status"], "queued");
    }

    #[test]
    fn messages_wait_in_order_and_the_queue_is_bounded() {
        let mut conn = store::test_db();
        workspace(&conn);
        startup(&mut conn).unwrap();
        for n in 0..MAX_QUEUED {
            send(&mut conn, &format!("c{n}"), &format!("m{n}")).unwrap();
        }
        assert_eq!(send(&mut conn, "overflow", "x").unwrap_err(), "queue-limit");
        let view = store::task_view(&conn, "t").unwrap().unwrap();
        let texts: Vec<_> = view["turns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["text"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            texts,
            (0..MAX_QUEUED).map(|n| format!("m{n}")).collect::<Vec<_>>()
        );
    }

    #[test]
    fn only_hosted_runtimes_accept_commands() {
        let mut conn = store::test_db();
        workspace(&conn);
        startup(&mut conn).unwrap();
        let tx = conn.transaction().unwrap();
        let mut j = store::Journal::new(&tx);
        let request = SendRequest {
            command_id: "c".into(),
            task_id: "t".into(),
            runtime: "other".into(),
            text: "hi".into(),
            attachments: vec![],
            config: None,
        };
        assert_eq!(
            accept_send(&mut j, &request).unwrap_err(),
            "runtime-not-hosted"
        );
        let unknown = SendRequest {
            task_id: "missing".into(),
            runtime: "codex".into(),
            ..request
        };
        assert_eq!(accept_send(&mut j, &unknown).unwrap_err(), "task-missing");
    }

    #[test]
    fn a_closed_session_refuses_new_messages() {
        let mut conn = store::test_db();
        workspace(&conn);
        startup(&mut conn).unwrap();
        send(&mut conn, "c1", "first").unwrap();
        conn.execute(
            "UPDATE agent_tasks SET state_json=json_set(state_json,'$.ended',json('true'))",
            [],
        )
        .unwrap();
        assert_eq!(send(&mut conn, "c2", "second").unwrap_err(), "closed");
    }

    #[test]
    fn steer_requires_the_same_active_native_turn_and_worker_generation() {
        let mut live = driver::Live::new(
            "codex",
            "thread".into(),
            "connection".into(),
            12,
            "C:\\project".into(),
        );
        live.turn = Some("host-turn".into());
        live.native_turn = Some("native-turn".into());
        assert!(validate_steer_target(&live, "native-turn", 12).is_ok());
        assert_eq!(
            validate_steer_target(&live, "stale-turn", 12).unwrap_err(),
            "stale"
        );
        assert_eq!(
            validate_steer_target(&live, "native-turn", 13).unwrap_err(),
            "stale"
        );
        live.turn = None;
        assert_eq!(
            validate_steer_target(&live, "native-turn", 12).unwrap_err(),
            "stale"
        );
    }

    #[test]
    fn review_acceptance_is_a_host_turn_and_command_idempotent() {
        let mut conn = store::test_db();
        workspace(&conn);
        startup(&mut conn).unwrap();
        let cwd = crate::agent_workspace::task_root(&conn, "t").unwrap();
        let request = ReviewRequest {
            command_id: "review-command".into(),
            task_id: "t".into(),
            expected_generation: 7,
        };
        let binding = CodexBinding {
            thread_id: "codex-thread".into(),
            connection_id: "profile-connection".into(),
            generation: 7,
            cwd,
        };
        let hash = command_hash(json!({
            "action":"codex-review",
            "taskId":"t",
            "expectedGeneration":7,
            "target":"uncommittedChanges",
        }));
        let tx = conn.transaction().unwrap();
        let (first, duplicate) = {
            let mut j = store::Journal::new(&tx);
            j.ensure_task("t", "codex").unwrap();
            j.edit_state("t", |state| {
                state.live = true;
                state.native_session_id = Some("codex-thread".into());
                state.native_connection_id = Some("profile-connection".into());
                state.native_generation = Some(7);
            })
            .unwrap();
            let first = accept_review(&mut j, &request, &binding, &hash, "local-turn-1").unwrap();
            let duplicate =
                accept_review(&mut j, &request, &binding, &hash, "local-turn-2").unwrap();
            (first, duplicate)
        };
        tx.commit().unwrap();
        assert!(first.1);
        assert!(!duplicate.1);
        assert_eq!(first.0["status"], "dispatching");
        assert_eq!(duplicate.0, first.0);
        assert_eq!(
            store::turns(&conn, "t", "running")
                .unwrap()
                .iter()
                .map(|turn| turn.id.as_str())
                .collect::<Vec<_>>(),
            vec!["local-turn-1"]
        );
        let state = store::read_task(&conn, "t").unwrap().unwrap().state;
        assert!(state.pending);
        assert_eq!(state.native_generation, Some(7));
    }

    #[test]
    fn fork_acceptance_copies_history_with_the_verified_profile_and_model_once() {
        let mut conn = store::test_db();
        workspace(&conn);
        codex_fork_workspace(&conn, "profile-1", "gpt-6");
        startup(&mut conn).unwrap();
        let cwd = crate::agent_workspace::task_root(&conn, "t").unwrap();
        let request = ForkRequest {
            command_id: "fork-command".into(),
            source_task_id: "t".into(),
            task_id: "child".into(),
            expected_generation: 9,
        };
        let binding = CodexBinding {
            thread_id: "parent-thread".into(),
            connection_id: "profile-1".into(),
            generation: 9,
            cwd,
        };
        let hash = command_hash(json!({
            "action":"codex-fork",
            "sourceTaskId":"t",
            "taskId":"child",
            "expectedGeneration":9,
        }));
        let tx = conn.transaction().unwrap();
        let (first, duplicate) = {
            let mut j = store::Journal::new(&tx);
            j.ensure_task("t", "codex").unwrap();
            j.set_config(
                "t",
                &store::TaskConfig {
                    model_id: Some("gpt-6".into()),
                    connection_id: Some("profile-1".into()),
                    ..Default::default()
                },
            )
            .unwrap();
            j.edit_state("t", |state| {
                state.live = true;
                state.native_session_id = Some("parent-thread".into());
                state.native_connection_id = Some("profile-1".into());
                state.native_generation = Some(9);
            })
            .unwrap();
            j.upsert_message(
                "t",
                &json!({"id":"history-1","kind":"assistant","text":"Existing history"}),
            )
            .unwrap();
            let first = accept_fork(&mut j, &request, &binding, &hash).unwrap();
            let duplicate = accept_fork(&mut j, &request, &binding, &hash).unwrap();
            (first, duplicate)
        };
        tx.commit().unwrap();
        assert!(first.1);
        assert!(!duplicate.1);
        assert_eq!(first.0["status"], "dispatching");
        assert_eq!(duplicate.0, first.0);
        let child = store::read_task(&conn, "child").unwrap().unwrap();
        assert_eq!(child.runtime, "codex");
        assert_eq!(child.config.connection_id.as_deref(), Some("profile-1"));
        assert_eq!(child.config.model_id.as_deref(), Some("gpt-6"));
        assert_eq!(
            store::messages(&conn, "child").unwrap()[0]["text"],
            "Existing history"
        );
        assert_eq!(
            store::read_task(&conn, "child")
                .unwrap()
                .unwrap()
                .state
                .starting,
            true
        );
    }

    #[test]
    fn fork_rejects_a_child_with_a_different_connection_profile() {
        let mut conn = store::test_db();
        workspace(&conn);
        codex_fork_workspace(&conn, "other-profile", "gpt-6");
        startup(&mut conn).unwrap();
        let cwd = crate::agent_workspace::task_root(&conn, "t").unwrap();
        let tx = conn.transaction().unwrap();
        let source = {
            let mut j = store::Journal::new(&tx);
            j.ensure_task("t", "codex").unwrap();
            j.set_config(
                "t",
                &store::TaskConfig {
                    model_id: Some("gpt-6".into()),
                    connection_id: Some("profile-1".into()),
                    ..Default::default()
                },
            )
            .unwrap();
            j.edit_state("t", |state| {
                state.live = true;
                state.native_session_id = Some("parent-thread".into());
                state.native_connection_id = Some("profile-1".into());
                state.native_generation = Some(9);
            })
            .unwrap();
            j.task("t").unwrap().unwrap()
        };
        tx.commit().unwrap();
        let binding = CodexBinding {
            thread_id: "parent-thread".into(),
            connection_id: "profile-1".into(),
            generation: 9,
            cwd,
        };
        assert_eq!(
            validate_fork_workspace(&conn, "t", "child", &binding, &source).unwrap_err(),
            "changed"
        );
    }
}
