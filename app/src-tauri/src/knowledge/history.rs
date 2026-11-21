//! One-action import of saved project task and plain chat history.
use super::outbox;
use crate::db::DbState;
use aplot_core::workspace;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, State};
use uuid::Uuid;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryImportResult {
    pub agent_tasks: usize,
    pub plain_chats: usize,
    pub notes: usize,
    pub skipped: usize,
    pub pending_notes: usize,
}

#[tauri::command]
pub(crate) async fn knowledge_import_project_history(
    app: AppHandle,
    db: State<'_, DbState>,
    project_id: String,
) -> Result<HistoryImportResult, String> {
    let project_id = Uuid::parse_str(&project_id).map_err(|_| "knowledge-project".to_owned())?;
    let mut result = {
        let mut conn = db.0.lock().await;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let result = queue_project_history(&tx, project_id)?;
        tx.commit().map_err(|error| error.to_string())?;
        result
    };

    // Scope publication to this project; unrelated pending notes stay in the outbox.
    let _ = outbox::publish_project(&app, project_id).await?;
    let conn = db.0.lock().await;
    result.pending_notes = outbox::pending_count_for_project(&*conn, project_id)?;
    Ok(result)
}

fn queue_project_history(
    conn: &Connection,
    project_id: Uuid,
) -> Result<HistoryImportResult, String> {
    let saved = workspace::read_saved(conn)?.ok_or_else(|| "knowledge-project".to_owned())?;
    if saved["version"] != 2 {
        return Err("workspace-version".into());
    }
    let data = &saved["data"];
    let project_key = project_id.to_string();
    let project = data["projects"]
        .as_array()
        .and_then(|projects| projects.iter().find(|item| item["id"] == project_key))
        .ok_or_else(|| "knowledge-project".to_owned())?;
    if outbox::write_vault(project).is_none() {
        return Err("knowledge-write-vault".into());
    }

    let mut result = HistoryImportResult::default();
    let mut seen_tasks = HashSet::new();
    for task in data["tasks"].as_array().into_iter().flatten() {
        if task["projectId"] != project_key || !task["deletedAt"].is_null() {
            continue;
        }
        let Some(task_id) = task["id"].as_str().filter(|id| !id.is_empty()) else {
            continue;
        };
        if !seen_tasks.insert(task_id.to_owned()) {
            continue;
        }

        let mut entries = read_legacy_entries(conn, data, &project_key, task_id)?;
        // Keep legacy-only rows, but let the host's current version win when an
        // entry ID appears in both stores.
        merge_entries(&mut entries, &read_host_entries(conn, task_id)?);
        let transcript = render_agent_entries(&entries).filter(|text| !text.trim().is_empty());
        let Some(transcript) = transcript else {
            continue;
        };

        let title = task["title"]
            .as_str()
            .filter(|title| !title.trim().is_empty())
            .unwrap_or("Agent task")
            .to_owned();
        let runtime = task["runtime"].as_str().unwrap_or("hermes");
        let created = task.get("createdAt").cloned().unwrap_or(Value::Null);
        let note_id = stable_note_id(project_id, "agent-task", task_id);
        let body = task_note(
            project,
            note_id,
            task_id,
            &title,
            runtime,
            &created,
            &transcript,
        );
        if body.len() as u64 > super::vault::MAX_NOTE_BYTES {
            result.skipped += 1;
            continue;
        }
        outbox::queue_project_note(conn, project, note_id, title, body)?;
        result.agent_tasks += 1;
        result.notes += 1;
    }

    for conversation in project_conversations(conn, &project_key)? {
        let Some(chat_id) = conversation["id"].as_str().filter(|id| !id.is_empty()) else {
            continue;
        };
        let Some(transcript) = render_plain_chat(&conversation["thread"]["messages"]) else {
            continue;
        };
        let title = conversation["title"]
            .as_str()
            .filter(|title| !title.trim().is_empty())
            .unwrap_or("Chat history")
            .to_owned();
        let created = conversation
            .get("createdAt")
            .cloned()
            .unwrap_or(Value::Null);
        let note_id = stable_note_id(project_id, "plain-chat", chat_id);
        let body = chat_note(project, note_id, chat_id, &title, &created, &transcript);
        if body.len() as u64 > super::vault::MAX_NOTE_BYTES {
            result.skipped += 1;
            continue;
        }
        outbox::queue_project_note(conn, project, note_id, title, body)?;
        result.plain_chats += 1;
        result.notes += 1;
    }
    Ok(result)
}

fn read_host_entries(conn: &Connection, task_id: &str) -> Result<Vec<Value>, String> {
    let mut statement = conn
        .prepare("SELECT entry_json FROM agent_messages WHERE task_id=?1 ORDER BY ord")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([task_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let raw = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(raw
        .into_iter()
        .filter_map(|entry| serde_json::from_str(&entry).ok())
        .collect())
}

fn read_legacy_entries(
    conn: &Connection,
    data: &Value,
    project_id: &str,
    task_id: &str,
) -> Result<Vec<Value>, String> {
    let mut merged = Vec::new();
    let imports_exist = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_task_imports')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| error.to_string())?;
    if imports_exist {
        let mut statement = conn
            .prepare(
                "SELECT backup_json FROM agent_task_imports WHERE status='active' ORDER BY runtime",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        for row in rows {
            let raw = row.map_err(|error| error.to_string())?;
            let Ok(backup) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            let backup_data = &backup["data"];
            let belongs_to_project = backup_data["tasks"].as_array().is_some_and(|tasks| {
                tasks
                    .iter()
                    .any(|task| task["id"] == task_id && task["projectId"] == project_id)
            });
            if belongs_to_project {
                if let Some(entries) = backup_data["threads"][task_id]["entries"].as_array() {
                    merge_entries(&mut merged, entries);
                }
            }
        }
    }
    if let Some(entries) = data["threads"][task_id]["entries"].as_array() {
        merge_entries(&mut merged, entries);
    }
    Ok(merged)
}

fn merge_entries(merged: &mut Vec<Value>, source: &[Value]) {
    let mut positions = merged
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            entry["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(|id| (id.to_owned(), index))
        })
        .collect::<HashMap<_, _>>();
    for entry in source {
        let Some(id) = entry["id"].as_str().filter(|id| !id.is_empty()) else {
            merged.push(entry.clone());
            continue;
        };
        if let Some(index) = positions.get(id).copied() {
            merged[index] = entry.clone();
        } else {
            positions.insert(id.to_owned(), merged.len());
            merged.push(entry.clone());
        }
    }
}

fn project_conversations(conn: &Connection, project_id: &str) -> Result<Vec<Value>, String> {
    let exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_conversations')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| error.to_string())?;
    if !exists {
        return Ok(Vec::new());
    }
    let mut statement = conn
        .prepare("SELECT conversation_json FROM chat_conversations ORDER BY updated_at,id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut conversations = Vec::new();
    for row in rows {
        let raw = row.map_err(|error| error.to_string())?;
        let Ok(conversation) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if conversation["projectId"] == project_id {
            conversations.push(conversation);
        }
    }
    Ok(conversations)
}

fn render_agent_entries(entries: &[Value]) -> Option<String> {
    let mut body = String::new();
    for entry in entries {
        let kind = entry["kind"].as_str().unwrap_or_default();
        let label = match kind {
            "user" => "User".to_owned(),
            "assistant" => "Assistant".to_owned(),
            "notice" => "Notice".to_owned(),
            "tool" => {
                let name = entry["name"]
                    .as_str()
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or("tool")
                    .replace(['\r', '\n', '`'], " ");
                let status = entry["status"]
                    .as_str()
                    .filter(|status| !status.trim().is_empty())
                    .map(|status| format!(" · {status}"))
                    .unwrap_or_default();
                format!("Tool: `{name}`{status}")
            }
            _ => continue,
        };
        let text = entry["text"]
            .as_str()
            .or_else(|| entry["content"].as_str())
            .unwrap_or_default()
            .trim_end();
        if text.trim().is_empty() {
            continue;
        }
        body.push_str("## ");
        body.push_str(&label);
        body.push_str("\n\n");
        body.push_str(text);
        body.push_str("\n\n");
    }
    (!body.is_empty()).then_some(body)
}

fn render_plain_chat(messages: &Value) -> Option<String> {
    let mut body = String::new();
    for message in messages.as_array().into_iter().flatten() {
        let label = match message["role"].as_str() {
            Some("user") => "User",
            Some("assistant") => "Assistant",
            _ => continue,
        };
        // User `content` can include extracted attachment text. Prefer the text
        // shown in the chat transcript and retain attachment names separately.
        let text = message["displayContent"]
            .as_str()
            .or_else(|| message["content"].as_str())
            .unwrap_or_default()
            .trim_end();
        let attachments = attachment_names(message);
        if text.trim().is_empty() && attachments.is_empty() {
            continue;
        }
        body.push_str("## ");
        body.push_str(label);
        body.push_str("\n\n");
        if !text.trim().is_empty() {
            body.push_str(text);
            body.push_str("\n\n");
        }
        if !attachments.is_empty() {
            body.push_str("Attachments: ");
            body.push_str(&attachments.join(", "));
            body.push_str("\n\n");
        }
    }
    (!body.is_empty()).then_some(body)
}

fn attachment_names(message: &Value) -> Vec<String> {
    let mut names = Vec::new();
    for name in message["attachmentNames"].as_array().into_iter().flatten() {
        if let Some(name) = name.as_str().filter(|name| !name.trim().is_empty()) {
            names.push(name.to_owned());
        }
    }
    for item in message["media"].as_array().into_iter().flatten() {
        if let Some(name) = item["name"].as_str().filter(|name| !name.trim().is_empty()) {
            if !names.iter().any(|existing| existing == name) {
                names.push(name.to_owned());
            }
        }
    }
    for item in message["documents"].as_array().into_iter().flatten() {
        if let Some(name) = item["name"].as_str().filter(|name| !name.trim().is_empty()) {
            if !names.iter().any(|existing| existing == name) {
                names.push(name.to_owned());
            }
        }
    }
    names
}

fn task_note(
    project: &Value,
    note_id: Uuid,
    task_id: &str,
    title: &str,
    runtime: &str,
    created: &Value,
    transcript: &str,
) -> String {
    format!(
        "---\naplot_id: {note_id}\nproject: {}\ntitle: {}\naplot_history: agent-task\naplot_task: {}\nruntime: {}\ncreated_at: {}\ntags: [aplot/history, aplot/agent-task]\n---\n\n{}",
        yaml_string(project["name"].as_str().unwrap_or("")),
        yaml_string(title),
        yaml_string(task_id),
        yaml_string(runtime),
        yaml_value(created),
        transcript,
    )
}

fn chat_note(
    project: &Value,
    note_id: Uuid,
    chat_id: &str,
    title: &str,
    created: &Value,
    transcript: &str,
) -> String {
    format!(
        "---\naplot_id: {note_id}\nproject: {}\ntitle: {}\naplot_history: plain-chat\naplot_chat: {}\ncreated_at: {}\ntags: [aplot/history, aplot/plain-chat]\n---\n\n{}",
        yaml_string(project["name"].as_str().unwrap_or("")),
        yaml_string(title),
        yaml_string(chat_id),
        yaml_value(created),
        transcript,
    )
}

fn yaml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

fn yaml_value(value: &Value) -> String {
    if value.is_null() {
        "null".into()
    } else {
        value.to_string()
    }
}

fn stable_note_id(project_id: Uuid, source_kind: &str, source_id: &str) -> Uuid {
    let digest = Sha256::digest(
        format!("aplot.knowledge.history.v1:{project_id}:{source_kind}:{source_id}").as_bytes(),
    );
    let mut bytes: [u8; 16] = digest[..16].try_into().expect("SHA-256 has 32 bytes");
    // The value is derived from SHA-256 rather than UUIDv5's SHA-1, so mark it
    // as a custom UUIDv8 value while preserving the standard variant bits.
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::store;
    use rusqlite::params;

    fn fixture() -> (Connection, Uuid, Uuid) {
        let mut conn = store::test_db();
        let project_id = Uuid::new_v4();
        let other_project_id = Uuid::new_v4();
        let data = json!({
            "projects": [
                {"id":project_id,"name":"Current project","path":"C:/fixture","knowledge":["vault"],"knowledgeWriteVault":"vault"},
                {"id":other_project_id,"name":"Other project","path":"C:/other","knowledge":["vault"],"knowledgeWriteVault":"vault"}
            ],
            "tasks": [
                {"id":"host-task","projectId":project_id,"title":"Host task","runtime":"codex","createdAt":1700000000000i64},
                {"id":"legacy-task","projectId":project_id,"title":"Legacy task","runtime":"hermes","createdAt":1700000000001i64},
                {"id":"other-task","projectId":other_project_id,"title":"Other task","runtime":"hermes"}
            ],
            "threads": {
                "host-task":{"entries":[
                    {"id":"host-user","kind":"user","text":"stale duplicate question"},
                    {"id":"host-assistant","kind":"assistant","text":"stale duplicate answer"},
                    {"id":"current-only","kind":"notice","text":"Current snapshot only"}
                ]},
                "legacy-task":{"entries":[
                    {"id":"user","kind":"user","text":"Legacy question"},
                    {"id":"assistant","kind":"assistant","text":"Legacy answer"}
                ]},
                "other-task":{"entries":[{"id":"other","kind":"user","text":"Other project secret"}]}
            },
            "memory": []
        });
        workspace::write_saved(&mut conn, data, 0).unwrap();
        conn.execute(
            "INSERT INTO agent_tasks(id,runtime,config_json,state_json,revision,created_at,updated_at) VALUES(?1,'codex','{}','{}',0,'2026-01-01','2026-01-01')",
            ["host-task"],
        ).unwrap();
        for (ord, id, kind, text) in [
            (1, "host-user", "user", "Host question"),
            (2, "host-assistant", "assistant", "Host answer"),
        ] {
            conn.execute(
                "INSERT INTO agent_messages(task_id,id,ord,kind,entry_json,updated_at) VALUES(?1,?2,?3,?4,?5,'2026-01-01')",
                params!["host-task", id, ord, kind, json!({"id":id,"kind":kind,"text":text}).to_string()],
            ).unwrap();
        }
        let backup = json!({"version":2,"revision":1,"data":{
            "projects":[
                {"id":project_id,"name":"Current project"},
                {"id":other_project_id,"name":"Other project"}
            ],
            "tasks":[
                {"id":"host-task","projectId":project_id,"runtime":"codex"},
                {"id":"other-task","projectId":other_project_id,"runtime":"hermes"}
            ],
            "threads":{
                "host-task":{"entries":[
                    {"id":"host-user","kind":"user","text":"backup duplicate question"},
                    {"id":"backup-only","kind":"notice","text":"Pre-import only"},
                    {"id":"host-assistant","kind":"assistant","text":"backup duplicate answer"}
                ]},
                "other-task":{"entries":[{"id":"other","kind":"user","text":"Other project backup secret"}]}
            }
        }});
        conn.execute(
            "INSERT INTO agent_task_imports(runtime,status,source_revision,backup_json,task_ids_json,imported_at) VALUES('codex','active',1,?1,'[]','2026-01-01')",
            [backup.to_string()],
        ).unwrap();
        conn.execute_batch("CREATE TABLE chat_conversations(id TEXT PRIMARY KEY,conversation_json TEXT NOT NULL,updated_at REAL NOT NULL);").unwrap();
        for (id, project, message) in [
            ("project-chat", project_id, "Project chat text"),
            ("other-chat", other_project_id, "Other chat secret"),
        ] {
            let value = json!({
                "id":id,"title":"Chat title","projectId":project,
                "createdAt":1700000000000.0,"updatedAt":1700000000001.0,
                "thread":{"messages":[
                    {"role":"user","content":format!("{message}\n\nprivate attachment extraction"),"displayContent":message,"attachmentText":"private attachment extraction","attachmentNames":["brief.pdf"],"images":["data:image/png;base64,never-copy"]},
                    {"role":"assistant","content":"Assistant reply"}
                ]}
            });
            conn.execute(
                "INSERT INTO chat_conversations(id,conversation_json,updated_at) VALUES(?1,?2,?3)",
                params![id, value.to_string(), 1700000000001.0],
            )
            .unwrap();
        }
        (conn, project_id, other_project_id)
    }

    #[test]
    fn imports_host_legacy_and_project_linked_chat_with_stable_scoped_handles() {
        let (conn, project_id, _) = fixture();
        let first = queue_project_history(&conn, project_id).unwrap();
        assert_eq!(first.agent_tasks, 2);
        assert_eq!(first.plain_chats, 1);
        assert_eq!(first.notes, 3);
        assert_eq!(first.skipped, 0);
        assert_eq!(
            outbox::pending_count_for_project(&conn, project_id).unwrap(),
            3
        );

        let notes_before = outbox_rows(&conn);
        let second = queue_project_history(&conn, project_id).unwrap();
        let notes_after = outbox_rows(&conn);
        assert_eq!(second.notes, 3);
        assert_eq!(notes_before, notes_after);
        assert_eq!(
            outbox::pending_count_for_project(&conn, project_id).unwrap(),
            3
        );

        let bodies = notes_after.join("\n");
        assert!(bodies.contains("Host question"));
        assert!(bodies.contains("Host answer"));
        assert!(bodies.contains("Pre-import only"));
        assert!(bodies.contains("Current snapshot only"));
        assert!(!bodies.contains("stale duplicate"));
        assert!(!bodies.contains("backup duplicate"));
        assert!(bodies.contains("Legacy question"));
        assert!(bodies.contains("Legacy answer"));
        assert!(bodies.contains("Project chat text"));
        assert!(bodies.contains("Assistant reply"));
        assert!(bodies.contains("Attachments: brief.pdf"));
        assert!(!bodies.contains("private attachment extraction"));
        assert!(!bodies.contains("Other project secret"));
        assert!(!bodies.contains("Other project backup secret"));
        assert!(!bodies.contains("Other chat secret"));
        assert!(!bodies.contains("data:image/png;base64"));
    }

    #[test]
    fn stable_history_handle_is_namespaced_by_project_kind_and_source() {
        let project = Uuid::new_v4();
        assert_eq!(
            stable_note_id(project, "plain-chat", "conversation-1"),
            stable_note_id(project, "plain-chat", "conversation-1")
        );
        assert_ne!(
            stable_note_id(project, "plain-chat", "conversation-1"),
            stable_note_id(project, "agent-task", "conversation-1")
        );
        assert_ne!(
            stable_note_id(project, "plain-chat", "conversation-1"),
            stable_note_id(Uuid::new_v4(), "plain-chat", "conversation-1")
        );
    }

    fn outbox_rows(conn: &Connection) -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT value_json FROM kv WHERE key GLOB 'knowledge.outbox.*' ORDER BY key")
            .unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }
}
