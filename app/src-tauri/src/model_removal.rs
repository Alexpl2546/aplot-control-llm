//! Deleting a downloaded model from the library: every file of the model
//! (all shards) plus the projector, draft and n-gram files kept with it.
//! A file a running server uses blocks the whole removal; saved profiles that
//! point at the model are reported, not changed.
use crate::{
    artifact_service::catalog_sources,
    db::DbState,
    domain::artifacts::{
        ArtifactCatalog, ArtifactConsumer, ArtifactKind, ArtifactState, ModelArtifact,
    },
    runs::RunManager,
};
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashSet},
    path::{Path, PathBuf},
};
use tauri::State;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemovalFile {
    pub path: String,
    pub role: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRemovalPlan {
    pub files: Vec<RemovalFile>,
    pub total_bytes: u64,
    /// Running servers that use these files; while any is listed nothing is deleted.
    pub active: Vec<String>,
    /// Saved profiles that point at the model and will stop starting.
    pub profiles: Vec<String>,
    /// Files skipped because another model shares them (hard links).
    pub shared: Vec<String>,
}

fn key(path: &str) -> String {
    let normalized = path.replace('/', "\\");
    normalized
        .strip_prefix("\\\\?\\")
        .unwrap_or(&normalized)
        .trim_end_matches('\\')
        .to_lowercase()
}

fn path_is_within(path: &str, root: &str) -> bool {
    let path = key(path);
    let root = key(root);
    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('\\'))
}

fn add_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths
        .iter()
        .any(|existing| key(&existing.to_string_lossy()) == key(&path.to_string_lossy()))
    {
        paths.push(path);
    }
}

fn path_is_scanned(path: &Path, roots: &[PathBuf]) -> bool {
    let path = path.to_string_lossy();
    roots
        .iter()
        .any(|root| path_is_within(&path, &root.to_string_lossy()))
}

fn parent_key(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|p| key(&p.to_string_lossy()))
        .unwrap_or_default()
}

/// A projector fetched later for this model sits in `<folder>\aplot-vision-<id>`.
fn vision_download_of(parent: &str, folder: &str) -> bool {
    parent
        .strip_prefix(folder)
        .and_then(|rest| rest.strip_prefix('\\'))
        .is_some_and(|name| {
            !name.contains('\\') && name.starts_with(crate::downloads::VISION_FOLDER_PREFIX)
        })
}

/// What deleting the model at `path` removes. Companions (projector, draft,
/// n-gram) belong to it when linked through a profile or kept in its own
/// folder, never when they sit loose in a shared models root.
pub(crate) fn plan(
    catalog: &ArtifactCatalog,
    consumers: &[ArtifactConsumer],
    roots: &[PathBuf],
    path: &str,
) -> Result<ModelRemovalPlan, String> {
    let wanted = key(path);
    let target = catalog
        .artifacts
        .iter()
        .find(|artifact| {
            matches!(
                artifact.kind,
                ArtifactKind::PrimaryModel | ArtifactKind::OtherModel
            ) && artifact.files.iter().any(|file| key(&file.path) == wanted)
        })
        .ok_or("model-not-found")?;
    let folder = parent_key(path);
    let own_folder = !roots
        .iter()
        .any(|root| key(&root.to_string_lossy()) == folder);
    let mut artifacts = vec![target];
    for artifact in &catalog.artifacts {
        let companion = matches!(
            artifact.kind,
            ArtifactKind::Mmproj | ArtifactKind::Mtp | ArtifactKind::Ngram
        );
        let linked = artifact.dependency_ids.iter().any(|id| id == &target.id);
        let beside = own_folder
            && artifact.files.iter().all(|file| {
                let parent = parent_key(&file.path);
                parent == folder || vision_download_of(&parent, &folder)
            });
        if companion && (linked || beside) {
            artifacts.push(artifact);
        }
    }
    Ok(plan_artifacts(
        catalog,
        consumers,
        &artifacts,
        &BTreeSet::new(),
        Vec::new(),
        &BTreeSet::new(),
    ))
}

fn plan_artifacts(
    catalog: &ArtifactCatalog,
    consumers: &[ArtifactConsumer],
    artifacts: &[&ModelArtifact],
    logically_shared: &BTreeSet<String>,
    extra_files: Vec<RemovalFile>,
    direct_consumers: &BTreeSet<String>,
) -> ModelRemovalPlan {
    let selected_ids: BTreeSet<_> = artifacts
        .iter()
        .map(|artifact| artifact.id.as_str())
        .collect();
    let mut files = Vec::new();
    let mut shared = Vec::new();
    let mut active = BTreeSet::new();
    let mut profiles = BTreeSet::new();
    for artifact in artifacts {
        for file in &artifact.files {
            if file.state == ArtifactState::Missing {
                continue;
            }
            for id in &file.consumer_ids {
                match consumers.iter().find(|consumer| &consumer.id == id) {
                    Some(consumer) if consumer.active => {
                        active.insert(id.clone());
                    }
                    Some(consumer) if consumer.kind == "profile" => {
                        profiles.insert(id.trim_start_matches("profile:").to_string());
                    }
                    _ => {}
                }
            }
            let shared_elsewhere = logically_shared.contains(&key(&file.path))
                || file.file_identity.as_ref().is_some_and(|identity| {
                    catalog.artifacts.iter().any(|other| {
                        !selected_ids.contains(other.id.as_str())
                            && other
                                .files
                                .iter()
                                .any(|f| f.file_identity.as_ref() == Some(identity))
                    })
                });
            if shared_elsewhere {
                shared.push(file.path.clone());
            } else {
                files.push(RemovalFile {
                    path: file.path.clone(),
                    role: file.role.clone(),
                    size_bytes: file.size_bytes,
                });
            }
        }
    }
    for id in direct_consumers {
        if let Some(consumer) = consumers.iter().find(|consumer| &consumer.id == id) {
            if consumer.active {
                active.insert(id.clone());
            } else if consumer.kind == "profile" {
                profiles.insert(id.trim_start_matches("profile:").to_string());
            }
        }
    }
    files.extend(extra_files);
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files.dedup_by(|a, b| key(&a.path) == key(&b.path));
    shared.sort();
    shared.dedup_by(|a, b| key(a) == key(b));
    ModelRemovalPlan {
        total_bytes: files.iter().map(|file| file.size_bytes).sum(),
        files,
        active: active.into_iter().collect(),
        profiles: profiles.into_iter().collect(),
        shared,
    }
}

async fn discover_strata_models(
    db: &DbState,
) -> Result<Option<Vec<crate::strata::StrataModelOption>>, String> {
    use rusqlite::OptionalExtension;

    let root = {
        let conn = db.0.lock().await;
        let settings: Option<String> = conn
            .query_row(
                "SELECT value_json FROM kv WHERE key='settings'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        settings
            .map(|settings| serde_json::from_str::<serde_json::Value>(&settings))
            .transpose()
            .map_err(|error| error.to_string())?
            .and_then(|settings| {
                settings
                    .get("strataRootPath")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .filter(|root| !root.trim().is_empty())
    };
    let Some(root) = root else {
        return Ok(None);
    };
    let models = tokio::task::spawn_blocking(move || crate::strata::discover_strata_models(root))
        .await
        .map_err(|error| error.to_string())??;
    Ok(Some(models))
}

fn selected_strata_options<'a>(
    options: &'a [crate::strata::StrataModelOption],
    path: &str,
) -> Vec<&'a crate::strata::StrataModelOption> {
    let wanted = key(path);
    options
        .iter()
        .filter(|option| {
            option
                .model_path
                .as_deref()
                .into_iter()
                .chain(option.pack_path.as_deref())
                .chain(std::iter::once(option.config_path.as_str()))
                .any(|candidate| key(candidate) == wanted)
        })
        .collect()
}

fn pack_files(pack: &Path) -> Result<Vec<PathBuf>, String> {
    let pack = pack
        .canonicalize()
        .map_err(|error| format!("Could not open Strata pack {}: {error}", pack.display()))?;
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(&pack).follow_links(false) {
        let entry = entry.map_err(|error| {
            format!(
                "Could not inspect Strata pack {}: {error}",
                error.path().unwrap_or(&pack).display()
            )
        })?;
        if entry.file_type().is_file() {
            files.push(entry.into_path());
        }
    }
    Ok(files)
}

fn add_extra_file(
    path: &Path,
    role: &str,
    catalog_paths: &HashSet<String>,
    seen: &mut BTreeSet<String>,
    files: &mut Vec<RemovalFile>,
) {
    let path_key = key(&path.to_string_lossy());
    if catalog_paths.contains(&path_key) || !seen.insert(path_key) {
        return;
    }
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return;
    };
    if !metadata.file_type().is_file() {
        return;
    }
    files.push(RemovalFile {
        path: path.to_string_lossy().into_owned(),
        role: role.into(),
        size_bytes: metadata.len(),
    });
}

fn strata_plan(
    catalog: &ArtifactCatalog,
    consumers: &[ArtifactConsumer],
    options: &[crate::strata::StrataModelOption],
    selected: &[&crate::strata::StrataModelOption],
) -> Result<ModelRemovalPlan, String> {
    let selected_configs: BTreeSet<_> = selected
        .iter()
        .map(|option| key(&option.config_path))
        .collect();
    let selected_model_paths: BTreeSet<_> = selected
        .iter()
        .flat_map(|option| option.model_files.iter().map(|path| key(path)))
        .collect();
    let mut logically_shared = BTreeSet::new();
    for option in options {
        if !selected_configs.contains(&key(&option.config_path)) {
            for model_path in &option.model_files {
                let model_path = key(model_path);
                if selected_model_paths.contains(&model_path) {
                    logically_shared.insert(model_path);
                }
            }
        }
    }

    let artifacts: Vec<_> = catalog
        .artifacts
        .iter()
        .filter(|artifact| {
            artifact
                .files
                .iter()
                .any(|file| selected_model_paths.contains(&key(&file.path)))
        })
        .collect();
    let catalog_paths: HashSet<_> = catalog
        .artifacts
        .iter()
        .flat_map(|artifact| artifact.files.iter().map(|file| key(&file.path)))
        .collect();
    let mut extra_files = Vec::new();
    let mut seen_extra = BTreeSet::new();
    let mut target_paths = BTreeSet::new();
    let mut direct_shared = Vec::new();
    for option in selected {
        target_paths.insert(key(&option.config_path));
        add_extra_file(
            Path::new(&option.config_path),
            "strataConfig",
            &catalog_paths,
            &mut seen_extra,
            &mut extra_files,
        );
        if let Some(model_path) = option.model_path.as_deref() {
            target_paths.insert(key(model_path));
        }
        for model_path in &option.model_files {
            target_paths.insert(key(model_path));
            if logically_shared.contains(&key(model_path)) {
                if Path::new(model_path).is_file() {
                    direct_shared.push(model_path.clone());
                }
            } else {
                add_extra_file(
                    Path::new(model_path),
                    "strataModel",
                    &catalog_paths,
                    &mut seen_extra,
                    &mut extra_files,
                );
            }
        }
        if let Some(pack) = option.pack_path.as_deref() {
            target_paths.insert(key(pack));
            for file in pack_files(Path::new(pack))? {
                add_extra_file(
                    &file,
                    "strataPack",
                    &catalog_paths,
                    &mut seen_extra,
                    &mut extra_files,
                );
            }
        }
    }
    let direct_consumers: BTreeSet<_> = consumers
        .iter()
        .filter(|consumer| {
            target_paths.iter().any(|target| {
                let consumer_path = key(&consumer.path);
                let target = key(target);
                path_is_within(&target, &consumer_path) || path_is_within(&consumer_path, &target)
            })
        })
        .map(|consumer| consumer.id.clone())
        .collect();

    let mut plan = plan_artifacts(
        catalog,
        consumers,
        &artifacts,
        &logically_shared,
        extra_files,
        &direct_consumers,
    );
    plan.shared.extend(direct_shared);
    plan.shared.sort();
    plan.shared.dedup_by(|a, b| key(a) == key(b));
    plan.files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(plan)
}

async fn current_plan(
    db: &DbState,
    manager: &RunManager,
    path: &str,
) -> Result<(ModelRemovalPlan, Vec<PathBuf>), String> {
    let (mut roots, consumers) = catalog_sources(db, manager).await?;
    // A model outside the known folders is still found through its own folder.
    if let Some(parent) = Path::new(path).parent() {
        if !path_is_scanned(Path::new(path), &roots) {
            add_unique_path(&mut roots, parent.to_path_buf());
        }
    }
    let cleanup_roots = roots.clone();
    let strata_discovery = discover_strata_models(db).await;
    let strata_options = strata_discovery.as_ref().ok().and_then(Option::as_deref);
    let selected = strata_options
        .map(|options| selected_strata_options(options, path))
        .unwrap_or_default();
    let mut scan_roots = roots.clone();
    let mut guarded_roots = cleanup_roots;
    for option in &selected {
        if let Some(pack) = option.pack_path.as_deref() {
            let pack = PathBuf::from(pack);
            if pack.exists() && !path_is_scanned(&pack, &scan_roots) {
                add_unique_path(&mut scan_roots, pack.clone());
            }
            if let Some(parent) = pack.parent() {
                add_unique_path(&mut guarded_roots, parent.to_path_buf());
            }
        }
        for model_file in &option.model_files {
            let model_file = PathBuf::from(model_file);
            if model_file.is_file() && !path_is_scanned(&model_file, &scan_roots) {
                add_unique_path(&mut scan_roots, model_file.clone());
            }
            if let Some(parent) = model_file.parent() {
                add_unique_path(&mut guarded_roots, parent.to_path_buf());
            }
        }
        if let Some(parent) = Path::new(&option.config_path).parent() {
            add_unique_path(&mut guarded_roots, parent.to_path_buf());
        }
    }
    let scan_consumers = consumers.clone();
    let catalog = tokio::task::spawn_blocking(move || {
        crate::model_artifacts::scan_model_artifacts(&scan_roots, &scan_consumers)
    })
    .await
    .map_err(|e| e.to_string())??;
    let result = if !selected.is_empty() {
        let options = strata_options.ok_or_else(|| "model-not-found".to_string())?;
        strata_plan(&catalog, &consumers, options, &selected)?
    } else {
        match plan(&catalog, &consumers, &roots, path) {
            Ok(plan) => plan,
            Err(error) => return Err(strata_discovery.as_ref().err().cloned().unwrap_or(error)),
        }
    };
    Ok((result, guarded_roots))
}

#[tauri::command]
pub async fn model_removal_plan(
    db: State<'_, DbState>,
    manager: State<'_, RunManager>,
    path: String,
) -> Result<ModelRemovalPlan, String> {
    Ok(current_plan(&db, &manager, &path).await?.0)
}

/// Deletes the files the plan lists, then folders left empty below a models root.
#[tauri::command]
pub async fn remove_model(
    db: State<'_, DbState>,
    manager: State<'_, RunManager>,
    path: String,
) -> Result<ModelRemovalPlan, String> {
    let (plan, roots) = current_plan(&db, &manager, &path).await?;
    if !plan.active.is_empty() {
        return Err("model-in-use".into());
    }
    let mut folders = BTreeSet::new();
    for file in &plan.files {
        std::fs::remove_file(&file.path).map_err(|e| format!("{}: {e}", file.path))?;
        if path_is_scanned(Path::new(&file.path), &roots) {
            if let Some(parent) = Path::new(&file.path).parent() {
                folders.insert(parent.to_path_buf());
            }
        }
    }
    for folder in folders {
        let mut current = Some(folder.as_path());
        while let Some(dir) = current {
            let is_root = roots
                .iter()
                .any(|root| key(&root.to_string_lossy()) == key(&dir.to_string_lossy()));
            // Never climb into shared stores such as `models` or `strata/models`.
            let shared_store = dir
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("models"));
            if is_root || shared_store || std::fs::remove_dir(dir).is_err() {
                break;
            }
            current = dir.parent();
        }
    }
    let conn = db.0.lock().await;
    let mut statement = conn
        .prepare("SELECT id, installed_path FROM model_installations")
        .map_err(|e| e.to_string())?;
    let gone: Vec<String> = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|(_, installed)| !Path::new(installed).exists())
        .map(|(id, _)| id)
        .collect();
    drop(statement);
    for id in gone {
        conn.execute("DELETE FROM model_installations WHERE id = ?1", [id])
            .map_err(|e| e.to_string())?;
    }
    // The model's reasoning levels go with it, a hand-made list included.
    let removed: Vec<String> = plan.files.iter().map(|file| file.path.clone()).collect();
    crate::reasoning::remove_local(&conn, &removed)?;
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture() -> PathBuf {
        let path = std::env::temp_dir().join(format!("aplot-removal-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn a_model_folder_takes_its_shards_and_projector_but_not_neighbours() {
        let root = fixture();
        let own = root.join("qwen");
        fs::create_dir_all(&own).unwrap();
        fs::write(own.join("model-00001-of-00002.gguf"), b"one").unwrap();
        fs::write(own.join("model-00002-of-00002.gguf"), b"two").unwrap();
        fs::write(own.join("model-mmproj-f16.gguf"), b"vision").unwrap();
        fs::create_dir_all(own.join("aplot-vision-1")).unwrap();
        fs::write(
            own.join("aplot-vision-1").join("later-mmproj-bf16.gguf"),
            b"later",
        )
        .unwrap();
        fs::write(root.join("other.gguf"), b"other").unwrap();
        fs::write(root.join("loose-mmproj.gguf"), b"loose").unwrap();
        let profile = ArtifactConsumer {
            id: "profile:p1".into(),
            kind: "profile".into(),
            path: own
                .join("model-00001-of-00002.gguf")
                .to_string_lossy()
                .into_owned(),
            active: false,
        };
        let roots = vec![root.clone()];
        let catalog =
            crate::model_artifacts::scan_model_artifacts(&roots, &[profile.clone()]).unwrap();
        let path = own
            .join("model-00001-of-00002.gguf")
            .to_string_lossy()
            .into_owned();
        let plan = plan(&catalog, &[profile], &roots, &path).unwrap();
        let names: Vec<_> = plan
            .files
            .iter()
            .map(|f| {
                Path::new(&f.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(
            names,
            [
                "later-mmproj-bf16.gguf",
                "model-00001-of-00002.gguf",
                "model-00002-of-00002.gguf",
                "model-mmproj-f16.gguf"
            ]
        );
        assert_eq!(plan.profiles, ["p1"]);
        assert!(plan.active.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_running_server_blocks_the_plan() {
        let root = fixture();
        fs::write(root.join("solo.gguf"), b"solo").unwrap();
        let path = root.join("solo.gguf").to_string_lossy().into_owned();
        let run = ArtifactConsumer {
            id: "run:a".into(),
            kind: "run".into(),
            path: path.clone(),
            active: true,
        };
        let roots = vec![root.clone()];
        let catalog = crate::model_artifacts::scan_model_artifacts(&roots, &[run.clone()]).unwrap();
        let plan = plan(&catalog, &[run], &roots, &path).unwrap();
        assert_eq!(plan.active, ["run:a"]);
        fs::remove_dir_all(root).unwrap();
    }
}
