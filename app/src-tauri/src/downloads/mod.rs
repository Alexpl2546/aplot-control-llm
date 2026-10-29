pub(crate) mod commands;
mod huggingface;
mod install;
mod manager;
pub(crate) mod paths;
pub(crate) mod repository;
mod transfer;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSearchResult {
    pub repo_id: String,
    pub publisher: String,
    pub repository_url: String,
    pub downloads: u64,
    pub likes: u64,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline_tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    pub gated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameter_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSearchPage {
    pub items: Vec<DownloadSearchResult>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFile {
    pub path: String,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_sha256: Option<String>,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantization: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadVariant {
    pub id: String,
    pub label: String,
    pub files: Vec<String>,
    pub total_bytes: u64,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDownload {
    pub source: String,
    pub repo_id: String,
    pub revision: String,
    pub publisher: String,
    pub repository_url: String,
    pub license_url: String,
    pub files: Vec<DownloadFile>,
    pub variants: Vec<DownloadVariant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSelection {
    pub source: String,
    pub revision: String,
    pub files: Vec<String>,
    /// Only the vision projector, for a model that is already installed.
    #[serde(default)]
    pub vision_only: bool,
}

/// Folder prefix of a projector downloaded for an installed model; it is placed inside the
/// model's own folder and is removed together with the model.
pub const VISION_FOLDER_PREFIX: &str = "aplot-vision-";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPlan {
    pub plan_id: String,
    pub source: String,
    pub repo_id: String,
    pub revision: String,
    pub files: Vec<DownloadFile>,
    pub destination: String,
    pub final_path: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub id: String,
    pub download_id: String,
    pub sequence: u64,
    pub state: String,
    pub plan: DownloadPlan,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bytes_per_second: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<DownloadError>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification: Option<String>,
}

pub(crate) use manager::DownloadManager;

#[cfg(test)]
pub(crate) fn fixture() -> DownloadTask {
    let id = uuid::Uuid::new_v4().to_string();
    let destination = std::env::temp_dir().join(format!("aplot-download-{id}"));
    std::fs::create_dir_all(&destination).unwrap();
    DownloadTask {
        id: id.clone(),
        download_id: id.clone(),
        sequence: 1,
        state: "queued".into(),
        plan: DownloadPlan {
            plan_id: id,
            source: "alice/model".into(),
            repo_id: "alice/model".into(),
            revision: "a".repeat(40),
            files: Vec::new(),
            destination: destination.to_string_lossy().into_owned(),
            final_path: destination.join("installed").to_string_lossy().into_owned(),
            total_bytes: 0,
            available_bytes: u64::MAX,
            warnings: Vec::new(),
        },
        downloaded_bytes: 0,
        total_bytes: 0,
        speed_bytes_per_second: 0.,
        current_file: None,
        error: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        installed_path: None,
        verification: None,
    }
}
