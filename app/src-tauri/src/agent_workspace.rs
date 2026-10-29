//! Versioned agent UI data in the existing app database. Files are read-only here;
//! tool execution remains owned by Hermes. No project metadata is written to cwd.
use crate::db::DbState;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

pub(crate) const KEY: &str = "agent-workspace-v2";
const MAX_BYTES: usize = 32 * 1024 * 1024;

pub(crate) fn display_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_owned()
}

// Only relocate the application's own old artifact workspace. Arbitrary user
// projects must be relinked explicitly, never guessed from a folder name.
fn relocate_artifact_projects(data: &mut Value, root: &Path) -> bool {
    let old_base = root.join("app/artifacts/agent-workspace-v2");
    let new_base = root.join("project/app/artifacts/agent-workspace-v2");
    let Some(projects) = data["projects"].as_array_mut() else {
        return false;
    };
    let mut relocated = HashMap::new();
    for project in projects {
        let Some(path) = project["path"].as_str() else {
            continue;
        };
        let old = PathBuf::from(path);
        if old.exists() {
            continue;
        }
        let Ok(relative) = old.strip_prefix(&old_base) else {
            continue;
        };
        if relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            continue;
        }
        let Ok(candidate) = fs::canonicalize(new_base.join(relative)) else {
            continue;
        };
        let Ok(base) = fs::canonicalize(&new_base) else {
            continue;
        };
        if !candidate.is_dir() || !candidate.starts_with(base) {
            continue;
        }
        let new_path = display_path(&candidate);
        relocated.insert(
            project["id"].as_str().unwrap_or_default().to_owned(),
            new_path.clone(),
        );
        project["path"] = json!(new_path);
    }
    if relocated.is_empty() {
        return false;
    }
    let tasks = data["tasks"].as_array().cloned().unwrap_or_default();
    for task in tasks {
        let Some(path) = task["projectId"].as_str().and_then(|id| relocated.get(id)) else {
            continue;
        };
        let Some(id) = task["id"].as_str() else {
            continue;
        };
        if let Some(thread) = data["threads"][id].as_object_mut() {
            thread.insert("cwd".into(), json!(path));
            for key in [
                "id",
                "nativeSessionId",
                "nativeRuntime",
                "nativeConnectionId",
                "hermesSessionId",
                "cursor",
                "context",
                "attachments",
                "queue",
            ] {
                thread.remove(key);
            }
        }
    }
    true
}

fn read_saved(conn: &Connection) -> Result<Option<Value>, String> {
    let raw: Option<String> = conn
        .query_row("SELECT value_json FROM kv WHERE key=?1", [KEY], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|s| serde_json::from_str::<Value>(&s).map_err(|_| "workspace-invalid".to_owned()))
        .transpose()
}
fn validate(data: &Value) -> Result<(), String> {
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
        let mut ids = std::collections::HashSet::new();
        if rows.len() > 500 {
            return Err("workspace-limit".into());
        }
        for p in rows {
            if !p["id"]
                .as_str()
                .is_some_and(|id| !id.is_empty() && ids.insert(id))
                || !p["name"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 80)
                || !p["instructions"].as_str().is_some_and(|s| s.len() <= 64000)
                || !matches!(p["runtime"].as_str(), Some("hermes" | "codex" | "claude"))
            {
                return Err("workspace-invalid".into());
            }
        }
    }
    let mut ids = std::collections::HashSet::new();
    for project in projects {
        let id = project["id"].as_str().ok_or("workspace-invalid")?;
        if id.is_empty()
            || !ids.insert(id)
            || !project["path"]
                .as_str()
                .is_some_and(|p| Path::new(p).is_absolute())
        {
            return Err("workspace-invalid".into());
        }
    }
    let mut task_ids = std::collections::HashSet::new();
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
fn write_saved(conn: &mut Connection, data: Value, revision: u64) -> Result<u64, String> {
    validate(&data)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let current = read_saved(&tx)?;
    if current.as_ref().is_some_and(|v| v["version"] != 2) {
        return Err("workspace-version".into());
    }
    if current
        .as_ref()
        .and_then(|v| v["revision"].as_u64())
        .unwrap_or(0)
        != revision
    {
        return Err("workspace-conflict".into());
    }
    let next = revision.checked_add(1).ok_or("workspace-limit")?;
    let envelope = json!({"version":2,"revision":next,"data":data});
    tx.execute("INSERT INTO kv(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at", params![KEY,envelope.to_string(),chrono::Utc::now().to_rfc3339()]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(next)
}

// Import only homes owned by Aplot V1. Hermes Desktop's home is never scanned.
fn legacy_data(home: &Path) -> Value {
    let mut projects = Vec::<Value>::new();
    let mut tasks = Vec::new();
    let mut threads = serde_json::Map::new();
    let Ok(dirs) = fs::read_dir(home) else {
        return json!({"projects":[],"tasks":[],"threads":{},"memory":[]});
    };
    for dir in dirs.flatten().take(200) {
        let id = dir.file_name().to_string_lossy().into_owned();
        if uuid::Uuid::parse_str(&id).is_err() {
            continue;
        }
        let Ok(db) = Connection::open_with_flags(
            dir.path().join("state.db"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        ) else {
            continue;
        };
        let row = db.query_row(
            "SELECT id,cwd,title,model,started_at FROM sessions ORDER BY started_at DESC LIMIT 1",
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, f64>(4)?,
                ))
            },
        );
        let Ok((sid, Some(cwd), title, _model, started)) = row else {
            continue;
        };
        if !Path::new(&cwd).is_absolute() {
            continue;
        }
        let project_id = if let Some(p) = projects.iter().find(|p| p["path"] == cwd) {
            p["id"].as_str().unwrap().to_owned()
        } else {
            let pid = uuid::Uuid::new_v4().to_string();
            let name = Path::new(&cwd)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy();
            projects.push(
                json!({"id":pid,"name":name,"path":cwd,"skills":"","createdAt":started*1000.0}),
            );
            pid
        };
        let Ok(mut stmt) = db.prepare("SELECT id,role,content,tool_call_id,tool_calls,tool_name,reasoning,reasoning_content FROM messages WHERE session_id=?1 AND active=1 ORDER BY id LIMIT 10000") else { continue; };
        let Ok(rows) = stmt.query_map([&sid], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
            ))
        }) else {
            continue;
        };
        let mut entries = Vec::new();
        let mut calls = HashMap::<String, Value>::new();
        for (mid, role, content, call_id, tool_calls, name, reasoning, reasoning_content) in
            rows.flatten()
        {
            if let Some(raw) = tool_calls {
                if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&raw) {
                    for call in items {
                        if let Some(id) = call["id"].as_str() {
                            calls.insert(id.to_owned(), call.clone());
                        }
                    }
                }
            }
            let content = content.unwrap_or_default();
            if role == "tool" {
                let call = calls.get(call_id.as_deref().unwrap_or(""));
                let args = call
                    .and_then(|c| c["function"]["arguments"].as_str())
                    .and_then(|s| serde_json::from_str::<Value>(s).ok());
                let result = serde_json::from_str::<Value>(&content).unwrap_or(json!(content));
                entries.push(json!({"id":format!("legacy-{mid}"),"kind":"tool","name":name,"text":content,"args":args,"result":result,"details":args.map(|v|v.to_string()),"status":"unknown"}));
            } else if ["user", "assistant"].contains(&role.as_str())
                && (!content.is_empty() || reasoning.is_some() || reasoning_content.is_some())
            {
                entries.push(json!({"id":format!("legacy-{mid}"),"kind":role,"text":content,"reasoning":reasoning_content.or(reasoning)}));
            }
        }
        if entries.is_empty() {
            continue;
        }
        let task_id = uuid::Uuid::new_v4().to_string();
        tasks.push(json!({"id":task_id,"projectId":project_id,"title":title.unwrap_or_else(||"Hermes".into()),"createdAt":started*1000.0,"updatedAt":started*1000.0,"archived":false,"unread":false}));
        threads.insert(task_id,json!({"cwd":cwd,"skills":"","entries":entries,"requests":[],"draft":"","pending":false,"starting":false,"ended":true,"restored":true,"error":"","stopped":false,"hermesSessionId":sid,"legacyHomeId":id}));
    }
    json!({"projects":projects,"tasks":tasks,"threads":threads,"memory":[]})
}
#[tauri::command]
pub async fn agent_workspace_load(app: AppHandle, db: State<'_, DbState>) -> Result<Value, String> {
    let mut conn = db.0.lock().await;
    if let Some(mut value) = read_saved(&conn)? {
        if value["version"] != 2 {
            return Err("workspace-version".into());
        }
        validate(&value["data"])?;
        if let Some(root) = crate::db::installation_root() {
            if relocate_artifact_projects(&mut value["data"], &PathBuf::from(display_path(&root))) {
                let revision = value["revision"].as_u64().ok_or("workspace-invalid")?;
                value["revision"] = json!(write_saved(&mut conn, value["data"].clone(), revision)?);
            }
        }
        return Ok(value);
    }
    let home = crate::db::connection_data_dir(&app)?.join("hermes-conversations");
    drop(conn);
    let data = tauri::async_runtime::spawn_blocking(move || legacy_data(&home))
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({"version":2,"revision":0,"data":data}))
}
#[tauri::command]
pub async fn agent_workspace_save(
    db: State<'_, DbState>,
    data: Value,
    revision: u64,
) -> Result<u64, String> {
    write_saved(&mut *db.0.lock().await, data, revision)
}
#[tauri::command]
pub fn agent_workspace_folder(path: String) -> Result<String, String> {
    let path = fs::canonicalize(path).map_err(|_| "folder")?;
    if !path.is_dir() {
        return Err("folder".into());
    }
    Ok(display_path(&path))
}
/// Folder of the task's project, resolved by the host from its own records.
/// Clients refer to tasks by ID and never send a working directory.
pub(crate) fn task_root(conn: &Connection, task_id: &str) -> Result<String, String> {
    let data = read_saved(conn)?.ok_or("project-missing")?;
    let data = &data["data"];
    let project = data["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|t| t["id"] == task_id))
        .map(|task| task["projectId"].clone())
        .ok_or("task-missing")?;
    let path = data["projects"]
        .as_array()
        .and_then(|a| a.iter().find(|p| p["id"] == project))
        .and_then(|p| p["path"].as_str())
        .ok_or("project-missing")?;
    let path = fs::canonicalize(path).map_err(|_| "folder")?;
    if !path.is_dir() {
        return Err("folder".into());
    }
    Ok(display_path(&path))
}
async fn project_root(db: &DbState, id: &str) -> Result<PathBuf, String> {
    let data = read_saved(&*db.0.lock().await)?.ok_or("project-missing")?;
    let path = data["data"]["projects"]
        .as_array()
        .and_then(|a| a.iter().find(|p| p["id"] == id))
        .and_then(|p| p["path"].as_str())
        .ok_or("project-missing")?;
    fs::canonicalize(path).map_err(|_| "folder".into())
}
fn scoped_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let candidate = fs::canonicalize(root.join(path)).map_err(|_| "file-missing")?;
    if !candidate.starts_with(root) {
        return Err("file-outside".into());
    }
    Ok(candidate)
}
#[tauri::command]
pub async fn agent_workspace_files(
    db: State<'_, DbState>,
    project_id: String,
    path: String,
) -> Result<Value, String> {
    let root = project_root(&db, &project_id).await?;
    let path = scoped_path(&root, &path)?;
    if path.is_file() {
        let m = path.metadata().map_err(|_| "file-missing")?;
        return Ok(
            json!([{"path":path.strip_prefix(&root).map_err(|_|"file-outside")?.to_string_lossy(),"name":path.file_name().unwrap_or_default().to_string_lossy(),"directory":false,"size":m.len()}]),
        );
    }
    let rows=fs::read_dir(path).map_err(|_|"folder")?.flatten().take(500).filter_map(|e| {
        let actual=fs::canonicalize(e.path()).ok()?; if !actual.starts_with(&root) { return None; }
        let m=e.metadata().ok()?;
        Some(json!({"path":actual.strip_prefix(&root).ok()?.to_string_lossy(),"name":e.file_name().to_string_lossy(),"directory":m.is_dir(),"size":m.len()}))
    }).collect::<Vec<_>>();
    Ok(json!(rows))
}
#[tauri::command]
pub async fn agent_workspace_read(
    db: State<'_, DbState>,
    project_id: String,
    path: String,
) -> Result<String, String> {
    let root = project_root(&db, &project_id).await?;
    let path = scoped_path(&root, &path)?;
    let meta = path.metadata().map_err(|_| "file-missing")?;
    if !meta.is_file() || meta.len() > 200_000 {
        return Err("file-limit".into());
    }
    let bytes = fs::read(path).map_err(|_| "file-missing")?;
    if bytes.contains(&0) {
        return Err("file-binary".into());
    }
    String::from_utf8(bytes).map_err(|_| "file-binary".into())
}
#[tauri::command]
pub async fn agent_workspace_open(
    db: State<'_, DbState>,
    project_id: String,
    path: String,
) -> Result<(), String> {
    let root = project_root(&db, &project_id).await?;
    let path = scoped_path(&root, &path)?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(if path.is_dir() {
                display_path(&path)
            } else {
                format!("/select,{}", display_path(&path))
            })
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("unavailable".into())
    }
}

// Documents use file associations; source/script files open in an editor rather
// than an interpreter. Unknown and executable formats remain available in Explorer.
#[tauri::command]
pub async fn agent_workspace_open_document(
    app: AppHandle,
    db: State<'_, DbState>,
    project_id: String,
    path: String,
) -> Result<(), String> {
    let root = project_root(&db, &project_id).await?;
    let path = scoped_path(&root, &path)?;
    let Some(editor) = document_editor(&path) else {
        return Err("file-document-required".into());
    };
    if !path.is_file() {
        return Err("file-document-required".into());
    }
    app.opener()
        .open_path(display_path(&path), editor.then_some("notepad"))
        .map_err(|e| e.to_string())
}

fn document_editor(path: &Path) -> Option<bool> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if "c cpp cc h hpp cs go rs py pyw js mjs cjs ts tsx jsx java kt swift rb php ps1 sh bash bat cmd sql vue svelte scss sass"
        .split_whitespace().any(|item| item == extension) {
        return Some(true);
    }
    "txt md markdown log csv tsv json jsonl yaml yml toml ini cfg conf xml css tex html htm pdf doc docx odt rtf xls xlsx xlsm ods ppt pptx odp epub png jpg jpeg webp gif bmp ico avif svg tif tiff mp3 wav ogg flac m4a opus mp4 webm mkv avi mov zip 7z rar tar gz bz2 xz psd ai blend gltf glb obj stl fbx"
        .split_whitespace().any(|item| item == extension).then_some(false)
}
/// Where new agent projects go by default: `projects` beside the installed app,
/// or in the app data folder for development builds. Created on first use.
#[tauri::command]
pub fn agent_projects_root(app: AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let base = match crate::db::model_library_root() {
        Some(root) => root,
        None => app.path().app_data_dir().map_err(|e| e.to_string())?,
    };
    let directory = base.join("projects");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory.to_string_lossy().into_owned())
}
#[tauri::command]
pub async fn agent_workspace_skills(path: String) -> Result<Value, String> {
    let root = fs::canonicalize(path).map_err(|_| "folder")?;
    let mut files = Vec::new();
    fn scan(root: &Path, dir: &Path, depth: usize, out: &mut Vec<Value>) {
        if depth > 3 || out.len() >= 200 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten().take(500) {
            let Ok(p) = fs::canonicalize(entry.path()) else {
                continue;
            };
            if !p.starts_with(root) {
                continue;
            }
            if p.is_dir() {
                scan(root, &p, depth + 1, out);
            } else if entry.file_name() == "SKILL.md"
                && p.metadata().is_ok_and(|m| m.len() <= 64000)
            {
                let Ok(s) = fs::read_to_string(&p) else {
                    continue;
                };
                let field = |key: &str| {
                    s.lines()
                        .take(40)
                        .find_map(|l| l.strip_prefix(key))
                        .map(|s| s.trim().trim_matches(['\"', '\'']).to_owned())
                        .unwrap_or_default()
                };
                let mut name = field("name:");
                if name.is_empty() {
                    name = p
                        .parent()
                        .and_then(|p| p.file_name())
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned();
                }
                out.push(json!({"path":p.to_string_lossy(),"name":name,"description":field("description:")}));
            }
        }
    }
    scan(&root, &root, 0, &mut files);
    Ok(json!(files))
}

#[cfg(test)]
mod tests {
    #[test]
    fn relocates_only_missing_owned_workspace_and_preserves_history() {
        let root = std::env::temp_dir().join(format!("aplot-relocate-{}", uuid::Uuid::new_v4()));
        let old = root.join("app/artifacts/agent-workspace-v2/workspace");
        let moved = root.join("project/app/artifacts/agent-workspace-v2/workspace");
        fs::create_dir_all(&moved).unwrap();
        fs::write(moved.join("keep.txt"), "project file").unwrap();
        let arbitrary = root.join("unrelated/workspace");
        let mut data = json!({"projects":[{"id":"p","path":old},{"id":"other","path":arbitrary}],"tasks":[{"id":"t","projectId":"p"}],"memory":[{"text":"keep"}],"threads":{"t":{"cwd":old,"nativeSessionId":"old-session","entries":[{"text":"history"}]}}});
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY,value_json TEXT,updated_at TEXT)")
            .unwrap();
        write_saved(&mut conn, data.clone(), 0).unwrap();
        assert!(relocate_artifact_projects(&mut data, &root));
        assert_eq!(
            data["projects"][0]["path"],
            display_path(&fs::canonicalize(&moved).unwrap())
        );
        assert_eq!(data["threads"]["t"]["cwd"], data["projects"][0]["path"]);
        assert_eq!(data["threads"]["t"]["entries"][0]["text"], "history");
        assert!(data["threads"]["t"]["nativeSessionId"].is_null());
        assert_eq!(data["projects"][1]["path"], json!(arbitrary));
        assert_eq!(write_saved(&mut conn, data.clone(), 1).unwrap(), 2);
        assert_eq!(read_saved(&conn).unwrap().unwrap()["data"], data);
        let validated =
            agent_workspace_folder(data["projects"][0]["path"].as_str().unwrap().to_owned())
                .unwrap();
        assert_eq!(
            fs::read_to_string(
                scoped_path(&fs::canonicalize(validated).unwrap(), "keep.txt").unwrap()
            )
            .unwrap(),
            "project file"
        );
        assert!(!relocate_artifact_projects(&mut data, &root));
        fs::create_dir_all(&old).unwrap();
        data["projects"][0]["path"] = json!(old);
        assert!(!relocate_artifact_projects(&mut data, &root));
        assert_eq!(
            fs::read_to_string(moved.join("keep.txt")).unwrap(),
            "project file"
        );
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn folder_validation_handles_spaces_unicode_and_rejects_files() {
        let root = std::env::temp_dir().join(format!("aplot-пути {}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("file.txt"), "contents").unwrap();
        assert_eq!(
            agent_workspace_folder(root.to_string_lossy().into_owned()).unwrap(),
            display_path(&fs::canonicalize(&root).unwrap())
        );
        assert!(
            agent_workspace_folder(root.join("file.txt").to_string_lossy().into_owned()).is_err()
        );
        assert!(
            agent_workspace_folder(root.join("missing").to_string_lossy().into_owned()).is_err()
        );
        fs::remove_file(root.join("file.txt")).unwrap();
        fs::remove_dir(root).unwrap();
    }
    use super::*;
    #[test]
    fn imports_only_owned_uuid_homes_without_changing_the_source() {
        let root = std::env::temp_dir().join(format!("aplot-legacy-{}", uuid::Uuid::new_v4()));
        let owned = root.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&owned).unwrap();
        let db_path = owned.join("state.db");
        let db = Connection::open(&db_path).unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT,cwd TEXT,title TEXT,model TEXT,started_at REAL); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,tool_call_id TEXT,tool_calls TEXT,tool_name TEXT,reasoning TEXT,reasoning_content TEXT,active INTEGER)").unwrap();
        db.execute(
            "INSERT INTO sessions VALUES('sid',?1,'Imported task','model',1.0)",
            [root.to_string_lossy().as_ref()],
        )
        .unwrap();
        db.execute_batch("INSERT INTO messages(id,session_id,role,content,active) VALUES(1,'sid','user','Keep this history',1),(2,'sid','assistant','Old answer',1),(3,'sid','assistant','Inactive branch',0)").unwrap();
        drop(db);
        let before = fs::read(&db_path).unwrap();
        let data = legacy_data(&root);
        assert_eq!(data["tasks"].as_array().unwrap().len(), 1);
        let task = data["tasks"][0]["id"].as_str().unwrap();
        assert_eq!(
            data["threads"][task]["entries"].as_array().unwrap().len(),
            2
        );
        assert_eq!(data["threads"][task]["hermesSessionId"], "sid");
        assert_eq!(data["threads"][task]["pending"], false);
        assert_eq!(fs::read(&db_path).unwrap(), before);
        validate(&data).unwrap();
        fs::remove_file(db_path).unwrap();
        fs::remove_dir(owned).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn snapshot_is_transactional_and_rejects_stale_or_future_versions() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY,value_json TEXT,updated_at TEXT)")
            .unwrap();
        let data = json!({"projects":[],"tasks":[],"threads":{},"memory":[]});
        assert_eq!(write_saved(&mut conn, data.clone(), 0).unwrap(), 1);
        assert!(write_saved(&mut conn, data.clone(), 0).is_err());
        assert_eq!(read_saved(&conn).unwrap().unwrap()["data"], data);
        conn.execute(
            "UPDATE kv SET value_json=?1",
            [json!({"version":99,"revision":1,"data":data}).to_string()],
        )
        .unwrap();
        assert!(write_saved(&mut conn, data, 1).is_err());
    }
    #[test]
    fn document_actions_use_editors_for_scripts_and_never_execute_unknown_files() {
        for extension in ["js", "py", "ps1", "bat", "cmd", "sh"] {
            assert_eq!(
                document_editor(Path::new(&format!("file.{extension}"))),
                Some(true)
            );
        }
        for extension in [
            "HTML", "pdf", "docx", "xlsx", "pptx", "png", "mp3", "mp4", "zip",
        ] {
            assert_eq!(
                document_editor(Path::new(&format!("file.{extension}"))),
                Some(false)
            );
        }
        for path in ["document.pdf.exe", "unknown.binary", "noextension"] {
            assert_eq!(document_editor(Path::new(path)), None);
        }
    }
    #[test]
    fn file_viewer_rejects_traversal_and_missing_files() {
        let root = std::env::temp_dir().join(format!("aplot-ws-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("project")).unwrap();
        fs::write(root.join("secret"), "outside").unwrap();
        fs::write(root.join("project/a.txt"), "inside").unwrap();
        let project = fs::canonicalize(root.join("project")).unwrap();
        assert!(scoped_path(&project, "a.txt").is_ok());
        assert!(scoped_path(&project, "../secret").is_err());
        assert!(scoped_path(&project, "missing").is_err());
        fs::remove_file(root.join("project/a.txt")).unwrap();
        fs::remove_file(root.join("secret")).unwrap();
        fs::remove_dir(root.join("project")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
