use crate::{
    db::{self, DbState},
    process::ProcessState,
};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
use tauri::{Emitter, State};
use walkdir::WalkDir;

static IMPORTING: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);
struct ImportGuard;
impl Drop for ImportGuard {
    fn drop(&mut self) {
        IMPORTING.store(false, Ordering::SeqCst);
    }
}

fn canonical_path(path: &Path) -> Result<PathBuf, String> {
    let full = path.canonicalize().map_err(|e| e.to_string())?;
    let text = full.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return Ok(PathBuf::from(format!(r"\\{unc}")));
    }
    Ok(PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text)))
}

#[tauri::command]
pub fn model_library_path() -> Result<String, String> {
    Ok(db::model_library_path()?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn cancel_model_import() {
    CANCELLED.store(true, Ordering::SeqCst);
}

fn same_contents(left: &Path, right: &Path) -> Result<bool, String> {
    let mut a = fs::File::open(left).map_err(|e| e.to_string())?;
    let mut b = fs::File::open(right).map_err(|e| e.to_string())?;
    let mut x = vec![0u8; 1024 * 1024];
    let mut y = vec![0u8; x.len()];
    loop {
        if CANCELLED.load(Ordering::SeqCst) {
            return Err("Import cancelled; source files were preserved.".into());
        }
        let n = a.read(&mut x).map_err(|e| e.to_string())?;
        b.read_exact(&mut y[..n]).map_err(|e| e.to_string())?;
        if x[..n] != y[..n] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(b.read(&mut y[..1]).map_err(|e| e.to_string())? == 0);
        }
    }
}

fn transfer_folder(
    emit: impl Fn(serde_json::Value),
    source: &Path,
    library: &Path,
    installation: &Path,
    mode: &str,
) -> Result<PathBuf, String> {
    fs::create_dir_all(library).map_err(|e| e.to_string())?;
    let library = canonical_path(library)?;
    if source.starts_with(&library) {
        return Ok(source.to_path_buf());
    }
    let installation = canonical_path(installation)?;
    if installation.starts_with(source) || source.parent().is_none() || source == library {
        return Err(
            "Select a folder containing models, not a drive or the application folder.".into(),
        );
    }
    let entries: Vec<_> = WalkDir::new(source)
        .follow_links(false)
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if entries.iter().any(|e| e.file_type().is_symlink()) {
        return Err("This folder contains links. Add it in place instead.".into());
    }
    let total: u64 = entries
        .iter()
        .filter(|e| e.file_type().is_file())
        .map(|e| e.metadata().map(|m| m.len()).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .sum();
    let folder = source
        .file_name()
        .ok_or("Invalid model folder")?
        .to_string_lossy();
    let mut target = library.join(folder.as_ref());
    let mut suffix = 2;
    while target.exists() {
        target = library.join(format!("{folder} ({suffix})"));
        suffix += 1;
    }
    if CANCELLED.load(Ordering::SeqCst) {
        return Err("Import cancelled; source files were preserved.".into());
    }
    if mode == "move" && fs::rename(source, &target).is_ok() {
        emit(serde_json::json!({"done":total,"total":total,"file":"","phase":"move"}));
        return Ok(target);
    }
    let staging = library.join(format!(".import-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let copied = (|| {
        let mut done = 0u64;
        let mut last = Instant::now();
        let mut buffer = vec![0u8; 4 * 1024 * 1024];
        for entry in &entries {
            if CANCELLED.load(Ordering::SeqCst) {
                return Err("Import cancelled; source files were preserved.".to_string());
            }
            let relative = entry
                .path()
                .strip_prefix(source)
                .map_err(|e| e.to_string())?;
            let dest = staging.join(relative);
            if entry.file_type().is_dir() {
                fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
                continue;
            }
            let mut input = fs::File::open(entry.path()).map_err(|e| e.to_string())?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&dest)
                .map_err(|e| e.to_string())?;
            loop {
                if CANCELLED.load(Ordering::SeqCst) {
                    return Err("Import cancelled; source files were preserved.".into());
                }
                let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                output.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
                done += n as u64;
                if last.elapsed().as_millis() >= 200 {
                    emit(
                        serde_json::json!({"done":done,"total":total,"file":relative.to_string_lossy(),"phase":"copy"}),
                    );
                    last = Instant::now();
                }
            }
            output.sync_all().map_err(|e| e.to_string())?;
        }
        if mode == "move" {
            emit(serde_json::json!({"done":total,"total":total,"file":"","phase":"verify"}));
            for entry in entries.iter().filter(|e| e.file_type().is_file()) {
                let dest = staging.join(
                    entry
                        .path()
                        .strip_prefix(source)
                        .map_err(|e| e.to_string())?,
                );
                if !same_contents(entry.path(), &dest)? {
                    return Err(
                        "Copied files failed verification; source files were preserved.".into(),
                    );
                }
            }
        }
        if CANCELLED.load(Ordering::SeqCst) {
            return Err("Import cancelled; source files were preserved.".into());
        }
        fs::rename(&staging, &target).map_err(|e| e.to_string())?;
        if mode == "move" {
            // Cross-volume moves remove the source only after byte-for-byte verification.
            fs::remove_dir_all(source).map_err(|e| format!("The verified copy is in {}, but the source could not be completely removed: {e}.", target.display()))?;
        }
        Ok(target.clone())
    })();
    if copied.is_err() && staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    copied
}

fn relocate_json(value: &mut serde_json::Value, source: &Path, target: &Path) {
    match value {
        serde_json::Value::String(text) => {
            if let Ok(relative) = Path::new(text.as_str()).strip_prefix(source) {
                *text = target.join(relative).to_string_lossy().into_owned();
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                relocate_json(item, source, target);
            }
        }
        serde_json::Value::Object(items) => {
            for item in items.values_mut() {
                relocate_json(item, source, target);
            }
        }
        _ => {}
    }
}

#[tauri::command]
pub async fn import_model_directory(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    process: State<'_, ProcessState>,
    source_path: String,
    mode: String,
) -> Result<String, String> {
    if mode != "copy" && mode != "move" {
        return Err("Choose copy or move.".into());
    }
    if mode == "move" && process.0.lock().await.current.is_some() {
        return Err("Stop the server before moving its model files.".into());
    }
    if IMPORTING.swap(true, Ordering::SeqCst) {
        return Err("Another model import is already running.".into());
    }
    let _guard = ImportGuard;
    CANCELLED.store(false, Ordering::SeqCst);
    let source = canonical_path(Path::new(&source_path))?;
    if !source.is_dir() {
        return Err("Choose a model folder.".into());
    }
    let library = db::model_library_path()?;
    let installation = db::installation_root().ok_or("Application folder not found")?;
    let source_copy = source.clone();
    let operation = mode.clone();
    let target = tokio::task::spawn_blocking(move || {
        transfer_folder(
            |payload| {
                let _ = app.emit("model-import-progress", payload);
            },
            &source_copy,
            &library,
            &installation,
            &operation,
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    if mode == "move" && target != source {
        let mut conn = db.0.lock().await;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let rows: Vec<(String, String)> = {
            let mut stmt = tx
                .prepare("SELECT id,config_json FROM profiles")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        for (id, raw) in rows {
            let mut config: serde_json::Value =
                serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            relocate_json(&mut config, &source, &target);
            tx.execute(
                "UPDATE profiles SET config_json=?1 WHERE id=?2",
                rusqlite::params![config.to_string(), id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("aplot-import-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("source/nested")).unwrap();
        fs::create_dir_all(root.join("installation")).unwrap();
        fs::write(root.join("source/model.gguf"), b"model fixture").unwrap();
        fs::write(root.join("source/nested/file.txt"), b"related file").unwrap();
        root
    }
    #[test]
    fn copy_preserves_source_and_does_not_overwrite() {
        let _lock = LOCK.lock().unwrap();
        CANCELLED.store(false, Ordering::SeqCst);
        let root = fixture();
        let source = canonical_path(&root.join("source")).unwrap();
        let first = transfer_folder(
            |_| {},
            &source,
            &root.join("library"),
            &root.join("installation"),
            "copy",
        )
        .unwrap();
        let second = transfer_folder(
            |_| {},
            &source,
            &root.join("library"),
            &root.join("installation"),
            "copy",
        )
        .unwrap();
        assert_ne!(first, second);
        assert!(source.is_dir());
        assert!(same_contents(&source.join("model.gguf"), &first.join("model.gguf")).unwrap());
        assert_eq!(
            fs::read(second.join("nested/file.txt")).unwrap(),
            b"related file"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn move_relocates_folder_and_preserves_contents() {
        let _lock = LOCK.lock().unwrap();
        CANCELLED.store(false, Ordering::SeqCst);
        let root = fixture();
        let source = canonical_path(&root.join("source")).unwrap();
        let target = transfer_folder(
            |_| {},
            &source,
            &root.join("library"),
            &root.join("installation"),
            "move",
        )
        .unwrap();
        assert!(!source.exists());
        assert_eq!(
            fs::read(target.join("model.gguf")).unwrap(),
            b"model fixture"
        );
        let mut config = serde_json::json!({"modelPath": source.join("model.gguf").to_string_lossy(), "loraPaths":[source.join("nested/file.txt").to_string_lossy()], "name":"unchanged"});
        relocate_json(&mut config, &source, &target);
        assert_eq!(
            config["modelPath"],
            target.join("model.gguf").to_string_lossy().as_ref()
        );
        assert_eq!(config["name"], "unchanged");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancellation_preserves_source() {
        let _lock = LOCK.lock().unwrap();
        let root = fixture();
        let source = canonical_path(&root.join("source")).unwrap();
        CANCELLED.store(true, Ordering::SeqCst);
        assert!(transfer_folder(
            |_| {},
            &source,
            &root.join("library"),
            &root.join("installation"),
            "copy",
        )
        .is_err());
        assert!(source.join("model.gguf").is_file());
        CANCELLED.store(false, Ordering::SeqCst);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_a_source_containing_the_application() {
        let _lock = LOCK.lock().unwrap();
        CANCELLED.store(false, Ordering::SeqCst);
        let root = fixture();
        let source = canonical_path(&root.join("source")).unwrap();
        let installation = source.join("application");
        fs::create_dir_all(&installation).unwrap();
        for mode in ["copy", "move"] {
            let error =
                transfer_folder(|_| {}, &source, &root.join("library"), &installation, mode)
                    .unwrap_err();
            assert!(error.contains("not a drive or the application folder"));
            assert!(source.join("model.gguf").is_file());
            assert!(!root.join("library/source").exists());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
