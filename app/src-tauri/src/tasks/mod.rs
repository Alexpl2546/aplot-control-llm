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
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
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
    let (result, _) = host.write(&app, |j| accept_send(j, &request)).await?;
    driver::drive(app.clone(), request.task_id.clone());
    Ok(result)
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
}
