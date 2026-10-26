//! SQLite repository and v1/raw/v2 profile serialization helpers.
//!
//! The legacy `profiles` commands remain in `profiles.rs`. This repository reads
//! and writes the additive `launch_profiles_v2` table introduced by migrations.rs.

use crate::domain::profile::{
    EngineOptions, LaunchProfileV2, ModelReference, ProfileEnvelope, PROFILE_FORMAT_VERSION,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use tauri::State;

pub const PROFILE_CONFLICT: &str = "Profile revision conflict. Reload the profile before saving.";

/// IPC transports envelope extensions separately; exports keep them at the
/// envelope root rather than accidentally nesting them in the profile.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileIpc {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    envelope_extensions: BTreeMap<String, Value>,
    #[serde(skip_deserializing, default, skip_serializing_if = "Option::is_none")]
    unsupported_engine: Option<String>,
    #[serde(flatten)]
    profile: LaunchProfileV2,
}

#[path = "profile_recovery.rs"]
pub(crate) mod recovery;

impl From<LaunchProfileV2> for ProfileIpc {
    fn from(profile: LaunchProfileV2) -> Self {
        Self {
            envelope_extensions: profile.envelope_extensions.clone(),
            unsupported_engine: (!crate::domain::profile::is_supported_engine(&profile.engine))
                .then(|| profile.engine.clone()),
            profile,
        }
    }
}

impl ProfileIpc {
    fn into_profile(mut self) -> LaunchProfileV2 {
        self.profile.envelope_extensions = self.envelope_extensions;
        self.profile
    }
}

pub struct ProfileRepository<'a> {
    conn: &'a Connection,
}

impl<'a> ProfileRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn list(&self) -> Result<Vec<LaunchProfileV2>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id,revision,envelope_json FROM launch_profiles_v2
                 ORDER BY COALESCE(json_extract(envelope_json, '$.profile.lastUsedAt'), updated_at) DESC, id",
            )
            .map_err(|e| format!("Could not prepare v2 profile list: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            let (id, revision, json) = row.map_err(|e| e.to_string())?;
            let mut envelope = decode_envelope(&json)?;
            validate_row_identity(&envelope.profile, &id, revision)?;
            envelope.profile.envelope_extensions = envelope.extensions;
            Ok(envelope.profile)
        })
        .collect()
    }

    pub fn get(&self, id: &str) -> Result<Option<LaunchProfileV2>, String> {
        let row: Option<(i64, String)> = self
            .conn
            .query_row(
                "SELECT revision,envelope_json FROM launch_profiles_v2 WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        row.map(|(revision, value)| {
            let mut envelope = decode_envelope(&value)?;
            validate_row_identity(&envelope.profile, id, revision)?;
            envelope.profile.envelope_extensions = envelope.extensions;
            Ok(envelope.profile)
        })
        .transpose()
    }

    /// Saves with an expected revision. `None` creates a new profile; `Some(n)`
    /// updates exactly revision n and returns revision n+1.
    pub fn save(
        &self,
        profile: LaunchProfileV2,
        expected_revision: Option<u64>,
    ) -> Result<LaunchProfileV2, String> {
        validate_profile(&profile)?;
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| format!("Could not begin profile save: {e}"))?;
        let current = ProfileRepository::new(&tx).get(&profile.id)?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut profile = profile;
        let revision = match (current.as_ref(), expected_revision) {
            (None, None) => 1,
            (Some(current), Some(expected)) if current.revision == expected => {
                profile.created_at = current.created_at.clone();
                expected
                    .checked_add(1)
                    .ok_or_else(|| "Profile revision overflow".to_string())?
            }
            _ => return Err(PROFILE_CONFLICT.into()),
        };
        let sql_revision = i64::try_from(revision)
            .map_err(|_| "Profile revision exceeds SQLite's integer range".to_string())?;
        let sql_expected_revision = expected_revision
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "Expected profile revision exceeds SQLite's integer range".to_string())?;
        profile.revision = revision;
        profile.updated_at = now;
        if let Some(current) = current {
            // Sanitized editors cannot echo plaintext and may omit unknown keys.
            // Missing/blank credentials retain references; a new nonempty value
            // replaces its vault entry below. Revision checks still precede this.
            if profile.secret_references.is_empty() {
                profile.secret_references = current.secret_references;
            }
            let mut envelope_extensions = current.envelope_extensions;
            envelope_extensions.extend(profile.envelope_extensions);
            profile.envelope_extensions = envelope_extensions;
            let mut extensions = current.engine_options.extensions;
            extensions.extend(profile.engine_options.extensions);
            profile.engine_options.extensions = extensions;
            let current_values = Value::Object(current.engine_options.values);
            let incoming_values = Value::Object(profile.engine_options.values.clone());
            if current.engine == profile.engine
                && options_are_keyed(&current_values) == options_are_keyed(&incoming_values)
            {
                let mut values = current_values;
                merge_json(&mut values, incoming_values);
                profile.engine_options.values = values.as_object().cloned().unwrap_or_default();
            }
        }
        // A nonempty replacement CLI string explicitly replaces the entire
        // encrypted argument string. A blank sanitized editor field retains it.
        let edit_value = serde_json::to_value(&profile).map_err(|e| e.to_string())?;
        profile.secret_references.retain(|path, _| {
            if !path
                .rsplit('/')
                .next()
                .is_some_and(|field| field.eq_ignore_ascii_case("extraArgs"))
            {
                return true;
            }
            let value = edit_value.pointer(path).or_else(|| {
                profile
                    .legacy_config
                    .as_ref()
                    .and_then(|config| config.pointer(path))
            });
            !value.and_then(Value::as_str).is_some_and(|args| {
                !args.is_empty() && !crate::domain::secrets::cli_contains_credentials(args)
            })
        });
        let envelope_extensions = profile.envelope_extensions.clone();
        let mut envelope = ProfileEnvelope {
            schema_version: PROFILE_FORMAT_VERSION,
            exported_at: None,
            profile,
            extensions: envelope_extensions,
        };
        let mut value = serde_json::to_value(&envelope).map_err(|e| e.to_string())?;
        let mut pending_secrets = Vec::new();
        extract_secret_values(&mut value, "", &mut pending_secrets);
        zero_profile_secret_values(&mut envelope.profile);
        for extension in envelope.extensions.values_mut() {
            clear_secret_fields(extension);
        }
        for (path, plaintext) in pending_secrets {
            let result = crate::domain::secrets::store_profile_secret(
                &tx,
                &envelope.profile.id,
                &path,
                &plaintext.0,
            );
            let reference = result?;
            let reference_key = path
                .strip_prefix("/profile")
                .map(str::to_string)
                .unwrap_or_else(|| format!("$envelope{path}"));
            let profile_object = value
                .pointer_mut("/profile")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| "Profile object is invalid".to_string())?;
            let reference_map = profile_object
                .entry("secretReferences".to_string())
                .or_insert_with(|| Value::Object(Default::default()))
                .as_object_mut()
                .ok_or_else(|| "Profile secret reference map is invalid".to_string())?;
            reference_map.insert(
                reference_key,
                serde_json::to_value(reference).map_err(|e| e.to_string())?,
            );
        }
        let mut envelope: ProfileEnvelope = serde_json::from_value(value)
            .map_err(|e| format!("Could not serialize protected profile: {e}"))?;
        envelope.profile.envelope_extensions = envelope.extensions.clone();
        profile = envelope.profile.clone();
        let json = serde_json::to_string(&envelope).map_err(|e| e.to_string())?;

        match expected_revision {
            None => {
                tx
                    .execute(
                        "INSERT INTO launch_profiles_v2(id, revision, envelope_json, created_at, updated_at)
                         VALUES(?1, 1, ?2, ?3, ?4)",
                        params![profile.id, json, profile.created_at, profile.updated_at],
                    )
                    .map_err(|e| {
                        if is_constraint_error(&e) {
                            PROFILE_CONFLICT.into()
                        } else {
                            format!("Could not create v2 profile: {e}")
                        }
                    })?;
            }
            Some(_) => {
                let changed = tx
                    .execute(
                        "UPDATE launch_profiles_v2 SET revision=?1, envelope_json=?2, updated_at=?3
                         WHERE id=?4 AND revision=?5",
                        params![
                            sql_revision,
                            json,
                            profile.updated_at,
                            profile.id,
                            sql_expected_revision
                        ],
                    )
                    .map_err(|e| format!("Could not update v2 profile: {e}"))?;
                if changed != 1 {
                    return Err(PROFILE_CONFLICT.into());
                }
            }
        }
        tx.execute(
            "DELETE FROM profile_secrets
             WHERE profile_id=?1 AND id NOT IN (
               SELECT json_extract(value, '$.id') FROM json_each(?2)
             )",
            params![
                profile.id,
                serde_json::to_string(&profile.secret_references).map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| format!("Could not prune unreferenced profile secrets: {e}"))?;
        tx.commit()
            .map_err(|e| format!("Could not commit profile save: {e}"))?;
        Ok(profile)
    }

    pub fn delete(&self, id: &str, expected_revision: u64) -> Result<(), String> {
        let expected_revision = i64::try_from(expected_revision)
            .map_err(|_| "Expected profile revision exceeds SQLite's integer range".to_string())?;
        let changed = self
            .conn
            .execute(
                "DELETE FROM launch_profiles_v2 WHERE id=?1 AND revision=?2",
                params![id, expected_revision],
            )
            .map_err(|e| format!("Could not delete v2 profile: {e}"))?;
        if changed == 1 {
            Ok(())
        } else {
            Err(PROFILE_CONFLICT.into())
        }
    }

    /// Resolves a fresh launch snapshot without modifying either profile or vault.
    /// A missing/corrupt v2 profile is an error, never a legacy fallback.
    pub fn resolve_launch_config(&self, id: &str) -> Result<Value, String> {
        let profile = self
            .get(id)?
            .ok_or_else(|| "Profile not found".to_string())?;
        crate::domain::profile::ensure_supported_engine(&profile.engine)?;
        let mut config = profile
            .legacy_config
            .clone()
            .unwrap_or_else(|| serde_json::json!({}));
        if !config.is_object() {
            return Err("Profile legacyConfig is not a launch configuration object".into());
        }
        if config
            .get("engineOptions")
            .is_some_and(|value| !value.is_object())
        {
            return Err("Profile legacyConfig.engineOptions is not an object".into());
        }
        let mut values = Value::Object(profile.engine_options.values.clone());
        // Restore legacy locations first; the full v2 snapshot is authoritative.
        for (path, reference) in &profile.secret_references {
            if path.starts_with("$envelope") {
                continue;
            }
            let legacy_path = path.strip_prefix("/legacyConfig").or_else(|| {
                (path.starts_with('/')
                    && !path.starts_with("/engineOptions/values/")
                    && path
                        .rsplit_once('/')
                        .is_some_and(|(parent, _)| config.pointer(parent).is_some()))
                .then_some(path.as_str())
            });
            let option_path = if let Some(path) = path.strip_prefix("/engineOptions/values") {
                Some(path.to_string())
            } else if let Some(path) = path.strip_prefix("/engineOptions/") {
                Some(format!("/{}", path.strip_prefix("values/").unwrap_or(path)))
            } else if !path.starts_with('/') {
                // Early global migrations used a bare field name.
                let field = if profile.engine == "strata" && path == "apiKey" {
                    "strataApiKey"
                } else {
                    path
                };
                let prefix = if values.get(&profile.engine).is_some_and(Value::is_object) {
                    format!("/{}/", escape_pointer(&profile.engine))
                } else {
                    "/".to_string()
                };
                Some(format!("{prefix}{}", escape_pointer(field)))
            } else {
                None
            };
            // Secret refs on non-launch profile extensions stay opaque.
            if legacy_path.is_none() && option_path.is_none() {
                continue;
            }
            if reference.provider == crate::domain::secrets::DPAPI_PROVIDER {
                let stored_path: Option<String> = self.conn.query_row(
                    "SELECT field_path FROM profile_secrets WHERE id=?1 AND profile_id=?2 AND provider=?3",
                    params![reference.id, profile.id, reference.provider], |row| row.get(0),
                ).optional().map_err(|e| e.to_string())?;
                let Some(stored_path) = stored_path else {
                    return Err(
                        "The referenced protected secret does not belong to this profile".into(),
                    );
                };
                if stored_path.starts_with("/profile/")
                    && !path.starts_with("/legacyConfig/")
                    && !path.starts_with("/engineOptions/")
                {
                    continue;
                }
            }
            let plaintext = SecretString(crate::domain::secrets::resolve_secret(
                self.conn, reference,
            )?);
            if let Some(path) = legacy_path {
                insert_credential(&mut config, path, &plaintext.0)?;
            }
            if let Some(path) = option_path {
                insert_credential(&mut values, &path, &plaintext.0)?;
            }
        }
        let object = config.as_object_mut().unwrap();
        let snapshot = normalize_engine_options(values, &profile.engine);
        let original = object
            .remove("engineOptions")
            .unwrap_or_else(|| serde_json::json!({}));
        let mut original = if original.get("engine").is_some() && original.get("values").is_some() {
            normalize_engine_options(original, &profile.engine)
        } else {
            original
        };
        merge_json(&mut original, snapshot);
        object.insert("engineOptions".into(), original);
        object.insert("engine".into(), Value::String(profile.engine));
        object.insert("profileId".into(), Value::String(profile.id));
        object.insert("profileName".into(), Value::String(profile.name));
        Ok(config)
    }
}

fn merge_json(base: &mut Value, update: Value) {
    match (base, update) {
        (Value::Object(base), Value::Object(update)) => {
            for (key, value) in update {
                if let Some(current) = base.get_mut(&key) {
                    merge_json(current, value);
                } else {
                    base.insert(key, value);
                }
            }
        }
        (base, update) => *base = update,
    }
}

fn escape_pointer(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

fn normalize_engine_options(value: Value, engine: &str) -> Value {
    let Some(object) = value.as_object() else {
        return value;
    };
    if let Some(values) = object
        .get("values")
        .filter(|_| object.get("engine").is_some())
    {
        let engine = object
            .get("engine")
            .and_then(Value::as_str)
            .unwrap_or(engine);
        return serde_json::json!({engine: values});
    }
    if object.is_empty()
        || object.get(engine).is_some_and(Value::is_object)
        || options_are_keyed(&value)
    {
        value
    } else {
        serde_json::json!({engine: value})
    }
}

fn options_are_keyed(value: &Value) -> bool {
    ["llama_cpp", "strata", "ollama", "qwfnfer", "infernix"]
        .iter()
        .any(|key| value.get(*key).is_some_and(Value::is_object))
}

/// Only credential leaves may be created. Invalid pointers/types fail closed.
fn insert_credential(root: &mut Value, pointer: &str, secret: &str) -> Result<(), String> {
    let invalid = || "Invalid launch credential reference path".to_string();
    let raw = pointer.strip_prefix('/').ok_or_else(invalid)?;
    let mut keys = Vec::new();
    for key in raw.split('/') {
        let mut decoded = String::new();
        let mut chars = key.chars();
        while let Some(ch) = chars.next() {
            if ch == '~' {
                decoded.push(match chars.next() {
                    Some('0') => '~',
                    Some('1') => '/',
                    _ => return Err(invalid()),
                });
            } else {
                decoded.push(ch);
            }
        }
        keys.push(decoded);
    }
    if !keys.last().is_some_and(|key| {
        crate::domain::secrets::is_secret_value(key, &Value::String(secret.to_string()))
    }) {
        return Err(invalid());
    }
    let (leaf, parents) = keys.split_last().ok_or_else(invalid)?;
    let mut current = root;
    for key in parents {
        current = match current {
            Value::Object(object) => object
                .entry(key.clone())
                .or_insert_with(|| serde_json::json!({})),
            Value::Array(array) => array
                .get_mut(key.parse::<usize>().map_err(|_| invalid())?)
                .ok_or_else(invalid)?,
            _ => return Err(invalid()),
        };
    }
    current
        .as_object_mut()
        .ok_or_else(invalid)?
        .insert(leaf.clone(), Value::String(secret.to_string()));
    Ok(())
}

pub fn parse_profile_import(text: &str) -> Result<ProfileEnvelope, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|e| format!("Invalid profile JSON: {e}"))?;
    let version = value.get("schemaVersion").and_then(Value::as_u64);
    if value.get("schemaVersion").is_some() && version.is_none() {
        return Err("Profile schemaVersion must be a positive integer".into());
    }
    if let Some(version) = version {
        if version > u64::from(PROFILE_FORMAT_VERSION) {
            return Err(format!(
                "Profile format version {version} is newer than supported version {PROFILE_FORMAT_VERSION}"
            ));
        }
        if version == 0 {
            return Err("Profile schemaVersion must be positive".into());
        }
    }

    if version == Some(u64::from(PROFILE_FORMAT_VERSION)) {
        let mut envelope: ProfileEnvelope = serde_json::from_value(value)
            .map_err(|e| format!("Invalid v2 profile envelope: {e}"))?;
        validate_profile(&envelope.profile)?;
        crate::domain::profile::ensure_supported_engine(&envelope.profile.engine)?;
        envelope.profile.envelope_extensions = envelope.extensions.clone();
        return Ok(envelope);
    }

    let is_envelope = value.get("profile").is_some();
    let raw_profile = value.get("profile").cloned().unwrap_or(value.clone());
    let mut profile = convert_legacy_profile(raw_profile)?;
    crate::domain::profile::ensure_supported_engine(&profile.engine)?;
    let mut extensions = BTreeMap::new();
    if is_envelope {
        if let Some(object) = value.as_object() {
            for (key, value) in object {
                if !["schemaVersion", "exportedAt", "profile"].contains(&key.as_str()) {
                    extensions.insert(key.clone(), value.clone());
                }
            }
        }
    }
    profile.envelope_extensions = extensions.clone();
    Ok(ProfileEnvelope {
        schema_version: PROFILE_FORMAT_VERSION,
        exported_at: None,
        profile,
        extensions,
    })
}

pub fn encode_profile_v2(profile: &LaunchProfileV2) -> Result<String, String> {
    export_profile_v2_with_secrets(profile, false)
}

pub fn export_profile_v2_with_secrets(
    profile: &LaunchProfileV2,
    include_secret_values: bool,
) -> Result<String, String> {
    validate_profile(profile)?;
    let mut envelope = ProfileEnvelope {
        schema_version: PROFILE_FORMAT_VERSION,
        exported_at: Some(chrono::Utc::now().to_rfc3339()),
        profile: profile.clone(),
        extensions: profile.envelope_extensions.clone(),
    };
    if !include_secret_values {
        let mut value = serde_json::to_value(&envelope).map_err(|e| e.to_string())?;
        redact_secret_values(&mut value);
        envelope = serde_json::from_value(value).map_err(|e| e.to_string())?;
    }
    serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())
}

/// Removes credential values at any depth while leaving nonsecret profile data
/// and reference metadata intact. Also used by legacy v1 export.
pub fn redact_secret_values(value: &mut Value) {
    match value {
        Value::Object(object) => {
            let keys: Vec<String> = object
                .keys()
                .filter(|key| {
                    object
                        .get(*key)
                        .is_some_and(|value| crate::domain::secrets::is_secret_value(key, value))
                        && !is_secret_reference_container(key)
                })
                .cloned()
                .collect();
            for key in keys {
                object.remove(&key);
            }
            for (key, child) in object.iter_mut() {
                if !is_secret_reference_container(key) {
                    redact_secret_values(child);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_secret_values),
        _ => {}
    }
}

fn is_secret_reference_container(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    normalized.contains("secretref")
}

struct SecretString(String);

impl Drop for SecretString {
    fn drop(&mut self) {
        zero_string(&mut self.0);
    }
}

fn zero_string(value: &mut String) {
    // NUL bytes remain valid UTF-8, so the String stays valid while its backing
    // allocation is wiped before it is released.
    unsafe { value.as_mut_vec().fill(0) };
}

fn extract_secret_values(
    value: &mut Value,
    pointer: &str,
    secrets: &mut Vec<(String, SecretString)>,
) {
    match value {
        Value::Object(object) => {
            let keys = object.keys().cloned().collect::<Vec<_>>();
            for key in keys {
                let child_pointer =
                    format!("{pointer}/{}", key.replace('~', "~0").replace('/', "~1"));
                if object
                    .get(&key)
                    .is_some_and(|value| crate::domain::secrets::is_secret_value(&key, value))
                {
                    if let Some(Value::String(secret)) = object.get_mut(&key) {
                        if !secret.is_empty() {
                            secrets.push((child_pointer, SecretString(secret.clone())));
                        }
                        zero_string(secret);
                        object.remove(&key);
                    } else if let Some(child) = object.get_mut(&key) {
                        extract_secret_values(child, &child_pointer, secrets);
                    }
                } else if let Some(child) = object.get_mut(&key) {
                    extract_secret_values(child, &child_pointer, secrets);
                }
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter_mut().enumerate() {
                extract_secret_values(child, &format!("{pointer}/{index}"), secrets);
            }
        }
        _ => {}
    }
}

fn clear_secret_fields(value: &mut Value) {
    match value {
        Value::Object(object) => {
            let keys = object.keys().cloned().collect::<Vec<_>>();
            for key in keys {
                if object
                    .get(&key)
                    .is_some_and(|value| crate::domain::secrets::is_secret_value(&key, value))
                {
                    if let Some(Value::String(secret)) = object.get_mut(&key) {
                        zero_string(secret);
                        object.remove(&key);
                    } else if let Some(child) = object.get_mut(&key) {
                        clear_secret_fields(child);
                    }
                } else if let Some(child) = object.get_mut(&key) {
                    clear_secret_fields(child);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(clear_secret_fields),
        _ => {}
    }
}

fn clear_btree_secret_fields(map: &mut BTreeMap<String, Value>) {
    let keys = map.keys().cloned().collect::<Vec<_>>();
    for key in keys {
        if map
            .get(&key)
            .is_some_and(|value| crate::domain::secrets::is_secret_value(&key, value))
        {
            if let Some(Value::String(secret)) = map.get_mut(&key) {
                zero_string(secret);
                map.remove(&key);
            } else if let Some(child) = map.get_mut(&key) {
                clear_secret_fields(child);
            }
        } else if let Some(child) = map.get_mut(&key) {
            clear_secret_fields(child);
        }
    }
}

fn zero_profile_secret_values(profile: &mut LaunchProfileV2) {
    if let Some(config) = profile.legacy_config.as_mut() {
        clear_secret_fields(config);
    }
    let mut options = Value::Object(std::mem::take(&mut profile.engine_options.values));
    clear_secret_fields(&mut options);
    profile.engine_options.values = options.as_object().cloned().unwrap_or_default();
    clear_btree_secret_fields(&mut profile.engine_options.extensions);
    clear_btree_secret_fields(&mut profile.model.extensions);
    clear_btree_secret_fields(&mut profile.extensions);
    clear_btree_secret_fields(&mut profile.envelope_extensions);
}

fn convert_legacy_profile(value: Value) -> Result<LaunchProfileV2, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Imported profile must be a JSON object".to_string())?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Imported profile has no id".to_string())?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Imported profile has no name".to_string())?;
    let config = object
        .get("config")
        .cloned()
        .ok_or_else(|| "Imported profile has no config".to_string())?;
    if !config.is_object() {
        return Err("Imported profile config must be a JSON object".into());
    }
    let engine = config
        .get("engine")
        .and_then(Value::as_str)
        .filter(|engine| !engine.trim().is_empty())
        .unwrap_or("unknown");
    let now = chrono::Utc::now().to_rfc3339();
    let mut profile = LaunchProfileV2::empty(id, name, engine);
    profile.description = object
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_string);
    profile.revision = 1;
    profile.model = model_reference_from_config(&config);
    profile.engine_options = engine_options_from_config(&config, engine);
    profile.legacy_config = Some(config);
    profile.created_at = object
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or(&now)
        .to_string();
    profile.updated_at = object
        .get("updatedAt")
        .and_then(Value::as_str)
        .unwrap_or(&now)
        .to_string();
    profile.last_used_at = object
        .get("lastUsedAt")
        .and_then(Value::as_str)
        .map(str::to_string);
    profile.last_known_good = object
        .get("lastKnownGood")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    for (key, value) in object {
        if ![
            "id",
            "name",
            "description",
            "config",
            "createdAt",
            "updatedAt",
            "lastUsedAt",
            "lastKnownGood",
        ]
        .contains(&key.as_str())
        {
            profile.extensions.insert(key.clone(), value.clone());
        }
    }
    Ok(profile)
}

fn model_reference_from_config(config: &Value) -> ModelReference {
    let mut paths = Vec::new();
    let option_values = config
        .get("engineOptions")
        .and_then(Value::as_object)
        .and_then(|options| options.get("values").and_then(Value::as_object));
    for key in ["modelPath", "mmprojPath", "ngramPath", "mtpPath"] {
        for source in [config.as_object(), option_values] {
            if let Some(path) = source
                .and_then(|object| object.get(key))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                if !paths.iter().any(|existing| existing == path) {
                    paths.push(path.to_string());
                }
            }
        }
    }
    if let Some(lora_paths) = config.get("loraPaths").and_then(Value::as_array) {
        paths.extend(
            lora_paths
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string),
        );
    }
    if let Some(lora_paths) = option_values
        .and_then(|options| options.get("loraPaths"))
        .and_then(Value::as_array)
    {
        paths.extend(
            lora_paths
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string),
        );
    }
    ModelReference {
        artifact_id: None,
        legacy_paths: paths,
        engine_model_id: config
            .get("engineModel")
            .and_then(Value::as_str)
            .map(str::to_string),
        extensions: BTreeMap::new(),
    }
}

fn engine_options_from_config(config: &Value, engine: &str) -> EngineOptions {
    let options = config.get("engineOptions").and_then(Value::as_object);
    let values = options
        .and_then(|options| options.get("values"))
        .and_then(Value::as_object)
        .cloned()
        .or_else(|| options.cloned())
        .unwrap_or_default();
    EngineOptions {
        engine: engine.to_string(),
        values,
        extensions: BTreeMap::new(),
    }
}

fn validate_profile(profile: &LaunchProfileV2) -> Result<(), String> {
    if profile.id.trim().is_empty() {
        return Err("Profile id cannot be empty".into());
    }
    if profile.name.trim().is_empty() {
        return Err("Profile name cannot be empty".into());
    }
    if profile.engine.trim().is_empty() {
        return Err("Profile engine cannot be empty".into());
    }
    if profile.engine_options.engine != profile.engine {
        return Err("Profile engine and engineOptions.engine must match".into());
    }
    if profile.revision == 0 {
        return Err("Profile revision must be positive".into());
    }
    if profile
        .legacy_config
        .as_ref()
        .is_some_and(|value| !value.is_object())
    {
        return Err("Profile legacyConfig must be a JSON object".into());
    }
    Ok(())
}

fn decode_envelope(json: &str) -> Result<ProfileEnvelope, String> {
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("Stored profile JSON is invalid: {e}"))?;
    let version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Stored profile has no schemaVersion".to_string())?;
    if version > u64::from(PROFILE_FORMAT_VERSION) {
        return Err(format!(
            "Stored profile format version {version} is newer than supported version {PROFILE_FORMAT_VERSION}"
        ));
    }
    if version != u64::from(PROFILE_FORMAT_VERSION) {
        return Err(format!(
            "Stored profile has unsupported schemaVersion {version}"
        ));
    }
    let envelope: ProfileEnvelope =
        serde_json::from_value(value).map_err(|e| format!("Stored v2 profile is invalid: {e}"))?;
    validate_profile(&envelope.profile)?;
    Ok(envelope)
}

fn validate_row_identity(profile: &LaunchProfileV2, id: &str, revision: i64) -> Result<(), String> {
    if profile.id != id || i64::try_from(profile.revision).ok() != Some(revision) {
        return Err("Stored v2 profile identity/revision does not match its SQLite row".into());
    }
    Ok(())
}

fn is_constraint_error(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

#[tauri::command]
pub async fn list_profiles_v2(
    db: State<'_, crate::db::DbState>,
) -> Result<Vec<ProfileIpc>, String> {
    let conn = db.0.lock().await;
    Ok(ProfileRepository::new(&conn)
        .list()?
        .into_iter()
        .map(ProfileIpc::from)
        .collect())
}

#[tauri::command]
pub async fn get_profile_v2(
    db: State<'_, crate::db::DbState>,
    id: String,
) -> Result<Option<ProfileIpc>, String> {
    let conn = db.0.lock().await;
    Ok(ProfileRepository::new(&conn)
        .get(&id)?
        .map(ProfileIpc::from))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn save_profile_v2(
    db: State<'_, crate::db::DbState>,
    profile: ProfileIpc,
    expected_revision: Option<u64>,
) -> Result<ProfileIpc, String> {
    let conn = db.0.lock().await;
    crate::domain::profile::ensure_supported_engine(&profile.profile.engine)?;
    Ok(ProfileRepository::new(&conn)
        .save(profile.into_profile(), expected_revision)?
        .into())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn delete_profile_v2(
    db: State<'_, crate::db::DbState>,
    id: String,
    expected_revision: u64,
) -> Result<(), String> {
    let conn = db.0.lock().await;
    ProfileRepository::new(&conn).delete(&id, expected_revision)
}

#[tauri::command]
pub async fn import_profile_v2(
    db: State<'_, crate::db::DbState>,
    profile_json: String,
) -> Result<ProfileIpc, String> {
    let mut envelope = parse_profile_import(&profile_json)?;
    let conn = db.0.lock().await;
    let repository = ProfileRepository::new(&conn);
    if repository.get(&envelope.profile.id)?.is_some() {
        envelope.profile.id = format!("{}-{}", envelope.profile.id, uuid::Uuid::new_v4());
        envelope.profile.name = format!("{} (Imported)", envelope.profile.name);
        if let Some(config) = envelope
            .profile
            .legacy_config
            .as_mut()
            .and_then(Value::as_object_mut)
        {
            if config.contains_key("profileId") {
                config.insert(
                    "profileId".into(),
                    Value::String(envelope.profile.id.clone()),
                );
            }
            if config.contains_key("profileName") {
                config.insert(
                    "profileName".into(),
                    Value::String(envelope.profile.name.clone()),
                );
            }
        }
    }
    let now = chrono::Utc::now().to_rfc3339();
    envelope.profile.revision = 1;
    envelope.profile.created_at = now.clone();
    envelope.profile.updated_at = now;
    envelope.profile.last_used_at = None;
    envelope.profile.last_known_good = false;
    Ok(repository.save(envelope.profile, None)?.into())
}

#[tauri::command]
pub async fn resolve_profile_launch_config(
    db: State<'_, crate::db::DbState>,
    id: String,
) -> Result<Value, String> {
    let conn = db.0.lock().await;
    ProfileRepository::new(&conn).resolve_launch_config(&id)
}

#[tauri::command]
pub async fn export_profile_v2(
    db: State<'_, crate::db::DbState>,
    id: String,
) -> Result<String, String> {
    let conn = db.0.lock().await;
    let profile = ProfileRepository::new(&conn)
        .get(&id)?
        .ok_or_else(|| "Profile not found".to_string())?;
    encode_profile_v2(&profile)
}

#[tauri::command]
pub async fn import_profile_file_v2(
    db: State<'_, crate::db::DbState>,
    path: String,
) -> Result<ProfileIpc, String> {
    use std::io::Read;
    const MAX_PROFILE_BYTES: u64 = 8 * 1024 * 1024;
    let file =
        std::fs::File::open(path).map_err(|e| format!("Could not read profile file: {e}"))?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_PROFILE_BYTES {
        return Err("Profile file exceeds the 8 MiB JSON limit".into());
    }
    let mut text = String::new();
    file.take(MAX_PROFILE_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|e| format!("Could not read profile JSON: {e}"))?;
    if text.len() as u64 > MAX_PROFILE_BYTES {
        return Err("Profile file exceeds the 8 MiB JSON limit".into());
    }
    import_profile_v2(db, text).await
}

#[tauri::command]
pub async fn export_profile_file_v2(
    db: State<'_, crate::db::DbState>,
    id: String,
    path: String,
) -> Result<(), String> {
    let json = export_profile_v2(db, id).await?;
    if !std::path::Path::new(&path)
        .extension()
        .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("json"))
    {
        return Err("Export profiles to a .json file".into());
    }
    std::fs::write(path, json).map_err(|e| format!("Could not write profile export: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations;
    use rusqlite::Connection;
    use serde_json::json;

    fn migrated_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE profiles(
               id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, config_json TEXT NOT NULL,
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT,
               last_known_good INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE kv(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);",
        ).unwrap();
        migrations::migrate(&mut conn).unwrap();
        conn
    }

    #[test]
    fn ipc_roundtrip_retains_envelope_extensions_without_nesting_in_export() {
        let conn = migrated_db();
        let mut profile = LaunchProfileV2::empty("ipc", "IPC", "llama_cpp");
        profile
            .envelope_extensions
            .insert("futureEnvelope".into(), json!({"kept": 1}));
        profile
            .extensions
            .insert("futureProfile".into(), json!([2]));
        let ipc = serde_json::to_value(ProfileIpc::from(profile)).unwrap();
        assert_eq!(ipc["envelopeExtensions"]["futureEnvelope"]["kept"], 1);
        let profile = serde_json::from_value::<ProfileIpc>(ipc)
            .unwrap()
            .into_profile();
        let saved = ProfileRepository::new(&conn).save(profile, None).unwrap();
        let exported: Value = serde_json::from_str(&encode_profile_v2(&saved).unwrap()).unwrap();
        assert_eq!(exported["futureEnvelope"]["kept"], 1);
        assert_eq!(exported["profile"]["futureProfile"][0], 2);
        assert!(exported["profile"].get("envelopeExtensions").is_none());
    }

    #[test]
    fn invalid_v2_never_falls_back_to_legacy_config() {
        let conn = migrated_db();
        conn.execute(
            "INSERT INTO profiles VALUES('bad','Legacy',NULL,'{}','a','b',NULL,0)",
            [],
        )
        .unwrap();
        let repository = ProfileRepository::new(&conn);
        repository
            .save(LaunchProfileV2::empty("bad", "Bad", "llama_cpp"), None)
            .unwrap();
        conn.execute(
            "UPDATE launch_profiles_v2 SET envelope_json='not-json' WHERE id='bad'",
            [],
        )
        .unwrap();
        assert!(repository
            .resolve_launch_config("bad")
            .unwrap_err()
            .contains("invalid"));
        let invalid = ProfileEnvelope {
            schema_version: 2,
            exported_at: None,
            profile: LaunchProfileV2::empty("other", "Other", "llama_cpp"),
            extensions: BTreeMap::new(),
        };
        conn.execute(
            "UPDATE launch_profiles_v2 SET envelope_json=?1 WHERE id='bad'",
            [serde_json::to_string(&invalid).unwrap()],
        )
        .unwrap();
        assert!(repository
            .resolve_launch_config("bad")
            .unwrap_err()
            .contains("does not match"));
        assert!(parse_profile_import(
            r#"{"schemaVersion":"2","profile":{"id":"bad","name":"Bad","config":{}}}"#
        )
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn resolve_dpapi_credentials_is_immutable_and_keeps_full_engine_snapshot() {
        let conn = migrated_db();
        let repository = ProfileRepository::new(&conn);
        let mut profile = LaunchProfileV2::empty("launch", "Launch", "strata");
        profile.legacy_config = Some(json!({
            "apiKey": "root-credential", "future/escape~": {"accessToken":"nested-credential"},
            "engineOptions":{"strata":{"strataApiKey":"engine-credential", "futureKnob":{"x":1}},
                "infernix":{"context":131072,"newKnob":3}}, "unknownLaunch":[1,2]
        }));
        profile.engine_options.values =
            json!({"strataApiKey":"engine-credential","futureKnob":{"x":1}})
                .as_object()
                .unwrap()
                .clone();
        let mut saved = repository.save(profile, None).unwrap();
        saved.name = "Edited".into();
        saved
            .legacy_config
            .as_mut()
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("apiKey".into(), json!(""));
        saved
            .engine_options
            .values
            .insert("strataApiKey".into(), json!(""));
        let saved = repository.save(saved, Some(1)).unwrap();
        let before: String = conn
            .query_row(
                "SELECT envelope_json FROM launch_profiles_v2 WHERE id='launch'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let launch = repository.resolve_launch_config("launch").unwrap();
        assert_eq!(launch["apiKey"], "root-credential");
        assert_eq!(launch["future/escape~"]["accessToken"], "nested-credential");
        assert_eq!(
            launch["engineOptions"]["strata"]["strataApiKey"],
            "engine-credential"
        );
        assert_eq!(launch["engineOptions"]["strata"]["futureKnob"]["x"], 1);
        assert_eq!(launch["engineOptions"]["infernix"]["context"], 131072);
        assert_eq!(launch["profileName"], "Edited");
        let after: String = conn
            .query_row(
                "SELECT envelope_json FROM launch_profiles_v2 WHERE id='launch'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(before, after);
        for credential in ["root-credential", "engine-credential", "nested-credential"] {
            assert!(!before.contains(credential));
            assert!(!encode_profile_v2(&saved).unwrap().contains(credential));
        }
        let mut foreign = saved;
        foreign.id = "foreign".into();
        repository.save(foreign, None).unwrap();
        assert!(repository
            .resolve_launch_config("foreign")
            .unwrap_err()
            .contains("does not belong"));
    }

    #[cfg(windows)]
    #[test]
    fn cli_credentials_are_protected_as_a_complete_argument_string() {
        let conn = migrated_db();
        let repository = ProfileRepository::new(&conn);
        let mut profile = LaunchProfileV2::empty("cli", "CLI", "llama_cpp");
        let cli = r#"--api-key "quoted credential" --token=opaque-token --ctx-size 8192"#;
        profile.legacy_config = Some(json!({"extraArgs":cli}));
        profile
            .engine_options
            .values
            .insert("extraArgs".into(), json!(cli));
        let saved = repository.save(profile, None).unwrap();
        let stored: String = conn
            .query_row(
                "SELECT envelope_json FROM launch_profiles_v2 WHERE id='cli'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!stored.contains("quoted credential") && !stored.contains("opaque-token"));
        assert_eq!(saved.secret_references.len(), 2);
        let launch = repository.resolve_launch_config("cli").unwrap();
        assert_eq!(launch["extraArgs"], cli);
        assert_eq!(launch["engineOptions"]["llama_cpp"]["extraArgs"], cli);
        assert!(!encode_profile_v2(&saved).unwrap().contains("opaque-token"));
        let mut edited = saved;
        edited.legacy_config.as_mut().unwrap()["extraArgs"] = json!("--n-predict 16");
        let edited = repository.save(edited, Some(1)).unwrap();
        assert!(!edited
            .secret_references
            .contains_key("/legacyConfig/extraArgs"));
        assert_eq!(
            repository.resolve_launch_config("cli").unwrap()["extraArgs"],
            "--n-predict 16"
        );
        let mut ordinary = LaunchProfileV2::empty("plain-cli", "Plain CLI", "llama_cpp");
        ordinary.legacy_config = Some(json!({"extraArgs":"--cache-type-k q8_0 --n-predict 32"}));
        let saved = repository.save(ordinary, None).unwrap();
        assert!(saved.secret_references.is_empty());
        assert!(encode_profile_v2(&saved)
            .unwrap()
            .contains("--cache-type-k"));
    }

    #[test]
    fn supported_legacy_imports_preserve_fields_and_retired_engines_are_rejected() {
        let v1 = json!({
            "schemaVersion":1,"exportedAt":"then",
            "profile":{"id":"v1-id","name":"V1","description":"old","createdAt":"a","updatedAt":"b","lastKnownGood":true,
              "config":{"engine":"llama_cpp","profileId":"v1-id","mtpPath":"E:/mtp.gguf","futureLaunchField":{"k":2}}}
        });
        let imported = parse_profile_import(&v1.to_string()).unwrap();
        assert_eq!(imported.profile.id, "v1-id");
        assert_eq!(imported.profile.engine, "llama_cpp");
        assert_eq!(
            imported.profile.legacy_config.as_ref().unwrap()["futureLaunchField"]["k"],
            2
        );
        assert_eq!(imported.profile.model.legacy_paths, vec!["E:/mtp.gguf"]);
        assert!(imported.profile.last_known_good);

        let raw =
            json!({"id":"raw-id","name":"Raw","config":{"engine":"strata","unknownOption":true}});
        let imported = parse_profile_import(&raw.to_string()).unwrap();
        assert_eq!(imported.profile.id, "raw-id");
        assert_eq!(
            imported.profile.legacy_config.as_ref().unwrap()["unknownOption"],
            true
        );
        let retired =
            json!({"id":"old-id","name":"Old","config":{"engine":"ollama","model":"old-model"}});
        assert!(parse_profile_import(&retired.to_string())
            .unwrap_err()
            .contains("ollama"));
        let missing_engine =
            json!({"id":"missing-engine","name":"Old","config":{"modelPath":"C:/model.gguf"}});
        assert!(parse_profile_import(&missing_engine.to_string())
            .unwrap_err()
            .contains("unknown"));
    }

    #[test]
    fn v2_round_trip_retains_revision_engine_fields_unknowns_and_refs() {
        let input = json!({
          "schemaVersion":2,"topLevelFuture":{"value":12},
          "profile":{"id":"v2-id","name":"V2","engine":"strata","revision":7,
            "model":{"legacyPaths":["E:/model.gguf"],"newModelField":"keep"},
            "engineOptions":{"engine":"strata","values":{"ngramPath":"E:/ngram","concurrency":3,"newTuning":{"a":1}},"futureEngineOption":9},
            "legacyConfig":{"engine":"strata","modelPath":"E:/model.gguf","futureConfig":{"x":1}},
            "secretReferences":{"apiKey":{"provider":"windows-dpapi-v1","id":"opaque-ref"}},
            "createdAt":"created","updatedAt":"updated","futureProfileField":[1,2]}
        });
        let parsed = parse_profile_import(&input.to_string()).unwrap();
        let encoded = export_profile_v2_with_secrets(&parsed.profile, true).unwrap();
        let output: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(output["profile"]["revision"], 7);
        assert_eq!(
            output["profile"]["engineOptions"]["values"]["newTuning"]["a"],
            1
        );
        assert_eq!(output["profile"]["engineOptions"]["futureEngineOption"], 9);
        assert_eq!(output["profile"]["futureProfileField"][1], 2);
        assert_eq!(output["topLevelFuture"]["value"], 12);
        assert_eq!(
            output["profile"]["secretReferences"]["apiKey"]["id"],
            "opaque-ref"
        );
    }

    #[test]
    fn retired_profiles_remain_exportable_but_cannot_launch_or_be_imported() {
        let conn = migrated_db();
        let repository = ProfileRepository::new(&conn);
        let mut legacy = LaunchProfileV2::empty("old", "Old Ollama", "ollama");
        legacy.legacy_config = Some(json!({
            "engine":"ollama",
            "model":"user-model",
            "endpoint":"http://127.0.0.1:11434",
            "futureField":{"kept":true}
        }));
        let saved = repository.save(legacy, None).unwrap();

        assert!(repository
            .resolve_launch_config("old")
            .unwrap_err()
            .contains("ollama"));
        let ipc = ProfileIpc::from(saved.clone());
        assert_eq!(ipc.unsupported_engine.as_deref(), Some("ollama"));
        let exported = encode_profile_v2(&saved).unwrap();
        let json: Value = serde_json::from_str(&exported).unwrap();
        assert_eq!(json["profile"]["engine"], "ollama");
        assert_eq!(json["profile"]["legacyConfig"]["futureField"]["kept"], true);
        assert!(parse_profile_import(&exported)
            .unwrap_err()
            .contains("ollama"));
    }

    #[test]
    fn rejects_newer_profile_formats_without_downgrading_them() {
        let future = json!({"schemaVersion":3,"profile":{"id":"future"}});
        let error = parse_profile_import(&future.to_string()).unwrap_err();
        assert!(error.contains("newer than supported"));
    }

    #[test]
    fn optimistic_revision_conflicts_and_successful_updates_increment_once() {
        let conn = migrated_db();
        let repository = ProfileRepository::new(&conn);
        let profile = LaunchProfileV2::empty("revision-id", "Revision", "llama_cpp");
        let created = repository.save(profile, None).unwrap();
        assert_eq!(created.revision, 1);
        let mut changed = created.clone();
        changed.name = "Updated".into();
        let updated = repository.save(changed.clone(), Some(1)).unwrap();
        assert_eq!(updated.revision, 2);
        assert!(repository
            .save(changed, Some(1))
            .unwrap_err()
            .contains("revision conflict"));
        assert_eq!(repository.get("revision-id").unwrap().unwrap().revision, 2);
        assert!(repository
            .delete("revision-id", 1)
            .unwrap_err()
            .contains("revision conflict"));
        repository.delete("revision-id", 2).unwrap();
        assert!(repository.get("revision-id").unwrap().is_none());
    }

    #[test]
    fn export_removes_nested_secret_values_but_keeps_portable_references() {
        let mut profile = LaunchProfileV2::empty("secret-id", "Secret", "strata");
        profile.legacy_config = Some(
            json!({"strataApiKey":"never-export","nested":{"authorization":"Bearer never","safe":"keep"}}),
        );
        profile.engine_options.values = json!({"apiKey":"also-never","context":4096})
            .as_object()
            .unwrap()
            .clone();
        profile.secret_references.insert(
            "apiKey".into(),
            crate::domain::profile::SecretReference {
                provider: "windows-dpapi-v1".into(),
                id: "opaque-reference".into(),
            },
        );
        let exported = encode_profile_v2(&profile).unwrap();
        assert!(!exported.contains("never-export"));
        assert!(!exported.contains("also-never"));
        assert!(!exported.contains("Bearer never"));
        assert!(exported.contains("opaque-reference"));
        assert!(exported.contains("keep"));
    }

    #[cfg(windows)]
    #[test]
    fn save_wraps_profile_secrets_and_preserves_references_on_later_edits() {
        let conn = migrated_db();
        let repository = ProfileRepository::new(&conn);
        let mut profile = LaunchProfileV2::empty("protected-id", "Protected", "strata");
        profile.legacy_config = Some(json!({
            "strataApiKey": "profile-secret-value",
            "nested": { "authorization": "Bearer profile-secret-value" }
        }));
        profile.engine_options.values = json!({ "apiKey": "engine-secret-value" })
            .as_object()
            .unwrap()
            .clone();

        let created = repository.save(profile, None).unwrap();
        let persisted = repository.get("protected-id").unwrap().unwrap();
        let encoded = encode_profile_v2(&persisted).unwrap();
        assert!(!encoded.contains("profile-secret-value"));
        assert!(!encoded.contains("engine-secret-value"));
        assert_eq!(persisted.secret_references.len(), 3);
        for reference in persisted.secret_references.values() {
            assert_eq!(reference.provider, crate::domain::secrets::DPAPI_PROVIDER);
            assert!(!crate::domain::secrets::resolve_secret(&conn, reference)
                .unwrap()
                .is_empty());
        }

        let mut edited = created;
        edited.description = Some("keep references while no secret value is resubmitted".into());
        let edited = repository.save(edited, Some(1)).unwrap();
        assert_eq!(edited.secret_references, persisted.secret_references);
        for reference in edited.secret_references.values() {
            assert!(crate::domain::secrets::resolve_secret(&conn, reference).is_ok());
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn save_fails_closed_for_new_plaintext_secrets_off_windows() {
        let conn = migrated_db();
        let repository = ProfileRepository::new(&conn);
        let mut profile = LaunchProfileV2::empty("no-plaintext-id", "No plaintext", "strata");
        profile.legacy_config = Some(json!({ "strataApiKey": "must-not-be-stored" }));

        let error = repository.save(profile, None).unwrap_err();
        assert!(error.contains("require Windows DPAPI"));
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM launch_profiles_v2 WHERE id='no-plaintext-id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "failed save must roll back the profile row");
    }

    #[test]
    fn migrated_global_secret_is_a_reference_and_not_in_v2_profile_or_export() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE profiles(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, config_json TEXT NOT NULL,
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT, last_known_good INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE kv(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);",
        ).unwrap();
        let settings = json!({"strataRootPath":"E:/strata","strataConfigPath":"","strataHost":"127.0.0.1","strataPort":8080,"strataApiKey":"do-not-leak"});
        conn.execute(
            "INSERT INTO kv VALUES('settings',?1,'now')",
            [settings.to_string()],
        )
        .unwrap();
        migrations::migrate(&mut conn).unwrap();
        let profile = ProfileRepository::new(&conn)
            .get("legacy-global-strata")
            .unwrap()
            .unwrap();
        assert_eq!(
            profile.secret_references["apiKey"].provider,
            if cfg!(windows) {
                "windows-dpapi-v1"
            } else {
                "legacy-settings-v1"
            }
        );
        let exported = encode_profile_v2(&profile).unwrap();
        assert!(!exported.contains("do-not-leak"));
        let settings_after: String = conn
            .query_row("SELECT value_json FROM kv WHERE key='settings'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(
            settings_after.contains("do-not-leak"),
            "legacy settings remain untouched for recovery"
        );
        #[cfg(windows)]
        {
            let ciphertext: Vec<u8> = conn.query_row("SELECT ciphertext FROM profile_secrets WHERE profile_id='legacy-global-strata'", [], |r| r.get(0)).unwrap();
            assert!(!ciphertext
                .windows("do-not-leak".len())
                .any(|window| window == b"do-not-leak"));
            assert_eq!(
                crate::domain::secrets::resolve_secret(&conn, &profile.secret_references["apiKey"])
                    .unwrap(),
                "do-not-leak"
            );
        }
    }
}
