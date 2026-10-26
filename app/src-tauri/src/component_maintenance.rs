//! One scoped removal implementation shared by Settings and the NSIS uninstaller.
//! Only marked installer-owned version directories are eligible. External engines are read-only.
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

const MODULES: &[(&str, &str)] = &[
    ("llama_cpp", "llama.cpp"),
    ("strata", "Strata"),
    ("hermes", "Hermes CLI"),
    ("codex", "Codex CLI"),
    ("claude", "Claude Code"),
];
const SHARED: &[(&str, &[&str])] = &[
    ("cache", &["downloads", "cache"]),
    ("python_runtime", &["python", "tools"]),
];
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleEntry {
    id: String,
    name: String,
    versions: Vec<String>,
    paths: Vec<String>,
    bytes: u64,
    external_path: Option<String>,
    blocked: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceState {
    root: String,
    uninstaller_path: Option<String>,
    modules: Vec<ModuleEntry>,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalReport {
    removed: Vec<String>,
    errors: Vec<String>,
}
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn reparse(path: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Ok(metadata.file_attributes() & 0x400 != 0)
    }
    #[cfg(not(windows))]
    {
        Ok(metadata.file_type().is_symlink())
    }
}
/// Never traverse a junction, including a junction in an ancestor of the component store.
fn check_scope(root: &Path, target: &Path) -> Result<(), String> {
    if !root.is_absolute()
        || !target.starts_with(root)
        || target == root
        || target
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("unsafe-component-path".into());
    }
    for parent in target.ancestors() {
        if parent.exists() && reparse(parent)? {
            return Err("component-link-protected".into());
        }
    }
    Ok(())
}
fn inspect_tree(root: &Path, target: &Path) -> Result<u64, String> {
    check_scope(root, target)?;
    let boundary = target.canonicalize().map_err(|e| e.to_string())?;
    let mut bytes = 0u64;
    for row in walkdir::WalkDir::new(target).follow_links(false) {
        let row = row.map_err(|e| e.to_string())?;
        if reparse(row.path())? {
            // uv creates Python version aliases as junctions inside its own runtime folder.
            // Never traverse them; allow unlinking only when they resolve inside this target.
            if !row
                .path()
                .canonicalize()
                .is_ok_and(|path| path.starts_with(&boundary))
            {
                return Err("component-link-protected".into());
            }
            continue;
        }
        if row.file_type().is_file() {
            bytes = bytes.saturating_add(row.metadata().map_err(|e| e.to_string())?.len());
        }
    }
    Ok(bytes)
}
fn owned_versions(root: &Path, id: &str) -> Vec<PathBuf> {
    let folder = root.join(id);
    if !folder.exists() || check_scope(root, &folder).is_err() {
        return vec![];
    }
    let mut result = Vec::new();
    if let Ok(rows) = fs::read_dir(&folder) {
        for row in rows.flatten() {
            let path = row.path();
            let version = row.file_name().to_string_lossy().into_owned();
            if !safe_name(&version) || !path.is_dir() || check_scope(root, &path).is_err() {
                continue;
            }
            // Keep incomplete installations removable too; their marker is written before setup.
            for marker in ["aplot-component.json", "aplot-installing.json"] {
                let file = path.join(marker);
                if reparse(&file).unwrap_or(true) {
                    continue;
                }
                let valid = fs::read_to_string(&file)
                    .ok()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                    .is_some_and(|v| {
                        v["id"] == id
                            && (marker == "aplot-installing.json" || v["version"] == version)
                    });
                if valid {
                    result.push(path);
                    break;
                }
            }
        }
    }
    result.sort();
    result
}
fn entries(root: &Path, external: &[crate::components::ComponentLocation]) -> Vec<ModuleEntry> {
    MODULES
        .iter()
        .map(|(id, name)| {
            let paths = owned_versions(root, id);
            let mut entry = ModuleEntry {
                id: (*id).into(),
                name: (*name).into(),
                versions: paths
                    .iter()
                    .filter_map(|p| p.file_name())
                    .map(|s| s.to_string_lossy().into_owned())
                    .collect(),
                paths: paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect(),
                bytes: 0,
                blocked: None,
                external_path: external
                    .iter()
                    .find(|c| {
                        c.id == *id && !paths.iter().any(|p| Path::new(&c.path).starts_with(p))
                    })
                    .map(|c| c.path.clone()),
            };
            for path in &paths {
                match inspect_tree(root, path) {
                    Ok(size) => entry.bytes = entry.bytes.saturating_add(size),
                    Err(error) => entry.blocked = Some(error),
                }
            }
            entry
        })
        .chain(SHARED.iter().map(|(id, names)| {
            let paths: Vec<_> = names
                .iter()
                .map(|n| root.join(n))
                .filter(|p| p.exists())
                .collect();
            let mut entry = ModuleEntry {
                id: (*id).into(),
                name: (*id).into(),
                versions: vec![],
                paths: paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect(),
                bytes: 0,
                external_path: None,
                blocked: None,
            };
            for path in paths {
                match inspect_tree(root, &path) {
                    Ok(size) => entry.bytes = entry.bytes.saturating_add(size),
                    Err(error) => entry.blocked = Some(error),
                }
            }
            entry
        }))
        .collect()
}
fn uninstaller() -> Option<PathBuf> {
    let path = std::env::current_exe()
        .ok()?
        .parent()?
        .join("uninstall.exe");
    path.is_file().then_some(path)
}
fn snapshot_for(app_directory: Option<PathBuf>) -> Result<MaintenanceState, String> {
    let root = crate::components::store_root().ok_or("component-store-unavailable")?;
    let external = crate::components::inventory(app_directory);
    Ok(MaintenanceState {
        root: root.to_string_lossy().into_owned(),
        uninstaller_path: uninstaller().map(|p| p.to_string_lossy().into_owned()),
        modules: entries(&root, &external),
    })
}
fn active_under(paths: &[PathBuf]) -> bool {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_exe(UpdateKind::Always)
            .with_cwd(UpdateKind::Always)
            .with_cmd(UpdateKind::Always),
    );
    system.processes().values().any(|process| {
        process
            .exe()
            .is_some_and(|exe| paths.iter().any(|p| exe.starts_with(p)))
            || process
                .cwd()
                .is_some_and(|cwd| paths.iter().any(|p| cwd.starts_with(p)))
            || process
                .cmd()
                .iter()
                .any(|arg| paths.iter().any(|p| Path::new(arg).starts_with(p)))
    })
}
fn lock_store(root: &Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    check_scope(root, &root.join(".install.lock"))?;
    if root.join(".install.lock").exists() && reparse(&root.join(".install.lock"))? {
        return Err("component-link-protected".into());
    }
    options
        .open(root.join(".install.lock"))
        .map_err(|_| "component-maintenance-busy".into())
}
/// Preserve ownership markers until last so a failed/locked removal remains visible and retryable.
fn delete_tree(path: &Path, keep_markers: bool) -> Result<(), String> {
    if reparse(path)? {
        return Err("component-link-protected".into());
    }
    for child in fs::read_dir(path).map_err(|e| e.to_string())? {
        let child = child.map_err(|e| e.to_string())?;
        if keep_markers
            && ["aplot-component.json", "aplot-installing.json"]
                .iter()
                .any(|s| child.file_name() == *s)
        {
            continue;
        }
        let target = child.path();
        if reparse(&target)? {
            // Unlink the junction itself, even when its target was already removed. No recursion.
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                let directory = fs::symlink_metadata(&target)
                    .map_err(|e| e.to_string())?
                    .file_attributes()
                    & 0x10
                    != 0;
                if directory {
                    fs::remove_dir(&target).map_err(|e| e.to_string())?;
                } else {
                    fs::remove_file(&target).map_err(|e| e.to_string())?;
                }
            }
            #[cfg(not(windows))]
            fs::remove_file(&target).map_err(|e| e.to_string())?;
            continue;
        }
        if target.is_dir() {
            delete_tree(&target, false)?;
        } else {
            fs::remove_file(&target).map_err(|e| e.to_string())?;
        }
    }
    if keep_markers {
        for name in ["aplot-component.json", "aplot-installing.json"] {
            let file = path.join(name);
            if file.exists() {
                fs::remove_file(file).map_err(|e| e.to_string())?;
            }
        }
    }
    fs::remove_dir(path).map_err(|e| e.to_string())
}
fn unpublish(root: &Path, deleted: &Path) -> Result<(), String> {
    let path = root.join("installations.json");
    if !path.exists() {
        return Ok(());
    }
    if reparse(&path)? {
        return Err("component-link-protected".into());
    }
    let mut value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if value["schemaVersion"] != 1 {
        return Err("unsupported-component-manifest".into());
    }
    if let Some(rows) = value["components"].as_array_mut() {
        rows.retain(|row| {
            !row["path"]
                .as_str()
                .is_some_and(|p| Path::new(p).starts_with(deleted))
        });
    }
    // Hold the same exclusive .install.lock as the installer throughout the operation.
    fs::write(
        path,
        serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
fn remove_at(
    root: &Path,
    ids: &[String],
    is_active: impl Fn(&[PathBuf]) -> bool,
) -> Result<RemovalReport, String> {
    if ids.is_empty()
        || ids.iter().any(|id| {
            !MODULES.iter().any(|(key, _)| key == id) && !SHARED.iter().any(|(key, _)| key == id)
        })
    {
        return Err("invalid-component-selection".into());
    }
    if !root.exists() {
        return Ok(RemovalReport::default());
    }
    let _lock = lock_store(root)?;
    let report_path = root.join("last-removal.json");
    if report_path.exists() && reparse(&report_path)? {
        return Err("component-link-protected".into());
    }
    let mut plan: Vec<(String, Vec<PathBuf>)> = Vec::new();
    for id in ids {
        if plan.iter().any(|(key, _)| key == id) {
            continue;
        }
        let paths = if let Some((_, names)) = SHARED.iter().find(|(key, _)| key == id) {
            names
                .iter()
                .map(|n| root.join(n))
                .filter(|p| p.exists())
                .collect()
        } else {
            owned_versions(root, id)
        };
        for path in &paths {
            inspect_tree(root, path)?;
        }
        plan.push((id.clone(), paths));
    }
    if ids.iter().any(|id| id == "python_runtime")
        && ["strata", "hermes"]
            .iter()
            .any(|id| !ids.iter().any(|s| s == id) && !owned_versions(root, id).is_empty())
    {
        return Err("component-python-in-use".into());
    }
    let all_paths: Vec<_> = plan.iter().flat_map(|(_, paths)| paths.clone()).collect();
    if is_active(&all_paths) {
        return Err("component-process-active".into());
    }
    // Validate manifest before touching files. Unknown schema/corruption never leads to data deletion.
    let manifest = root.join("installations.json");
    if manifest.exists() {
        if reparse(&manifest)? {
            return Err("component-link-protected".into());
        }
        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(manifest).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if v["schemaVersion"] != 1 {
            return Err("unsupported-component-manifest".into());
        }
    }
    // Modules first. Shared Python is retained if either dependent module could not be removed.
    plan.sort_by_key(|(id, _)| id == "python_runtime");
    let mut report = RemovalReport::default();
    for (id, paths) in plan {
        if id == "python_runtime"
            && ["strata", "hermes"]
                .iter()
                .any(|key| !owned_versions(root, key).is_empty())
        {
            report
                .errors
                .push("python_runtime: component-python-in-use".into());
            continue;
        }
        let mut success = true;
        for path in paths {
            let result = inspect_tree(root, &path).and_then(|_| {
                if is_active(std::slice::from_ref(&path)) {
                    return Err("component-process-active".into());
                }
                delete_tree(&path, MODULES.iter().any(|(key, _)| *key == id))?;
                unpublish(root, &path)
            });
            if let Err(error) = result {
                success = false;
                report.errors.push(format!("{id}: {error}"));
            }
        }
        if success {
            report.removed.push(id);
        }
    }
    fs::write(
        root.join("last-removal.json"),
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(report)
}
#[tauri::command]
pub async fn component_maintenance_state() -> Result<MaintenanceState, String> {
    tauri::async_runtime::spawn_blocking(|| snapshot_for(None))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn remove_components(ids: Vec<String>) -> Result<RemovalReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::components::store_root().ok_or("component-store-unavailable")?;
        remove_at(&root, &ids, active_under)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn open_uninstall_settings() -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg("ms-settings:appsfeatures")
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn launch_uninstaller(app: tauri::AppHandle) -> Result<(), String> {
    let path = uninstaller().ok_or("uninstaller-not-found")?;
    crate::app_lifecycle::shutdown(&app).await?;
    std::process::Command::new(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}
/// Invoked before the GUI, also usable from NSIS while the main app is closed.
pub fn cli() -> Option<i32> {
    let args: Vec<_> = std::env::args().collect();
    let mode = args.get(1)?.as_str();
    if ![
        "--component-removal-inventory",
        "--component-maintenance-state",
        "--remove-components",
    ]
    .contains(&mode)
    {
        return None;
    }
    let result = (|| -> Result<bool, String> {
        if mode == "--component-removal-inventory" && args.len() == 3 {
            let state = snapshot_for(None)?;
            let mut ini = String::from("[components]\r\n");
            for module in state.modules {
                ini.push_str(&format!(
                    "{}={}\r\n",
                    module.id,
                    u8::from(!module.paths.is_empty() && module.blocked.is_none())
                ));
            }
            fs::write(&args[2], ini).map_err(|e| e.to_string())?;
            return Ok(true);
        }
        if mode == "--component-maintenance-state" && [3, 4].contains(&args.len()) {
            let state = snapshot_for(args.get(3).map(PathBuf::from))?;
            fs::write(
                &args[2],
                serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            return Ok(true);
        }
        if mode == "--remove-components" && args.len() == 4 {
            let root = crate::components::store_root().ok_or("component-store-unavailable")?;
            let ids: Vec<_> = args[2]
                .split(',')
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect();
            let report = remove_at(&root, &ids, active_under)?;
            fs::write(
                &args[3],
                serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            return Ok(report.errors.is_empty());
        }
        Err("invalid-component-maintenance-arguments".into())
    })();
    match result {
        Ok(true) => Some(0),
        Ok(false) => Some(1),
        Err(error) => {
            // NSIS can display a failure report even when preflight fails before any deletion.
            if mode == "--remove-components" && args.len() == 4 {
                let _ = fs::write(
                    &args[3],
                    serde_json::json!({"removed":[],"errors":[error]}).to_string(),
                );
            }
            Some(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("aplot-removal-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn module(root: &Path, id: &str, version: &str) -> PathBuf {
        let path = root.join(id).join(version);
        fs::create_dir_all(&path).unwrap();
        fs::write(
            path.join("aplot-component.json"),
            serde_json::json!({"id":id,"version":version}).to_string(),
        )
        .unwrap();
        fs::write(path.join("binary.exe"), "owned").unwrap();
        path
    }
    #[test]
    fn selected_versions_only_and_external_manifest_entry_survives() {
        let root = fixture();
        let selected = module(&root, "llama_cpp", "v1");
        module(&root, "llama_cpp", "v2");
        let other = module(&root, "hermes", "v1");
        let unknown = root.join("llama_cpp/user-files");
        fs::create_dir_all(&unknown).unwrap();
        fs::write(unknown.join("model.gguf"), "model").unwrap();
        let external = root.parent().unwrap().join("external-engine.exe");
        fs::write(root.join("installations.json"), serde_json::json!({"schemaVersion":1,"components":[{"id":"llama_cpp","path":selected.join("binary.exe")},{"id":"hermes","path":external}]}).to_string()).unwrap();
        let report = remove_at(&root, &["llama_cpp".into()], |_| false).unwrap();
        assert!(report.errors.is_empty());
        assert!(!selected.exists());
        assert!(other.exists());
        assert!(unknown.join("model.gguf").is_file());
        let manifest = fs::read_to_string(root.join("installations.json")).unwrap();
        assert!(manifest.contains("external-engine"));
        assert!(!manifest.contains("binary.exe"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn preflight_blocks_unknown_ids_active_processes_and_shared_python() {
        let root = fixture();
        let owned = module(&root, "hermes", "v1");
        fs::create_dir(root.join("python")).unwrap();
        for ids in [vec!["../hermes".into()], vec!["python_runtime".into()]] {
            assert!(remove_at(&root, &ids, |_| false).is_err());
            assert!(owned.exists());
        }
        assert!(remove_at(&root, &["hermes".into()], |_| true)
            .unwrap_err()
            .contains("process-active"));
        assert!(owned.exists());
        let report = remove_at(&root, &["python_runtime".into(), "hermes".into()], |_| {
            false
        })
        .unwrap();
        assert!(report.errors.is_empty());
        assert!(!root.join("python").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn removed_engine_ids_are_hidden_and_never_cleaned_by_maintenance() {
        let root = fixture();
        let legacy = module(&root, "ollama", "v1");
        fs::write(
            root.join("installations.json"),
            serde_json::json!({"schemaVersion":1,"components":[{"id":"ollama","path":legacy.join("binary.exe")}]}).to_string(),
        )
        .unwrap();

        let visible = entries(&root, &[]);
        assert!(!visible.iter().any(|row| row.id == "ollama"));
        assert!(remove_at(&root, &["ollama".into()], |_| false).is_err());
        assert!(legacy.join("binary.exe").is_file());
        assert!(legacy.join("aplot-component.json").is_file());

        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_marker_and_corrupt_manifest_are_not_deleted() {
        let root = fixture();
        let path = module(&root, "strata", "v1");
        fs::write(
            path.join("aplot-component.json"),
            "{\"id\":\"hermes\",\"version\":\"v1\"}",
        )
        .unwrap();
        assert!(owned_versions(&root, "strata").is_empty());
        fs::write(path.join("aplot-installing.json"), "{\"id\":\"strata\"}").unwrap();
        fs::write(root.join("installations.json"), "corrupt").unwrap();
        assert!(remove_at(&root, &["strata".into()], |_| false).is_err());
        assert!(path.exists());
        assert!(check_scope(&root, &root.join("../other")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cache_removal_preserves_models_and_handles_a_missing_store() {
        let root = fixture();
        fs::create_dir(root.join("downloads")).unwrap();
        fs::write(root.join("downloads/package.zip"), "cache").unwrap();
        fs::create_dir(root.join("models")).unwrap();
        fs::write(root.join("models/keep.gguf"), "model").unwrap();
        let report = remove_at(&root, &["cache".into()], |_| false).unwrap();
        assert!(report.errors.is_empty());
        assert!(!root.join("downloads").exists());
        assert!(root.join("models/keep.gguf").exists());
        assert!(remove_at(&root, &["cache".into()], |_| false)
            .unwrap()
            .errors
            .is_empty());
        fs::remove_dir_all(&root).unwrap();
        assert!(remove_at(&root, &["cache".into()], |_| false)
            .unwrap()
            .errors
            .is_empty());
    }
    #[cfg(windows)]
    #[test]
    fn installation_lock_and_linked_directories_block_removal() {
        let root = fixture();
        let path = module(&root, "llama_cpp", "v1");
        let lock = lock_store(&root).unwrap();
        assert!(remove_at(&root, &["llama_cpp".into()], |_| false)
            .unwrap_err()
            .contains("maintenance-busy"));
        assert!(path.exists());
        drop(lock);
        // mklink /J needs no administrator or Developer Mode. Both targets are this test's files.
        let outside = root.join("project");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep.txt"), "project").unwrap();
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(path.join("linked"))
            .arg(&outside)
            .creation_flags(0x08000000)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(remove_at(&root, &["llama_cpp".into()], |_| false)
            .unwrap_err()
            .contains("link-protected"));
        assert!(outside.join("keep.txt").exists());
        fs::remove_dir(path.join("linked")).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn running_process_in_module_directory_is_detected() {
        use std::os::windows::process::CommandExt;
        let root = fixture();
        let path = module(&root, "hermes", "v1");
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/Q", "/K"])
            .current_dir(&path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let detected = (0..30).any(|_| {
            if active_under(std::slice::from_ref(&path)) {
                true
            } else {
                std::thread::sleep(std::time::Duration::from_millis(50));
                false
            }
        });
        let _ = child.kill();
        let _ = child.wait();
        fs::remove_dir_all(root).unwrap();
        assert!(detected);
    }
    #[cfg(windows)]
    #[test]
    fn uv_internal_python_alias_is_unlinked_without_traversal() {
        use std::os::windows::process::CommandExt;
        let root = fixture();
        let python = root.join("python");
        let real = python.join("cpython-version");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("python.exe"), "runtime").unwrap();
        let status = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(python.join("cpython-alias"))
            .arg(&real)
            .creation_flags(0x08000000)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        let report = remove_at(&root, &["python_runtime".into()], |_| false).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(!python.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn locked_file_retains_marker_and_other_selected_module_can_be_removed() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = fixture();
        let path = module(&root, "hermes", "v1");
        let peer = module(&root, "llama_cpp", "v1");
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(path.join("binary.exe"))
            .unwrap();
        let report = remove_at(&root, &["hermes".into(), "llama_cpp".into()], |_| false).unwrap();
        assert!(!report.errors.is_empty());
        assert!(path.join("aplot-component.json").exists());
        assert!(!peer.exists());
        drop(locked);
        assert!(remove_at(&root, &["hermes".into()], |_| false)
            .unwrap()
            .errors
            .is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
