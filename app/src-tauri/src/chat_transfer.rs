//! Explicit user-selected chat import/export. No launch credentials are read.
use std::{fs, io::Read, path::PathBuf};

const MAX_TRANSFER_BYTES: u64 = 128 * 1024 * 1024;

fn checked_path(path: String, format: Option<&str>) -> Result<PathBuf, String> {
    let mut path = PathBuf::from(path);
    if !path.is_absolute() || path.file_name().is_none() {
        return Err("chat-transfer-path".into());
    }
    if let Some(format) = format {
        let extension = match format {
            "json" => "json",
            "markdown" => "md",
            _ => return Err("chat-transfer-format".into()),
        };
        if path.extension().is_none() {
            path.set_extension(extension);
        }
        if !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
        {
            return Err("chat-transfer-format".into());
        }
    }
    Ok(path)
}

#[tauri::command]
pub async fn chat_export_file(
    path: String,
    format: String,
    contents: String,
) -> Result<(), String> {
    if contents.len() as u64 > MAX_TRANSFER_BYTES {
        return Err("chat-import-limit".into());
    }
    let path = checked_path(path, Some(&format))?;
    if format == "json" {
        let json: serde_json::Value =
            serde_json::from_str(&contents).map_err(|_| "chat-transfer-invalid")?;
        if json["version"] != 1 || !json["conversations"].is_array() {
            return Err("chat-transfer-invalid".into());
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::connection_profiles::atomic_write(&path, contents.as_bytes())
    })
    .await
    .map_err(|_| "storage".to_string())?
}

#[tauri::command]
pub async fn chat_import_file(path: String) -> Result<String, String> {
    let path = checked_path(path, None)?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = fs::File::open(path).map_err(|_| "chat-transfer-read")?;
        let metadata = file.metadata().map_err(|_| "chat-transfer-read")?;
        if !metadata.is_file() || metadata.len() > MAX_TRANSFER_BYTES {
            return Err("chat-import-limit".into());
        }
        let mut text = String::new();
        file.take(MAX_TRANSFER_BYTES + 1)
            .read_to_string(&mut text)
            .map_err(|_| "chat-transfer-read")?;
        if text.len() as u64 > MAX_TRANSFER_BYTES {
            return Err("chat-import-limit".into());
        }
        Ok(text)
    })
    .await
    .map_err(|_| "storage".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_explicit_paths_and_format_before_writing() {
        let root = std::env::temp_dir();
        let file = root.join("aplot-export");
        let path = checked_path(file.to_string_lossy().into_owned(), Some("json")).unwrap();
        assert_eq!(path.extension().unwrap(), "json");
        assert!(checked_path("relative/file.json".into(), Some("json")).is_err());
        assert!(checked_path(
            root.join("export.exe").to_string_lossy().into_owned(),
            Some("json")
        )
        .is_err());
        assert!(checked_path(file.to_string_lossy().into_owned(), Some("unknown")).is_err());
    }
}
