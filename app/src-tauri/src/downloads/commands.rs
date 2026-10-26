use super::{
    huggingface, DownloadManager, DownloadPlan, DownloadSearchPage, DownloadSelection,
    DownloadTask, ResolvedDownload,
};
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn search_model_downloads(
    query: String,
    engine: String,
    limit: Option<usize>,
    cursor: Option<String>,
    sort: Option<String>,
    all_gguf: Option<bool>,
) -> Result<DownloadSearchPage, String> {
    huggingface::search(
        &query,
        &engine,
        limit,
        cursor.as_deref(),
        sort.as_deref(),
        all_gguf.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn resolve_model_download(source: String) -> Result<ResolvedDownload, String> {
    huggingface::resolve(&source, None).await
}
#[tauri::command]
pub async fn prepare_model_download(
    manager: State<'_, DownloadManager>,
    selection: DownloadSelection,
    destination: String,
) -> Result<DownloadPlan, String> {
    manager.prepare(selection, destination).await
}
#[tauri::command]
pub async fn start_model_download(
    app: AppHandle,
    manager: State<'_, DownloadManager>,
    plan_id: String,
) -> Result<DownloadTask, String> {
    manager.start(&app, &plan_id).await
}
#[tauri::command]
pub async fn list_model_downloads(
    manager: State<'_, DownloadManager>,
) -> Result<Vec<DownloadTask>, String> {
    Ok(manager.list().await)
}
#[tauri::command]
pub async fn get_model_download(
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<DownloadTask, String> {
    manager.get(&id).await
}
#[tauri::command]
pub async fn pause_model_download(
    app: AppHandle,
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<DownloadTask, String> {
    manager.control(&app, &id, "pause").await
}
#[tauri::command]
pub async fn resume_model_download(
    app: AppHandle,
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<DownloadTask, String> {
    manager.control(&app, &id, "resume").await
}
#[tauri::command]
pub async fn cancel_model_download(
    app: AppHandle,
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<DownloadTask, String> {
    manager.control(&app, &id, "cancel").await
}
#[tauri::command]
pub async fn remove_model_download_partial(
    app: AppHandle,
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<DownloadTask, String> {
    manager.control(&app, &id, "remove").await
}
#[tauri::command]
pub fn model_download_destination(engine: Option<String>) -> Result<String, String> {
    let base = crate::db::installation_root()
        .or_else(|| {
            std::env::current_exe()
                .ok()?
                .parent()
                .map(std::path::Path::to_path_buf)
        })
        .ok_or("Cannot locate the application folder")?;
    destination_for_engine(&base, engine.as_deref().unwrap_or("llama_cpp"))
}

fn destination_for_engine(base: &std::path::Path, engine: &str) -> Result<String, String> {
    let folder = match engine {
        "llama_cpp" | "llama.cpp" => "llama",
        "strata" => "strata",
        _ => return Err("Unsupported model download engine".into()),
    };
    Ok(base
        .join("models")
        .join(folder)
        .to_string_lossy()
        .into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destinations_stay_inside_application_and_are_separate_for_each_engine() {
        let root = std::env::temp_dir().join("Aplot");
        for (engine, folder) in [("llama_cpp", "llama"), ("strata", "strata")] {
            assert_eq!(
                std::path::PathBuf::from(destination_for_engine(&root, engine).unwrap()),
                root.join("models").join(folder)
            );
        }
        assert!(destination_for_engine(&root, "../outside").is_err());
    }
}
