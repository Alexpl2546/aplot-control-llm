//! User-selected copies of agent result files.
//!
//! These artifacts are independent copies under the application data directory.
//! Project files are only read as the source and are never modified or removed.
use crate::{agent_workspace, db::DbState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

const MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;
const STORAGE_DIR: &str = "user-artifacts";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserArtifact {
    pub id: String,
    pub task_id: String,
    pub source_relative: String,
    pub name: String,
    pub mime: String,
    pub bytes: u64,
    pub sha256: String,
    pub version: u32,
    pub created_at: String,
    #[serde(skip)]
    storage_relative: String,
}

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS user_artifacts (
           id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL,
           source_relative TEXT NOT NULL,
           name TEXT NOT NULL,
           mime TEXT NOT NULL,
           bytes INTEGER NOT NULL CHECK(bytes >= 0),
           sha256 TEXT NOT NULL,
           version INTEGER NOT NULL CHECK(version > 0),
           created_at TEXT NOT NULL,
           storage_relative TEXT NOT NULL,
           UNIQUE(task_id, source_relative, version)
         );
         CREATE INDEX IF NOT EXISTS user_artifacts_task_time
           ON user_artifacts(task_id, created_at DESC, version DESC);",
    )
    .map_err(|error| error.to_string())
}

fn storage_root(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = crate::db::connection_data_dir(app)?;
    fs::create_dir_all(&data_dir).map_err(|_| "artifact-storage".to_string())?;
    let data_dir = fs::canonicalize(data_dir).map_err(|_| "artifact-storage".to_string())?;
    let root = data_dir.join(STORAGE_DIR);
    if fs::symlink_metadata(&root).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("artifact-storage".into());
    }
    fs::create_dir_all(&root).map_err(|_| "artifact-storage".to_string())?;
    let root = fs::canonicalize(root).map_err(|_| "artifact-storage".to_string())?;
    if !root.starts_with(&data_dir) {
        return Err("artifact-storage".into());
    }
    Ok(root)
}

fn valid_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

fn normalize_relative(value: &str) -> Result<(PathBuf, String), String> {
    if value.is_empty()
        || value.contains('\0')
        || value.contains("://")
        || value.starts_with('/')
        || value.starts_with('\\')
        || value.as_bytes().get(1) == Some(&b':')
    {
        return Err("artifact-path-invalid".into());
    }
    let portable = value.replace('\\', "/");
    let path = Path::new(&portable);
    let mut pieces = Vec::new();
    for part in path.components() {
        let Component::Normal(value) = part else {
            return Err("artifact-path-invalid".into());
        };
        let text = value.to_str().ok_or("artifact-path-invalid")?;
        if text.is_empty() || text.contains(':') {
            return Err("artifact-path-invalid".into());
        }
        pieces.push(text.to_owned());
    }
    if pieces.is_empty() {
        return Err("artifact-path-invalid".into());
    }
    let normalized = pieces.join("/");
    Ok((path.to_path_buf(), normalized))
}

fn resolve_project_file(root: &Path, relative: &str) -> Result<(PathBuf, String), String> {
    let (relative_path, normalized) = normalize_relative(relative)?;
    let root = fs::canonicalize(root).map_err(|_| "project-missing".to_string())?;
    let source = fs::canonicalize(root.join(relative_path))
        .map_err(|_| "artifact-source-missing".to_string())?;
    if !source.starts_with(&root) {
        return Err("artifact-path-outside-project".into());
    }
    let metadata = fs::metadata(&source).map_err(|_| "artifact-source-missing".to_string())?;
    if !metadata.is_file() {
        return Err("artifact-source-not-file".into());
    }
    if metadata.len() > MAX_ARTIFACT_BYTES {
        return Err("artifact-size-limit".into());
    }
    Ok((source, normalized))
}

fn safe_extension(name: &str) -> String {
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !extension.is_empty()
        && extension.len() <= 16
        && extension.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        extension
    } else {
        "bin".into()
    }
}

fn mime_for(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "txt" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "json" | "jsonl" => "application/json",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

fn copy_atomic(
    source: &Path,
    destination_dir: &Path,
    id: &str,
    name: &str,
) -> Result<(u64, String, String), String> {
    let extension = safe_extension(name);
    fs::create_dir_all(destination_dir).map_err(|_| "artifact-storage".to_string())?;
    let canonical_dir =
        fs::canonicalize(destination_dir).map_err(|_| "artifact-storage".to_string())?;
    let temporary = canonical_dir.join(format!(".tmp-{id}"));
    let destination_name = format!("artifact.{extension}");
    let destination = canonical_dir.join(&destination_name);
    let result = (|| {
        let mut input = File::open(source).map_err(|_| "artifact-source-missing".to_string())?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "artifact-storage".to_string())?;
        let mut digest = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = input
                .read(&mut buffer)
                .map_err(|_| "artifact-source-read".to_string())?;
            if count == 0 {
                break;
            }
            total = total
                .checked_add(count as u64)
                .ok_or("artifact-size-limit")?;
            if total > MAX_ARTIFACT_BYTES {
                return Err("artifact-size-limit".into());
            }
            digest.update(&buffer[..count]);
            output
                .write_all(&buffer[..count])
                .map_err(|_| "artifact-storage".to_string())?;
        }
        output
            .sync_all()
            .map_err(|_| "artifact-storage".to_string())?;
        drop(output);
        fs::rename(&temporary, &destination).map_err(|_| "artifact-storage".to_string())?;
        Ok((total, format!("{:x}", digest.finalize()), destination_name))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserArtifact> {
    let bytes: i64 = row.get(5)?;
    let version: i64 = row.get(7)?;
    Ok(UserArtifact {
        id: row.get(0)?,
        task_id: row.get(1)?,
        source_relative: row.get(2)?,
        name: row.get(3)?,
        mime: row.get(4)?,
        bytes: bytes.max(0) as u64,
        sha256: row.get(6)?,
        version: version.max(0) as u32,
        created_at: row.get(8)?,
        storage_relative: row.get(9)?,
    })
}

fn select_for_task(conn: &Connection, task_id: &str) -> Result<Vec<UserArtifact>, String> {
    let mut statement = conn.prepare("SELECT id,task_id,source_relative,name,mime,bytes,sha256,version,created_at,storage_relative FROM user_artifacts WHERE task_id=?1 ORDER BY source_relative COLLATE NOCASE, version DESC, created_at DESC").map_err(|e|e.to_string())?;
    let rows = statement
        .query_map([task_id], from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn cleanup_task_orphans(
    storage_root: &Path,
    task_id: &str,
    rows: &[UserArtifact],
) -> Result<(), String> {
    let storage_root =
        fs::canonicalize(storage_root).map_err(|_| "artifact-storage".to_string())?;
    let task_dir = storage_root.join(task_id);
    let Ok(task_meta) = fs::symlink_metadata(&task_dir) else {
        return Ok(());
    };
    if task_meta.file_type().is_symlink() || !task_meta.is_dir() {
        return Err("artifact-storage".into());
    }
    let task_dir = fs::canonicalize(task_dir).map_err(|_| "artifact-storage".to_string())?;
    if !task_dir.starts_with(&storage_root) {
        return Err("artifact-storage".into());
    }
    let registered: HashMap<&str, String> = rows
        .iter()
        .map(|row| {
            let (path, _) = normalize_relative(&row.storage_relative)?;
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or("artifact-storage")?;
            Ok((row.id.as_str(), name.to_owned()))
        })
        .collect::<Result<_, String>>()?;
    for entry in fs::read_dir(&task_dir)
        .map_err(|_| "artifact-storage".to_string())?
        .flatten()
    {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| "artifact-storage".to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !registered.contains_key(name.as_str()) {
            if metadata.file_type().is_symlink() || metadata.is_file() {
                fs::remove_file(path).map_err(|_| "artifact-cleanup".to_string())?;
            } else if metadata.is_dir() {
                fs::remove_dir_all(path).map_err(|_| "artifact-cleanup".to_string())?;
            }
            continue;
        }
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("artifact-storage".into());
        }
        let expected_name = registered.get(name.as_str()).ok_or("artifact-storage")?;
        for child in fs::read_dir(&path)
            .map_err(|_| "artifact-storage".to_string())?
            .flatten()
        {
            let child_name = child.file_name().to_string_lossy().into_owned();
            let child_path = child.path();
            let child_meta =
                fs::symlink_metadata(&child_path).map_err(|_| "artifact-storage".to_string())?;
            if child_name.starts_with(".tmp-")
                && (child_meta.is_file() || child_meta.file_type().is_symlink())
            {
                let _ = fs::remove_file(child_path);
            } else if child_name == format!(".delete-{name}") {
                let expected = path.join(expected_name);
                if !expected.exists()
                    && (child_meta.is_file() || child_meta.file_type().is_symlink())
                {
                    let _ = fs::rename(child_path, expected);
                } else if child_meta.is_file() || child_meta.file_type().is_symlink() {
                    let _ = fs::remove_file(child_path);
                }
            }
        }
    }
    Ok(())
}

fn save_artifact(
    conn: &mut Connection,
    storage_root: &Path,
    task_id: &str,
    project_root: &Path,
    source_relative: &str,
) -> Result<UserArtifact, String> {
    if !valid_id(task_id) {
        return Err("task-missing".into());
    }
    let storage_root =
        fs::canonicalize(storage_root).map_err(|_| "artifact-storage".to_string())?;
    let (source, normalized) = resolve_project_file(project_root, source_relative)?;
    let name = source
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or("artifact-path-invalid")?
        .to_owned();
    let mime = mime_for(&name).to_owned();
    let id = uuid::Uuid::new_v4().to_string();
    let task_dir = storage_root.join(task_id);
    let destination_dir = task_dir.join(&id);
    fs::create_dir_all(&task_dir).map_err(|_| "artifact-storage".to_string())?;
    let canonical_task_dir =
        fs::canonicalize(&task_dir).map_err(|_| "artifact-storage".to_string())?;
    if !canonical_task_dir.starts_with(&storage_root) {
        return Err("artifact-storage".into());
    }
    if fs::create_dir_all(&destination_dir).is_err() {
        let _ = fs::remove_dir_all(&destination_dir);
        return Err("artifact-storage".into());
    }
    let destination_dir = match fs::canonicalize(&destination_dir) {
        Ok(path) => path,
        Err(_) => {
            let _ = fs::remove_dir_all(&destination_dir);
            return Err("artifact-storage".into());
        }
    };
    if !destination_dir.starts_with(&canonical_task_dir)
        || destination_dir.file_name().and_then(|v| v.to_str()) != Some(id.as_str())
    {
        let _ = fs::remove_dir_all(&destination_dir);
        return Err("artifact-storage".into());
    }

    let tx = match conn.transaction() {
        Ok(tx) => tx,
        Err(error) => {
            let _ = fs::remove_dir_all(&destination_dir);
            return Err(error.to_string());
        }
    };
    let latest = match tx
        .query_row(
            "SELECT id,task_id,source_relative,name,mime,bytes,sha256,version,created_at,storage_relative
             FROM user_artifacts WHERE task_id=?1 AND source_relative=?2
             ORDER BY version DESC LIMIT 1",
            params![task_id, normalized],
            from_row,
        )
        .optional()
    {
        Ok(latest) => latest,
        Err(error) => {
            drop(tx);
            let _ = fs::remove_dir_all(&destination_dir);
            return Err(error.to_string());
        }
    };
    let (bytes, sha256, stored_name) = match copy_atomic(&source, &destination_dir, &id, &name) {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_dir_all(&destination_dir);
            return Err(error);
        }
    };
    if let Some(existing) = latest.as_ref() {
        if existing.sha256 == sha256
            && managed_copy_path(&storage_root, &existing.storage_relative).is_ok()
        {
            let _ = tx.rollback();
            let _ = fs::remove_dir_all(&destination_dir);
            return Ok(existing.clone());
        }
    }
    let version = match latest.as_ref() {
        Some(existing) => existing.version.checked_add(1),
        None => Some(1),
    };
    let Some(version) = version else {
        let _ = tx.rollback();
        let _ = fs::remove_dir_all(&destination_dir);
        return Err("artifact-version-limit".into());
    };
    let storage_relative = format!("{task_id}/{id}/{stored_name}");
    let created_at = chrono::Utc::now().to_rfc3339();
    let write = tx.execute("INSERT INTO user_artifacts(id,task_id,source_relative,name,mime,bytes,sha256,version,created_at,storage_relative) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", params![id, task_id, normalized, name, mime, bytes as i64, sha256, version, created_at, storage_relative]);
    if let Err(error) = write {
        let _ = fs::remove_dir_all(&destination_dir);
        return Err(error.to_string());
    }
    if let Err(error) = tx.commit() {
        let _ = fs::remove_dir_all(&destination_dir);
        return Err(error.to_string());
    }
    Ok(UserArtifact {
        id,
        task_id: task_id.to_owned(),
        source_relative: normalized,
        name,
        mime,
        bytes,
        sha256,
        version,
        created_at,
        storage_relative,
    })
}

fn managed_copy_path(storage_root: &Path, stored_relative: &str) -> Result<PathBuf, String> {
    let storage_root =
        fs::canonicalize(storage_root).map_err(|_| "artifact-storage".to_string())?;
    let (relative, _) = normalize_relative(stored_relative)?;
    let candidate = fs::canonicalize(storage_root.join(relative))
        .map_err(|_| "artifact-missing".to_string())?;
    if !candidate.starts_with(&storage_root) || !candidate.is_file() {
        return Err("artifact-missing".into());
    }
    Ok(candidate)
}

fn open_application(path: &Path) -> Result<Option<&'static str>, String> {
    let editor = agent_workspace::document_editor(path).ok_or("artifact-open-unsupported")?;
    Ok(editor.then_some("notepad"))
}

fn remove_artifact(
    conn: &mut Connection,
    storage_root: &Path,
    task_id: &str,
    id: &str,
) -> Result<(), String> {
    if !valid_id(task_id) || !valid_id(id) {
        return Err("artifact-missing".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let artifact = tx.query_row("SELECT id,task_id,source_relative,name,mime,bytes,sha256,version,created_at,storage_relative FROM user_artifacts WHERE task_id=?1 AND id=?2", params![task_id,id], from_row).optional().map_err(|e|e.to_string())?.ok_or("artifact-missing")?;
    let path = managed_copy_path(storage_root, &artifact.storage_relative).ok();
    let quarantine = path
        .as_ref()
        .map(|path| path.with_file_name(format!(".delete-{}", id)));
    if let (Some(path), Some(quarantine)) = (&path, &quarantine) {
        fs::rename(path, quarantine).map_err(|_| "artifact-remove-failed".to_string())?;
    }
    let deleted = tx.execute(
        "DELETE FROM user_artifacts WHERE task_id=?1 AND id=?2",
        params![task_id, id],
    );
    if let Err(error) = deleted {
        if let (Some(path), Some(quarantine)) = (&path, &quarantine) {
            let _ = fs::rename(quarantine, path);
        }
        return Err(error.to_string());
    }
    if let Err(error) = tx.commit() {
        if let (Some(path), Some(quarantine)) = (&path, &quarantine) {
            let _ = fs::rename(quarantine, path);
        }
        return Err(error.to_string());
    }
    if let Some(quarantine) = quarantine {
        let _ = fs::remove_file(quarantine);
    }
    Ok(())
}

#[tauri::command]
pub async fn user_artifact_save(
    app: AppHandle,
    db: State<'_, DbState>,
    task_id: String,
    path: String,
) -> Result<UserArtifact, String> {
    let mut conn = db.0.lock().await;
    let root = PathBuf::from(agent_workspace::task_root(&conn, &task_id)?);
    init_schema(&conn)?;
    let storage_root = storage_root(&app)?;
    let artifact = save_artifact(&mut conn, &storage_root, &task_id, &root, &path)?;
    let rows = select_for_task(&conn, &task_id)?;
    let _ = cleanup_task_orphans(&storage_root, &task_id, &rows);
    Ok(artifact)
}

/// Save a result from the current native task session. The task identity comes
/// from the private app-tool token, never from model supplied arguments.
pub(crate) async fn save_for_active_task(
    app: &AppHandle,
    task_id: &str,
    source_relative: &str,
) -> Result<UserArtifact, String> {
    let host = app.state::<crate::tasks::TaskHost>();
    let db = app.state::<DbState>();
    let mut conn = db.0.lock().await;
    let task = crate::tasks::store::read_task(&conn, task_id)?.ok_or("task-missing")?;
    if !can_save_from_task(&task.state, host.sessions.is_live(task_id)) {
        return Err("task-not-active".into());
    }
    let root = PathBuf::from(agent_workspace::task_root(&conn, task_id)?);
    init_schema(&conn)?;
    let storage_root = storage_root(app)?;
    let artifact = save_artifact(&mut conn, &storage_root, task_id, &root, source_relative)?;
    let rows = select_for_task(&conn, task_id)?;
    let _ = cleanup_task_orphans(&storage_root, task_id, &rows);
    Ok(artifact)
}

fn can_save_from_task(state: &crate::tasks::store::TaskState, session_live: bool) -> bool {
    state.pending && state.live && !state.ended && !state.stopped && session_live
}

#[tauri::command]
pub async fn user_artifact_list(
    app: AppHandle,
    db: State<'_, DbState>,
    task_id: String,
) -> Result<Vec<UserArtifact>, String> {
    let conn = db.0.lock().await;
    let _ = agent_workspace::task_project_path(&conn, &task_id)?;
    init_schema(&conn)?;
    let rows = select_for_task(&conn, &task_id)?;
    let _ = cleanup_task_orphans(&storage_root(&app)?, &task_id, &rows);
    Ok(rows)
}

#[tauri::command]
pub async fn user_artifact_open(
    app: AppHandle,
    db: State<'_, DbState>,
    task_id: String,
    id: String,
) -> Result<(), String> {
    let conn = db.0.lock().await;
    let _ = agent_workspace::task_project_path(&conn, &task_id)?;
    init_schema(&conn)?;
    let artifact = conn.query_row("SELECT id,task_id,source_relative,name,mime,bytes,sha256,version,created_at,storage_relative FROM user_artifacts WHERE task_id=?1 AND id=?2", params![task_id,id], from_row).optional().map_err(|e|e.to_string())?.ok_or("artifact-missing")?;
    let path = managed_copy_path(&storage_root(&app)?, &artifact.storage_relative)?;
    let app_name = open_application(&path)?;
    drop(conn);
    app.opener()
        .open_path(crate::agent_workspace::display_path(&path), app_name)
        .map_err(|_| "artifact-open-failed".to_string())
}

#[tauri::command]
pub async fn user_artifact_preview(
    app: AppHandle,
    db: State<'_, DbState>,
    task_id: String,
    id: String,
) -> Result<serde_json::Value, String> {
    let conn = db.0.lock().await;
    let _ = agent_workspace::task_project_path(&conn, &task_id)?;
    init_schema(&conn)?;
    let artifact = conn.query_row("SELECT id,task_id,source_relative,name,mime,bytes,sha256,version,created_at,storage_relative FROM user_artifacts WHERE task_id=?1 AND id=?2", params![task_id,id], from_row).optional().map_err(|_| "artifact-missing")?.ok_or("artifact-missing")?;
    if artifact.bytes > 10 * 1024 * 1024 {
        return Err("attachment-limit".into());
    }
    let path = managed_copy_path(&storage_root(&app)?, &artifact.storage_relative)?;
    if fs::metadata(&path).map_err(|_| "artifact-missing")?.len() > 10 * 1024 * 1024 {
        return Err("attachment-limit".into());
    }
    drop(conn);
    tauri::async_runtime::spawn_blocking(move || {
        let result = crate::chat_media::chat_attachment_read(
            agent_workspace::display_path(&path),
            Some(true),
        )?;
        if !result["mime"]
            .as_str()
            .is_some_and(|mime| mime.starts_with("image/"))
        {
            return Err("attachment-unsupported".into());
        }
        Ok(result)
    })
    .await
    .map_err(|_| "artifact-read-failed".to_string())?
}

#[tauri::command]
pub async fn user_artifact_remove(
    app: AppHandle,
    db: State<'_, DbState>,
    task_id: String,
    id: String,
) -> Result<(), String> {
    let mut conn = db.0.lock().await;
    let _ = agent_workspace::task_project_path(&conn, &task_id)?;
    init_schema(&conn)?;
    remove_artifact(&mut conn, &storage_root(&app)?, &task_id, &id)?;
    let rows = select_for_task(&conn, &task_id)?;
    let _ = cleanup_task_orphans(&storage_root(&app)?, &task_id, &rows);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);
    impl Temp {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "aplot-user-artifact-{name}-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn setup() -> (Temp, Connection, String) {
        let temp = Temp::new("test");
        let root = temp.0.join("project");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("result.txt"), b"result body").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        (temp, conn, root.to_string_lossy().into_owned())
    }

    #[test]
    fn rejects_traversal_absolute_paths_and_symlink_escapes() {
        let (temp, _conn, root) = setup();
        let root = PathBuf::from(root);
        let outside = temp.0.join("outside.txt");
        fs::write(&outside, b"outside").unwrap();
        for path in [
            "../outside.txt",
            "sub/../../outside.txt",
            "/outside.txt",
            "C:\\outside.txt",
            "https://example.test/file",
        ] {
            assert!(
                resolve_project_file(&root, path).is_err(),
                "accepted {path}"
            );
        }
        let oversized = root.join("too-large.bin");
        File::create(&oversized)
            .unwrap()
            .set_len(MAX_ARTIFACT_BYTES + 1)
            .unwrap();
        assert_eq!(
            resolve_project_file(&root, "too-large.bin").unwrap_err(),
            "artifact-size-limit"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("escape.txt")).unwrap();
            assert_eq!(
                resolve_project_file(&root, "escape.txt").unwrap_err(),
                "artifact-path-outside-project"
            );
        }
    }

    #[test]
    fn saves_immutable_versions_with_hash_and_removes_only_the_managed_copy() {
        let (temp, mut conn, root) = setup();
        let root = PathBuf::from(root);
        let managed = temp.0.join("managed");
        fs::create_dir_all(&managed).unwrap();
        let task = uuid::Uuid::new_v4().to_string();
        let first = save_artifact(&mut conn, &managed, &task, &root, "result.txt").unwrap();
        assert_eq!(first.version, 1);
        assert_eq!(first.mime, "text/plain");
        assert_eq!(
            first.sha256,
            format!("{:x}", Sha256::digest(b"result body"))
        );
        let first_path = managed_copy_path(&managed, &first.storage_relative).unwrap();
        assert_eq!(fs::read(&first_path).unwrap(), b"result body");
        let retry = save_artifact(&mut conn, &managed, &task, &root, "result.txt").unwrap();
        assert_eq!(retry.id, first.id);
        assert_eq!(retry.version, first.version);
        assert_eq!(select_for_task(&conn, &task).unwrap().len(), 1);
        assert_eq!(fs::read_dir(managed.join(&task)).unwrap().count(), 1);
        fs::write(root.join("result.txt"), b"updated result").unwrap();
        let second = save_artifact(&mut conn, &managed, &task, &root, "result.txt").unwrap();
        assert_eq!(second.version, 2);
        assert_ne!(second.id, first.id);
        assert_eq!(fs::read(&first_path).unwrap(), b"result body");
        remove_artifact(&mut conn, &managed, &task, &first.id).unwrap();
        assert!(!first_path.exists());
        assert_eq!(
            fs::read(root.join("result.txt")).unwrap(),
            b"updated result"
        );
        assert_eq!(
            select_for_task(&conn, &task)
                .unwrap()
                .iter()
                .map(|row| row.version)
                .collect::<Vec<_>>(),
            vec![2]
        );
    }

    #[test]
    fn failed_metadata_insert_removes_the_new_managed_copy() {
        let (temp, mut conn, root) = setup();
        let root = PathBuf::from(root);
        let managed = temp.0.join("managed");
        fs::create_dir_all(&managed).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_artifact_insert BEFORE INSERT ON user_artifacts BEGIN SELECT RAISE(ABORT,'forced write failure'); END;").unwrap();
        let task = uuid::Uuid::new_v4().to_string();
        assert!(save_artifact(&mut conn, &managed, &task, &root, "result.txt").is_err());
        assert_eq!(fs::read(root.join("result.txt")).unwrap(), b"result body");
        assert_eq!(fs::read_dir(managed.join(task)).unwrap().count(), 0);
    }

    #[test]
    fn listing_cleans_only_unregistered_managed_orphans() {
        let (temp, mut conn, root) = setup();
        let root = PathBuf::from(root);
        let managed = temp.0.join("managed");
        fs::create_dir_all(&managed).unwrap();
        let task = uuid::Uuid::new_v4().to_string();
        let registered = save_artifact(&mut conn, &managed, &task, &root, "result.txt").unwrap();
        let orphan = managed.join(&task).join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&orphan).unwrap();
        fs::write(orphan.join("artifact.bin"), b"orphan").unwrap();
        let rows = select_for_task(&conn, &task).unwrap();
        cleanup_task_orphans(&managed, &task, &rows).unwrap();
        assert!(managed_copy_path(&managed, &registered.storage_relative).is_ok());
        assert!(!orphan.exists());
    }

    #[test]
    fn cleanup_restores_a_quarantined_copy_when_its_database_record_remains() {
        let (temp, mut conn, root) = setup();
        let root = PathBuf::from(root);
        let managed = temp.0.join("managed");
        fs::create_dir_all(&managed).unwrap();
        let task = uuid::Uuid::new_v4().to_string();
        let saved = save_artifact(&mut conn, &managed, &task, &root, "result.txt").unwrap();
        let expected = managed_copy_path(&managed, &saved.storage_relative).unwrap();
        let quarantined = expected.with_file_name(format!(".delete-{}", saved.id));
        fs::rename(&expected, &quarantined).unwrap();
        cleanup_task_orphans(&managed, &task, &select_for_task(&conn, &task).unwrap()).unwrap();
        assert_eq!(fs::read(expected).unwrap(), b"result body");
        assert!(!quarantined.exists());
    }

    #[test]
    fn opens_known_documents_but_sends_scripts_to_notepad_and_rejects_unknown_formats() {
        assert_eq!(open_application(Path::new("report.docx")).unwrap(), None);
        assert_eq!(
            open_application(Path::new("script.py")).unwrap(),
            Some("notepad")
        );
        assert_eq!(
            open_application(Path::new("untrusted.exe")).unwrap_err(),
            "artifact-open-unsupported"
        );
    }

    #[test]
    fn active_task_saving_requires_a_live_pending_native_session() {
        let mut state = crate::tasks::store::TaskState::default();
        state.pending = true;
        state.live = true;
        assert!(can_save_from_task(&state, true));
        assert!(!can_save_from_task(&state, false));

        state.ended = true;
        assert!(!can_save_from_task(&state, true));
        state.ended = false;
        state.stopped = true;
        assert!(!can_save_from_task(&state, true));
    }

    #[test]
    fn failed_delete_keeps_the_metadata_and_managed_copy() {
        let (temp, mut conn, root) = setup();
        let root = PathBuf::from(root);
        let managed = temp.0.join("managed");
        fs::create_dir_all(&managed).unwrap();
        let task = uuid::Uuid::new_v4().to_string();
        let saved = save_artifact(&mut conn, &managed, &task, &root, "result.txt").unwrap();
        let copy = managed_copy_path(&managed, &saved.storage_relative).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_artifact_delete BEFORE DELETE ON user_artifacts BEGIN SELECT RAISE(ABORT,'forced delete failure'); END;").unwrap();
        assert!(remove_artifact(&mut conn, &managed, &task, &saved.id).is_err());
        assert_eq!(select_for_task(&conn, &task).unwrap().len(), 1);
        assert_eq!(fs::read(&copy).unwrap(), b"result body");
        assert_eq!(fs::read(root.join("result.txt")).unwrap(), b"result body");
    }
}
