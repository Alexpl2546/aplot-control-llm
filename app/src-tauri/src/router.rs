use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn reload_router_models(
    endpoint: String,
    api_key: String,
) -> Result<Vec<String>, String> {
    let url = reqwest::Url::parse(&format!(
        "{}/models?reload=1",
        endpoint.trim_end_matches('/')
    ))
    .map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Invalid router endpoint.".into());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(3))
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.get(url);
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    let body: serde_json::Value = request
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let models = body["data"]
        .as_array()
        .ok_or("Router returned an invalid model list.")?;
    Ok(models
        .iter()
        .filter_map(|model| model["id"].as_str().map(str::to_owned))
        .collect())
}

fn preset_path(app: &AppHandle, run_id: Option<&str>) -> Result<PathBuf, String> {
    let mut directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Aplot Control LLM data directory: {error}"))?;
    if let Some(id) = run_id {
        if let Some(root) = crate::db::installation_root() {
            directory = root.join("data");
        }
        if cfg!(debug_assertions) {
            if let Some(test_directory) = std::env::var_os("APLOT_TEST_DATA_DIR") {
                directory = PathBuf::from(test_directory);
            }
        }
        directory = run_directory(&directory, id)?;
    }
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create Aplot Control LLM data directory: {error}"))?;
    Ok(directory.join("router-presets.ini"))
}

fn run_directory(base: &std::path::Path, id: &str) -> Result<PathBuf, String> {
    if id.trim().is_empty() || id.len() > 128 {
        return Err("Invalid router run ID".into());
    }
    // A fixed-length directory name cannot escape the data directory.
    let hash = id
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    let directory = base.join("routers").join(format!("run-{hash:016x}"));
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let owner = directory.join("owner.json");
    let expected = serde_json::to_string(id).map_err(|e| e.to_string())?;
    if owner.exists() {
        if fs::read_to_string(&owner).map_err(|e| e.to_string())? != expected {
            return Err("Router directory belongs to a different run".into());
        }
    } else {
        fs::write(owner, expected).map_err(|e| e.to_string())?;
    }
    Ok(directory)
}

#[tauri::command]
pub fn router_preset_path(app: AppHandle, run_id: Option<String>) -> Result<String, String> {
    Ok(preset_path(&app, run_id.as_deref())?
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
pub async fn write_router_preset(
    app: AppHandle,
    manager: tauri::State<'_, crate::runs::RunManager>,
    preset: String,
    run_id: Option<String>,
) -> Result<String, String> {
    let _lease = if let Some(id) = run_id.as_deref() {
        Some(manager.edit_lease(id).await?)
    } else {
        None
    };
    if preset.trim().is_empty() {
        return Err("The generated router preset is empty.".into());
    }
    if preset.len() > 4 * 1024 * 1024 {
        return Err("The generated router preset is larger than 4 MiB.".into());
    }
    let path = preset_path(&app, run_id.as_deref())?;
    install_preset(&path, &preset)?;
    Ok(path.to_string_lossy().into_owned())
}
fn install_preset(path: &std::path::Path, preset: &str) -> Result<(), String> {
    let temporary_path = path.with_extension(format!("ini.{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary_path, preset)
        .map_err(|error| format!("Could not write router preset: {error}"))?;
    if let Err(error) = fs::rename(&temporary_path, &path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!("Could not install router preset: {error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn router_preset_updates_stay_in_the_target_directory_and_reject_foreign_ownership() {
        let base =
            std::env::temp_dir().join(format!("aplot-router-proof-{}", uuid::Uuid::new_v4()));
        let a = run_directory(&base, "router-a").unwrap();
        let b = run_directory(&base, "../router-b").unwrap();
        assert_ne!(a, b);
        assert!(a.starts_with(base.join("routers")) && b.starts_with(base.join("routers")));
        let ap = a.join("router-presets.ini");
        let bp = b.join("router-presets.ini");
        install_preset(&ap, "[a]\nmodel=a.gguf\n").unwrap();
        install_preset(&bp, "[b]\nmodel=b.gguf\n").unwrap();
        install_preset(&bp, "[b]\nmodel=b-new.gguf\n").unwrap();
        assert_eq!(fs::read_to_string(&ap).unwrap(), "[a]\nmodel=a.gguf\n");
        assert_eq!(fs::read_to_string(&bp).unwrap(), "[b]\nmodel=b-new.gguf\n");
        fs::write(b.join("owner.json"), "\"foreign\"").unwrap();
        assert!(run_directory(&base, "../router-b").is_err());
        assert_eq!(fs::read_to_string(&ap).unwrap(), "[a]\nmodel=a.gguf\n");
        fs::remove_dir_all(base).unwrap();
    }
}
