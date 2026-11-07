//! Persisted agent workspace data and task-scoped read operations.
//!
//! This module contains only the saved workspace envelope and database-backed
//! reads. Filesystem relocation, folder access, and legacy imports remain in
//! the desktop host.

use crate::tasks::store;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path};

/// Existing application database key. The serialized envelope remains v2.
pub const KEY: &str = "agent-workspace-v2";
const MAX_BYTES: usize = 32 * 1024 * 1024;

/// Read the saved envelope without applying schema validation, as before.
pub fn read_saved(conn: &Connection) -> Result<Option<Value>, String> {
    let raw: Option<String> = conn
        .query_row("SELECT value_json FROM kv WHERE key=?1", [KEY], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|s| serde_json::from_str::<Value>(&s).map_err(|_| "workspace-invalid".to_owned()))
        .transpose()
}

/// Validate the saved workspace data object, preserving desktop limits.
pub fn validate(data: &Value) -> Result<(), String> {
    if !data.is_object() || data.to_string().len() > MAX_BYTES {
        return Err("workspace-limit".into());
    }
    let projects = data["projects"].as_array().ok_or("workspace-invalid")?;
    let tasks = data["tasks"].as_array().ok_or("workspace-invalid")?;
    if projects.len() > 1000
        || tasks.len() > 5000
        || !data["threads"].is_object()
        || !data["memory"].is_array()
    {
        return Err("workspace-invalid".into());
    }
    if let Some(presets) = data.get("presets") {
        let rows = presets.as_array().ok_or("workspace-invalid")?;
        let mut ids = HashSet::new();
        if rows.len() > 500 {
            return Err("workspace-limit".into());
        }
        for preset in rows {
            if !preset["id"]
                .as_str()
                .is_some_and(|id| !id.is_empty() && ids.insert(id))
                || !preset["name"]
                    .as_str()
                    .is_some_and(|name| !name.trim().is_empty() && name.chars().count() <= 80)
                || !preset["instructions"]
                    .as_str()
                    .is_some_and(|instructions| instructions.len() <= 64000)
                || !matches!(
                    preset["runtime"].as_str(),
                    Some("hermes" | "codex" | "claude")
                )
            {
                return Err("workspace-invalid".into());
            }
        }
    }
    let mut ids = HashSet::new();
    for project in projects {
        let id = project["id"].as_str().ok_or("workspace-invalid")?;
        if id.is_empty()
            || project
                .get("instructions")
                .is_some_and(|value| !value.as_str().is_some_and(|s| s.len() <= 32000))
            || !ids.insert(id)
            || !project["path"]
                .as_str()
                .is_some_and(|path| Path::new(path).is_absolute())
        {
            return Err("workspace-invalid".into());
        }
    }
    let mut task_ids = HashSet::new();
    for task in tasks {
        if !task["projectId"]
            .as_str()
            .is_some_and(|id| ids.contains(id))
            || !task["id"].as_str().is_some_and(|id| task_ids.insert(id))
        {
            return Err("workspace-invalid".into());
        }
    }
    Ok(())
}

/// Save workspace data and advance its revision in the caller's transaction.
/// The caller controls commit or rollback so workspace records can be committed
/// atomically with task journal writes.
pub fn write_saved_in_transaction(
    tx: &Transaction<'_>,
    data: Value,
    revision: u64,
) -> Result<u64, String> {
    validate(&data)?;
    write_saved_inner(tx, data, revision)
}

fn write_saved_inner(tx: &Transaction<'_>, data: Value, revision: u64) -> Result<u64, String> {
    let current = read_saved(tx)?;
    if current.as_ref().is_some_and(|value| value["version"] != 2) {
        return Err("workspace-version".into());
    }
    if current
        .as_ref()
        .and_then(|value| value["revision"].as_u64())
        .unwrap_or(0)
        != revision
    {
        return Err("workspace-conflict".into());
    }
    let next = revision.checked_add(1).ok_or("workspace-limit")?;
    let envelope = json!({"version":2,"revision":next,"data":data});
    tx.execute(
        "INSERT INTO kv(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
        params![KEY, envelope.to_string(), chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(next)
}

/// Save workspace data in its own transaction, matching the desktop behavior.
pub fn write_saved(conn: &mut Connection, data: Value, revision: u64) -> Result<u64, String> {
    // Keep validation before transaction creation, as it was in the desktop.
    validate(&data)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let next = write_saved_inner(&tx, data, revision)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(next)
}

/// Resolve the saved project path for a task without requiring that the
/// project folder still exists. This is persisted ownership, not filesystem
/// validation.
pub fn task_project_path(conn: &Connection, task_id: &str) -> Result<String, String> {
    let saved = read_saved(conn)?.ok_or("project-missing")?;
    let data = &saved["data"];
    let project_id = data["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id))
        .map(|task| task["projectId"].clone())
        .ok_or("task-missing")?;
    data["projects"]
        .as_array()
        .and_then(|projects| projects.iter().find(|project| project["id"] == project_id))
        .and_then(|project| project["path"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| "project-missing".into())
}

fn read_active_caller(conn: &Connection, task_id: &str) -> Result<(Value, Value), String> {
    let saved = read_saved(conn)?.ok_or("workspace-missing")?;
    if saved["version"] != 2 {
        return Err("workspace-version".into());
    }
    let data = saved
        .get("data")
        .cloned()
        .ok_or_else(|| "workspace-invalid".to_owned())?;
    validate(&data)?;
    let caller = data["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id))
        .cloned()
        .ok_or_else(|| "task-not-active".to_owned())?;
    if is_unavailable(&caller) {
        return Err("task-not-active".into());
    }
    let row = store::read_task(conn, task_id)?.ok_or("task-not-active")?;
    if !row.state.pending || !row.state.live || row.state.ended || row.state.stopped {
        return Err("task-not-active".into());
    }
    Ok((data, caller))
}

fn is_unavailable(task: &Value) -> bool {
    json_truthy(&task["archived"]) || json_truthy(&task["deletedAt"])
}

fn json_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Read the project list visible to an active app-tool caller.
pub fn app_tool_list_projects(conn: &Connection, caller_task_id: &str) -> Result<Value, String> {
    let (data, _) = read_active_caller(conn, caller_task_id)?;
    let projects = data["projects"]
        .as_array()
        .ok_or("workspace-invalid")?
        .iter()
        .map(|project| {
            let mut item = serde_json::Map::new();
            if let Some(id) = project.get("id") {
                item.insert("id".into(), id.clone());
            }
            if let Some(name) = project.get("name") {
                item.insert("name".into(), name.clone());
            }
            Value::Object(item)
        })
        .collect::<Vec<_>>();
    Ok(json!({"projects":projects}))
}

/// Read agents available to an active caller, optionally filtered by project.
pub fn app_tool_list_agents(
    conn: &Connection,
    caller_task_id: &str,
    project_id: Option<&str>,
) -> Result<Value, String> {
    let (data, caller) = read_active_caller(conn, caller_task_id)?;
    let project_id = project_id.unwrap_or_else(|| caller["projectId"].as_str().unwrap_or_default());
    if !data["projects"]
        .as_array()
        .is_some_and(|projects| projects.iter().any(|project| project["id"] == project_id))
    {
        return Err("project-missing".into());
    }
    let agents = data["presets"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|agent| Ok((agent, assigned_to_project(agent, project_id)?)))
        .collect::<Result<Vec<_>, String>>()?
        .into_iter()
        .filter(|(_, assigned)| *assigned)
        .map(|(agent, _)| agent)
        .map(|agent| {
            let model = agent["model"]
                .as_str()
                .filter(|model| !model.is_empty())
                .or_else(|| {
                    agent["binding"]["modelId"]
                        .as_str()
                        .filter(|model| !model.is_empty())
                });
            let title = agent["title"]
                .as_str()
                .filter(|title| !title.is_empty())
                .or_else(|| {
                    agent["templateId"]
                        .as_str()
                        .filter(|title| !title.is_empty())
                })
                .or_else(|| agent["name"].as_str());
            json!({
                "id":agent["id"],
                "name":agent["name"],
                "title":title,
                "runtime":agent["runtime"],
                "model":model,
                "inheritsCaller":model.is_none() && agent.get("binding").is_none_or(Value::is_null),
                "instructions":agent["instructions"].as_str().unwrap_or_default().chars().take(1000).collect::<String>(),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({"agents":agents}))
}

fn assigned_to_project(agent: &Value, project_id: &str) -> Result<bool, String> {
    match agent.get("projectIds") {
        None | Some(Value::Null) => Ok(true),
        Some(Value::Array(ids)) if ids.is_empty() => Ok(true),
        Some(Value::Array(ids)) => {
            if ids
                .iter()
                .all(|id| id.as_str().is_some_and(|id| !id.is_empty()))
            {
                Ok(ids.iter().any(|id| id.as_str() == Some(project_id)))
            } else {
                Err("workspace-invalid".into())
            }
        }
        _ => Err("workspace-invalid".into()),
    }
}

/// Read a delegated task's durable status and latest assistant result.
/// Caller identity and descendant ownership are checked against the validated
/// workspace on every call, including repeated calls during a wait loop.
pub fn app_tool_task_result(
    conn: &Connection,
    caller_task_id: &str,
    target_task_id: &str,
) -> Result<Value, String> {
    let (data, _) = read_active_caller(conn, caller_task_id)?;
    let tasks = data["tasks"].as_array().ok_or("workspace-invalid")?;
    let target = tasks
        .iter()
        .find(|task| task["id"] == target_task_id)
        .ok_or_else(|| "task-not-descendant".to_owned())?;
    let descendants = descendant_ids(caller_task_id, tasks);
    if !descendants.contains(target_task_id) {
        return Err("task-not-descendant".into());
    }
    if is_unavailable(target) {
        return Err("task-unavailable".into());
    }

    let view = store::task_view(conn, target_task_id)?;
    let latest_turn = latest_turn(conn, target_task_id)?;
    let state = view.as_ref().map(|task| &task["state"]);
    let error_code = state
        .and_then(|state| state["error"].as_str())
        .filter(|error| !error.is_empty());
    let stopped = state.is_some_and(|state| state["stopped"].as_bool() == Some(true));
    let waiting = view
        .as_ref()
        .and_then(|task| task["approvals"].as_array())
        .is_some_and(|approvals| !approvals.is_empty());
    let running = state.is_some_and(|state| {
        state["pending"].as_bool() == Some(true) || state["starting"].as_bool() == Some(true)
    });
    let result = view
        .as_ref()
        .and_then(|task| task["messages"].as_array())
        .and_then(|messages| {
            messages
                .iter()
                .rev()
                .find(|message| message["kind"] == "assistant")
        })
        .and_then(|message| message["text"].as_str())
        .unwrap_or_default();
    let latest_error = latest_turn
        .as_ref()
        .and_then(|(_, error)| error.as_deref())
        .filter(|error| !error.trim().is_empty());
    let latest_status = latest_turn.as_ref().map(|(status, _)| status.as_str());
    let fallback_status = || {
        if error_code.is_some() {
            "error"
        } else if stopped {
            "interrupted"
        } else if waiting {
            "waiting_for_user"
        } else if running {
            "running"
        } else if !result.is_empty() {
            "completed"
        } else {
            "queued"
        }
    };
    let status = match latest_status {
        Some("failed") => "error",
        Some("completed") if latest_error.is_some() => "error",
        Some("completed") => "completed",
        Some("interrupted" | "cancelled") => "interrupted",
        Some("running") if waiting => "waiting_for_user",
        Some("running") => "running",
        Some("queued") if waiting => "waiting_for_user",
        Some("queued") => "queued",
        _ => fallback_status(),
    };
    let mut response = json!({
        "taskId":target_task_id,
        "status":status,
        "result":tail_chars(result, 16_000),
    });
    if let Some(agent_name) = target.get("agentName") {
        response["agent"] = agent_name.clone();
    }
    if let Some(error) = state
        .and_then(|state| state["ioError"].as_str())
        .filter(|error| !error.is_empty())
        .or(error_code)
        .or(latest_error)
    {
        response["error"] = json!(error);
    }
    Ok(response)
}

fn latest_turn(
    conn: &Connection,
    task_id: &str,
) -> Result<Option<(String, Option<String>)>, String> {
    conn.query_row(
        "SELECT status,error FROM agent_turns WHERE task_id=?1 ORDER BY ord DESC LIMIT 1",
        [task_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn descendant_ids(parent_id: &str, tasks: &[Value]) -> HashSet<String> {
    let mut result = HashSet::new();
    for _ in 0..tasks.len() {
        let before = result.len();
        for task in tasks {
            if task["parentTaskId"]
                .as_str()
                .is_some_and(|parent| parent == parent_id || result.contains(parent))
            {
                if let Some(id) = task["id"].as_str().filter(|id| *id != parent_id) {
                    result.insert(id.to_owned());
                }
            }
        }
        if result.len() == before {
            break;
        }
    }
    result
}

fn tail_chars(value: &str, limit: usize) -> String {
    let count = value.chars().count();
    value.chars().skip(count.saturating_sub(limit)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::store::{Journal, TaskState, TurnRow};
    use rusqlite::Connection;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE kv(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);",
        )
        .unwrap();
        store::create_schema(&conn).unwrap();
        conn
    }

    fn workspace() -> Value {
        let path = std::env::temp_dir().to_string_lossy().into_owned();
        json!({
            "projects":[{"id":"project-a","name":"A","path":path},{"id":"project-b","name":"B","path":path}],
            "tasks":[
                {"id":"caller","projectId":"project-a","archived":false},
                {"id":"child","projectId":"project-a","parentTaskId":"caller","agentName":"Writer"},
                {"id":"child-failed","projectId":"project-a","parentTaskId":"caller"},
                {"id":"child-cancelled","projectId":"project-a","parentTaskId":"caller"},
                {"id":"grandchild","projectId":"project-a","parentTaskId":"child","agentName":"Reviewer"},
                {"id":"sibling","projectId":"project-a","parentTaskId":"other-caller"},
                {"id":"other-caller","projectId":"project-b"}
            ],
            "threads":{},
            "memory":[],
            "presets":[
                {"id":"agent-a","name":"Writer","title":"Writer job","runtime":"hermes","model":"model-a","instructions":"x"},
                {"id":"agent-b","name":"Other","runtime":"codex","instructions":"y","projectIds":["project-b"]},
                {"id":"agent-c","name":"Shared","runtime":"claude","instructions":"z","projectIds":[]}
            ]
        })
    }

    fn insert_task(conn: &mut Connection, id: &str, state: TaskState) {
        let tx = conn.transaction().unwrap();
        let mut journal = Journal::new(&tx);
        journal.ensure_task(id, "hermes").unwrap();
        journal.set_state(id, &state).unwrap();
        drop(journal);
        tx.commit().unwrap();
    }

    fn insert_terminal_turn(
        conn: &mut Connection,
        task_id: &str,
        status: &str,
        error: Option<&str>,
    ) {
        let turn_id = format!("{task_id}-{status}-turn");
        let tx = conn.transaction().unwrap();
        let mut journal = Journal::new(&tx);
        journal
            .insert_turn(&TurnRow {
                id: turn_id.clone(),
                task_id: task_id.into(),
                status: "running".into(),
                command_id: None,
                message_id: format!("{task_id}-input"),
                input: json!({"text":"task"}),
                native_turn_id: None,
                error: None,
                created_at: store::now(),
            })
            .unwrap();
        journal.set_turn(&turn_id, status, None, error).unwrap();
        drop(journal);
        tx.commit().unwrap();
    }

    #[test]
    fn saved_workspace_revision_and_validation_semantics_are_preserved() {
        let mut conn = test_db();
        let data = json!({"projects":[],"tasks":[],"threads":{},"memory":[]});
        assert_eq!(write_saved(&mut conn, data.clone(), 0).unwrap(), 1);
        assert_eq!(read_saved(&conn).unwrap().unwrap()["data"], data);
        assert!(write_saved(&mut conn, data.clone(), 0).is_err());
        conn.execute(
            "UPDATE kv SET value_json=?1 WHERE key=?2",
            params![
                json!({"version":99,"revision":1,"data":data}).to_string(),
                KEY
            ],
        )
        .unwrap();
        assert!(write_saved(&mut conn, data, 1).is_err());
    }

    #[test]
    fn an_outer_transaction_can_commit_or_rollback_workspace_data() {
        let mut conn = test_db();
        let data = workspace();
        {
            let tx = conn.transaction().unwrap();
            assert_eq!(write_saved_in_transaction(&tx, data.clone(), 0).unwrap(), 1);
            tx.rollback().unwrap();
        }
        assert!(read_saved(&conn).unwrap().is_none());
        let tx = conn.transaction().unwrap();
        assert_eq!(write_saved_in_transaction(&tx, data, 0).unwrap(), 1);
        tx.commit().unwrap();
        assert_eq!(read_saved(&conn).unwrap().unwrap()["revision"], 1);
    }

    #[test]
    fn project_path_uses_saved_task_ownership_without_folder_access() {
        let conn = test_db();
        let data = workspace();
        conn.execute(
            "INSERT INTO kv(key,value_json,updated_at) VALUES(?1,?2,'now')",
            params![
                KEY,
                json!({"version":2,"revision":1,"data":data}).to_string()
            ],
        )
        .unwrap();
        assert_eq!(
            task_project_path(&conn, "child").unwrap(),
            std::env::temp_dir().to_string_lossy()
        );
        assert_eq!(
            task_project_path(&conn, "missing").unwrap_err(),
            "task-missing"
        );
    }

    #[test]
    fn app_tools_require_active_callers_and_scope_results_to_descendants() {
        let mut conn = test_db();
        write_saved(&mut conn, workspace(), 0).unwrap();
        let mut caller_state = TaskState::default();
        caller_state.live = true;
        caller_state.pending = true;
        insert_task(&mut conn, "caller", caller_state.clone());

        let mut child_state = TaskState::default();
        insert_task(&mut conn, "child", child_state.clone());
        let tx = conn.transaction().unwrap();
        let mut journal = Journal::new(&tx);
        journal
            .upsert_message(
                "child",
                &json!({"id":"answer","kind":"assistant","text":"delegated result"}),
            )
            .unwrap();
        child_state.pending = false;
        journal.set_state("child", &child_state).unwrap();
        drop(journal);
        tx.commit().unwrap();
        insert_task(&mut conn, "grandchild", TaskState::default());
        insert_task(&mut conn, "child-failed", TaskState::default());
        insert_task(&mut conn, "child-cancelled", TaskState::default());
        insert_task(&mut conn, "sibling", TaskState::default());

        assert_eq!(
            app_tool_list_projects(&conn, "caller").unwrap(),
            json!({"projects":[{"id":"project-a","name":"A"},{"id":"project-b","name":"B"}]})
        );
        let agents = app_tool_list_agents(&conn, "caller", None).unwrap();
        assert_eq!(agents["agents"].as_array().unwrap().len(), 2);
        assert_eq!(agents["agents"][0]["model"], "model-a");
        assert_eq!(agents["agents"][1]["inheritsCaller"], true);
        let project_b_agents = app_tool_list_agents(&conn, "caller", Some("project-b")).unwrap();
        assert_eq!(project_b_agents["agents"].as_array().unwrap().len(), 3);
        assert_eq!(project_b_agents["agents"][1]["id"], "agent-b");
        assert!(app_tool_list_agents(&conn, "caller", Some("missing")).is_err());
        assert!(app_tool_list_agents(&conn, "caller", Some("")).is_err());

        let result = app_tool_task_result(&conn, "caller", "child").unwrap();
        assert_eq!(result["status"], "completed");
        assert_eq!(result["result"], "delegated result");
        assert_eq!(result["agent"], "Writer");
        assert_eq!(
            app_tool_task_result(&conn, "caller", "grandchild").unwrap()["status"],
            "queued"
        );
        insert_terminal_turn(&mut conn, "child", "completed", None);
        assert_eq!(
            app_tool_task_result(&conn, "caller", "child").unwrap()["status"],
            "completed"
        );
        insert_terminal_turn(&mut conn, "child", "interrupted", None);
        let partial = app_tool_task_result(&conn, "caller", "child").unwrap();
        assert_eq!(partial["status"], "interrupted");
        assert_eq!(partial["result"], "delegated result");
        insert_terminal_turn(&mut conn, "child-failed", "failed", Some("tool failed"));
        assert_eq!(
            app_tool_task_result(&conn, "caller", "child-failed").unwrap()["status"],
            "error"
        );
        insert_terminal_turn(
            &mut conn,
            "grandchild",
            "completed",
            Some("completion reported an error"),
        );
        let completed_error = app_tool_task_result(&conn, "caller", "grandchild").unwrap();
        assert_eq!(completed_error["status"], "error");
        assert_eq!(completed_error["error"], "completion reported an error");
        insert_terminal_turn(&mut conn, "child-cancelled", "cancelled", None);
        assert_eq!(
            app_tool_task_result(&conn, "caller", "child-cancelled").unwrap()["status"],
            "interrupted"
        );
        assert_eq!(
            app_tool_task_result(&conn, "caller", "sibling").unwrap_err(),
            "task-not-descendant"
        );

        caller_state.pending = false;
        let tx = conn.transaction().unwrap();
        let mut journal = Journal::new(&tx);
        journal.set_state("caller", &caller_state).unwrap();
        drop(journal);
        tx.commit().unwrap();
        assert_eq!(
            app_tool_list_projects(&conn, "caller").unwrap_err(),
            "task-not-active"
        );
        assert_eq!(
            app_tool_task_result(&conn, "caller", "child").unwrap_err(),
            "task-not-active"
        );

        caller_state.pending = true;
        caller_state.live = false;
        let tx = conn.transaction().unwrap();
        let mut journal = Journal::new(&tx);
        journal.set_state("caller", &caller_state).unwrap();
        drop(journal);
        tx.commit().unwrap();
        assert_eq!(
            app_tool_list_projects(&conn, "caller").unwrap_err(),
            "task-not-active"
        );
    }

    #[test]
    fn malformed_saved_workspace_is_rejected_before_app_tool_reads() {
        let conn = test_db();
        conn.execute(
            "INSERT INTO kv(key,value_json,updated_at) VALUES(?1,?2,'now')",
            params![
                KEY,
                json!({"version":2,"revision":1,"data":{"projects":[],"tasks":[],"threads":{}}})
                    .to_string()
            ],
        )
        .unwrap();
        assert_eq!(
            app_tool_list_projects(&conn, "caller").unwrap_err(),
            "workspace-invalid"
        );
    }

    #[test]
    fn malformed_agent_project_assignments_are_rejected_instead_of_substring_matched() {
        for malformed in [
            json!("project-b-extra"),
            json!(["project-b", ""]),
            json!(["project-b", 3]),
        ] {
            let mut conn = test_db();
            let mut data = workspace();
            data["presets"][1]["projectIds"] = malformed;
            write_saved(&mut conn, data, 0).unwrap();
            let mut state = TaskState::default();
            state.live = true;
            state.pending = true;
            insert_task(&mut conn, "caller", state);

            assert_eq!(
                app_tool_list_agents(&conn, "caller", Some("project-b")).unwrap_err(),
                "workspace-invalid"
            );
        }
    }

    #[test]
    fn cyclic_ancestry_never_authorizes_the_caller_as_its_own_descendant() {
        let mut conn = test_db();
        let mut data = workspace();
        data["tasks"][0]["parentTaskId"] = json!("grandchild");
        write_saved(&mut conn, data, 0).unwrap();
        let mut state = TaskState::default();
        state.live = true;
        state.pending = true;
        insert_task(&mut conn, "caller", state);

        assert_eq!(
            app_tool_task_result(&conn, "caller", "caller").unwrap_err(),
            "task-not-descendant"
        );
    }
}
