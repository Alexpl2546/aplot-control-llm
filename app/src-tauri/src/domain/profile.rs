use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub const PROFILE_FORMAT_VERSION: u32 = 2;

pub const SUPPORTED_ENGINE_IDS: &[&str] = &["llama_cpp", "strata"];

pub fn is_supported_engine(engine: &str) -> bool {
    SUPPORTED_ENGINE_IDS.contains(&engine)
}

pub fn unsupported_engine_error(engine: &str) -> String {
    format!(
        "Engine '{engine}' is no longer supported. Export the legacy profile or select llama.cpp/Strata."
    )
}

pub fn ensure_supported_engine(engine: &str) -> Result<(), String> {
    if is_supported_engine(engine) {
        Ok(())
    } else {
        Err(unsupported_engine_error(engine))
    }
}

pub type JsonObject = Map<String, Value>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEnvelope {
    pub schema_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exported_at: Option<String>,
    pub profile: LaunchProfileV2,
    #[serde(default, flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProfileV2 {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// A string keeps profiles from newer engines loadable by older app builds.
    pub engine: String,
    pub revision: u64,
    #[serde(default)]
    pub model: ModelReference,
    #[serde(default)]
    pub engine_options: EngineOptions,
    /// The original LaunchConfig or imported config object, retained verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_config: Option<Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub secret_references: BTreeMap<String, SecretReference>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    #[serde(default)]
    pub last_known_good: bool,
    #[serde(default, flatten)]
    pub extensions: BTreeMap<String, Value>,
    /// Envelope-level future fields preserved by the repository but never nested
    /// under `profile` when serialized.
    #[serde(skip)]
    pub envelope_extensions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelReference {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub legacy_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_model_id: Option<String>,
    #[serde(default, flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineOptions {
    pub engine: String,
    #[serde(default)]
    pub values: JsonObject,
    #[serde(default, flatten)]
    pub extensions: BTreeMap<String, Value>,
}

impl Default for EngineOptions {
    fn default() -> Self {
        Self {
            engine: "llama_cpp".into(),
            values: JsonObject::new(),
            extensions: BTreeMap::new(),
        }
    }
}

impl EngineOptions {
    pub fn empty(engine: impl Into<String>) -> Self {
        Self {
            engine: engine.into(),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretReference {
    /// `windows-dpapi-v1` is stored in this application's portable data DB.
    /// `legacy-settings-v1` is a compatibility reference to the original kv row.
    pub provider: String,
    pub id: String,
}

impl LaunchProfileV2 {
    pub fn empty(
        id: impl Into<String>,
        name: impl Into<String>,
        engine: impl Into<String>,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        let engine = engine.into();
        Self {
            id: id.into(),
            name: name.into(),
            description: None,
            engine: engine.clone(),
            revision: 1,
            model: ModelReference::default(),
            engine_options: EngineOptions::empty(engine),
            legacy_config: None,
            secret_references: BTreeMap::new(),
            created_at: now.clone(),
            updated_at: now,
            last_used_at: None,
            last_known_good: false,
            extensions: BTreeMap::new(),
            envelope_extensions: BTreeMap::new(),
        }
    }
}
