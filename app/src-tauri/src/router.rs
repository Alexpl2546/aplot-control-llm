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

fn preset_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Aplot Control LLM data directory: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create Aplot Control LLM data directory: {error}"))?;
    Ok(directory.join("router-presets.ini"))
}

#[tauri::command]
pub fn router_preset_path(app: AppHandle) -> Result<String, String> {
    Ok(preset_path(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn write_router_preset(app: AppHandle, preset: String) -> Result<String, String> {
    if preset.trim().is_empty() {
        return Err("The generated router preset is empty.".into());
    }
    if preset.len() > 4 * 1024 * 1024 {
        return Err("The generated router preset is larger than 4 MiB.".into());
    }
    let path = preset_path(&app)?;
    let temporary_path = path.with_extension(format!("ini.{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary_path, preset)
        .map_err(|error| format!("Could not write router preset: {error}"))?;
    if let Err(error) = fs::rename(&temporary_path, &path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!("Could not install router preset: {error}"));
    }
    Ok(path.to_string_lossy().into_owned())
}
