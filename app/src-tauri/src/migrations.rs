//! Additive, transactional SQLite migrations for the v2 profile and artifact stores.

use crate::domain::profile::{
    EngineOptions, LaunchProfileV2, ModelReference, ProfileEnvelope, PROFILE_FORMAT_VERSION,
};
use crate::domain::secrets;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub const LATEST_MIGRATION: i64 = 2;

/// Applies pending app-owned migrations without rewriting any legacy table or row.
/// Call this after the existing `profiles` and `kv` tables have been initialized.
pub fn migrate(conn: &mut Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_schema_migrations (
           version INTEGER PRIMARY KEY,
           applied_at TEXT NOT NULL
         );",
    )
    .map_err(|e| format!("Could not prepare migration journal: {e}"))?;

    let version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM app_schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if version > LATEST_MIGRATION {
        return Err(format!(
            "Database schema version {version} is newer than this app supports ({LATEST_MIGRATION})"
        ));
    }

    if version < 1 {
        migrate_v1(conn)?;
    }
    if version < 2 {
        migrate_v2(conn)?;
    }
    Ok(())
}

/// Takes a repeat-safe, append-only snapshot of raw engine settings and recovery
/// records before later engine-scope migrations can sanitize their live view.
fn migrate_v2(conn: &mut Connection) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("Could not begin engine-scope archive migration: {e}"))?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS engine_scope_legacy_state (
           key TEXT PRIMARY KEY,
           raw_json TEXT NOT NULL,
           source_updated_at TEXT NOT NULL,
           captured_at TEXT NOT NULL
         );
         CREATE TRIGGER IF NOT EXISTS engine_scope_legacy_state_no_update
         BEFORE UPDATE ON engine_scope_legacy_state
         BEGIN SELECT RAISE(ABORT, 'legacy engine state is append-only'); END;
         CREATE TRIGGER IF NOT EXISTS engine_scope_legacy_state_no_delete
         BEFORE DELETE ON engine_scope_legacy_state
         BEGIN SELECT RAISE(ABORT, 'legacy engine state is append-only'); END;",
    )
    .map_err(|e| format!("Could not create engine-scope archive: {e}"))?;
    validate_table_columns(
        &tx,
        "engine_scope_legacy_state",
        &["key", "raw_json", "source_updated_at", "captured_at"],
    )?;
    let captured_at = chrono::Utc::now().to_rfc3339();
    tx.execute(
        "INSERT OR IGNORE INTO engine_scope_legacy_state(key,raw_json,source_updated_at,captured_at)
         SELECT key,value_json,updated_at,?1 FROM kv
         WHERE key='settings' OR key GLOB 'last_known_good_*'",
        [&captured_at],
    )
    .map_err(|e| format!("Could not archive legacy engine state: {e}"))?;
    tx.execute(
        "INSERT INTO app_schema_migrations(version, applied_at) VALUES(2, ?1)",
        [&captured_at],
    )
    .map_err(|e| format!("Could not record migration 2: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Could not commit engine-scope archive migration: {e}"))
}

fn migrate_v1(conn: &mut Connection) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("Could not begin profile migration: {e}"))?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS launch_profiles_v2 (
           id TEXT PRIMARY KEY,
           revision INTEGER NOT NULL CHECK (revision > 0),
           envelope_json TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS profile_secrets (
           id TEXT PRIMARY KEY,
           profile_id TEXT NOT NULL,
           field_path TEXT NOT NULL,
           provider TEXT NOT NULL,
           ciphertext BLOB NOT NULL,
           created_at TEXT NOT NULL,
           UNIQUE(profile_id, field_path),
           FOREIGN KEY(profile_id) REFERENCES launch_profiles_v2(id) ON DELETE CASCADE
             DEFERRABLE INITIALLY DEFERRED
         );
         CREATE TABLE IF NOT EXISTS model_artifacts (
           id TEXT PRIMARY KEY,
           manifest_json TEXT NOT NULL,
           indexed_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS artifact_files (
           artifact_id TEXT NOT NULL,
           path TEXT NOT NULL,
           relative_path TEXT NOT NULL,
           role TEXT NOT NULL,
           size_bytes INTEGER NOT NULL,
           file_identity TEXT,
           \"exists\" INTEGER NOT NULL DEFAULT 1,
           PRIMARY KEY(artifact_id, path),
           FOREIGN KEY(artifact_id) REFERENCES model_artifacts(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS artifact_consumers (
           artifact_id TEXT NOT NULL,
           consumer_id TEXT NOT NULL,
           path TEXT NOT NULL,
           source TEXT NOT NULL,
           PRIMARY KEY(artifact_id, consumer_id, path),
           FOREIGN KEY(artifact_id) REFERENCES model_artifacts(id) ON DELETE CASCADE
         );",
    )
    .map_err(|e| format!("Could not create v2 profile/catalog tables: {e}"))?;

    validate_table_columns(
        &tx,
        "launch_profiles_v2",
        &[
            "id",
            "revision",
            "envelope_json",
            "created_at",
            "updated_at",
        ],
    )?;
    validate_table_columns(
        &tx,
        "profile_secrets",
        &[
            "id",
            "profile_id",
            "field_path",
            "provider",
            "ciphertext",
            "created_at",
        ],
    )?;
    validate_table_columns(
        &tx,
        "model_artifacts",
        &["id", "manifest_json", "indexed_at"],
    )?;
    validate_table_columns(
        &tx,
        "artifact_files",
        &[
            "artifact_id",
            "path",
            "relative_path",
            "role",
            "size_bytes",
            "file_identity",
            "exists",
        ],
    )?;
    validate_table_columns(
        &tx,
        "artifact_consumers",
        &["artifact_id", "consumer_id", "path", "source"],
    )?;

    import_legacy_profiles(&tx)?;
    migrate_global_engine_settings(&tx)?;
    tx.execute(
        "INSERT INTO app_schema_migrations(version, applied_at) VALUES(1, ?1)",
        [chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|e| format!("Could not record migration 1: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Could not commit profile migration: {e}"))
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
    .map_err(|e| e.to_string())
}

fn validate_table_columns(
    conn: &Connection,
    table: &str,
    required_columns: &[&str],
) -> Result<(), String> {
    let escaped_table = table.replace('"', "\"\"");
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info(\"{escaped_table}\")"))
        .map_err(|e| format!("Could not inspect {table} table: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Could not inspect {table} table: {e}"))?;
    let columns = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Could not inspect {table} table: {e}"))?;
    for column in required_columns {
        if !columns.iter().any(|existing| existing == column) {
            return Err(format!(
                "Incompatible {table} table: required column {column:?} is missing"
            ));
        }
    }
    Ok(())
}

fn import_legacy_profiles(tx: &Transaction<'_>) -> Result<(), String> {
    if !table_exists(tx, "profiles")? {
        return Ok(());
    }
    let mut stmt = tx
        .prepare(
            "SELECT id, name, description, config_json, created_at, updated_at, last_used_at, last_known_good
             FROM profiles ORDER BY id",
        )
        .map_err(|e| format!("Could not read legacy profiles: {e}"))?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id: String = row.get(0).map_err(|e| e.to_string())?;
        let name: String = row.get(1).map_err(|e| e.to_string())?;
        let description: Option<String> = row.get(2).map_err(|e| e.to_string())?;
        let raw_config: String = row.get(3).map_err(|e| e.to_string())?;
        let created_at: String = row.get(4).map_err(|e| e.to_string())?;
        let updated_at: String = row.get(5).map_err(|e| e.to_string())?;
        let last_used_at: Option<String> = row.get(6).map_err(|e| e.to_string())?;
        let last_known_good: i64 = row.get(7).map_err(|e| e.to_string())?;
        let config = serde_json::from_str::<Value>(&raw_config)
            .unwrap_or_else(|_| Value::String(raw_config.clone()));
        let engine = config
            .get("engine")
            .and_then(Value::as_str)
            .filter(|engine| !engine.trim().is_empty())
            .unwrap_or("unknown")
            .to_string();
        let mut profile = LaunchProfileV2::empty(&id, &name, &engine);
        profile.revision = 1;
        profile.description = description;
        let mut secret_references = BTreeMap::new();
        let mut safe_config = config.clone();
        protect_legacy_profile_secrets(tx, &id, &mut safe_config, "", &mut secret_references)?;
        profile.legacy_config = Some(safe_config);
        profile.created_at = created_at;
        profile.updated_at = updated_at;
        profile.last_used_at = last_used_at;
        profile.last_known_good = last_known_good != 0;
        profile.engine_options = legacy_engine_options(&config, &engine);
        let option_pointer = if config
            .get("engineOptions")
            .and_then(Value::as_object)
            .is_some_and(|options| options.get("values").is_some())
        {
            "/engineOptions/values"
        } else {
            "/engineOptions"
        };
        let mut safe_options = Value::Object(profile.engine_options.values.clone());
        protect_legacy_profile_secrets(
            tx,
            &id,
            &mut safe_options,
            option_pointer,
            &mut secret_references,
        )?;
        profile.engine_options.values = safe_options.as_object().cloned().unwrap_or_default();
        profile.secret_references = secret_references;
        profile.model = model_reference_from_config(&config);
        let envelope = ProfileEnvelope {
            schema_version: PROFILE_FORMAT_VERSION,
            exported_at: None,
            profile,
            extensions: BTreeMap::new(),
        };
        let json = serde_json::to_string(&envelope).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO launch_profiles_v2(id, revision, envelope_json, created_at, updated_at)
             VALUES(?1, 1, ?2, ?3, ?4)",
            params![id, json, envelope.profile.created_at, envelope.profile.updated_at],
        )
        .map_err(|e| format!("Could not copy legacy profile {id}: {e}"))?;
    }
    Ok(())
}

fn legacy_engine_options(config: &Value, engine: &str) -> EngineOptions {
    let options = config.get("engineOptions").and_then(Value::as_object);
    let values = options
        .and_then(|value| value.get("values").and_then(Value::as_object).cloned())
        .or_else(|| {
            options.map(|value| {
                value
                    .iter()
                    .filter(|(key, _)| key.as_str() != "engine")
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect()
            })
        })
        .unwrap_or_default();
    EngineOptions {
        engine: engine.into(),
        values,
        extensions: BTreeMap::new(),
    }
}

fn model_reference_from_config(config: &Value) -> ModelReference {
    let mut paths = Vec::new();
    for key in ["modelPath", "mmprojPath", "ngramPath"] {
        if let Some(path) = config
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
        {
            paths.push(path.to_string());
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

fn protect_legacy_profile_secrets(
    tx: &Transaction<'_>,
    profile_id: &str,
    value: &mut Value,
    pointer: &str,
    references: &mut BTreeMap<String, crate::domain::profile::SecretReference>,
) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            let keys = object.keys().cloned().collect::<Vec<_>>();
            for key in keys {
                let child_pointer =
                    format!("{pointer}/{}", key.replace('~', "~0").replace('/', "~1"));
                if object
                    .get(&key)
                    .is_some_and(|value| secrets::is_secret_value(&key, value))
                {
                    let secret = object.get(&key).and_then(Value::as_str).map(str::to_string);
                    if let Some(secret) = secret.filter(|secret| !secret.is_empty()) {
                        let reference = secrets::store_legacy_profile_secret(
                            tx,
                            profile_id,
                            &child_pointer,
                            &secret,
                        )?;
                        references.insert(child_pointer.clone(), reference);
                    }
                    if object.get(&key).is_some_and(Value::is_string) {
                        object.remove(&key);
                    } else if let Some(child) = object.get_mut(&key) {
                        protect_legacy_profile_secrets(
                            tx,
                            profile_id,
                            child,
                            &child_pointer,
                            references,
                        )?;
                    }
                } else if let Some(child) = object.get_mut(&key) {
                    protect_legacy_profile_secrets(
                        tx,
                        profile_id,
                        child,
                        &child_pointer,
                        references,
                    )?;
                }
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter_mut().enumerate() {
                protect_legacy_profile_secrets(
                    tx,
                    profile_id,
                    child,
                    &format!("{pointer}/{index}"),
                    references,
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn migrate_global_engine_settings(tx: &Transaction<'_>) -> Result<(), String> {
    if !table_exists(tx, "kv")? {
        return Ok(());
    }
    let settings_json: Option<String> = tx
        .query_row(
            "SELECT value_json FROM kv WHERE key='settings'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(settings_json) = settings_json else {
        return Ok(());
    };
    let settings: Value = serde_json::from_str(&settings_json)
        .map_err(|e| format!("Stored settings JSON is invalid: {e}"))?;
    let Some(settings) = settings.as_object() else {
        return Err("Stored settings are not a JSON object".into());
    };

    let mut candidates = Vec::new();
    let strata_values = take_fields(
        settings,
        &[
            "strataRootPath",
            "strataConfigPath",
            "strataHost",
            "strataPort",
        ],
    );
    if is_populated_strata(settings, &strata_values) {
        candidates.push((
            "legacy-global-strata",
            "Strata (from global settings)",
            "strata",
            strata_values,
            vec![("apiKey", "strataApiKey")],
        ));
    }

    let ollama_values = take_fields(
        settings,
        &[
            "ollamaEndpoint",
            "ollamaModel",
            "ollamaBinaryPath",
            "ollamaContext",
        ],
    );
    if is_populated_ollama(settings, &ollama_values) {
        candidates.push((
            "legacy-global-ollama",
            "Ollama (from global settings)",
            "ollama",
            ollama_values,
            Vec::new(),
        ));
    }

    let qwfn = settings.get("qwfn").and_then(Value::as_object);
    let qwfn_values = qwfn.cloned().unwrap_or_default();
    if is_populated_nested(
        qwfn,
        &[
            ("binaryPath", ""),
            ("modelPath", ""),
            ("host", "127.0.0.1"),
            ("port", "8080"),
            ("context", "32768"),
            ("ramGb", "16"),
            ("vramGb", "12"),
            ("reserveMb", "1024"),
            ("threads", "8"),
            ("kv", "q8_0"),
            ("asyncIo", "false"),
            ("mtpPath", ""),
            ("mtpGpu", "false"),
            ("prefixCacheGb", "0"),
        ],
    ) {
        candidates.push((
            "legacy-global-qwfnfer",
            "QwFNfer (from global settings)",
            "qwfnfer",
            qwfn_values,
            vec![("apiKey", "qwfn.apiKey")],
        ));
    }

    let infernix = settings.get("infernix").and_then(Value::as_object);
    let infernix_values = infernix.cloned().unwrap_or_default();
    if is_populated_nested(
        infernix,
        &[
            ("binaryPath", ""),
            ("modelPath", ""),
            ("ngramPath", ""),
            ("modelAlias", ""),
            ("host", "127.0.0.1"),
            ("port", "8080"),
            ("context", "65536"),
            ("kv", "int8"),
            ("concurrency", "1"),
            ("prefillChunk", "1024"),
            ("hostContextMiB", "4096"),
            ("ramHeadroomMiB", "4096"),
            ("vramHeadroomMiB", "1536"),
            ("expertRamMiB", "0"),
            ("spec", "off"),
            ("draftTokens", "4"),
            ("lmHeadDraft", "false"),
        ],
    ) {
        candidates.push((
            "legacy-global-infernix",
            "Infernix (from global settings)",
            "infernix",
            infernix_values,
            vec![("apiKey", "infernix.apiKey")],
        ));
    }

    for (id, name, engine, mut values, secret_fields) in candidates {
        let exists: i64 = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM launch_profiles_v2 WHERE id=?1)",
                [id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists != 0 {
            continue;
        }
        let mut profile = LaunchProfileV2::empty(id, name, engine);
        profile.description = Some(
            "Imported once from the original global settings; those settings remain unchanged."
                .into(),
        );
        profile.engine_options = EngineOptions {
            engine: engine.into(),
            values: Map::new(),
            extensions: BTreeMap::new(),
        };
        for (field, settings_path) in secret_fields {
            let plaintext = lookup_settings_secret(settings, settings_path);
            if let Some(plaintext) = plaintext.filter(|value| !value.is_empty()) {
                let reference = secrets::store_secret(tx, id, settings_path, plaintext)?;
                profile.secret_references.insert(field.into(), reference);
            }
            values.remove(field);
        }
        let mut safe_values = Value::Object(values);
        let prefix = match engine {
            "qwfnfer" => "qwfn",
            "infernix" => "infernix",
            _ => "",
        };
        protect_global_setting_values(
            tx,
            id,
            &mut safe_values,
            prefix,
            "",
            &mut profile.secret_references,
        )?;
        profile.engine_options.values = safe_values.as_object().cloned().unwrap_or_default();
        let timestamp = profile.created_at.clone();
        let envelope = ProfileEnvelope {
            schema_version: PROFILE_FORMAT_VERSION,
            exported_at: None,
            profile,
            extensions: BTreeMap::new(),
        };
        let json = serde_json::to_string(&envelope).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO launch_profiles_v2(id, revision, envelope_json, created_at, updated_at)
             VALUES(?1, 1, ?2, ?3, ?3)",
            params![id, json, timestamp],
        )
        .map_err(|e| format!("Could not import {engine} settings as a profile: {e}"))?;
    }
    Ok(())
}

fn take_fields(settings: &Map<String, Value>, keys: &[&str]) -> Map<String, Value> {
    keys.iter()
        .filter_map(|key| {
            settings
                .get(*key)
                .map(|value| ((*key).to_string(), value.clone()))
        })
        .collect()
}

fn protect_global_setting_values(
    tx: &Transaction<'_>,
    id: &str,
    value: &mut Value,
    settings_path: &str,
    pointer: &str,
    references: &mut BTreeMap<String, crate::domain::profile::SecretReference>,
) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            for key in object.keys().cloned().collect::<Vec<_>>() {
                let path = if settings_path.is_empty() {
                    key.clone()
                } else {
                    format!("{settings_path}.{key}")
                };
                let child_pointer =
                    format!("{pointer}/{}", key.replace('~', "~0").replace('/', "~1"));
                if object
                    .get(&key)
                    .is_some_and(|value| secrets::is_secret_value(&key, value))
                    && object.get(&key).is_some_and(Value::is_string)
                {
                    let secret = object[&key].as_str().unwrap();
                    if !secret.is_empty() {
                        let reference = secrets::store_secret(tx, id, &path, secret)?;
                        references
                            .insert(format!("/engineOptions/values{child_pointer}"), reference);
                    }
                    object.remove(&key);
                } else if let Some(child) = object.get_mut(&key) {
                    protect_global_setting_values(
                        tx,
                        id,
                        child,
                        &path,
                        &child_pointer,
                        references,
                    )?;
                }
            }
        }
        Value::Array(array) => {
            for (index, child) in array.iter_mut().enumerate() {
                protect_global_setting_values(
                    tx,
                    id,
                    child,
                    &format!("{settings_path}.{index}"),
                    &format!("{pointer}/{index}"),
                    references,
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn is_populated_strata(settings: &Map<String, Value>, values: &Map<String, Value>) -> bool {
    ["strataRootPath", "strataConfigPath", "strataApiKey"]
        .iter()
        .any(|key| nonempty_string(settings.get(*key)))
        || values
            .get("strataHost")
            .and_then(Value::as_str)
            .is_some_and(|value| value != "127.0.0.1")
        || values
            .get("strataPort")
            .and_then(Value::as_i64)
            .is_some_and(|value| value != 8080)
}

fn is_populated_ollama(settings: &Map<String, Value>, values: &Map<String, Value>) -> bool {
    nonempty_string(settings.get("ollamaModel"))
        || nonempty_string(settings.get("ollamaBinaryPath"))
        || values
            .get("ollamaEndpoint")
            .and_then(Value::as_str)
            .is_some_and(|value| value != "http://127.0.0.1:11434")
        || values
            .get("ollamaContext")
            .and_then(Value::as_u64)
            .is_some_and(|value| value != 4096)
}

fn is_populated_nested(object: Option<&Map<String, Value>>, defaults: &[(&str, &str)]) -> bool {
    let Some(object) = object else { return false };
    object.iter().any(|(key, value)| {
        if key == "apiKey" {
            return nonempty_string(Some(value));
        }
        match value {
            Value::String(text) if text.is_empty() => false,
            Value::String(text) => defaults
                .iter()
                .find(|(default_key, _)| *default_key == key)
                .is_none_or(|(_, default)| text != default),
            Value::Null => false,
            _ => defaults
                .iter()
                .find(|(default_key, _)| *default_key == key)
                .is_none_or(|(_, default)| {
                    let expected = serde_json::from_str::<Value>(default)
                        .unwrap_or_else(|_| Value::String((*default).to_string()));
                    match (value.as_number(), expected.as_number()) {
                        (Some(actual), Some(expected)) => actual.as_f64() != expected.as_f64(),
                        _ => value != &expected,
                    }
                }),
        }
    })
}

fn nonempty_string(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

fn lookup_settings_secret<'a>(settings: &'a Map<String, Value>, path: &str) -> Option<&'a str> {
    let mut parts = path.split('.');
    let first = parts.next()?;
    let mut value = settings.get(first)?;
    for part in parts {
        value = value.get(part)?;
    }
    value.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;

    /// Explicit opt-in proof on a preserved baseline; source is opened read-only.
    /// All writes, including DPAPI ciphertext, go to a unique temporary SQLite DB.
    #[test]
    #[ignore = "requires APLOT_MIGRATION_SOURCE baseline copy and APLOT_MIGRATION_REPORT JSON path"]
    fn migration_copy_preserves_real_baseline() {
        use rusqlite::{types::ValueRef, OpenFlags};
        use std::{fs, path::PathBuf};

        fn digest(bytes: &[u8]) -> String {
            let mut hash = 0xcbf29ce484222325u64;
            for byte in bytes {
                hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
            }
            format!("fnv1a64:{hash:016x}")
        }
        fn hex(bytes: &[u8]) -> String {
            bytes.iter().map(|byte| format!("{byte:02x}")).collect()
        }
        fn tables(conn: &Connection) -> BTreeMap<String, (String, Vec<String>)> {
            let mut result = BTreeMap::new();
            let mut stmt = conn.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap();
            let names = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .unwrap();
            for entry in names {
                let (name, schema) = entry.unwrap();
                let mut query = conn
                    .prepare(&format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")))
                    .unwrap();
                let columns = query.column_count();
                let mut rows = query
                    .query_map([], |row| {
                        let values = (0..columns)
                            .map(|index| match row.get_ref(index)? {
                                ValueRef::Null => Ok(json!(["null"])),
                                ValueRef::Integer(value) => {
                                    Ok(json!(["integer", value.to_string()]))
                                }
                                ValueRef::Real(value) => {
                                    Ok(json!(["real", value.to_bits().to_string()]))
                                }
                                ValueRef::Text(value) => Ok(json!(["text", hex(value)])),
                                ValueRef::Blob(value) => Ok(json!(["blob", hex(value)])),
                            })
                            .collect::<rusqlite::Result<Vec<Value>>>()?;
                        Ok(serde_json::to_string(&values).unwrap())
                    })
                    .unwrap()
                    .map(Result::unwrap)
                    .collect::<Vec<_>>();
                rows.sort();
                result.insert(name, (schema, rows));
            }
            result
        }
        fn table_report(tables: &BTreeMap<String, (String, Vec<String>)>) -> Value {
            Value::Object(
                tables
                    .iter()
                    .map(|(name, (schema, rows))| {
                        let bytes = serde_json::to_vec(&(schema, rows)).unwrap();
                        (
                            name.clone(),
                            json!({"rows":rows.len(),"digest":digest(&bytes)}),
                        )
                    })
                    .collect(),
            )
        }
        fn settings(conn: &Connection) -> Option<String> {
            conn.query_row(
                "SELECT value_json FROM kv WHERE key='settings'",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap()
        }
        fn recovery(conn: &Connection) -> Vec<(String, String)> {
            let mut values = Vec::new();
            let mut stmt = conn
                .prepare(
                    "SELECT id,config_json FROM profiles WHERE last_known_good != 0 ORDER BY id",
                )
                .unwrap();
            values.extend(
                stmt.query_map([], |row| {
                    Ok((
                        format!("profile:{}", row.get::<_, String>(0)?),
                        row.get::<_, String>(1)?,
                    ))
                })
                .unwrap()
                .map(Result::unwrap),
            );
            let mut stmt = conn
                .prepare(
                    "SELECT key,value_json FROM kv WHERE key LIKE 'last_known_good%' ORDER BY key",
                )
                .unwrap();
            values.extend(
                stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .unwrap()
                .map(Result::unwrap),
            );
            values
        }
        struct Scratch(PathBuf);
        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = fs::remove_file(&self.0);
                for suffix in ["-wal", "-shm", "-journal"] {
                    let _ = fs::remove_file(PathBuf::from(format!("{}{suffix}", self.0.display())));
                }
            }
        }
        let source = fs::canonicalize(
            std::env::var_os("APLOT_MIGRATION_SOURCE")
                .expect("Set APLOT_MIGRATION_SOURCE to a baseline copy"),
        )
        .unwrap();
        let working =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../data/llama-control.sqlite3");
        assert_ne!(
            source,
            fs::canonicalize(working).unwrap(),
            "Do not run this proof against the working user DB"
        );
        let report = PathBuf::from(
            std::env::var_os("APLOT_MIGRATION_REPORT").expect("Set APLOT_MIGRATION_REPORT"),
        );
        assert!(
            report.is_absolute()
                && report
                    .extension()
                    .is_some_and(|extension| extension == "json")
        );
        let source_bytes = fs::read(&source).unwrap();
        let source_conn =
            Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let before = tables(&source_conn);
        let settings_before = settings(&source_conn);
        let recovery_before = recovery(&source_conn);
        assert_eq!(
            before["profiles"].1.len(),
            40,
            "Expected the preserved 40-profile baseline"
        );
        let scratch = Scratch(std::env::temp_dir().join(format!(
            "aplot-migration-proof-{}.sqlite3",
            uuid::Uuid::new_v4()
        )));
        source_conn
            .execute("VACUUM INTO ?1", [scratch.0.to_str().unwrap()])
            .unwrap();
        let mut conn = Connection::open(&scratch.0).unwrap();
        assert!(
            tables(&conn) == before,
            "Scratch copy must exactly match baseline rows/schema"
        );
        migrate(&mut conn).unwrap();
        let migrated = tables(&conn);
        migrate(&mut conn).unwrap();
        assert!(
            tables(&conn) == migrated,
            "Second migration must be idempotent"
        );
        let after = tables(&conn)
            .into_iter()
            .filter(|(name, _)| before.contains_key(name))
            .collect::<BTreeMap<_, _>>();
        assert!(
            before == after,
            "Every legacy table and raw cell must be unchanged"
        );
        assert!(
            settings_before == settings(&conn),
            "Raw settings JSON must be unchanged"
        );
        assert!(
            recovery_before == recovery(&conn),
            "Raw last-known-good JSON must be unchanged"
        );
        let migrated_legacy_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM profiles p JOIN launch_profiles_v2 v ON v.id=p.id",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migrated_legacy_count, 40);
        let v2_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM launch_profiles_v2", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            conn.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert!(
            tables(&source_conn) == before,
            "Read-only source cells changed"
        );
        assert!(
            fs::read(&source).unwrap() == source_bytes,
            "Read-only source file changed"
        );
        let recovery_bytes = serde_json::to_vec(&recovery_before).unwrap();
        let evidence = json!({
            "passed":true,"source":source,"sourceReadOnly":true,"sourceUnchanged":true,
            "sourceFileDigest":digest(&source_bytes),
            "digestAlgorithm":"fnv1a64; assertions compare complete bytes/cells, not just digests",
            "legacyTablesBefore":table_report(&before),"legacyTablesAfter":table_report(&after),
            "legacyProfiles":40,"migratedLegacyProfiles":migrated_legacy_count,"v2Profiles":v2_count,
            "settingsUnchanged":true,"settingsDigest":digest(settings_before.as_deref().unwrap_or("").as_bytes()),
            "rawLastKnownGoodUnchanged":true,"rawLastKnownGoodEntries":recovery_before.len(),
            "rawLastKnownGoodDigest":digest(&recovery_bytes),"idempotent":true,"integrity":"ok"
        });
        fs::create_dir_all(report.parent().unwrap()).unwrap();
        fs::write(report, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    }

    fn legacy_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE profiles(
               id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, config_json TEXT NOT NULL,
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT,
               last_known_good INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE kv(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE benchmarks(id TEXT PRIMARY KEY, result_json TEXT NOT NULL);
             CREATE TABLE events(id INTEGER PRIMARY KEY, payload_json TEXT);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn engine_scope_v2_archives_v1_settings_and_recovery_without_rewriting_profiles() {
        let mut conn = legacy_db();
        let profiles = [
            (
                "legacy-ollama",
                json!({"engine":"ollama","model":"old","apiKey":"ollama-profile-secret"}),
            ),
            (
                "legacy-qwfnfer",
                json!({"engine":"qwfnfer","model":"old","apiKey":"qwfn-profile-secret"}),
            ),
            (
                "legacy-infernix",
                json!({"engine":"infernix","modelPath":"E:/old/model.infernix","apiKey":"infernix-profile-secret"}),
            ),
            (
                "future-engine",
                json!({"engine":"vendor-future","modelPath":"E:/future/model.bin","apiKey":"future-profile-secret","futureField":{"keep":true}}),
            ),
        ];
        for (id, config) in profiles {
            conn.execute(
                "INSERT INTO profiles VALUES(?1,?1,NULL,?2,'created','updated',NULL,0)",
                params![id, config.to_string()],
            )
            .unwrap();
        }
        let settings = json!({
            "serverEngine":"ollama", "autoStartServer":true, "routerAutoload":true,
            "ollamaEndpoint":"http://127.0.0.1:11434", "ollamaModel":"",
            "ollamaBinaryPath":"", "ollamaContext":4096, "ollamaApiKey":"global-secret",
            "qwfn":{"binaryPath":"","modelPath":"","host":"127.0.0.1","port":8080,"context":32768,"ramGb":16,"vramGb":12,"reserveMb":1024,"threads":8,"kv":"q8_0","asyncIo":false,"mtpPath":"","mtpGpu":false,"prefixCacheGb":0},
            "infernix":{"binaryPath":"","modelPath":"","ngramPath":"","modelAlias":"","host":"127.0.0.1","port":8080,"context":65536,"kv":"int8","concurrency":1,"prefillChunk":1024,"hostContextMiB":4096,"ramHeadroomMiB":4096,"vramHeadroomMiB":1536,"expertRamMiB":0,"spec":"off","draftTokens":4,"lmHeadDraft":false},
            "futureSetting":{"keep":true}
        })
        .to_string();
        let router_recovery = json!({
            "profiles":[{"id":"legacy-ollama"}], "settings":{"apiKey":"router-recovery-secret"},
            "unknown":"preserve-me"
        })
        .to_string();
        let model_recovery =
            json!({"profile":{"id":"legacy-infernix"},"token":"model-recovery-secret"}).to_string();
        for (key, value, updated_at) in [
            ("settings", settings.as_str(), "settings-source-stamp"),
            (
                "last_known_good_router",
                router_recovery.as_str(),
                "router-source-stamp",
            ),
            (
                "last_known_good_model",
                model_recovery.as_str(),
                "model-source-stamp",
            ),
        ] {
            conn.execute(
                "INSERT INTO kv VALUES(?1,?2,?3)",
                params![key, value, updated_at],
            )
            .unwrap();
        }

        // Construct the exact schema state shipped by migration 1, then snapshot
        // every data table that migration 2 is required to leave untouched.
        conn.execute_batch(
            "CREATE TABLE app_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
        )
        .unwrap();
        migrate_v1(&mut conn).unwrap();
        let legacy_profiles_before = {
            let mut stmt = conn
                .prepare("SELECT id,config_json FROM profiles ORDER BY id")
                .unwrap();
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<(String, String)>, _>>()
                .unwrap()
        };
        let v1_profiles_before = {
            let mut stmt = conn.prepare(
                "SELECT id,revision,envelope_json,created_at,updated_at FROM launch_profiles_v2 ORDER BY id",
            ).unwrap();
            stmt.query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<(String, i64, String, String, String)>, _>>()
            .unwrap()
        };
        let secrets_before = {
            let mut stmt = conn.prepare(
                "SELECT id,profile_id,field_path,provider,ciphertext,created_at FROM profile_secrets ORDER BY id",
            ).unwrap();
            stmt.query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<(String, String, String, String, Vec<u8>, String)>, _>>()
            .unwrap()
        };
        let raw_state_before = {
            let mut stmt = conn.prepare(
                "SELECT key,value_json,updated_at FROM kv WHERE key='settings' OR key GLOB 'last_known_good_*' ORDER BY key",
            ).unwrap();
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<Result<Vec<(String, String, String)>, _>>()
                .unwrap()
        };
        assert_eq!(legacy_profiles_before.len(), 4);
        assert_eq!(v1_profiles_before.len(), 4);
        assert!(!secrets_before.is_empty());

        migrate_v2(&mut conn).unwrap();
        migrate(&mut conn).unwrap();

        let legacy_profiles_after = {
            let mut stmt = conn
                .prepare("SELECT id,config_json FROM profiles ORDER BY id")
                .unwrap();
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<(String, String)>, _>>()
                .unwrap()
        };
        let v1_profiles_after = {
            let mut stmt = conn.prepare(
                "SELECT id,revision,envelope_json,created_at,updated_at FROM launch_profiles_v2 ORDER BY id",
            ).unwrap();
            stmt.query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<(String, i64, String, String, String)>, _>>()
            .unwrap()
        };
        let secrets_after = {
            let mut stmt = conn.prepare(
                "SELECT id,profile_id,field_path,provider,ciphertext,created_at FROM profile_secrets ORDER BY id",
            ).unwrap();
            stmt.query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<(String, String, String, String, Vec<u8>, String)>, _>>()
            .unwrap()
        };
        let raw_state_after = {
            let mut stmt = conn.prepare(
                "SELECT key,value_json,updated_at FROM kv WHERE key='settings' OR key GLOB 'last_known_good_*' ORDER BY key",
            ).unwrap();
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<Result<Vec<(String, String, String)>, _>>()
                .unwrap()
        };
        assert_eq!(legacy_profiles_after, legacy_profiles_before);
        assert_eq!(v1_profiles_after, v1_profiles_before);
        assert_eq!(secrets_after, secrets_before);
        assert_eq!(raw_state_after, raw_state_before);

        let archived = {
            let mut stmt = conn.prepare(
                "SELECT key,raw_json,source_updated_at,captured_at FROM engine_scope_legacy_state ORDER BY key",
            ).unwrap();
            stmt.query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<Vec<(String, String, String, String)>, _>>()
            .unwrap()
        };
        assert_eq!(archived.len(), 3);
        for (key, raw_json, source_updated_at, captured_at) in archived {
            let original = raw_state_before
                .iter()
                .find(|(original_key, _, _)| original_key == &key)
                .unwrap();
            assert_eq!(&raw_json, &original.1);
            assert_eq!(&source_updated_at, &original.2);
            assert!(!captured_at.is_empty());
        }
        assert!(conn
            .execute(
                "UPDATE engine_scope_legacy_state SET raw_json='{}' WHERE key='settings'",
                [],
            )
            .is_err());
        assert!(conn
            .execute(
                "DELETE FROM engine_scope_legacy_state WHERE key='settings'",
                [],
            )
            .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn migration_protects_cli_credentials_in_profiles_and_global_engine_settings() {
        let mut conn = legacy_db();
        let config =
            json!({"engine":"infernix","extraArgs":"--api-key legacy-cli-key --ctx-size 8192"});
        let settings = json!({"infernix":{"modelPath":"E:/fake/model.infernix","extraArgs":"--token=global-cli-key"}});
        conn.execute(
            "INSERT INTO profiles VALUES('cli','CLI',NULL,?1,'a','b',NULL,0)",
            [config.to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO kv VALUES('settings',?1,'a')",
            [settings.to_string()],
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        let repo = crate::profile_store::ProfileRepository::new(&conn);
        let profile = repo.get("cli").unwrap().unwrap();
        let global = repo.get("legacy-global-infernix").unwrap().unwrap();
        assert!(!crate::profile_store::encode_profile_v2(&profile)
            .unwrap()
            .contains("legacy-cli-key"));
        assert!(!crate::profile_store::encode_profile_v2(&global)
            .unwrap()
            .contains("global-cli-key"));
        assert!(repo
            .resolve_launch_config("cli")
            .unwrap_err()
            .contains("infernix"));
        assert!(repo
            .resolve_launch_config("legacy-global-infernix")
            .unwrap_err()
            .contains("infernix"));
        assert_eq!(
            serde_json::from_str::<Value>(
                &crate::profile_store::encode_profile_v2(&profile).unwrap()
            )
            .unwrap()["profile"]["legacyConfig"]["engine"],
            "infernix"
        );
        let legacy: String = conn
            .query_row(
                "SELECT config_json FROM profiles WHERE id='cli'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let original: String = conn
            .query_row(
                "SELECT value_json FROM kv WHERE key='settings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy, config.to_string());
        assert_eq!(original, settings.to_string());
    }

    #[test]
    fn migration_is_additive_repeatable_and_preserves_recovery_and_settings() {
        let mut conn = legacy_db();
        let config = json!({"engine":"infernix","modelPath":"E:/models/main.gguf","unknownNewOption":{"x":7}});
        let recovery =
            json!({"profiles":[{"id":"recover-me"}],"settings":{"routerApiKey":"keep-this"}});
        let settings = json!({
            "theme":"light", "dashboardLayout":{"version":1,"items":{"x":{"x":1}}},
            "strataRootPath":"E:/strata", "strataConfigPath":"E:/strata/model.yaml",
            "strataHost":"127.0.0.1", "strataPort":8080, "strataApiKey":"strata-secret",
            "ollamaEndpoint":"http://127.0.0.1:11434", "ollamaModel":"",
            "ollamaBinaryPath":"", "ollamaContext":4096,
            "qwfn":{"binaryPath":"", "modelPath":"", "host":"127.0.0.1", "port":8080,
                    "apiKey":"", "context":32768, "ramGb":16, "vramGb":12, "reserveMb":1024,
                    "threads":8, "kv":"q8_0", "asyncIo":false, "mtpPath":"", "mtpGpu":false, "prefixCacheGb":0},
            "infernix":{"binaryPath":"", "modelPath":"", "ngramPath":"", "modelAlias":"",
                    "host":"127.0.0.1", "port":8080, "apiKey":"", "context":65536, "kv":"int8",
                    "concurrency":1, "prefillChunk":1024, "hostContextMiB":4096, "ramHeadroomMiB":4096,
                    "vramHeadroomMiB":1536, "expertRamMiB":0, "spec":"off", "draftTokens":4, "lmHeadDraft":false}
        });
        conn.execute(
            "INSERT INTO profiles VALUES('old-id','Legacy',NULL,?1,'created','updated',NULL,1)",
            [config.to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO kv VALUES('settings',?1,'settings-stamp')",
            [settings.to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO kv VALUES('last_known_good_router',?1,'recovery-stamp')",
            [recovery.to_string()],
        )
        .unwrap();

        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM launch_profiles_v2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "legacy profile plus configured Strata profile");
        let raw_config: String = conn
            .query_row(
                "SELECT config_json FROM profiles WHERE id='old-id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&raw_config).unwrap(), config);
        let settings_after: String = conn
            .query_row("SELECT value_json FROM kv WHERE key='settings'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&settings_after).unwrap(),
            settings
        );
        let recovery_after: String = conn
            .query_row(
                "SELECT value_json FROM kv WHERE key='last_known_good_router'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&recovery_after).unwrap(),
            recovery
        );
        let envelope_json: String = conn
            .query_row(
                "SELECT envelope_json FROM launch_profiles_v2 WHERE id='old-id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let envelope: ProfileEnvelope = serde_json::from_str(&envelope_json).unwrap();
        assert_eq!(envelope.profile.legacy_config, Some(config));
        assert_eq!(envelope.profile.engine, "infernix");
        assert!(crate::profile_store::ProfileRepository::new(&conn)
            .resolve_launch_config("old-id")
            .unwrap_err()
            .contains("infernix"));
        assert_eq!(
            envelope.profile.model.legacy_paths,
            vec!["E:/models/main.gguf"]
        );
        assert_eq!(
            envelope.profile.legacy_config.as_ref().unwrap()["unknownNewOption"]["x"],
            7
        );
    }

    #[test]
    fn migration_does_not_default_profiles_with_missing_engine_to_llama() {
        let mut conn = legacy_db();
        let config = json!({"modelPath":"E:/old/model.gguf","future":{"retained":true}});
        conn.execute(
            "INSERT INTO profiles VALUES('no-engine','Old',NULL,?1,'created','updated',NULL,1)",
            [config.to_string()],
        )
        .unwrap();

        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();

        let repository = crate::profile_store::ProfileRepository::new(&conn);
        let profile = repository.get("no-engine").unwrap().unwrap();
        assert_eq!(profile.engine, "unknown");
        assert_eq!(profile.legacy_config, Some(config.clone()));
        assert!(repository
            .resolve_launch_config("no-engine")
            .unwrap_err()
            .contains("unknown"));
        let exported: Value =
            serde_json::from_str(&crate::profile_store::encode_profile_v2(&profile).unwrap())
                .unwrap();
        assert_eq!(exported["profile"]["engine"], "unknown");
        assert_eq!(exported["profile"]["legacyConfig"], config);
        let legacy_config: String = conn
            .query_row(
                "SELECT config_json FROM profiles WHERE id='no-engine'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy_config, config.to_string());
    }

    #[test]
    fn empty_engine_settings_do_not_create_global_profiles() {
        let mut conn = legacy_db();
        conn.execute(
            "INSERT INTO kv VALUES('settings',?1,'now')",
            [json!({"strataRootPath":"","strataConfigPath":"","strataHost":"127.0.0.1","strataPort":8080,
              "strataApiKey":"","ollamaEndpoint":"http://127.0.0.1:11434","ollamaModel":"","ollamaBinaryPath":"","ollamaContext":4096,
              "qwfn":{"binaryPath":"","modelPath":"","host":"127.0.0.1","port":8080,"apiKey":"","context":32768,"ramGb":16,"vramGb":12,"reserveMb":1024,"threads":8,"kv":"q8_0","asyncIo":false,"mtpPath":"","mtpGpu":false,"prefixCacheGb":0},
              "infernix":{"binaryPath":"","modelPath":"","ngramPath":"","modelAlias":"","host":"127.0.0.1","port":8080,"apiKey":"","context":65536,"kv":"int8","concurrency":1,"prefillChunk":1024,"hostContextMiB":4096,"ramHeadroomMiB":4096,"vramHeadroomMiB":1536,"expertRamMiB":0,"spec":"off","draftTokens":4,"lmHeadDraft":false}}).to_string()],
        ).unwrap();
        migrate(&mut conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM launch_profiles_v2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn failed_migration_rolls_back_all_version_one_objects() {
        let mut conn = legacy_db();
        // Force a failure after the first CREATE TABLE has succeeded.
        conn.execute_batch("CREATE TABLE profile_secrets(id TEXT PRIMARY KEY);")
            .unwrap();
        assert!(migrate(&mut conn).is_err());
        let migrated: i64 = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='launch_profiles_v2')",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(migrated, 0);
        let versions: i64 = conn
            .query_row("SELECT COUNT(*) FROM app_schema_migrations", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(versions, 0);
    }

    #[test]
    fn future_database_schema_is_rejected_before_mutation() {
        let mut conn = legacy_db();
        conn.execute_batch("CREATE TABLE app_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);").unwrap();
        conn.execute("INSERT INTO app_schema_migrations VALUES(900,'future')", [])
            .unwrap();
        assert!(migrate(&mut conn)
            .unwrap_err()
            .contains("newer than this app supports"));
        let exists: i64 = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='launch_profiles_v2')",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(exists, 0);
    }
}
