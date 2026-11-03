//! Project-scoped, persistent copies of files explicitly selected by the user.
//!
//! Copies are stored below the application's data directory and are addressed
//! only by opaque UUIDs. The original project directory is never required after
//! import, and internal storage paths are never serialized to the frontend.

use crate::db::DbState;
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager, State};

const STORAGE_DIR: &str = "project-files";
const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 200_000;
const MAX_NAME_CHARS: usize = 180;
const MAX_NAME_BYTES: usize = 200;
const MAX_SEARCH_CHARS: usize = 512;
const MAX_SEARCH_TERMS: usize = 16;
const MAX_SEARCH_MATCHES: usize = 50;
const MAX_SNIPPET_CHARS: usize = 500;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub mime: String,
    pub bytes: u64,
    pub sha256: String,
    pub version: u32,
    pub created_at: String,
    pub indexed: bool,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileMatch {
    pub file: ProjectFile,
    pub snippet: String,
}

#[derive(Clone, Debug)]
struct StoredFile {
    file: ProjectFile,
    extracted_text: String,
    storage_relative: String,
}

struct StagedFile {
    stored: StoredFile,
    root: PathBuf,
    file_dir: PathBuf,
    temporary_path: PathBuf,
    final_path: PathBuf,
}

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_files (
           id TEXT PRIMARY KEY,
           project_id TEXT NOT NULL,
           name TEXT NOT NULL,
           name_key TEXT NOT NULL,
           mime TEXT NOT NULL,
           bytes INTEGER NOT NULL CHECK(bytes >= 0),
           sha256 TEXT NOT NULL,
           version INTEGER NOT NULL CHECK(version > 0),
           created_at TEXT NOT NULL,
           indexed INTEGER NOT NULL CHECK(indexed IN (0, 1)),
           truncated INTEGER NOT NULL CHECK(truncated IN (0, 1)),
           extracted_text TEXT NOT NULL DEFAULT '',
           storage_relative TEXT NOT NULL,
           UNIQUE(project_id, name_key, version)
         );
         CREATE INDEX IF NOT EXISTS project_files_project_name
           ON project_files(project_id, name_key, version DESC);
         CREATE VIRTUAL TABLE IF NOT EXISTS project_files_fts USING fts5(
           file_id UNINDEXED,
           project_id UNINDEXED,
           name,
           extracted_text,
           tokenize='unicode61 remove_diacritics 2'
         );",
    )
    .map_err(|error| format!("project-file-schema: {error}"))
}

fn workspace_data(conn: &Connection) -> Result<Value, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM kv WHERE key='agent-workspace-v2'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("project-file-workspace: {error}"))?;
    let Some(raw) = raw else {
        return Err("project-missing".into());
    };
    let envelope: Value =
        serde_json::from_str(&raw).map_err(|_| "project-file-workspace-invalid".to_string())?;
    if envelope["version"].as_i64() != Some(2) {
        return Err("project-file-workspace-invalid".into());
    }
    envelope
        .get("data")
        .cloned()
        .ok_or_else(|| "project-file-workspace-invalid".to_string())
}

pub(crate) fn require_project(conn: &Connection, project_id: &str) -> Result<(), String> {
    if project_id.is_empty() || project_id.chars().count() > 200 {
        return Err("project-missing".into());
    }
    let data = workspace_data(conn)?;
    let projects = data["projects"]
        .as_array()
        .ok_or_else(|| "project-file-workspace-invalid".to_string())?;
    if projects
        .iter()
        .any(|project| project["id"].as_str() == Some(project_id))
    {
        Ok(())
    } else {
        Err("project-missing".into())
    }
}

pub(crate) fn project_id_for_task(conn: &Connection, task_id: &str) -> Result<String, String> {
    if task_id.is_empty() || task_id.chars().count() > 200 {
        return Err("task-missing".into());
    }
    let data = workspace_data(conn)?;
    let tasks = data["tasks"]
        .as_array()
        .ok_or_else(|| "project-file-workspace-invalid".to_string())?;
    let project_id = tasks
        .iter()
        .find(|task| task["id"].as_str() == Some(task_id))
        .and_then(|task| task["projectId"].as_str())
        .ok_or_else(|| "task-missing".to_string())?;
    require_project(conn, project_id)?;
    Ok(project_id.to_owned())
}

fn app_storage_root(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = crate::db::connection_data_dir(app)?;
    fs::create_dir_all(&data_dir).map_err(|_| "project-file-storage".to_string())?;
    let data_dir = fs::canonicalize(data_dir).map_err(|_| "project-file-storage".to_string())?;
    storage_root_for_data_dir(&data_dir)
}

fn storage_root_for_data_dir(data_dir: &Path) -> Result<PathBuf, String> {
    let data_dir = fs::canonicalize(data_dir).map_err(|_| "project-file-storage".to_string())?;
    let root = data_dir.join(STORAGE_DIR);
    if fs::symlink_metadata(&root).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("project-file-storage".into());
    }
    fs::create_dir_all(&root).map_err(|_| "project-file-storage".to_string())?;
    let canonical = fs::canonicalize(&root).map_err(|_| "project-file-storage".to_string())?;
    if !canonical.starts_with(&data_dir)
        || canonical.file_name().and_then(|v| v.to_str()) != Some(STORAGE_DIR)
    {
        return Err("project-file-storage".into());
    }
    Ok(canonical)
}

fn valid_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

fn project_storage_key(project_id: &str) -> String {
    let digest = Sha256::digest(project_id.as_bytes());
    format!("{:x}", digest)
}

fn ensure_project_storage_dir(root: &Path, project_id: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|_| "project-file-storage".to_string())?;
    let shard_name = project_storage_key(project_id);
    let shard = root.join(&shard_name);
    match fs::symlink_metadata(&shard) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("project-file-storage".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::create_dir(&shard) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err("project-file-storage".into()),
            }
        }
        Err(_) => return Err("project-file-storage".into()),
    }
    let canonical = fs::canonicalize(&shard).map_err(|_| "project-file-storage".to_string())?;
    if !canonical.starts_with(&root)
        || canonical.file_name().and_then(|v| v.to_str()) != Some(shard_name.as_str())
    {
        return Err("project-file-storage".into());
    }
    Ok(canonical)
}

fn safe_extension(name: &str) -> String {
    let ext = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ext.is_empty() && ext.len() <= 16 && ext.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        ext
    } else {
        "bin".into()
    }
}

fn sanitize_name(path: &Path) -> Result<String, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "project-file-path-invalid".to_string())?;
    let mut cleaned: String = name
        .chars()
        .filter_map(|ch| {
            if ch.is_control() {
                None
            } else if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                Some('_')
            } else {
                Some(ch)
            }
        })
        .collect();
    cleaned = cleaned.trim().trim_end_matches('.').to_owned();
    if cleaned.is_empty() {
        cleaned = "file".into();
    }
    if cleaned.chars().count() > MAX_NAME_CHARS || cleaned.len() > MAX_NAME_BYTES {
        return Err("project-file-name-invalid".into());
    }
    Ok(cleaned)
}

fn mime_for_office(name: &str) -> Option<&'static str> {
    match Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        _ => None,
    }
}

fn cap_utf8(text: String, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text, false);
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}

fn staged_paths(
    root: &Path,
    project_id: &str,
    file_id: &str,
    extension: &str,
) -> Result<(PathBuf, PathBuf, PathBuf, String), String> {
    if !valid_uuid(file_id)
        || extension.is_empty()
        || extension.len() > 16
        || !extension
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        return Err("project-file-storage".into());
    }
    let project_dir = ensure_project_storage_dir(root, project_id)?;
    let file_dir = project_dir.join(file_id);
    fs::create_dir(&file_dir).map_err(|_| "project-file-storage".to_string())?;
    let canonical_dir =
        fs::canonicalize(&file_dir).map_err(|_| "project-file-storage".to_string())?;
    if !canonical_dir.starts_with(&project_dir)
        || canonical_dir.file_name().and_then(|v| v.to_str()) != Some(file_id)
    {
        let _ = fs::remove_dir(&file_dir);
        return Err("project-file-storage".into());
    }
    let temporary = canonical_dir.join(format!(".incoming.{extension}"));
    let final_path = canonical_dir.join(format!("content.{extension}"));
    let relative = format!(
        "{}/{file_id}/content.{extension}",
        project_storage_key(project_id)
    );
    Ok((canonical_dir, temporary, final_path, relative))
}

fn write_staged(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|_| "project-file-storage".to_string())?;
        output
            .write_all(bytes)
            .map_err(|_| "project-file-storage".to_string())?;
        output
            .sync_all()
            .map_err(|_| "project-file-storage".to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

fn stage_import(root: &Path, project_id: &str, source: &Path) -> Result<StagedFile, String> {
    if !source.is_absolute() {
        return Err("project-file-path-invalid".into());
    }
    let source = fs::canonicalize(source).map_err(|_| "project-file-source-missing".to_string())?;
    let metadata = fs::metadata(&source).map_err(|_| "project-file-source-missing".to_string())?;
    if !metadata.is_file() {
        return Err("project-file-source-not-file".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("project-file-size-limit".into());
    }
    let mut input = File::open(&source).map_err(|_| "project-file-source-missing".to_string())?;
    let mut bytes = Vec::with_capacity(metadata.len().min(MAX_FILE_BYTES) as usize);
    Read::by_ref(&mut input)
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "project-file-source-read".to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("project-file-size-limit".into());
    }
    let name = sanitize_name(&source)?;
    let extension = safe_extension(&name);
    let file_id = uuid::Uuid::new_v4().to_string();
    let (file_dir, temporary_path, final_path, storage_relative) =
        staged_paths(root, project_id, &file_id, &extension)?;
    let mut staged_dir_guard = Some(file_dir.clone());

    let result = (|| {
        write_staged(&temporary_path, &bytes)?;
        let (mime, extracted_text, indexed, truncated) = if let Some(mime) = mime_for_office(&name)
        {
            if !bytes.starts_with(b"PK\x03\x04")
                && !bytes.starts_with(b"PK\x05\x06")
                && !bytes.starts_with(b"PK\x07\x08")
            {
                return Err("project-file-unsupported".into());
            }
            let extracted = crate::document_text::extract_office(&temporary_path)?
                .ok_or_else(|| "project-file-unsupported".to_string())?;
            let (text, capped) = cap_utf8(extracted.text, MAX_TEXT_BYTES);
            (mime.to_owned(), text, true, extracted.truncated || capped)
        } else {
            let attachment = crate::chat_media::chat_attachment_read(
                temporary_path.to_string_lossy().to_string(),
                None,
            )?;
            let mime = attachment["mime"]
                .as_str()
                .ok_or_else(|| "project-file-unsupported".to_string())?;
            if !matches!(
                mime,
                "image/png"
                    | "image/jpeg"
                    | "image/gif"
                    | "image/webp"
                    | "application/pdf"
                    | "text/plain"
            ) {
                return Err("project-file-unsupported".into());
            }
            if mime == "text/plain" {
                let text = attachment["text"]
                    .as_str()
                    .ok_or_else(|| "project-file-unsupported".to_string())?
                    .to_owned();
                (mime.to_owned(), text, true, false)
            } else {
                (mime.to_owned(), String::new(), false, false)
            }
        };
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let file = ProjectFile {
            id: file_id.clone(),
            project_id: project_id.to_owned(),
            name: name.clone(),
            mime,
            bytes: bytes.len() as u64,
            sha256,
            version: 0,
            created_at: String::new(),
            indexed,
            truncated,
        };
        Ok(StagedFile {
            stored: StoredFile {
                file,
                extracted_text,
                storage_relative,
            },
            root: root.to_path_buf(),
            file_dir: file_dir.clone(),
            temporary_path: temporary_path.clone(),
            final_path: final_path.clone(),
        })
    })();
    if result.is_ok() {
        staged_dir_guard = None;
    }
    if let Some(dir) = staged_dir_guard {
        remove_created_dir(root, project_id, &file_id, &dir);
    }
    result
}

fn remove_created_dir(root: &Path, project_id: &str, file_id: &str, dir: &Path) {
    if !valid_uuid(file_id) {
        return;
    }
    let Ok(project_dir) = ensure_project_storage_dir(root, project_id) else {
        return;
    };
    if dir.parent() != Some(project_dir.as_path())
        || dir.file_name().and_then(|v| v.to_str()) != Some(file_id)
    {
        return;
    }
    if fs::symlink_metadata(dir)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    {
        let _ = fs::remove_dir_all(dir);
    }
}

fn read_stored(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredFile> {
    let bytes: i64 = row.get(5)?;
    let version: i64 = row.get(7)?;
    Ok(StoredFile {
        file: ProjectFile {
            id: row.get(0)?,
            project_id: row.get(1)?,
            name: row.get(2)?,
            mime: row.get(4)?,
            bytes: bytes.max(0) as u64,
            sha256: row.get(6)?,
            version: version.max(0) as u32,
            created_at: row.get(8)?,
            indexed: row.get::<_, i64>(9)? != 0,
            truncated: row.get::<_, i64>(10)? != 0,
        },
        extracted_text: row.get(11)?,
        storage_relative: row.get(12)?,
    })
}

const SELECT_COLUMNS: &str = "id,project_id,name,name_key,mime,bytes,sha256,version,created_at,indexed,truncated,extracted_text,storage_relative";

fn get_file(conn: &Connection, project_id: &str, id: &str) -> Result<StoredFile, String> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM project_files WHERE project_id=?1 AND id=?2");
    conn.query_row(&sql, params![project_id, id], read_stored)
        .optional()
        .map_err(|error| format!("project-file-db: {error}"))?
        .ok_or_else(|| "project-file-missing".to_string())
}

fn latest_for_name(
    conn: &Connection,
    project_id: &str,
    name_key: &str,
) -> Result<Option<StoredFile>, String> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM project_files WHERE project_id=?1 AND name_key=?2 ORDER BY version DESC LIMIT 1");
    conn.query_row(&sql, params![project_id, name_key], read_stored)
        .optional()
        .map_err(|error| format!("project-file-db: {error}"))
}

fn list_project(conn: &Connection, project_id: &str) -> Result<Vec<ProjectFile>, String> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM project_files WHERE project_id=?1 ORDER BY name_key COLLATE BINARY, version DESC");
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| format!("project-file-db: {error}"))?;
    let rows = statement
        .query_map([project_id], read_stored)
        .map_err(|error| format!("project-file-db: {error}"))?;
    rows.map(|row| {
        row.map(|stored| stored.file)
            .map_err(|error| error.to_string())
    })
    .collect()
}

fn relative_parts(
    storage_relative: &str,
    project_id: &str,
    file_id: &str,
) -> Result<(String, String), String> {
    let path = Path::new(storage_relative);
    let mut pieces = Vec::new();
    for component in path.components() {
        let Component::Normal(part) = component else {
            return Err("project-file-storage".into());
        };
        pieces.push(part.to_str().ok_or("project-file-storage")?.to_owned());
    }
    if pieces.len() != 3
        || pieces[0] != project_storage_key(project_id)
        || pieces[1] != file_id
        || !valid_uuid(file_id)
    {
        return Err("project-file-storage".into());
    }
    let filename = &pieces[2];
    let extension = filename
        .strip_prefix("content.")
        .filter(|ext| {
            !ext.is_empty()
                && ext.len() <= 16
                && ext
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
        .ok_or_else(|| "project-file-storage".to_string())?;
    Ok((pieces[1].clone(), extension.to_owned()))
}

fn managed_copy_path(root: &Path, stored: &StoredFile) -> Result<PathBuf, String> {
    let (canonical_dir, path) = managed_copy_location(root, stored)?;
    let metadata = fs::symlink_metadata(&path).map_err(|_| "project-file-missing".to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() != stored.file.bytes
    {
        return Err("project-file-integrity".into());
    }
    let canonical = fs::canonicalize(&path).map_err(|_| "project-file-storage".to_string())?;
    let root = fs::canonicalize(root).map_err(|_| "project-file-storage".to_string())?;
    if !canonical.starts_with(&root) || canonical.parent() != Some(canonical_dir.as_path()) {
        return Err("project-file-storage".into());
    }
    Ok(canonical)
}

/// Resolve only the generated project/file UUID layout. The managed leaf may
/// be absent so explicit removal can clean a broken metadata row safely.
fn managed_copy_location(root: &Path, stored: &StoredFile) -> Result<(PathBuf, PathBuf), String> {
    let (file_id, extension) = relative_parts(
        &stored.storage_relative,
        &stored.file.project_id,
        &stored.file.id,
    )?;
    let root = fs::canonicalize(root).map_err(|_| "project-file-storage".to_string())?;
    let shard = ensure_project_storage_dir(&root, &stored.file.project_id)?;
    let file_dir = shard.join(&file_id);
    let canonical_dir = match fs::symlink_metadata(&file_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("project-file-storage".into());
        }
        Ok(_) => fs::canonicalize(&file_dir).map_err(|_| "project-file-storage".to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => file_dir,
        Err(_) => return Err("project-file-storage".into()),
    };
    if !canonical_dir.starts_with(&shard)
        || canonical_dir.file_name().and_then(|v| v.to_str()) != Some(file_id.as_str())
    {
        return Err("project-file-storage".into());
    }
    let path = canonical_dir.join(format!("content.{extension}"));
    Ok((canonical_dir, path))
}

fn verify_file_bytes(stored: &StoredFile, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 != stored.file.bytes
        || bytes.len() as u64 > MAX_FILE_BYTES
        || format!("{:x}", Sha256::digest(bytes)) != stored.file.sha256
    {
        return Err("project-file-integrity".into());
    }
    Ok(())
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let mut input = File::open(path).map_err(|_| "project-file-read".to_string())?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut input)
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "project-file-read".to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("project-file-integrity".into());
    }
    Ok(bytes)
}

fn verify_managed_copy(root: &Path, stored: &StoredFile) -> Result<Vec<u8>, String> {
    let path = managed_copy_path(root, stored)?;
    let bytes = read_bounded(&path)?;
    verify_file_bytes(stored, &bytes)?;
    Ok(bytes)
}

fn remove_staged(staged: &StagedFile) {
    remove_created_dir(
        &staged.root,
        &staged.stored.file.project_id,
        &staged.stored.file.id,
        &staged.file_dir,
    );
}

fn insert_staged(
    conn: &mut Connection,
    mut staged: StagedFile,
    verified_duplicate_id: Option<&str>,
) -> Result<ProjectFile, String> {
    if let Err(error) = require_project(conn, &staged.stored.file.project_id) {
        remove_staged(&staged);
        return Err(error);
    }
    let name_key = staged.stored.file.name.to_lowercase();
    let tx = match conn.transaction() {
        Ok(tx) => tx,
        Err(error) => {
            remove_staged(&staged);
            return Err(format!("project-file-db: {error}"));
        }
    };
    let latest = match latest_for_name(&tx, &staged.stored.file.project_id, &name_key) {
        Ok(row) => row,
        Err(error) => {
            drop(tx);
            remove_staged(&staged);
            return Err(error);
        }
    };
    if let Some(existing) = latest.as_ref() {
        if existing.file.sha256 == staged.stored.file.sha256
            && verified_duplicate_id == Some(existing.file.id.as_str())
            && managed_copy_path(&staged.root, existing).is_ok()
        {
            let result = existing.file.clone();
            let _ = tx.rollback();
            remove_staged(&staged);
            return Ok(result);
        }
    }
    let version = match latest.as_ref() {
        Some(file) => file.file.version.checked_add(1),
        None => Some(1),
    };
    let Some(version) = version.filter(|value| *value > 0 && *value <= i64::MAX as u32) else {
        drop(tx);
        remove_staged(&staged);
        return Err("project-file-version-limit".into());
    };
    staged.stored.file.version = version;
    staged.stored.file.created_at = chrono::Utc::now().to_rfc3339();
    if managed_copy_path_for_staged(&staged).is_err() {
        drop(tx);
        remove_staged(&staged);
        return Err("project-file-storage".into());
    }
    if fs::rename(&staged.temporary_path, &staged.final_path).is_err() {
        drop(tx);
        remove_staged(&staged);
        return Err("project-file-storage".into());
    }
    let write_result = (|| {
        tx.execute(
            "INSERT INTO project_files(id,project_id,name,name_key,mime,bytes,sha256,version,created_at,indexed,truncated,extracted_text,storage_relative)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                staged.stored.file.id,
                staged.stored.file.project_id,
                staged.stored.file.name,
                name_key,
                staged.stored.file.mime,
                staged.stored.file.bytes as i64,
                staged.stored.file.sha256,
                staged.stored.file.version as i64,
                staged.stored.file.created_at,
                if staged.stored.file.indexed { 1_i64 } else { 0_i64 },
                if staged.stored.file.truncated { 1_i64 } else { 0_i64 },
                staged.stored.extracted_text,
                staged.stored.storage_relative,
            ],
        )?;
        tx.execute(
            "INSERT INTO project_files_fts(file_id,project_id,name,extracted_text) VALUES(?1,?2,?3,?4)",
            params![
                staged.stored.file.id,
                staged.stored.file.project_id,
                staged.stored.file.name,
                staged.stored.extracted_text
            ],
        )?;
        Ok::<(), rusqlite::Error>(())
    })();
    if let Err(error) = write_result {
        drop(tx);
        remove_staged(&staged);
        return Err(format!("project-file-db: {error}"));
    }
    if let Err(error) = tx.commit() {
        remove_staged(&staged);
        return Err(format!("project-file-db: {error}"));
    }
    Ok(staged.stored.file)
}

fn managed_copy_path_for_staged(staged: &StagedFile) -> Result<(), String> {
    let file_id = &staged.stored.file.id;
    let (id, extension) = relative_parts(
        &staged.stored.storage_relative,
        &staged.stored.file.project_id,
        file_id,
    )?;
    let shard = ensure_project_storage_dir(&staged.root, &staged.stored.file.project_id)?;
    let canonical_dir =
        fs::canonicalize(&staged.file_dir).map_err(|_| "project-file-storage".to_string())?;
    if id != *file_id
        || canonical_dir.parent() != Some(shard.as_path())
        || canonical_dir.file_name().and_then(|v| v.to_str()) != Some(file_id.as_str())
    {
        return Err("project-file-storage".into());
    }
    let expected = canonical_dir.join(format!("content.{extension}"));
    if expected != staged.final_path
        || staged.temporary_path.parent() != Some(canonical_dir.as_path())
    {
        return Err("project-file-storage".into());
    }
    let temp_meta = fs::symlink_metadata(&staged.temporary_path)
        .map_err(|_| "project-file-storage".to_string())?;
    if temp_meta.file_type().is_symlink()
        || !temp_meta.is_file()
        || temp_meta.len() != staged.stored.file.bytes
    {
        return Err("project-file-storage".into());
    }
    Ok(())
}

fn safe_fts_query(raw: &str) -> String {
    let mut query = String::new();
    for (index, term) in raw
        .chars()
        .take(MAX_SEARCH_CHARS)
        .collect::<String>()
        .split_whitespace()
        .take(MAX_SEARCH_TERMS)
        .enumerate()
    {
        if index > 0 {
            query.push_str(" AND ");
        }
        query.push('"');
        query.push_str(&term.replace('"', "\"\""));
        query.push('"');
    }
    query
}

fn snippet_for(text: &str) -> String {
    text.chars().take(MAX_SNIPPET_CHARS).collect()
}

fn search_project(
    conn: &Connection,
    project_id: &str,
    query: &str,
) -> Result<Vec<ProjectFileMatch>, String> {
    let fts_query = safe_fts_query(query);
    if fts_query.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT project_files.id,project_files.project_id,project_files.name,project_files.name_key,
           project_files.mime,project_files.bytes,project_files.sha256,project_files.version,
           project_files.created_at,project_files.indexed,project_files.truncated,
           project_files.extracted_text,project_files.storage_relative,
           snippet(project_files_fts,-1,'‹','›','…',18)
         FROM project_files_fts
         JOIN project_files ON project_files.id=project_files_fts.file_id
           AND project_files.project_id=project_files_fts.project_id
         WHERE project_files_fts MATCH ?1 AND project_files.project_id=?2
         ORDER BY project_files.created_at DESC, project_files.version DESC
         LIMIT {MAX_SEARCH_MATCHES}"
    );
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| format!("project-file-search: {error}"))?;
    let rows = statement
        .query_map(params![fts_query, project_id], |row| {
            let stored = read_stored(row)?;
            let snippet: String = row.get(13)?;
            Ok(ProjectFileMatch {
                file: stored.file.clone(),
                snippet: snippet_for(if snippet.is_empty() {
                    &stored.file.name
                } else {
                    &snippet
                }),
            })
        })
        .map_err(|error| format!("project-file-search: {error}"))?;
    rows.map(|row| row.map_err(|error| format!("project-file-search: {error}")))
        .collect()
}

fn read_payload(root: &Path, stored: &StoredFile) -> Result<Value, String> {
    let path = managed_copy_path(root, stored)?;
    match stored.file.mime.as_str() {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => {
            let extracted_text = verified_extracted_text(root, stored)?;
            let text = if stored.file.truncated {
                format!(
                    "[Extracted document text is truncated; remaining content unavailable.]\n{}",
                    extracted_text
                )
            } else {
                extracted_text
            };
            Ok(json!({
                "name": stored.file.name,
                "mime": "text/plain",
                "text": text,
                "truncated": stored.file.truncated,
            }))
        }
        "text/plain" => {
            let raw =
                crate::chat_media::chat_attachment_read(path.to_string_lossy().to_string(), None)?;
            let text = raw["text"].as_str().ok_or("project-file-unsupported")?;
            verify_file_bytes(stored, text.as_bytes())?;
            if !stored.file.indexed || stored.file.truncated || text != stored.extracted_text {
                return Err("project-file-integrity".into());
            }
            Ok(
                json!({"name":stored.file.name,"mime":"text/plain","text":text,"truncated":stored.file.truncated}),
            )
        }
        "application/pdf" | "image/png" | "image/jpeg" | "image/gif" | "image/webp" => {
            let raw =
                crate::chat_media::chat_attachment_read(path.to_string_lossy().to_string(), None)?;
            if raw["mime"].as_str() != Some(stored.file.mime.as_str()) {
                return Err("project-file-integrity".into());
            }
            let data = raw["data"].as_str().ok_or("project-file-unsupported")?;
            let encoded = data
                .split_once(',')
                .map(|(_, encoded)| encoded)
                .ok_or("project-file-integrity")?;
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| "project-file-integrity")?;
            verify_file_bytes(stored, &bytes)?;
            Ok(
                json!({"name":stored.file.name,"mime":stored.file.mime,"data":data,"truncated":stored.file.truncated}),
            )
        }
        _ => Err("project-file-unsupported".into()),
    }
}

fn read_indexed_text(root: &Path, stored: &StoredFile) -> Result<Value, String> {
    if !stored.file.indexed
        || !matches!(
            stored.file.mime.as_str(),
            "text/plain"
                | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
    {
        return Err("project-file-text-unavailable".into());
    }
    let extracted_text = verified_extracted_text(root, stored)?;
    let text = if stored.file.truncated {
        format!(
            "[Extracted document text is truncated; remaining content unavailable.]\n{}",
            extracted_text
        )
    } else {
        extracted_text
    };
    Ok(json!({
        "id": stored.file.id,
        "name": stored.file.name,
        "text": text,
        "truncated": stored.file.truncated,
    }))
}

/// Recompute cached text from the SHA-verified managed copy before serving it.
/// UTF-8 text comes from the verified bytes; Office extraction is repeated from
/// the managed copy and its digest is checked again afterward.
fn verified_extracted_text(root: &Path, stored: &StoredFile) -> Result<String, String> {
    if !stored.file.indexed {
        return Err("project-file-text-unavailable".into());
    }
    let path = managed_copy_path(root, stored)?;
    let bytes = read_bounded(&path)?;
    verify_file_bytes(stored, &bytes)?;
    let (text, truncated) = match stored.file.mime.as_str() {
        "text/plain" => (
            String::from_utf8(bytes).map_err(|_| "project-file-integrity")?,
            false,
        ),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => {
            let extracted = crate::document_text::extract_office(&path)
                .map_err(|_| "project-file-integrity")?
                .ok_or("project-file-integrity")?;
            let (text, capped) = cap_utf8(extracted.text, MAX_TEXT_BYTES);
            let after = read_bounded(&path)?;
            verify_file_bytes(stored, &after)?;
            (text, extracted.truncated || capped)
        }
        _ => return Err("project-file-text-unavailable".into()),
    };
    if text != stored.extracted_text || truncated != stored.file.truncated {
        return Err("project-file-integrity".into());
    }
    Ok(text)
}

fn remove_project_file(
    conn: &mut Connection,
    root: &Path,
    project_id: &str,
    id: &str,
) -> Result<(), String> {
    require_project(conn, project_id)?;
    let stored = get_file(conn, project_id, id)?;
    let (file_dir, path) = managed_copy_location(root, &stored)?;
    let tombstone = file_dir.join(format!(".delete-{}", stored.file.id));
    // A previous process may have stopped after staging the deletion but
    // before the database commit. Restore the file while its row still exists.
    if fs::symlink_metadata(&path).is_err()
        && fs::symlink_metadata(&tombstone)
            .is_ok_and(|metadata| metadata.is_file() || metadata.file_type().is_symlink())
    {
        fs::rename(&tombstone, &path).map_err(|_| "project-file-storage".to_string())?;
    }
    let has_tombstone = match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
            if fs::symlink_metadata(&tombstone).is_ok() {
                let _ = fs::remove_file(&tombstone);
            }
            fs::rename(&path, &tombstone).map_err(|_| "project-file-storage".to_string())?;
            true
        }
        Ok(_) => false,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("project-file-storage".into()),
    };
    let tx = match conn.transaction() {
        Ok(tx) => tx,
        Err(error) => {
            if has_tombstone {
                let _ = fs::rename(&tombstone, &path);
            }
            return Err(format!("project-file-db: {error}"));
        }
    };
    let result = (|| {
        tx.execute(
            "DELETE FROM project_files_fts WHERE file_id=?1 AND project_id=?2",
            params![id, project_id],
        )?;
        tx.execute(
            "DELETE FROM project_files WHERE id=?1 AND project_id=?2",
            params![id, project_id],
        )?;
        Ok::<(), rusqlite::Error>(())
    })();
    if let Err(error) = result {
        drop(tx);
        if has_tombstone {
            let _ = fs::rename(&tombstone, &path);
        }
        return Err(format!("project-file-db: {error}"));
    }
    if let Err(error) = tx.commit() {
        if has_tombstone {
            let _ = fs::rename(&tombstone, &path);
        }
        return Err(format!("project-file-db: {error}"));
    }
    if has_tombstone {
        fs::remove_file(&tombstone).map_err(|_| "project-file-cleanup".to_string())?;
    }
    let _ = fs::remove_dir(file_dir);
    Ok(())
}

/// Run only while holding the database mutex. A live delete holds the same
/// mutex across quarantine, commit and unlink. Imports use `.incoming.*` and
/// are deliberately excluded from this recovery pass.
fn cleanup_deleted_copies(conn: &Connection, root: &Path, project_id: &str) -> Result<(), String> {
    let shard = ensure_project_storage_dir(root, project_id)?;
    for entry in fs::read_dir(&shard).map_err(|_| "project-file-cleanup")? {
        let entry = entry.map_err(|_| "project-file-cleanup")?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if !valid_uuid(&id) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| "project-file-cleanup")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let dir = fs::canonicalize(entry.path()).map_err(|_| "project-file-cleanup")?;
        if dir.parent() != Some(shard.as_path()) {
            return Err("project-file-storage".into());
        }
        let tombstone = dir.join(format!(".delete-{id}"));
        let Ok(metadata) = fs::symlink_metadata(&tombstone) else {
            continue;
        };
        if !metadata.is_file() && !metadata.file_type().is_symlink() {
            continue;
        }
        match get_file(conn, project_id, &id) {
            Ok(stored) => {
                let (expected_dir, path) = managed_copy_location(root, &stored)?;
                if expected_dir != dir {
                    return Err("project-file-storage".into());
                }
                let missing = match fs::symlink_metadata(&path) {
                    Ok(_) => false,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                    Err(_) => return Err("project-file-cleanup".into()),
                };
                if missing {
                    fs::rename(&tombstone, &path).map_err(|_| "project-file-cleanup")?;
                } else if verify_managed_copy(root, &stored).is_ok() {
                    fs::remove_file(&tombstone).map_err(|_| "project-file-cleanup")?;
                }
            }
            Err(error) if error == "project-file-missing" => {
                fs::remove_file(&tombstone).map_err(|_| "project-file-cleanup")?;
                // Never recurse: an active import or unrelated leaf stays intact.
                let _ = fs::remove_dir(&dir);
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn project_files_import(
    app: AppHandle,
    db: State<'_, DbState>,
    project_id: String,
    path: String,
) -> Result<ProjectFile, String> {
    {
        let conn = db.0.lock().await;
        init_schema(&conn)?;
        require_project(&conn, &project_id)?;
    }
    let root = app_storage_root(&app)?;
    let source = PathBuf::from(path);
    let project_for_stage = project_id.clone();
    let root_for_stage = root.clone();
    let staged = tauri::async_runtime::spawn_blocking(move || {
        stage_import(&root_for_stage, &project_for_stage, &source)
    })
    .await
    .map_err(|error| format!("project-file-import: {error}"))??;
    let candidate = {
        let conn = db.0.lock().await;
        let result = require_project(&conn, &project_id).and_then(|_| {
            latest_for_name(&conn, &project_id, &staged.stored.file.name.to_lowercase())
        });
        match result {
            Ok(candidate) => candidate,
            Err(error) => {
                remove_staged(&staged);
                return Err(error);
            }
        }
    };
    let verified_duplicate_id = if let Some(candidate) =
        candidate.filter(|candidate| candidate.file.sha256 == staged.stored.file.sha256)
    {
        let candidate_id = candidate.file.id.clone();
        let root_for_check = root.clone();
        let valid = tauri::async_runtime::spawn_blocking(move || {
            verify_managed_copy(&root_for_check, &candidate).is_ok()
        })
        .await
        .map_err(|error| {
            remove_staged(&staged);
            format!("project-file-import: {error}")
        })?;
        valid.then_some(candidate_id)
    } else {
        None
    };
    let mut conn = db.0.lock().await;
    insert_staged(&mut conn, staged, verified_duplicate_id.as_deref())
}

#[tauri::command]
pub async fn project_files_list(
    app: AppHandle,
    db: State<'_, DbState>,
    project_id: String,
) -> Result<Vec<ProjectFile>, String> {
    let conn = db.0.lock().await;
    init_schema(&conn)?;
    require_project(&conn, &project_id)?;
    if app_storage_root(&app)
        .and_then(|root| cleanup_deleted_copies(&conn, &root, &project_id))
        .is_err()
    {
        eprintln!("project files: deferred deletion cleanup is incomplete");
    }
    list_project(&conn, &project_id)
}

#[tauri::command]
pub async fn project_files_read(
    app: AppHandle,
    db: State<'_, DbState>,
    project_id: String,
    id: String,
) -> Result<Value, String> {
    let stored = {
        let conn = db.0.lock().await;
        init_schema(&conn)?;
        require_project(&conn, &project_id)?;
        get_file(&conn, &project_id, &id)?
    };
    let root = app_storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_payload(&root, &stored))
        .await
        .map_err(|error| format!("project-file-read: {error}"))?
}

fn export_copy(root: &Path, stored: &StoredFile, destination: &Path) -> Result<(), String> {
    if !destination.is_absolute()
        || destination
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("project-file-export-path".into());
    }
    let name = destination.file_name().ok_or("project-file-export-path")?;
    let parent = fs::canonicalize(destination.parent().ok_or("project-file-export-path")?)
        .map_err(|_| "project-file-export-path")?;
    let storage = fs::canonicalize(root).map_err(|_| "project-file-storage")?;
    // Export must not overwrite the application's database, credentials or blobs.
    if parent.starts_with(storage.parent().ok_or("project-file-storage")?) {
        return Err("project-file-export-path".into());
    }
    let destination = parent.join(name);
    if fs::symlink_metadata(&destination)
        .is_ok_and(|metadata| !metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err("project-file-export-path".into());
    }
    let bytes = verify_managed_copy(root, stored)?;
    crate::connection_profiles::atomic_write(&destination, &bytes)
        .map_err(|_| "project-file-export-failed".into())
}

#[tauri::command]
pub async fn project_files_export(
    app: AppHandle,
    db: State<'_, DbState>,
    project_id: String,
    id: String,
    path: String,
) -> Result<(), String> {
    let stored = {
        let conn = db.0.lock().await;
        require_project(&conn, &project_id)?;
        get_file(&conn, &project_id, &id)?
    };
    let root = app_storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || export_copy(&root, &stored, Path::new(&path)))
        .await
        .map_err(|_| "project-file-export-failed".to_string())?
}

#[tauri::command]
pub async fn project_files_remove(
    app: AppHandle,
    db: State<'_, DbState>,
    project_id: String,
    id: String,
) -> Result<(), String> {
    let root = app_storage_root(&app)?;
    let mut conn = db.0.lock().await;
    init_schema(&conn)?;
    remove_project_file(&mut conn, &root, &project_id, &id)
}

#[tauri::command]
pub async fn project_files_search(
    db: State<'_, DbState>,
    project_id: String,
    query: String,
) -> Result<Vec<ProjectFileMatch>, String> {
    let conn = db.0.lock().await;
    init_schema(&conn)?;
    require_project(&conn, &project_id)?;
    search_project(&conn, &project_id, &query)
}

/// Search only the project that owns this host-side task. The task ID is
/// resolved from saved workspace state so a model cannot choose another root.
pub(crate) async fn search_for_task(
    app: &AppHandle,
    task_id: &str,
    query: &str,
) -> Result<Vec<ProjectFileMatch>, String> {
    let db = app.state::<DbState>();
    let conn = db.0.lock().await;
    init_schema(&conn)?;
    let project_id = project_id_for_task(&conn, task_id)?;
    if query.trim().is_empty() {
        return Ok(list_project(&conn, &project_id)?
            .into_iter()
            .take(MAX_SEARCH_MATCHES)
            .map(|file| ProjectFileMatch {
                snippet: file.name.clone(),
                file,
            })
            .collect());
    }
    search_project(&conn, &project_id, query)
}

/// Return bounded extracted text for a host-validated task's own project.
/// Binary-only image/PDF files are deliberately not exposed to agent tools.
pub(crate) async fn read_text_for_task(
    app: &AppHandle,
    task_id: &str,
    id: &str,
) -> Result<Value, String> {
    let stored = {
        let db = app.state::<DbState>();
        let conn = db.0.lock().await;
        init_schema(&conn)?;
        let project_id = project_id_for_task(&conn, task_id)?;
        get_file(&conn, &project_id, id)?
    };
    let root = app_storage_root(app)?;
    tauri::async_runtime::spawn_blocking(move || read_indexed_text(&root, &stored))
        .await
        .map_err(|error| format!("project-file-read: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        time::{SystemTime, UNIX_EPOCH},
    };
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    fn test_dir(label: &str) -> PathBuf {
        let tick = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "aplot-project-files-{label}-{tick}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"CREATE TABLE kv(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);
             INSERT INTO kv(key,value_json,updated_at) VALUES(
               'agent-workspace-v2',
               '{"version":2,"revision":1,"data":{"projects":[{"id":"project-a","path":"C:\\\\missing"},{"id":"project-b","path":"C:\\\\also-missing"}],"tasks":[{"id":"task-a","projectId":"project-a"}],"threads":{},"memory":[]}}',
               'now');"#,
        )
        .unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    fn import(conn: &mut Connection, root: &Path, project_id: &str, source: &Path) -> ProjectFile {
        let staged = stage_import(root, project_id, source).unwrap();
        let candidate =
            latest_for_name(conn, project_id, &staged.stored.file.name.to_lowercase()).unwrap();
        let verified_duplicate_id = candidate
            .filter(|candidate| candidate.file.sha256 == staged.stored.file.sha256)
            .filter(|candidate| verify_managed_copy(root, candidate).is_ok())
            .map(|candidate| candidate.file.id);
        insert_staged(conn, staged, verified_duplicate_id.as_deref()).unwrap()
    }

    #[test]
    fn imports_immutable_versions_deduplicates_retry_and_reads_after_source_removal() {
        let root = test_dir("versions");
        fs::create_dir_all(&root).unwrap();
        let data = storage_root_for_data_dir(&root).unwrap();
        let source = root.join("note.txt");
        fs::write(&source, "first version").unwrap();
        let mut conn = setup_conn();

        let first = import(&mut conn, &data, "project-a", &source);
        fs::write(&source, "second version").unwrap();
        let second = import(&mut conn, &data, "project-a", &source);
        let retry = import(&mut conn, &data, "project-a", &source);

        assert_eq!(first.version, 1);
        assert_eq!(second.version, 2);
        assert_ne!(first.id, second.id);
        assert_eq!(retry.id, second.id);
        fs::remove_file(&source).unwrap();
        let stored = get_file(&conn, "project-a", &second.id).unwrap();
        let payload = read_payload(&data, &stored).unwrap();
        assert_eq!(payload["text"], "second version");
        assert_ne!(
            managed_copy_path(&data, &stored).unwrap(),
            source,
            "the library stores a separate managed copy"
        );

        fs::write(&source, "second version").unwrap();
        fs::remove_file(managed_copy_path(&data, &stored).unwrap()).unwrap();
        let recovered = import(&mut conn, &data, "project-a", &source);
        assert_eq!(recovered.version, 3);
        assert_ne!(recovered.id, second.id);
        assert_eq!(
            read_payload(&data, &get_file(&conn, "project-a", &recovered.id).unwrap()).unwrap()
                ["text"],
            "second version"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_is_project_scoped_and_matches_nonindexed_filenames() {
        let root = test_dir("search");
        fs::create_dir_all(&root).unwrap();
        let data = storage_root_for_data_dir(&root).unwrap();
        let image = root.join("needle.png");
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&[0, 0, 0, 0]);
        fs::write(&image, png).unwrap();
        let mut conn = setup_conn();
        let file = import(&mut conn, &data, "project-a", &image);
        assert!(!file.indexed);

        let matches = search_project(&conn, "project-a", "needle").unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].file.id, file.id);
        assert!(search_project(&conn, "project-b", "needle")
            .unwrap()
            .is_empty());
        assert!(project_id_for_task(&conn, "task-a").unwrap() == "project-a");
        assert_eq!(
            project_id_for_task(&conn, "foreign-task").unwrap_err(),
            "task-missing"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_managed_symlinks_and_hash_tampering() {
        let root = test_dir("tamper");
        fs::create_dir_all(&root).unwrap();
        let data = storage_root_for_data_dir(&root).unwrap();
        let source = root.join("safe.txt");
        fs::write(&source, "original bytes").unwrap();
        let mut conn = setup_conn();
        let file = import(&mut conn, &data, "project-a", &source);
        let stored = get_file(&conn, "project-a", &file.id).unwrap();
        let managed = managed_copy_path(&data, &stored).unwrap();
        let mut traversed = stored.clone();
        traversed.storage_relative = format!("../../outside/{}/content.txt", file.id);
        assert!(managed_copy_path(&data, &traversed).is_err());

        fs::write(&managed, "tampered bytes").unwrap();
        assert_eq!(
            read_payload(&data, &stored).unwrap_err(),
            "project-file-integrity"
        );
        fs::write(&managed, "original bytes").unwrap();

        conn.execute(
            "UPDATE project_files SET extracted_text='tampered cache' WHERE id=?1",
            [&file.id],
        )
        .unwrap();
        let corrupt_cache = get_file(&conn, "project-a", &file.id).unwrap();
        assert_eq!(
            verified_extracted_text(&data, &corrupt_cache).unwrap_err(),
            "project-file-integrity"
        );

        let _ = fs::remove_file(&managed);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&source, &managed).unwrap();
            assert!(managed_copy_path(&data, &stored).is_err());
        }
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&source, &managed).is_ok() {
            assert!(managed_copy_path(&data, &stored).is_err());
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleans_staged_copy_when_database_transaction_fails() {
        let root = test_dir("rollback");
        fs::create_dir_all(&root).unwrap();
        let data = storage_root_for_data_dir(&root).unwrap();
        let source = root.join("note.txt");
        fs::write(&source, "cleanup me").unwrap();
        let mut conn = setup_conn();
        conn.execute_batch("DROP TABLE project_files_fts;").unwrap();
        let staged = stage_import(&data, "project-a", &source).unwrap();
        let file_dir = staged.file_dir.clone();
        assert!(file_dir.exists());
        let error = insert_staged(&mut conn, staged, None).unwrap_err();
        assert!(error.starts_with("project-file-db:"));
        assert!(
            !file_dir.exists(),
            "failed insert must remove its staged copy"
        );
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM project_files", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restores_managed_copy_when_remove_transaction_fails() {
        let root = test_dir("remove-rollback");
        fs::create_dir_all(&root).unwrap();
        let data = storage_root_for_data_dir(&root).unwrap();
        let source = root.join("note.txt");
        fs::write(&source, "keep this copy").unwrap();
        let mut conn = setup_conn();
        let file = import(&mut conn, &data, "project-a", &source);
        let stored = get_file(&conn, "project-a", &file.id).unwrap();
        conn.execute_batch("DROP TABLE project_files_fts;").unwrap();

        let error = remove_project_file(&mut conn, &data, "project-a", &file.id).unwrap_err();
        assert!(error.starts_with("project-file-db:"));
        assert!(managed_copy_path(&data, &stored).unwrap().is_file());
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM project_files WHERE id=?1",
                [&file.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicit_remove_cleans_metadata_when_managed_copy_is_missing() {
        let root = test_dir("missing-copy-remove");
        fs::create_dir_all(&root).unwrap();
        let data = storage_root_for_data_dir(&root).unwrap();
        let source = root.join("note.txt");
        fs::write(&source, "copy to remove").unwrap();
        let mut conn = setup_conn();
        let file = import(&mut conn, &data, "project-a", &source);
        fs::remove_file(
            managed_copy_path(&data, &get_file(&conn, "project-a", &file.id).unwrap()).unwrap(),
        )
        .unwrap();

        remove_project_file(&mut conn, &data, "project-a", &file.id).unwrap();
        assert_eq!(
            get_file(&conn, "project-a", &file.id).unwrap_err(),
            "project-file-missing"
        );
        let fts_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM project_files_fts WHERE file_id=?1",
                [&file.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fts_rows, 0);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remove_restores_interrupted_tombstone_before_deleting_the_row() {
        let root = test_dir("tombstone-recovery");
        fs::create_dir_all(&root).unwrap();
        let data = storage_root_for_data_dir(&root).unwrap();
        let source = root.join("note.txt");
        fs::write(&source, "recover then remove").unwrap();
        let mut conn = setup_conn();
        let file = import(&mut conn, &data, "project-a", &source);
        let path =
            managed_copy_path(&data, &get_file(&conn, "project-a", &file.id).unwrap()).unwrap();
        let tombstone = path.parent().unwrap().join(format!(".delete-{}", file.id));
        fs::rename(&path, &tombstone).unwrap();

        remove_project_file(&mut conn, &data, "project-a", &file.id).unwrap();
        assert!(!tombstone.exists());
        assert_eq!(
            get_file(&conn, "project-a", &file.id).unwrap_err(),
            "project-file-missing"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn list_recovery_restores_precommit_deletes_cleans_committed_deletes_and_preserves_imports() {
        let root = test_dir("delete-list-recovery");
        fs::create_dir_all(&root).unwrap();
        let data = storage_root_for_data_dir(&root).unwrap();
        let source = root.join("note.txt");
        fs::write(&source, "retained copy").unwrap();
        let mut conn = setup_conn();
        let file = import(&mut conn, &data, "project-a", &source);
        let stored = get_file(&conn, "project-a", &file.id).unwrap();
        let path = managed_copy_path(&data, &stored).unwrap();
        let tombstone = path.parent().unwrap().join(format!(".delete-{}", file.id));
        fs::rename(&path, &tombstone).unwrap();
        cleanup_deleted_copies(&conn, &data, "project-a").unwrap();
        assert_eq!(
            read_payload(&data, &stored).unwrap()["text"],
            "retained copy"
        );
        fs::rename(&path, &tombstone).unwrap();
        conn.execute("DELETE FROM project_files_fts WHERE file_id=?1", [&file.id])
            .unwrap();
        conn.execute("DELETE FROM project_files WHERE id=?1", [&file.id])
            .unwrap();
        let incoming = stage_import(&data, "project-a", &source).unwrap();
        cleanup_deleted_copies(&conn, &data, "project-a").unwrap();
        assert!(!tombstone.exists());
        assert!(incoming.temporary_path.exists());
        assert!(source.exists());
        remove_staged(&incoming);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exports_verified_original_bytes_and_rejects_app_storage_and_relative_targets() {
        let root = test_dir("export");
        fs::create_dir_all(&root).unwrap();
        let app_data = root.join("app-data");
        fs::create_dir_all(&app_data).unwrap();
        let data = storage_root_for_data_dir(&app_data).unwrap();
        let source = root.join("sample.txt");
        fs::write(&source, "original bytes: русский текст").unwrap();
        let mut conn = setup_conn();
        let file = import(&mut conn, &data, "project-a", &source);
        let stored = get_file(&conn, "project-a", &file.id).unwrap();
        let destination = root.join("restored.txt");
        export_copy(&data, &stored, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), fs::read(&source).unwrap());
        assert!(export_copy(&data, &stored, &app_data.join("database.txt")).is_err());
        assert!(export_copy(&data, &stored, Path::new("relative.txt")).is_err());
        fs::write(managed_copy_path(&data, &stored).unwrap(), "tamper").unwrap();
        assert!(export_copy(&data, &stored, &destination).is_err());
        assert_eq!(fs::read(&destination).unwrap(), fs::read(&source).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_injection_shaped_search_terms_without_fts_syntax_errors() {
        let query = safe_fts_query("name\" OR file_id:secret)");
        assert!(query.starts_with('"'));
        assert!(query.contains("\" AND \""));
    }

    #[test]
    fn preserves_safe_unicode_names_and_enforces_utf8_byte_limit() {
        assert_eq!(sanitize_name(Path::new("отчёт.txt")).unwrap(), "отчёт.txt");
        let too_many_bytes = format!("{}.txt", "界".repeat(70));
        assert_eq!(
            sanitize_name(Path::new(&too_many_bytes)).unwrap_err(),
            "project-file-name-invalid"
        );
        assert_eq!(
            sanitize_name(Path::new("line\nbreak.txt")).unwrap(),
            "linebreak.txt"
        );
    }

    #[test]
    fn imports_docx_from_extension_preserving_stage_and_reads_extracted_text() {
        let root = test_dir("docx");
        fs::create_dir_all(&root).unwrap();
        let data = storage_root_for_data_dir(&root).unwrap();
        let source = root.join("report.docx");
        let file = File::create(&source).unwrap();
        let mut archive = ZipWriter::new(file);
        archive
            .start_file(
                "word/document.xml",
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
            )
            .unwrap();
        archive
            .write_all(
                br#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello Office</w:t></w:r></w:p></w:body></w:document>"#,
            )
            .unwrap();
        archive.finish().unwrap();

        let mut conn = setup_conn();
        let file = import(&mut conn, &data, "project-a", &source);
        assert_eq!(
            file.mime,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        assert!(file.indexed);
        let stored = get_file(&conn, "project-a", &file.id).unwrap();
        fs::remove_file(&source).unwrap();
        let payload = read_payload(&data, &stored).unwrap();
        assert_eq!(payload["name"], "report.docx");
        assert_eq!(payload["mime"], "text/plain");
        assert_eq!(payload["text"], "Hello Office\n");
        assert_eq!(payload["truncated"], false);

        fs::remove_dir_all(root).unwrap();
    }
}
