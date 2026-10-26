//! Application use case around the read-only filesystem scanner.
//! Consumers come from stored profiles and owned runs, rather than UI guesses.
use crate::{
    db::DbState,
    domain::artifacts::{ArtifactCatalog, ArtifactConsumer},
    runs::RunManager,
};
use serde_json::Value;
use std::path::PathBuf;
use tauri::State;

pub(crate) fn collect_paths(
    value: &Value,
    id: &str,
    source: &str,
    active: bool,
    output: &mut Vec<ArtifactConsumer>,
) {
    fn add(path: &str, id: &str, source: &str, active: bool, output: &mut Vec<ArtifactConsumer>) {
        if !path.trim().is_empty()
            && !output
                .iter()
                .any(|c| c.id == id && c.path.eq_ignore_ascii_case(path))
        {
            output.push(ArtifactConsumer {
                id: id.into(),
                kind: source.into(),
                path: path.into(),
                active,
            });
        }
    }
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                let key_lower = key.to_ascii_lowercase();
                if [
                    "modelpath",
                    "mmprojpath",
                    "ngrampath",
                    "mtppath",
                    "draftmodelpath",
                    "lorapaths",
                    "legacyPaths",
                    "resolvedModelPaths",
                ]
                .iter()
                .any(|k| k.eq_ignore_ascii_case(&key_lower))
                {
                    if let Some(path) = value.as_str() {
                        add(path, id, source, active, output);
                    }
                    if let Some(paths) = value.as_array() {
                        for path in paths.iter().filter_map(Value::as_str) {
                            add(path, id, source, active, output);
                        }
                    }
                }
                if key_lower == "args" {
                    if let Some(args) = value.as_array() {
                        let flags = [
                            "--model",
                            "-m",
                            "--native",
                            "--mmproj",
                            "--model-draft",
                            "-md",
                            "--ngram",
                            "--ngram-volume",
                            "--mtp-model",
                            "--lora",
                        ];
                        for (index, arg) in args.iter().filter_map(Value::as_str).enumerate() {
                            if flags.contains(&arg) {
                                if let Some(path) = args.get(index + 1).and_then(Value::as_str) {
                                    add(path, id, source, active, output);
                                }
                            } else if let Some((flag, path)) = arg.split_once('=') {
                                if flags.contains(&flag) {
                                    add(path, id, source, active, output);
                                }
                            }
                        }
                    }
                }
                collect_paths(value, id, source, active, output);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_paths(item, id, source, active, output)
            }
        }
        _ => {}
    }
}

#[tauri::command]
pub async fn model_catalog(
    db: State<'_, DbState>,
    manager: State<'_, RunManager>,
) -> Result<ArtifactCatalog, String> {
    let mut roots = crate::db::installation_root()
        .map(|root| vec![root.join("models")])
        .unwrap_or_default();
    let mut consumers = manager.artifact_consumers().await?;
    {
        let conn = db.0.lock().await;
        let profiles = crate::profile_store::ProfileRepository::new(&conn).list()?;
        for profile in profiles {
            collect_paths(
                &serde_json::to_value(&profile).map_err(|e| e.to_string())?,
                &format!("profile:{}", profile.id),
                "profile",
                false,
                &mut consumers,
            );
        }
        for profile in crate::profile_store::recovery::catalog_profiles(&conn)? {
            collect_paths(
                &serde_json::to_value(&profile).map_err(|e| e.to_string())?,
                &format!("recovery:{}:{}", profile.id, profile.revision),
                "recovery",
                false,
                &mut consumers,
            );
        }
        let mut installations = conn
            .prepare("SELECT installed_path FROM model_installations ORDER BY installed_at, id")
            .map_err(|e| format!("Could not read downloaded model installations: {e}"))?;
        let paths = installations
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        roots.extend(
            paths
                .map(|path| path.map(PathBuf::from))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?,
        );
        use rusqlite::OptionalExtension;
        let settings: Option<String> = conn
            .query_row("SELECT value_json FROM kv WHERE key='settings'", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(settings) = settings {
            let settings: Value = serde_json::from_str(&settings).map_err(|e| e.to_string())?;
            if let Some(directories) = settings["modelDirectories"].as_array() {
                roots.extend(
                    directories
                        .iter()
                        .filter_map(Value::as_str)
                        .map(PathBuf::from),
                );
            }
        }
    }
    for consumer in &consumers {
        let path = PathBuf::from(&consumer.path);
        if !roots.iter().any(|root| path.starts_with(root)) {
            roots.push(path);
        }
    }
    roots.sort();
    roots.dedup();
    let scan_consumers = consumers.clone();
    let catalog = tokio::task::spawn_blocking(move || {
        crate::model_artifacts::scan_model_artifacts(&roots, &scan_consumers)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut conn = db.0.lock().await;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // The index is reproducible and replaceable; profile and run data are untouched.
    tx.execute_batch(
        "DELETE FROM artifact_consumers; DELETE FROM artifact_files; DELETE FROM model_artifacts;",
    )
    .map_err(|e| e.to_string())?;
    for artifact in &catalog.artifacts {
        tx.execute(
            "INSERT INTO model_artifacts(id,manifest_json,indexed_at) VALUES(?1,?2,?3)",
            rusqlite::params![
                artifact.id,
                serde_json::to_string(artifact).map_err(|e| e.to_string())?,
                catalog.scanned_at
            ],
        )
        .map_err(|e| e.to_string())?;
        for file in &artifact.files {
            let size =
                i64::try_from(file.size_bytes).map_err(|_| "Artifact is too large for SQLite")?;
            tx.execute("INSERT INTO artifact_files(artifact_id,path,relative_path,role,size_bytes,file_identity,\"exists\") VALUES(?1,?2,?3,?4,?5,?6,?7)",rusqlite::params![artifact.id,file.path,file.relative_path,file.role,size,file.file_identity,file.state != crate::domain::artifacts::ArtifactState::Missing]).map_err(|e|e.to_string())?;
            for id in &file.consumer_ids {
                let consumer = consumers.iter().find(|consumer| consumer.id == *id);
                let source = consumer
                    .map(|c| c.kind.as_str())
                    .unwrap_or("catalog-derived");
                let path = consumer
                    .map(|c| c.path.as_str())
                    .unwrap_or(file.path.as_str());
                tx.execute("INSERT OR IGNORE INTO artifact_consumers(artifact_id,consumer_id,path,source) VALUES(?1,?2,?3,?4)",rusqlite::params![artifact.id,id,path,source]).map_err(|e|e.to_string())?;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(catalog)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_model_paths_become_consumers_and_duplicate_paths_are_collapsed() {
        let mut output = Vec::new();
        collect_paths(
            &serde_json::json!({"launch":{"modelPath":"C:/models/a.gguf","binaryPath":"C:/engines/server.exe","apiKey":"private","args":["--model","C:/models/a.gguf","--mmproj","C:/models/vision.gguf"]},"model":{"legacyPaths":["C:/models/shared-ngram"]}}),
            "run:a",
            "run",
            true,
            &mut output,
        );
        assert_eq!(output.len(), 3);
        assert!(output.iter().all(|c| c.active));
        assert!(!output
            .iter()
            .any(|c| c.path.contains("engines") || c.path.contains("private")));
    }
}
