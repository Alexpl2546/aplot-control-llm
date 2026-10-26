//! Explicit user-selected attachments. Merely staging a file never submits a prompt.
use base64::Engine;
use serde_json::{json, Value};
use std::{fs, path::Path};
use tauri::{AppHandle, Manager};
const MAX_FILE: u64 = 25 * 1024 * 1024;
fn inspect(path: &Path) -> Result<Value, String> {
    let actual = fs::canonicalize(path).map_err(|_| "attachment-missing")?;
    let meta = actual.metadata().map_err(|_| "attachment-missing")?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return Err("attachment-limit".into());
    }
    let ext = actual
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let kind =
        if ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"].contains(&ext.as_str()) {
            "image"
        } else {
            "file"
        };
    Ok(
        json!({"id":uuid::Uuid::new_v4().to_string(),"path":crate::agent_workspace::display_path(&actual),"name":actual.file_name().unwrap_or_default().to_string_lossy(),"size":meta.len(),"kind":kind}),
    )
}
pub(crate) fn inspect_paths(paths: Vec<String>) -> Result<Vec<Value>, String> {
    if paths.len() > 8 {
        return Err("attachment-limit".into());
    }
    paths.into_iter().map(|p| inspect(Path::new(&p))).collect()
}
#[tauri::command]
pub fn hermes_agent_files(paths: Vec<String>) -> Result<Vec<Value>, String> {
    inspect_paths(paths)
}
#[tauri::command]
pub fn hermes_agent_import(app: AppHandle, name: String, data: String) -> Result<Value, String> {
    if data.len() > 36_000_000 {
        return Err("attachment-limit".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "attachment-data")?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("attachment-limit".into());
    }
    let safe: String = Path::new(&name)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .take(120)
        .collect();
    if safe.trim().trim_matches('.').is_empty() {
        return Err("attachment-data".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "attachment-data")?
        .join("hermes-uploads")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&dir).map_err(|_| "attachment-data")?;
    let path = dir.join(safe);
    fs::write(&path, bytes).map_err(|_| "attachment-data")?;
    inspect(&path)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_folders_missing_and_large_attachments() {
        let dir = std::env::temp_dir().join(format!("aplot-attach-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        assert!(inspect(&dir).is_err());
        assert!(inspect(&dir.join("missing")).is_err());
        let path = dir.join("test.txt");
        fs::write(&path, "hello").unwrap();
        assert_eq!(inspect(&path).unwrap()["kind"], "file");
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_FILE + 1)
            .unwrap();
        assert!(inspect(&path).is_err());
        fs::remove_file(path).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
