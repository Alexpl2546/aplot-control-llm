//! Model recipes run the installed Strata setup under the application's process ownership.
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Manager, State};
use tokio::{
    io::AsyncReadExt,
    sync::{watch, Mutex},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationStatus {
    id: String,
    recipe_id: String,
    state: String,
    lines: Vec<String>,
    config_path: Option<String>,
    error: Option<String>,
    #[serde(default)]
    recipe: Option<StrataRecipe>,
    #[serde(default)]
    destination: Option<String>,
    #[serde(default)]
    root_path: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrataRecipe {
    id: String,
    name: String,
    family: String,
    model: String,
    config_tag: String,
    images: bool,
    #[serde(default)]
    model_files: Vec<String>,
    #[serde(flatten)]
    metadata: serde_json::Map<String, serde_json::Value>,
}
#[derive(Default)]
pub struct ModelPreparation {
    current: Mutex<Option<PreparationStatus>>,
    stopping: AtomicBool,
    cancel: Mutex<Option<watch::Sender<bool>>>,
}

fn safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}
fn validate_catalog(recipes: Vec<StrataRecipe>) -> Result<Vec<StrataRecipe>, String> {
    if recipes.is_empty() || recipes.len() > 512 {
        return Err("The installed Strata component returned an invalid model catalog".into());
    }
    let mut ids = std::collections::HashSet::new();
    for recipe in &recipes {
        if ![
            &recipe.id,
            &recipe.family,
            &recipe.model,
            &recipe.config_tag,
        ]
        .into_iter()
        .all(|value| safe_identifier(value))
            || !ids.insert(&recipe.id)
            || recipe.model_files.len() > 64
            || recipe.model_files.iter().any(|file| {
                file.is_empty()
                    || file.len() > 256
                    || file.contains(['/', '\\', ':'])
                    || file == "."
                    || file == ".."
            })
        {
            return Err("The installed Strata component returned an invalid model catalog".into());
        }
    }
    Ok(recipes)
}
async fn read_catalog(root: &Path, with_hardware: bool) -> Result<Vec<StrataRecipe>, String> {
    let python = root.join(".venv/Scripts/python.exe");
    if !python.is_file() {
        return Err("Install the Strata component and its Python environment first".into());
    }
    let mut command = tokio::process::Command::new(python);
    command
        .args(["-B", "-c", include_str!("strata_model_catalog.py")])
        .arg(root)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("PYTHONIOENCODING", "utf-8")
        .env_remove("STRATA_CONTROL_INSTALL")
        .env_remove("STRATA_INSTALL_DIR");
    if !with_hardware {
        command.arg("--without-hardware");
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot read Strata's model catalog: {error}"))?;
    let job = match crate::owned_job::OwnedJob::assign(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill().await;
            return Err(error);
        }
    };
    let output = tokio::time::timeout(std::time::Duration::from_secs(45), child.wait_with_output())
        .await
        .map_err(|_| "Reading Strata's model catalog timed out".to_string())?
        .map_err(|error| error.to_string())?;
    drop(job);
    if !output.status.success() {
        let detail: String = String::from_utf8_lossy(&output.stderr)
            .chars()
            .rev()
            .take(1800)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        return Err(format!("Cannot read Strata's model catalog: {detail}"));
    }
    if output.stdout.len() > 512 * 1024 {
        return Err("Strata's model catalog is too large".into());
    }
    let recipes = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Cannot decode Strata's model catalog: {error}"))?;
    validate_catalog(recipes)
}
#[tauri::command]
pub async fn strata_model_catalog(root_value: String) -> Result<Vec<StrataRecipe>, String> {
    let root = crate::strata::root_path(&root_value)?;
    read_catalog(&root, true).await
}
fn arguments(
    family: &str,
    model: &str,
    destination: &str,
    gguf_dir: Option<&str>,
    images: bool,
) -> Vec<String> {
    let mut args: Vec<String> = [
        "-B",
        "-u",
        "-c",
        include_str!("strata_model_setup.py"),
        "--setup",
        "--yes",
        "--no-start",
        "--family",
        family,
        "--model",
        model,
        "--context",
        "8192",
        "--vision",
        if images { "yes" } else { "no" },
        "--data-dir",
        destination,
    ]
    .into_iter()
    .map(String::from)
    .collect();
    if let Some(directory) = gguf_dir {
        args.extend(["--gguf-dir".into(), directory.into()]);
    }
    if matches!(family, "qwen" | "coder") {
        args.extend(["--experimental-speed-projection".into(), "off".into()]);
    }
    args
}
fn find_existing_files(directories: Vec<String>, files: &[String]) -> Option<String> {
    let first = files.first()?;
    for directory in directories.into_iter().take(64) {
        for entry in walkdir::WalkDir::new(directory)
            .max_depth(5)
            .follow_links(false)
            .into_iter()
            .take(50000)
            .filter_map(Result::ok)
        {
            if entry.file_type().is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(first)
            {
                if let Some(parent) = entry.path().parent() {
                    if files.iter().all(|file| parent.join(file).is_file()) {
                        return Some(parent.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    None
}
fn status_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root.join("model-preparation.json"))
}
async fn update(app: &AppHandle, edit: impl FnOnce(&mut PreparationStatus)) {
    let manager = app.state::<ModelPreparation>();
    let mut current = manager.current.lock().await;
    if let Some(status) = current.as_mut() {
        edit(status);
        if let Ok(path) = status_path(app) {
            if let Ok(bytes) = serde_json::to_vec(status) {
                let _ = crate::connection_profiles::atomic_write(&path, &bytes);
            }
        }
    }
}
#[derive(Default)]
struct PreparationOutput {
    pending: Vec<u8>,
}
impl PreparationOutput {
    fn finish_line(&mut self) -> Option<String> {
        let line: String = String::from_utf8_lossy(&self.pending)
            .chars()
            .take(1000)
            .collect();
        self.pending.clear();
        if line.trim().is_empty() {
            None
        } else {
            Some(line)
        }
    }
    fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();
        for &byte in chunk {
            if matches!(byte, b'\r' | b'\n') {
                if let Some(line) = self.finish_line() {
                    lines.push(line);
                }
            } else if self.pending.len() < 4000 {
                self.pending.push(byte);
            }
        }
        lines
    }
}
async fn record_output(app: &AppHandle, line: String) {
    update(app, |status| {
        status.lines.push(line);
        if status.lines.len() > 80 {
            status.lines.remove(0);
        }
    })
    .await;
}
async fn read_output(app: AppHandle, mut output: impl tokio::io::AsyncRead + Unpin) {
    // Strata updates transfer/hash progress with carriage returns, without newlines.
    let mut decoder = PreparationOutput::default();
    let mut chunk = [0u8; 4096];
    while let Ok(size) = output.read(&mut chunk).await {
        if size == 0 {
            break;
        }
        for line in decoder.feed(&chunk[..size]) {
            record_output(&app, line).await;
        }
    }
    if let Some(line) = decoder.finish_line() {
        record_output(&app, line).await;
    }
}

#[tauri::command]
pub async fn model_preparation_status(
    app: AppHandle,
    manager: State<'_, ModelPreparation>,
) -> Result<Option<PreparationStatus>, String> {
    let mut current = manager.current.lock().await;
    if current.is_none() {
        let path = status_path(&app)?;
        if path.is_file() {
            let mut status: PreparationStatus =
                serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if status.state == "installing" {
                status.state = "interrupted".into();
            }
            *current = Some(status);
        }
    }
    Ok(current.clone())
}

#[tauri::command]
pub async fn start_strata_model_preparation(
    app: AppHandle,
    manager: State<'_, ModelPreparation>,
    operations: State<'_, crate::strata_engine_update::StrataEngineOperationLock>,
    recipe_id: String,
    root_value: String,
    destination: String,
    existing_directories: Vec<String>,
) -> Result<PreparationStatus, String> {
    if manager.stopping.load(Ordering::Acquire) {
        return Err("Application is shutting down".into());
    }
    let operation_lease = operations.try_prepare()?;
    let root = crate::strata::root_path(&root_value)?;
    // The selected family/quantization must be offered by this installed engine.
    // Hardware estimates are advisory; setup handles its own backend checks.
    let recipe = read_catalog(&root, false).await?.into_iter()
        .find(|recipe| recipe.id == recipe_id)
        .ok_or("This model is not supported by the installed Strata component; refresh the catalog or update Strata")?;
    let family = recipe.family.clone();
    let model = recipe.model.clone();
    let python = root.join(".venv/Scripts/python.exe");
    if !python.is_file() {
        return Err("Install the Strata component and its Python environment first".into());
    }
    let destination = crate::downloads::paths::destination(&destination)?;
    let mut current = manager.current.lock().await;
    if current
        .as_ref()
        .is_some_and(|status| status.state == "installing")
    {
        return Err("A model preparation is already running".into());
    }
    let existing_config = root.join(format!("strata-{}.json", recipe.config_tag));
    if crate::strata::validate_config(&root, &existing_config).is_ok() {
        let status = PreparationStatus {
            id: uuid::Uuid::new_v4().to_string(),
            recipe_id,
            state: "completed".into(),
            lines: vec![],
            config_path: Some(existing_config.to_string_lossy().into_owned()),
            error: None,
            recipe: Some(recipe.clone()),
            destination: Some(destination.to_string_lossy().into_owned()),
            root_path: Some(root.to_string_lossy().into_owned()),
        };
        *current = Some(status.clone());
        drop(current);
        update(&app, |_| {}).await;
        return Ok(status);
    }
    let files = recipe.model_files.clone();
    let gguf_dir =
        tokio::task::spawn_blocking(move || find_existing_files(existing_directories, &files))
            .await
            .map_err(|e| e.to_string())?;
    if manager.stopping.load(Ordering::Acquire) {
        return Err("Application is shutting down".into());
    }
    let mut command = tokio::process::Command::new(python);
    command
        .args(arguments(
            &family,
            &model,
            &destination.to_string_lossy(),
            gguf_dir.as_deref(),
            recipe.images,
        ))
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env(
            "STRATA_SETTINGS_FILE",
            status_path(&app)?.with_file_name("strata-model-settings.json"),
        )
        .env("STRATA_CONTROL_INSTALL", "1")
        .env("STRATA_INSTALL_DIR", &root)
        .env("STRATA_COMPONENTS_DIR", root.join("components"))
        .env_remove("STRATA_ALLOW_UNPINNED")
        .env_remove("STRATA_NO_ACQUIRE");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let job = match crate::owned_job::OwnedJob::assign(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill().await;
            return Err(error);
        }
    };
    let status = PreparationStatus {
        id: uuid::Uuid::new_v4().to_string(),
        recipe_id,
        state: "installing".into(),
        lines: vec![],
        config_path: None,
        error: None,
        recipe: Some(recipe.clone()),
        destination: Some(destination.to_string_lossy().into_owned()),
        root_path: Some(root.to_string_lossy().into_owned()),
    };
    *current = Some(status.clone());
    let (cancel, mut receive) = watch::channel(false);
    *manager.cancel.lock().await = Some(cancel);
    let stdout = child.stdout.take().ok_or("Installer stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("Installer stderr unavailable")?;
    drop(current);
    update(&app, |_| {}).await;
    tauri::async_runtime::spawn(async move {
        let _operation_lease = operation_lease;
        let out = tokio::spawn(read_output(app.clone(), stdout));
        let err = tokio::spawn(read_output(app.clone(), stderr));
        let result = tokio::select! {
            result=child.wait()=>result.map_err(|e|e.to_string()).and_then(|status|if status.success(){Ok(())}else{Err(format!("Strata setup exited with {status}"))}),
            _=receive.changed()=>{job.terminate();let _=child.kill().await;Err("cancelled".into())}
        };
        drop(job);
        let _ = out.await;
        let _ = err.await;
        let config = root.join(format!("strata-{}.json", recipe.config_tag));
        let result = result.and_then(|_| {
            crate::strata::validate_config(&root, Path::new(&config))
                .map(|_| config.to_string_lossy().into_owned())
        });
        app.state::<ModelPreparation>().cancel.lock().await.take();
        // The status remains installing until cancellation ownership has been released.
        update(&app, |status| match result {
            Ok(path) => {
                status.state = "completed".into();
                status.config_path = Some(path);
            }
            Err(error) => {
                status.state = if error == "cancelled" {
                    "cancelled"
                } else {
                    "failed"
                }
                .into();
                status.error = Some(error);
            }
        })
        .await;
    });
    Ok(status)
}

#[tauri::command]
pub async fn cancel_model_preparation(manager: State<'_, ModelPreparation>) -> Result<(), String> {
    if let Some(cancel) = manager.cancel.lock().await.as_ref() {
        let _ = cancel.send(true);
    }
    Ok(())
}
impl ModelPreparation {
    pub async fn shutdown(&self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(cancel) = self.cancel.lock().await.as_ref() {
            let _ = cancel.send(true);
        }
        loop {
            if self.cancel.lock().await.is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn progress_reads_carriage_returns_split_utf8_and_bounds_unterminated_lines() {
        let mut output = PreparationOutput::default();
        assert_eq!(
            output.feed(b"start\r\n\rmodel (42%)\r"),
            vec!["start", "model (42%)"]
        );
        let text = "готово".as_bytes();
        assert!(output.feed(&text[..1]).is_empty());
        assert!(output.feed(&text[1..]).is_empty());
        assert_eq!(output.feed(b"\n"), vec!["готово"]);
        output.feed(&vec![b'x'; 100_000]);
        assert_eq!(output.pending.len(), 4000);
        assert_eq!(output.finish_line().unwrap().len(), 1000);
        assert!(output.finish_line().is_none());
    }
    #[test]
    fn catalog_rejects_paths_and_duplicate_ids() {
        let row = serde_json::json!({"id":"strata-qwen36-ud-q4_k_xl", "name":"Qwen3.6", "family":"qwen36", "model":"UD-Q4_K_XL", "configTag":"qwen36-ud-q4_k_xl", "images":true});
        let recipe: StrataRecipe = serde_json::from_value(row.clone()).unwrap();
        assert!(validate_catalog(vec![recipe.clone()]).is_ok());
        assert!(validate_catalog(vec![recipe.clone(), recipe]).is_err());
        let mut invalid: StrataRecipe = serde_json::from_value(row).unwrap();
        invalid.config_tag = "../outside".into();
        assert!(validate_catalog(vec![invalid]).is_err());
    }
    #[test]
    fn catalog_accepts_deepseek_quantization_identifiers_with_decimal_points() {
        let recipe: StrataRecipe = serde_json::from_value(serde_json::json!({
            "id":"strata-deepseek41-ist-das-2.00bpw",
            "name":"DeepSeek V4.1 Flash · IST-DAS-2.00bpw",
            "family":"deepseek41",
            "model":"IST-DAS-2.00bpw",
            "configTag":"deepseek-v4.1-flash-ist-das-2.00bpw",
            "images":false
        }))
        .unwrap();
        assert!(validate_catalog(vec![recipe]).is_ok());
    }
    #[test]
    fn setup_does_not_start_a_server_and_paths_are_separate_arguments() {
        let args = arguments("qwen", "IQ2_XS", "C:\\Models folder", None, true);
        assert!(args.contains(&"--no-start".into()));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--data-dir", "C:\\Models folder"]));
        assert!(args.windows(2).any(|pair| pair == ["--vision", "yes"]));
        assert_eq!(args[0], "-B");
        assert_eq!(args[2], "-c");
        assert!(!args.contains(&"--build".into()));
    }
    #[test]
    fn existing_files_require_the_entire_installed_catalog_shard_set() {
        let temp =
            std::env::temp_dir().join(format!("aplot-catalog-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let files: Vec<String> = (1..=3)
            .map(|i| format!("Swift-UD-IQ4_XS-{i}.gguf"))
            .collect();
        for file in &files[..2] {
            std::fs::write(temp.join(file), []).unwrap();
        }
        let directories = vec![temp.to_string_lossy().into_owned()];
        assert!(find_existing_files(directories.clone(), &files).is_none());
        std::fs::write(temp.join(&files[2]), []).unwrap();
        assert_eq!(
            find_existing_files(directories, &files),
            Some(temp.to_string_lossy().into_owned())
        );
        assert!(find_existing_files(vec![], &[]).is_none());
        std::fs::remove_dir_all(temp).unwrap();
    }
}
