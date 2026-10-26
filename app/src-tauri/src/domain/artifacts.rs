use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactConsumer {
    pub id: String,
    /// Examples: `profile`, `run`, `router-route`, or a local download.
    pub kind: String,
    /// A file path or a directory containing the files consumed by this owner.
    pub path: String,
    #[serde(default)]
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCatalog {
    pub scanned_at: String,
    pub roots: Vec<String>,
    pub logical_bytes: u64,
    pub unique_physical_bytes: u64,
    pub artifacts: Vec<ModelArtifact>,
    pub missing_references: Vec<MissingArtifactReference>,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelArtifact {
    pub id: String,
    pub display_name: String,
    pub kind: ArtifactKind,
    pub state: ArtifactState,
    pub files: Vec<ArtifactFile>,
    pub dependency_ids: Vec<String>,
    pub consumer_ids: Vec<String>,
    pub logical_bytes: u64,
    pub unique_physical_bytes: u64,
    /// This catalogue avoids reading multi-gigabyte model contents. Identity is
    /// based on filesystem metadata and normalized paths, never a content hash.
    pub identity_confidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactKind {
    PrimaryModel,
    Mmproj,
    Ngram,
    Mtp,
    OtherModel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactState {
    Complete,
    Incomplete,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFile {
    pub path: String,
    pub relative_path: String,
    pub role: String,
    pub state: ArtifactState,
    pub size_bytes: u64,
    pub file_identity: Option<String>,
    pub hardlink_aliases: Vec<String>,
    pub consumer_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MissingArtifactReference {
    pub path: String,
    pub consumer_id: String,
    pub consumer_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRemovalPreview {
    pub artifact_id: String,
    pub files: Vec<RemovalPreviewFile>,
    pub protected_file_count: usize,
    pub candidate_file_count: usize,
    pub preview_only: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemovalPreviewFile {
    pub path: String,
    pub size_bytes: u64,
    pub candidate_if_confirmed: bool,
    pub protected_by: Vec<String>,
}
