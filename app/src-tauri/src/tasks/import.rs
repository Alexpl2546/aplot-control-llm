//! One-time import of the renderer's workspace snapshot, per runtime.
//!
//! Importing a runtime makes the host the owner of its conversations. IDs of
//! tasks, messages and queued prompts are kept. The snapshot as it was before
//! the import is stored with the import record, and a rollback writes the host's
//! current conversations back into the snapshot so the old renderer path can
//! continue without losing what happened since.
use super::store::{self, Journal, TaskConfig, TaskState, TurnRow};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

const WORKSPACE_KEY: &str = crate::agent_workspace::KEY;

fn read_workspace(conn: &Connection) -> Result<Option<Value>, String> {
    conn.query_row(
        "SELECT value_json FROM kv WHERE key=?1",
        [WORKSPACE_KEY],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|raw| serde_json::from_str(&raw).map_err(|_| "workspace-invalid".to_owned()))
    .transpose()
}

fn text(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

pub(crate) fn status(conn: &Connection, runtime: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT status FROM agent_task_imports WHERE runtime=?1",
        [runtime],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Imports `runtime` once. A rolled-back runtime stays with the renderer until
/// `force` is set (an explicit re-enable).
pub(crate) fn import(conn: &mut Connection, runtime: &str, force: bool) -> Result<usize, String> {
    match status(conn, runtime)?.as_deref() {
        Some("active") => return Ok(0),
        Some(_) if !force => return Ok(0),
        _ => {}
    }
    let envelope = read_workspace(conn)?;
    if envelope.as_ref().is_some_and(|v| v["version"] != 2) {
        return Err("workspace-version".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM agent_task_imports WHERE runtime=?1", [runtime])
        .map_err(|e| e.to_string())?;
    let mut imported = Vec::new();
    {
        let mut journal = Journal::new(&tx);
        let data = envelope
            .as_ref()
            .map(|v| &v["data"])
            .cloned()
            .unwrap_or(Value::Null);
        for task in data["tasks"].as_array().into_iter().flatten() {
            let Some(id) = text(&task["id"]) else {
                continue;
            };
            if task["runtime"].as_str().unwrap_or("hermes") != runtime {
                continue;
            }
            let thread = &data["threads"][&id];
            if !thread.is_object() || journal.task(&id)?.is_some() {
                continue;
            }
            import_task(&mut journal, &id, runtime, task, thread)?;
            imported.push(id);
        }
    }
    tx.execute(
        "INSERT INTO agent_task_imports(runtime,status,source_revision,backup_json,task_ids_json,imported_at) VALUES(?1,'active',?2,?3,?4,?5)",
        params![
            runtime,
            envelope.as_ref().and_then(|v| v["revision"].as_i64()).unwrap_or(0),
            envelope.map(|v| v.to_string()).unwrap_or_else(|| "null".into()),
            json!(imported).to_string(),
            store::now()
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(imported.len())
}

fn import_task(
    journal: &mut Journal,
    id: &str,
    runtime: &str,
    task: &Value,
    thread: &Value,
) -> Result<(), String> {
    journal.ensure_task(id, runtime)?;
    let entries = thread["entries"].as_array().cloned().unwrap_or_default();
    let same_runtime = thread["nativeRuntime"] == runtime;
    let native = if same_runtime {
        text(&thread["nativeSessionId"])
    } else {
        None
    };
    journal.set_config(
        id,
        &TaskConfig {
            model_id: text(&task["cloudModel"]).or_else(|| text(&task["codexModel"])),
            connection_id: text(&task["connectionId"]),
            reasoning: text(&task["reasoning"]),
            access_mode: text(&thread["accessMode"]).or_else(|| text(&task["accessMode"])),
            language: None,
            context: None,
            skills: text(&thread["skills"]),
        },
    )?;
    journal.set_state(
        id,
        &TaskState {
            // Same rule the renderer used on restore: history without a resumable session is closed.
            ended: !entries.is_empty() && native.is_none(),
            native_connection_id: if same_runtime {
                text(&thread["nativeConnectionId"])
            } else {
                None
            },
            native_session_id: native,
            actual_model_id: text(&thread["actualModelId"]),
            context: thread.get("context").filter(|v| v.is_object()).cloned(),
            children: thread["children"].as_array().cloned().unwrap_or_default(),
            ..TaskState::default()
        },
    )?;
    let mut seen = HashSet::new();
    for mut entry in entries {
        if !entry.is_object() {
            continue;
        }
        let mut entry_id = text(&entry["id"]).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if !seen.insert(entry_id.clone()) {
            entry_id = format!("{entry_id}:{}", seen.len());
            seen.insert(entry_id.clone());
        }
        entry["id"] = json!(entry_id);
        if entry["kind"] == "tool" && entry["status"] == "running" {
            entry["status"] = json!("unknown");
        }
        journal.upsert_message(id, &entry)?;
    }
    for prompt in thread["queue"].as_array().into_iter().flatten() {
        let Some(turn_id) = text(&prompt["id"]) else {
            continue;
        };
        journal.insert_turn(&TurnRow {
            id: turn_id,
            task_id: id.into(),
            status: "queued".into(),
            command_id: None,
            message_id: uuid::Uuid::new_v4().to_string(),
            input: json!({"text":prompt["text"],"attachments":prompt.get("attachments").cloned().unwrap_or(json!([])),"time":prompt["time"]}),
            native_turn_id: None,
            error: None,
            created_at: store::now(),
        })?;
    }
    Ok(())
}

/// Hands `runtime` back to the renderer. Refuses while a session is live so no
/// running agent loses its owner.
pub(crate) fn rollback(conn: &mut Connection, runtime: &str) -> Result<usize, String> {
    if status(conn, runtime)?.as_deref() != Some("active") {
        return Err("import-missing".into());
    }
    let ids = store::task_ids(conn, Some(runtime))?;
    for id in &ids {
        let task = store::read_task(conn, id)?.ok_or("task-missing")?;
        if task.state.live || task.state.pending || task.state.starting {
            return Err("tasks-busy".into());
        }
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut restored = 0;
    if let Some(mut envelope) = read_workspace(&tx)? {
        let threads = envelope["data"]["threads"]
            .as_object_mut()
            .ok_or("workspace-invalid")?;
        for id in &ids {
            let task = store::read_task(&tx, id)?.ok_or("task-missing")?;
            let mut thread = threads
                .get(id)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_else(Map::new);
            let queue = super::store::task_view(&tx, id)?
                .map(|view| view["turns"].as_array().cloned().unwrap_or_default())
                .unwrap_or_default()
                .into_iter()
                .filter(|turn| turn["status"] == "queued")
                .map(|turn| json!({"id":turn["id"],"text":turn["text"],"attachments":turn["attachments"],"time":turn["time"]}))
                .collect::<Vec<_>>();
            thread.insert("entries".into(), json!(store::messages(&tx, id)?));
            thread.insert("queue".into(), json!(queue));
            thread.insert("requests".into(), json!([]));
            thread.insert("ended".into(), json!(task.state.ended));
            for (key, value) in [
                (
                    "nativeSessionId",
                    task.state.native_session_id.map(Value::from),
                ),
                (
                    "nativeConnectionId",
                    task.state.native_connection_id.map(Value::from),
                ),
                ("actualModelId", task.state.actual_model_id.map(Value::from)),
                ("context", task.state.context),
            ] {
                match value {
                    Some(value) => thread.insert(key.into(), value),
                    None => thread.remove(key),
                };
            }
            thread.insert("nativeRuntime".into(), json!(runtime));
            thread.insert("children".into(), json!(task.state.children));
            threads.insert(id.clone(), Value::Object(thread));
            restored += 1;
        }
        let revision = envelope["revision"].as_u64().ok_or("workspace-invalid")? + 1;
        envelope["revision"] = json!(revision);
        // The renderer holds the old revision, so its next save reports a conflict and reloads.
        tx.execute(
            "UPDATE kv SET value_json=?2, updated_at=?3 WHERE key=?1",
            params![WORKSPACE_KEY, envelope.to_string(), store::now()],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM agent_tasks WHERE runtime=?1", [runtime])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE agent_task_imports SET status='rolled_back', rolled_back_at=?2 WHERE runtime=?1",
        params![runtime, store::now()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(conn: &Connection) {
        let data = json!({"version":2,"revision":4,"data":{
        "projects":[{"id":"p","path":"C:\\work"}],
        "tasks":[{"id":"codex-task","projectId":"p","runtime":"codex","cloudModel":"gpt-5","connectionId":"c1"},
                 {"id":"hermes-task","projectId":"p"}],
        "memory":[],
        "threads":{
          "codex-task":{"cwd":"C:\\work","draft":"unsent","nativeRuntime":"codex","nativeSessionId":"thread-1","nativeConnectionId":"c1",
            "entries":[{"id":"u1","kind":"user","text":"hi"},{"id":"tool-1","kind":"tool","text":"","status":"running"},{"id":"a1","kind":"assistant","text":"hello"}],
            "queue":[{"id":"q1","text":"next","time":5}]},
          "hermes-task":{"cwd":"C:\\work","entries":[{"id":"h1","kind":"user","text":"keep"}]}
        }}});
        conn.execute(
            "INSERT INTO kv(key,value_json,updated_at) VALUES(?1,?2,'now')",
            params![WORKSPACE_KEY, data.to_string()],
        )
        .unwrap();
    }

    #[test]
    fn import_keeps_ids_and_only_takes_the_runtime() {
        let mut conn = store::test_db();
        seed(&conn);
        assert_eq!(import(&mut conn, "codex", false).unwrap(), 1);
        // Idempotent: a second start never imports twice.
        assert_eq!(import(&mut conn, "codex", false).unwrap(), 0);
        let view = store::task_view(&conn, "codex-task").unwrap().unwrap();
        let ids: Vec<_> = view["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["u1", "tool-1", "a1"]);
        assert_eq!(view["messages"][1]["status"], "unknown");
        assert_eq!(view["turns"][0]["id"], "q1");
        assert_eq!(view["state"]["nativeSessionId"], "thread-1");
        assert_eq!(view["state"]["ended"], false);
        assert!(store::read_task(&conn, "hermes-task").unwrap().is_none());
        assert_eq!(store::server_runtimes(&conn).unwrap(), ["codex"]);
    }

    #[test]
    fn rollback_writes_host_history_back_and_keeps_client_fields() {
        let mut conn = store::test_db();
        seed(&conn);
        import(&mut conn, "codex", false).unwrap();
        {
            let tx = conn.transaction().unwrap();
            let mut j = Journal::new(&tx);
            j.upsert_message(
                "codex-task",
                &json!({"id":"a2","kind":"assistant","text":"after import"}),
            )
            .unwrap();
            drop(j);
            tx.commit().unwrap();
        }
        assert_eq!(rollback(&mut conn, "codex").unwrap(), 1);
        let envelope = read_workspace(&conn).unwrap().unwrap();
        assert_eq!(envelope["revision"], 5);
        let thread = &envelope["data"]["threads"]["codex-task"];
        assert_eq!(thread["draft"], "unsent");
        assert_eq!(thread["entries"].as_array().unwrap().len(), 4);
        assert_eq!(thread["entries"][3]["text"], "after import");
        assert_eq!(thread["queue"][0]["id"], "q1");
        assert_eq!(thread["nativeSessionId"], "thread-1");
        assert_eq!(
            envelope["data"]["threads"]["hermes-task"]["entries"][0]["text"],
            "keep"
        );
        assert!(store::server_runtimes(&conn).unwrap().is_empty());
        assert!(store::read_task(&conn, "codex-task").unwrap().is_none());
        // Rolled back stays with the renderer on the next start until re-enabled.
        assert_eq!(import(&mut conn, "codex", false).unwrap(), 0);
        assert_eq!(import(&mut conn, "codex", true).unwrap(), 1);
    }

    #[test]
    fn rollback_refuses_while_a_turn_runs() {
        let mut conn = store::test_db();
        seed(&conn);
        import(&mut conn, "codex", false).unwrap();
        conn.execute(
            "UPDATE agent_tasks SET state_json=json_set(state_json,'$.pending',json('true'))",
            [],
        )
        .unwrap();
        assert_eq!(rollback(&mut conn, "codex").unwrap_err(), "tasks-busy");
    }

    #[test]
    fn fresh_install_is_server_owned() {
        let mut conn = store::test_db();
        assert_eq!(import(&mut conn, "codex", false).unwrap(), 0);
        assert_eq!(store::server_runtimes(&conn).unwrap(), ["codex"]);
    }
}
