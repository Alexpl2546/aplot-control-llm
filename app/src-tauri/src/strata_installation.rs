//! Publish an updated Aplot-owned Strata runtime as a sibling version directory.
//! Models are never copied or deleted. Old saved paths follow the manifest aliases.
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn plain(path: &str) -> String {
    let path = path.replace('\\', "/");
    let path = if let Some(tail) = path.strip_prefix("//?/UNC/") {
        format!("//{tail}")
    } else {
        path.strip_prefix("//?/").unwrap_or(&path).to_string()
    };
    path.trim_end_matches('/').to_string()
}
pub(crate) fn rebase_path(path: &str, old: &str, new: &str) -> Option<String> {
    let path = plain(path);
    let old = plain(old);
    let prefix = path.get(..old.len())?;
    if !prefix.eq_ignore_ascii_case(&old)
        || (!path[old.len()..].is_empty() && !path[old.len()..].starts_with('/'))
    {
        return None;
    }
    Some(format!("{}{}", plain(new), &path[old.len()..]))
}
fn rebase(value: &mut Value, old: &str, new: &str) {
    match value {
        Value::String(text) => {
            if let Some(next) = rebase_path(text, old, new) {
                *text = next;
            }
        }
        Value::Array(rows) => rows.iter_mut().for_each(|row| rebase(row, old, new)),
        Value::Object(fields) => fields.values_mut().for_each(|row| rebase(row, old, new)),
        _ => {}
    }
}

/// Only installer-owned roots are renamed. A collision leaves both installations intact.
pub(crate) fn publish(root: &Path, version: &str) -> Result<Option<PathBuf>, String> {
    if version.is_empty()
        || version.contains("..")
        || !version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))
    {
        return Err("Invalid Strata engine version".into());
    }
    let Some(parent) = root.parent().filter(|p| {
        p.file_name()
            .is_some_and(|n| n.eq_ignore_ascii_case("strata"))
    }) else {
        return Ok(None);
    };
    let Some(store) = parent.parent() else {
        return Ok(None);
    };
    let manifest_path = store.join("installations.json");
    let marker_path = root.join("aplot-component.json");
    if !marker_path.is_file() || !manifest_path.is_file() {
        return Ok(None);
    }
    let _lease = crate::component_maintenance::lock_store(store)?;
    crate::component_maintenance::check_scope(store, root)?;
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(&manifest_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if manifest["schemaVersion"] != 1 {
        return Err("unsupported-component-manifest".into());
    }
    let old = plain(&root.to_string_lossy());
    let Some(row) = manifest["components"].as_array_mut().and_then(|rows| {
        rows.iter_mut().find(|row| {
            row["id"] == "strata"
                && row["path"]
                    .as_str()
                    .is_some_and(|path| plain(path).eq_ignore_ascii_case(&old))
        })
    }) else {
        return Ok(None);
    };
    if root.file_name().is_some_and(|n| n == version) {
        return Ok(None);
    }
    let target = parent.join(version);
    crate::component_maintenance::check_scope(store, &target)?;
    if target.exists() {
        return Err(format!(
            "The Strata version folder already exists: {}. No installation was overwritten.",
            target.display()
        ));
    }
    let new = plain(&target.to_string_lossy());
    let mut previous = row["previousPaths"].as_array().cloned().unwrap_or_default();
    if !previous.iter().any(|path| {
        path.as_str()
            .is_some_and(|path| plain(path).eq_ignore_ascii_case(&old))
    }) {
        previous.push(Value::String(old.clone()));
    }
    row["previousPaths"] = Value::Array(previous);
    row["path"] = Value::String(new.clone());
    row["version"] = Value::String(version.into());
    let mut edits = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_none_or(|e| e != "json") || !path.is_file() {
            continue;
        }
        crate::component_maintenance::check_scope(store, &path)?;
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if path == marker_path && value["id"] != "strata" {
            return Err("The Strata ownership marker does not match the installation".into());
        }
        rebase(&mut value, &old, &new);
        if path == marker_path {
            value["version"] = Value::String(version.into());
            value["path"] = Value::String(new.clone());
        }
        let updated = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
        edits.push((path.file_name().unwrap().to_owned(), bytes, updated));
    }
    // The Python base lives in the shared component store. Rebase activation
    // scripts too, so opening a terminal in the relocated environment still works.
    for name in [
        ".venv/pyvenv.cfg",
        ".venv/Scripts/activate",
        ".venv/Scripts/activate.bat",
        ".venv/Scripts/Activate.ps1",
    ] {
        let path = root.join(name);
        if !path.is_file() {
            continue;
        }
        crate::component_maintenance::check_scope(store, &path)?;
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        if let Ok(text) = std::str::from_utf8(&bytes) {
            let updated = text
                .replace(&old, &new)
                .replace(&old.replace('/', "\\"), &new.replace('/', "\\"))
                .into_bytes();
            edits.push((std::ffi::OsString::from(name), bytes, updated));
        }
    }
    fs::rename(root, &target)
        .map_err(|e| format!("Could not switch the Strata version folder: {e}"))?;
    let publish = (|| {
        for (file, _, updated) in &edits {
            crate::connection_profiles::atomic_write(&target.join(file), updated)?;
        }
        crate::connection_profiles::atomic_write(
            &manifest_path,
            &serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
        )
    })();
    if let Err(error) = publish {
        let mut failures = Vec::new();
        for (file, original, _) in &edits {
            if let Err(e) = crate::connection_profiles::atomic_write(&target.join(file), original) {
                failures.push(e);
            }
        }
        if let Err(e) = fs::rename(&target, root) {
            failures.push(e.to_string());
        }
        return Err(format!(
            "Could not publish Strata: {error}. Rollback: {}",
            if failures.is_empty() {
                "completed".into()
            } else {
                failures.join("; ")
            }
        ));
    }
    Ok(Some(target))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rebases_only_paths_inside_the_previous_installation() {
        assert_eq!(
            rebase_path(
                r"\\?\C:\App\strata\0.1.50\strata-qwen.json",
                r"C:\App\strata\0.1.50",
                r"C:\App\strata\0.1.55"
            ),
            Some("C:/App/strata/0.1.55/strata-qwen.json".into())
        );
        assert_eq!(
            rebase_path("C:/App/strata/0.1.500/a", "C:/App/strata/0.1.50", "C:/new"),
            None
        );
    }
    #[test]
    fn publishes_a_sibling_version_and_preserves_configurations_and_models() {
        let store =
            std::env::temp_dir().join(format!("aplot-strata-publish-{}", uuid::Uuid::new_v4()));
        let root = store.join("strata/0.1.50");
        fs::create_dir_all(root.join("models")).unwrap();
        fs::write(root.join("models/keep.gguf"), b"weights").unwrap();
        fs::write(
            root.join("aplot-component.json"),
            r#"{"id":"strata","version":"0.1.50"}"#,
        )
        .unwrap();
        fs::write(root.join("strata-qwen.json"),serde_json::json!({"cwd":root,"model":root.join("models/keep.gguf"),"other":"C:/outside.gguf"}).to_string()).unwrap();
        fs::write(store.join("installations.json"),serde_json::json!({"schemaVersion":1,"components":[{"id":"strata","path":root,"version":"0.1.50"},{"id":"codex","path":"C:/codex.exe"}]}).to_string()).unwrap();
        let target = publish(&root, "0.1.55").unwrap().unwrap();
        assert_eq!(target, store.join("strata/0.1.55"));
        assert!(!root.exists());
        assert_eq!(
            fs::read(target.join("models/keep.gguf")).unwrap(),
            b"weights"
        );
        let config: Value =
            serde_json::from_slice(&fs::read(target.join("strata-qwen.json")).unwrap()).unwrap();
        assert_eq!(config["cwd"], plain(&target.to_string_lossy()));
        assert_eq!(config["other"], "C:/outside.gguf");
        let manifest: Value =
            serde_json::from_slice(&fs::read(store.join("installations.json")).unwrap()).unwrap();
        assert_eq!(manifest["components"][0]["version"], "0.1.55");
        assert_eq!(
            manifest["components"][0]["previousPaths"][0],
            plain(&root.to_string_lossy())
        );
        assert_eq!(manifest["components"][1]["path"], "C:/codex.exe");
        fs::create_dir_all(store.join("strata/0.1.56")).unwrap();
        assert!(publish(&target, "0.1.56").is_err());
        assert!(target.exists());
        fs::remove_dir_all(store).unwrap();
    }
}
