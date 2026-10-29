//! Deleting a downloaded model from the library: every file of the model
//! (all shards) plus the projector, draft and n-gram files kept with it.
//! A file a running server uses blocks the whole removal; saved profiles that
//! point at the model are reported, not changed.
use crate::{
    artifact_service::catalog_sources,
    db::DbState,
    domain::artifacts::{ArtifactCatalog, ArtifactConsumer, ArtifactKind, ArtifactState},
    runs::RunManager,
};
use serde::Serialize;
use std::{
    collections::BTreeSet,
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
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
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
    let mut files = Vec::new();
    let mut shared = Vec::new();
    let mut active = BTreeSet::new();
    let mut profiles = BTreeSet::new();
    for artifact in &artifacts {
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
            let shared_elsewhere = file.file_identity.as_ref().is_some_and(|identity| {
                catalog.artifacts.iter().any(|other| {
                    !artifacts.iter().any(|mine| mine.id == other.id)
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
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files.dedup_by(|a, b| key(&a.path) == key(&b.path));
    Ok(ModelRemovalPlan {
        total_bytes: files.iter().map(|file| file.size_bytes).sum(),
        files,
        active: active.into_iter().collect(),
        profiles: profiles.into_iter().collect(),
        shared,
    })
}

async fn current_plan(
    db: &DbState,
    manager: &RunManager,
    path: &str,
) -> Result<(ModelRemovalPlan, Vec<PathBuf>), String> {
    let (mut roots, consumers) = catalog_sources(db, manager).await?;
    // A model outside the known folders is still found through its own folder.
    if let Some(parent) = Path::new(path).parent() {
        if !roots.iter().any(|root| Path::new(path).starts_with(root)) {
            roots.push(parent.to_path_buf());
        }
    }
    let (scan_roots, scan_consumers) = (roots.clone(), consumers.clone());
    let catalog = tokio::task::spawn_blocking(move || {
        crate::model_artifacts::scan_model_artifacts(&scan_roots, &scan_consumers)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok((plan(&catalog, &consumers, &roots, path)?, roots))
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
        if let Some(parent) = Path::new(&file.path).parent() {
            folders.insert(parent.to_path_buf());
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
