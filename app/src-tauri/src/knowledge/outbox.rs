//! Publish completed agent turns as Obsidian notes after the task transaction commits.
use super::{vault, Job, KnowledgeState};
use crate::db::DbState;
use crate::tasks::store::TurnRow;
use aplot_core::workspace;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::Path,
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const KEY_PREFIX: &str = "knowledge.outbox.";

#[derive(Deserialize, Serialize)]
struct Publication {
    vault_id: String,
    project_id: Uuid,
    note_id: Uuid,
    project_name: String,
    title: String,
    body: String,
}

fn folder_name(project: &Value) -> String {
    project["knowledgeFolderName"]
        .as_str()
        .or_else(|| project["name"].as_str())
        .unwrap_or("Project")
        .to_owned()
}
pub(super) fn write_vault(project: &Value) -> Option<&str> {
    let id = project["knowledgeWriteVault"].as_str()?;
    project["knowledge"]
        .as_array()?
        .iter()
        .any(|bound| bound == id)
        .then_some(id)
}

/// Queue an explicitly project-scoped note for that project's selected vault.
/// The outbox key is the stable note ID, so retries never create duplicates.
pub(super) fn queue_project_note(
    conn: &Connection,
    project: &Value,
    note_id: Uuid,
    title: String,
    body: String,
) -> Result<bool, String> {
    if body.len() as u64 > vault::MAX_NOTE_BYTES {
        return Err("knowledge-limit".into());
    }
    let Some(vault_id) = write_vault(project) else {
        return Err("knowledge-write-vault".into());
    };
    let (Some(project_id), Some(project_name)) = (
        project["id"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok()),
        project["knowledgeFolderName"]
            .as_str()
            .or_else(|| project["name"].as_str()),
    ) else {
        return Err("knowledge-project".into());
    };
    queue(
        conn,
        &Publication {
            vault_id: vault_id.to_owned(),
            project_id,
            note_id,
            project_name: project_name.to_owned(),
            title,
            body,
        },
    )
}

pub(crate) fn queue_turn(
    conn: &Connection,
    turn: &TurnRow,
    final_text: &str,
) -> Result<(), String> {
    let Some(saved) = workspace::read_saved(conn)? else {
        return Ok(());
    };
    let data = &saved["data"];
    let Some(task) = data["tasks"].as_array().and_then(|tasks| {
        tasks
            .iter()
            .find(|task| task["id"] == turn.task_id && task["deletedAt"].is_null())
    }) else {
        return Ok(());
    };
    let Some(project) = data["projects"].as_array().and_then(|projects| {
        projects
            .iter()
            .find(|project| project["id"] == task["projectId"])
    }) else {
        return Ok(());
    };
    let (Some(vault_id), Some(project_id), Ok(note_id)) = (
        write_vault(project),
        project["id"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok()),
        Uuid::parse_str(&turn.id),
    ) else {
        return Ok(());
    };
    let latest = if final_text.trim().is_empty() {
        let raw = conn.query_row(
            "SELECT entry_json FROM agent_messages
             WHERE task_id = ?1 AND ord > (SELECT ord FROM agent_messages WHERE task_id = ?1 AND id = ?2)
             ORDER BY ord DESC LIMIT 1",
            params![turn.task_id, turn.message_id],
            |row| row.get::<_, String>(0),
        ).optional().map_err(|error| error.to_string())?;
        raw.and_then(|entry| serde_json::from_str::<Value>(&entry).ok())
            .filter(|entry| entry["kind"] == "assistant")
            .and_then(|entry| entry["text"].as_str().map(str::to_owned))
            .unwrap_or_default()
    } else {
        final_text.to_owned()
    };
    if latest.trim().is_empty() {
        return Ok(());
    }
    let title = task["title"].as_str().unwrap_or("Agent result");
    let body = format!(
        "---\naplot_id: {note_id}\nproject: {}\ntitle: {}\nagent: {}\naplot_task: {}\ncreated: {}\ntags: [aplot/result]\n---\n\n{}\n",
        json!(project["name"].as_str().unwrap_or("")),
        json!(title),
        json!(task["agentName"].as_str().or_else(|| task["runtime"].as_str()).unwrap_or("Hermes")),
        json!(turn.task_id),
        json!(turn.created_at),
        latest.trim()
    );
    if body.len() as u64 > vault::MAX_NOTE_BYTES {
        return Err("knowledge-limit".into());
    }
    let note = Publication {
        vault_id: vault_id.to_owned(),
        project_id,
        note_id,
        project_name: folder_name(project),
        title: title.to_owned(),
        body,
    };
    queue(conn, &note)?;
    Ok(())
}

fn queue(conn: &Connection, note: &Publication) -> Result<bool, String> {
    let note_id = note.note_id;
    conn.execute(
        "INSERT OR IGNORE INTO kv(key, value_json, updated_at) VALUES(?1, ?2, ?3)",
        params![
            format!("{KEY_PREFIX}{note_id}"),
            serde_json::to_string(note).map_err(|e| e.to_string())?,
            chrono::Utc::now().to_rfc3339()
        ],
    )
    .map(|rows| rows > 0)
    .map_err(|error| error.to_string())
}

pub(crate) fn queue_confirmed_memory(conn: &Connection, data: &Value) -> Result<bool, String> {
    let Some(projects) = data["projects"].as_array() else {
        return Ok(false);
    };
    let Some(memory) = data["memory"].as_array() else {
        return Ok(false);
    };
    if memory.is_empty()
        || !projects
            .iter()
            .any(|project| write_vault(project).is_some())
    {
        return Ok(false);
    }
    let old = workspace::read_saved(conn)?.unwrap_or_default();
    let old_projects = old["data"]["projects"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let old_memory = old["data"]["memory"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut queued = false;
    for item in memory.iter().filter(|item| item["confirmed"] == true) {
        let Some(project) = projects
            .iter()
            .find(|project| project["id"] == item["projectId"])
        else {
            continue;
        };
        let Some(vault_id) = write_vault(project) else {
            continue;
        };
        let existing_vault = old_projects
            .iter()
            .find(|old| old["id"] == project["id"])
            .and_then(write_vault);
        if existing_vault == Some(vault_id) && old_memory.contains(item) {
            continue;
        }
        let (Some(project_id), Some(id), Some(text)) = (
            project["id"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok()),
            item["id"].as_str(),
            item["text"].as_str().filter(|text| !text.trim().is_empty()),
        ) else {
            continue;
        };
        let version =
            Sha256::digest(format!("{project_id}:{id}:{}:{text}", item["updatedAt"]).as_bytes());
        let note_id = Uuid::from_bytes(version[..16].try_into().expect("SHA-256 is 32 bytes"));
        let title = text
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
            .trim()
            .chars()
            .take(100)
            .collect::<String>();
        let body = format!(
            "---\naplot_id: {note_id}\nproject: {}\ntitle: {}\ncategory: {}\naplot_memory: {}\ntags: [aplot/memory]\n---\n\n{}\n",
            json!(project["name"].as_str().unwrap_or("")),
            json!(title),
            json!(item["category"].as_str().unwrap_or("fact")),
            json!(id),
            text.trim()
        );
        if body.len() as u64 <= vault::MAX_NOTE_BYTES {
            queued |= queue(
                conn,
                &Publication {
                    vault_id: vault_id.to_owned(),
                    project_id,
                    note_id,
                    project_name: folder_name(project),
                    title,
                    body,
                },
            )?;
        }
    }
    Ok(queued)
}

fn write_note(vault: &super::Vault, note: &Publication) -> Result<String, String> {
    let root = vault::canonical_root(&vault.path)?;
    let configured = Path::new(&vault.path);
    if !vault::is_inside(configured, &root) || !vault::is_inside(&root, configured) {
        return Err("knowledge-path".into());
    }
    let folder = format!(
        "Aplot/{}",
        note_component(&note.project_name, note.project_id)
    );
    let rel = format!("{folder}/{}.md", note_component(&note.title, note.note_id));
    if vault::is_excluded(&rel, &vault.exclusions) {
        return Err("knowledge-exclusion".into());
    }
    let mut parent = root.clone();
    for part in folder.split('/') {
        parent.push(part);
        match fs::create_dir(&parent) {
            Ok(()) => (),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => (),
            Err(_) => return Err("knowledge-publish".into()),
        }
        let actual = fs::canonicalize(&parent).map_err(|_| "knowledge-path")?;
        if !actual.is_dir() || vault::relative(&root, &actual) != vault::relative(&root, &parent) {
            return Err("knowledge-path".into());
        }
    }
    let dest = root.join(&rel);
    let temp = parent.join(format!(".aplot-{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|_| "knowledge-publish")?;
    let result = file
        .write_all(note.body.as_bytes())
        .and_then(|()| file.sync_all());
    drop(file);
    let result = result.and_then(|()| fs::hard_link(&temp, &dest));
    let _ = fs::remove_file(&temp);
    match result {
        Ok(()) => Ok(rel),
        Err(error)
            if error.kind() == ErrorKind::AlreadyExists
                && owned_note(&root, &rel, note.note_id) =>
        {
            Ok(rel)
        }
        Err(_) => Err("knowledge-publish".into()),
    }
}

fn note_component(title: &str, id: Uuid) -> String {
    let safe: String = title
        .chars()
        .take(48)
        .map(|ch| {
            if ch.is_control() || "<>:\"/\\|?*[]#^".contains(ch) {
                '-'
            } else {
                ch
            }
        })
        .collect();
    let stem = safe.trim_matches(|ch: char| ch == '.' || ch.is_whitespace());
    if stem.is_empty() {
        id.to_string()
    } else {
        format!("{stem} -- {id}")
    }
}

fn owned_note(root: &Path, rel: &str, note_id: Uuid) -> bool {
    let Ok(path) = vault::resolve_inside(root, rel) else {
        return false;
    };
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    use std::io::{BufRead, BufReader, Read};
    let mut lines = BufReader::new(file.take(100)).lines();
    lines.next().and_then(Result::ok).as_deref() == Some("---")
        && lines.next().and_then(Result::ok).as_deref() == Some(&format!("aplot_id: {note_id}"))
}

pub(crate) fn schedule(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = publish(&app).await;
    });
}

pub(super) fn pending_count(conn: &Connection) -> Result<usize, String> {
    conn.query_row(
        "SELECT count(*) FROM kv WHERE key GLOB 'knowledge.outbox.*'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count as usize)
    .map_err(|error| error.to_string())
}

pub(super) fn pending_count_for_project(
    conn: &Connection,
    project_id: Uuid,
) -> Result<usize, String> {
    let mut statement = conn
        .prepare("SELECT value_json FROM kv WHERE key GLOB 'knowledge.outbox.*'")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut count = 0;
    for row in rows {
        let raw = row.map_err(|error| error.to_string())?;
        if serde_json::from_str::<Publication>(&raw).is_ok_and(|note| note.project_id == project_id)
        {
            count += 1;
        }
    }
    Ok(count)
}

pub(super) async fn publish(app: &AppHandle) -> Result<usize, String> {
    publish_scoped(app, None).await
}

pub(super) async fn publish_project(app: &AppHandle, project_id: Uuid) -> Result<usize, String> {
    publish_scoped(app, Some(project_id)).await
}

async fn publish_scoped(app: &AppHandle, project_id: Option<Uuid>) -> Result<usize, String> {
    let knowledge = app.state::<KnowledgeState>();
    let db = app.state::<DbState>();
    let _publisher = knowledge.publishing.lock().await;
    let conn = db.0.lock().await;
    let pending = {
        let mut statement = conn.prepare("SELECT key, value_json FROM kv WHERE key GLOB 'knowledge.outbox.*' ORDER BY updated_at")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    if pending.is_empty() {
        return Ok(0);
    }
    let saved = workspace::read_saved(&conn)?.unwrap_or_default();
    drop(conn);
    let mut failures = 0;
    for (key, value) in pending {
        let Ok(note) = serde_json::from_str::<Publication>(&value) else {
            failures += 1;
            continue;
        };
        if project_id.is_some_and(|id| note.project_id != id) {
            continue;
        }
        let id = note.project_id.to_string();
        let allowed = saved["data"]["projects"]
            .as_array()
            .is_some_and(|projects| {
                projects.iter().any(|project| {
                    project["id"] == id && write_vault(project) == Some(&note.vault_id)
                })
            });
        if !allowed {
            db.0.lock()
                .await
                .execute("DELETE FROM kv WHERE key = ?1", [key])
                .map_err(|e| e.to_string())?;
            continue;
        }
        let Ok(vault) = knowledge.vault(&note.vault_id) else {
            failures += 1;
            continue;
        };
        let vault_id = vault.id.clone();
        match tauri::async_runtime::spawn_blocking(move || write_note(&vault, &note)).await {
            Ok(Ok(path)) => {
                db.0.lock()
                    .await
                    .execute("DELETE FROM kv WHERE key = ?1", [key])
                    .map_err(|e| e.to_string())?;
                let _ = knowledge.jobs.send(Job::Sync(vault_id, Some(vec![path])));
            }
            _ => failures += 1,
        }
    }
    Ok(failures)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeats_are_idempotent_and_keep_obsidian_edits() {
        let root = std::env::temp_dir().join(format!("aplot-knowledge-write-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let vault = super::super::Vault {
            id: "test".into(),
            name: "Test vault".into(),
            path: vault::display(&root),
            exclusions: vec![],
            added_at: String::new(),
        };
        let note_id = Uuid::new_v4();
        let note = Publication {
            vault_id: vault.id.clone(),
            project_id: Uuid::new_v4(),
            note_id,
            project_name: "Мой проект".into(),
            title: "../Вывод: выпуск #1".into(),
            body: format!("---\naplot_id: {note_id}\n---\n\nПервый вариант"),
        };
        let path = write_note(&vault, &note).unwrap();
        assert!(path.starts_with("Aplot/Мой проект"));
        assert!(path.ends_with(".md"));
        let edited = format!("{}\n\nПравка в Obsidian", note.body);
        fs::write(root.join(&path), &edited).unwrap();
        assert_eq!(write_note(&vault, &note).unwrap(), path);
        assert_eq!(fs::read_to_string(root.join(&path)).unwrap(), edited);
        fs::write(root.join(&path), "Другой файл").unwrap();
        assert!(write_note(&vault, &note).is_err());
        assert_eq!(fs::read_to_string(root.join(&path)).unwrap(), "Другой файл");
        // The test creates a unique directory and removes only that fixture.
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_confirmed_memory_is_queued_for_the_chosen_vault() {
        let mut conn = crate::tasks::store::test_db();
        let project_id = Uuid::new_v4();
        let data = |write_vault: &str| {
            json!({
            "projects":[{"id":project_id,"name":"Design","path":std::env::temp_dir(),"knowledge":["vault"],"knowledgeWriteVault":write_vault}],
                "tasks":[], "threads":{},
                "memory":[
                    {"id":"checked","projectId":project_id,"confirmed":true,"text":"Use Markdown","updatedAt":1},
                    {"id":"draft","projectId":project_id,"confirmed":false,"text":"Unfinished draft","updatedAt":1}
                ]
            })
        };
        assert!(!queue_confirmed_memory(&conn, &data("other")).unwrap());
        let chosen = data("vault");
        assert!(queue_confirmed_memory(&conn, &chosen).unwrap());
        assert_eq!(pending_count(&conn).unwrap(), 1);
        workspace::write_saved(&mut conn, chosen.clone(), 0).unwrap();
        assert!(!queue_confirmed_memory(&conn, &chosen).unwrap());
    }

    #[test]
    fn completed_turn_snapshot_uses_the_project_vault_and_only_the_final_text() {
        let mut conn = crate::tasks::store::test_db();
        let project_id = Uuid::new_v4();
        workspace::write_saved(&mut conn, json!({
            "projects":[{"id":project_id,"name":"Design","path":std::env::temp_dir(),"knowledge":["vault"],"knowledgeWriteVault":"vault"}],
            "tasks":[{"id":"task","projectId":project_id,"title":"Choose format","runtime":"codex"}],
            "threads":{}, "memory":[]
        }), 0).unwrap();
        let note_id = Uuid::new_v4();
        let turn = TurnRow {
            id: note_id.to_string(),
            task_id: "task".into(),
            status: "completed".into(),
            command_id: None,
            message_id: "user".into(),
            input: json!({"text":"Raw user input"}),
            native_turn_id: None,
            error: None,
            created_at: "2026-11-21T00:00:00Z".into(),
        };
        queue_turn(&conn, &turn, "The project uses **Markdown**.").unwrap();
        queue_turn(&conn, &turn, "The project uses **Markdown**.").unwrap();
        assert_eq!(pending_count(&conn).unwrap(), 1);
        let raw: String = conn
            .query_row(
                "SELECT value_json FROM kv WHERE key = ?1",
                [format!("{KEY_PREFIX}{note_id}")],
                |row| row.get(0),
            )
            .unwrap();
        let note: Publication = serde_json::from_str(&raw).unwrap();
        assert_eq!(note.vault_id, "vault");
        assert_eq!(note.project_id, project_id);
        assert!(note.body.contains("The project uses **Markdown**."));
        assert!(!note.body.contains("Raw user input"));
    }
}
