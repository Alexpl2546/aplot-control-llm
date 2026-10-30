//! Folder listing for Aplot's own file picker (the styled replacement for the
//! system dialog): drives and well-known places, one folder's entries, and
//! creating a folder. Hidden and system entries are left out, as in Explorer.
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEntry {
    name: String,
    path: String,
    directory: bool,
    size: u64,
    /// Milliseconds since the Unix epoch; 0 when unknown.
    modified: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPlace {
    /// `home`, `desktop`, `documents`, `downloads` or `drive`.
    kind: String,
    name: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFolder {
    path: String,
    parent: Option<String>,
    entries: Vec<BrowserEntry>,
}

fn display(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    text.strip_prefix(r"\\?\")
        .map(str::to_string)
        .unwrap_or(text)
}

#[cfg(windows)]
fn hidden(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    metadata.file_attributes() & (HIDDEN | SYSTEM) != 0
}

#[cfg(not(windows))]
fn hidden(_: &std::fs::Metadata) -> bool {
    false
}

fn list(path: &Path) -> Result<BrowserFolder, String> {
    let read = std::fs::read_dir(path).map_err(|e| format!("{}: {e}", display(path)))?;
    let mut entries: Vec<BrowserEntry> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let metadata = entry.metadata().ok()?;
            if name.starts_with('.') || hidden(&metadata) {
                return None;
            }
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_millis() as u64);
            Some(BrowserEntry {
                path: display(&entry.path()),
                directory: metadata.is_dir(),
                size: if metadata.is_dir() { 0 } else { metadata.len() },
                modified,
                name,
            })
        })
        .collect();
    // Folders first, then names in a case-insensitive order.
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(BrowserFolder {
        path: display(path),
        parent: path.parent().map(display),
        entries,
    })
}

/// One folder's visible entries; a missing path falls back to the nearest existing parent.
#[tauri::command]
pub async fn browse_folder(path: String) -> Result<BrowserFolder, String> {
    tokio::task::spawn_blocking(move || {
        let mut current = PathBuf::from(path.trim());
        while !current.is_dir() {
            current = current
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| format!("{}: not found", display(&current)))?;
        }
        list(&current)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Home, Desktop, Documents, Downloads and every drive that answers.
#[tauri::command]
pub async fn browse_places(app: AppHandle) -> Result<Vec<BrowserPlace>, String> {
    let paths = app.path();
    let mut places = Vec::new();
    for (kind, path) in [
        ("home", paths.home_dir()),
        ("desktop", paths.desktop_dir()),
        ("documents", paths.document_dir()),
        ("downloads", paths.download_dir()),
    ] {
        if let Ok(path) = path {
            if path.is_dir() {
                places.push(BrowserPlace {
                    kind: kind.into(),
                    name: path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| display(&path)),
                    path: display(&path),
                });
            }
        }
    }
    let drives = tokio::task::spawn_blocking(|| {
        if cfg!(windows) {
            (b'A'..=b'Z')
                .map(|letter| format!("{}:\\", letter as char))
                .filter(|drive| Path::new(drive).is_dir())
                .collect::<Vec<_>>()
        } else {
            vec!["/".to_string()]
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    places.extend(drives.into_iter().map(|drive| BrowserPlace {
        kind: "drive".into(),
        name: drive.trim_end_matches('\\').to_string(),
        path: drive,
    }));
    Ok(places)
}

/// A new folder inside `parent`; the name must be a single path segment.
#[tauri::command]
pub async fn browse_create_folder(parent: String, name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
    {
        return Err("invalid-folder-name".into());
    }
    let target = Path::new(&parent).join(&name);
    std::fs::create_dir(&target).map_err(|e| format!("{}: {e}", display(&target)))?;
    Ok(display(&target))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_folders_first_and_skips_dot_files() {
        let root = std::env::temp_dir().join(format!("aplot-browse-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("b-folder")).unwrap();
        std::fs::write(root.join("a.gguf"), b"x").unwrap();
        std::fs::write(root.join(".secret"), b"x").unwrap();
        let folder = list(&root).unwrap();
        let names: Vec<_> = folder.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["b-folder", "a.gguf"]);
        std::fs::remove_dir_all(root).unwrap();
    }
}
