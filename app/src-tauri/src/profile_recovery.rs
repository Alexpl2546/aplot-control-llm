//! Frozen v2 recovery snapshots. Only explicit mark/restore actions write data;
//! legacy fallback reads do not rewrite the original recovery KV records.

use super::{
    extract_secret_values, validate_profile, ProfileIpc, ProfileRepository, SecretString,
    PROFILE_CONFLICT,
};
use crate::{
    db::DbState,
    domain::{
        profile::{LaunchProfileV2, ProfileEnvelope, SecretReference},
        secrets,
    },
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tauri::State;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultEntry {
    id: String,
    profile_id: String,
    field_path: String,
    ciphertext: Vec<u8>,
    created_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrozenRecovery {
    schema_version: u32,
    kind: String,
    profiles: Vec<ProfileEnvelope>,
    config: Value,
    settings: Value,
    #[serde(default)]
    secret_references: BTreeMap<String, SecretReference>,
    #[serde(default)]
    vault: Vec<VaultEntry>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterRecoveryIpc {
    schema_version: u32,
    profiles: Vec<ProfileIpc>,
    config: Value,
    settings: Value,
    #[serde(default)]
    secret_references: BTreeMap<String, SecretReference>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterRecoveryInput {
    profiles: Vec<ProfileIpc>,
    config: Value,
    settings: Value,
}

const ROUTER_SETTINGS: &[&str] = &[
    "binaryPath",
    "serverMode",
    "routerHost",
    "routerPort",
    "routerMaxLoadedModels",
    "routerAutoload",
];
fn key(kind: &str) -> String {
    format!("last_known_good_{kind}_v2")
}

fn vault_entry(
    conn: &Connection,
    profile_id: &str,
    reference: &SecretReference,
) -> Result<VaultEntry, String> {
    conn.query_row("SELECT id,profile_id,field_path,ciphertext,created_at FROM profile_secrets WHERE id=?1 AND profile_id=?2 AND provider=?3",
        params![reference.id, profile_id, secrets::DPAPI_PROVIDER], |row| Ok(VaultEntry {
            id: row.get(0)?, profile_id: row.get(1)?, field_path: row.get(2)?, ciphertext: row.get(3)?, created_at: row.get(4)?,
        })).optional().map_err(|e| e.to_string())?
        .ok_or_else(|| "Recovery credential is missing or belongs to another profile".into())
}

fn seal(
    profile_id: &str,
    path: &str,
    plaintext: &str,
    vault: &mut Vec<VaultEntry>,
) -> Result<SecretReference, String> {
    let id = uuid::Uuid::new_v4().to_string();
    vault.push(VaultEntry {
        id: id.clone(),
        profile_id: profile_id.into(),
        field_path: path.into(),
        ciphertext: secrets::seal_recovery_secret(plaintext)?,
        created_at: chrono::Utc::now().to_rfc3339(),
    });
    Ok(SecretReference {
        provider: secrets::DPAPI_PROVIDER.into(),
        id,
    })
}

fn freeze_profile(
    conn: &Connection,
    profile: LaunchProfileV2,
    vault: &mut Vec<VaultEntry>,
) -> Result<ProfileEnvelope, String> {
    validate_profile(&profile)?;
    let extensions = profile.envelope_extensions.clone();
    let mut value = serde_json::to_value(ProfileEnvelope {
        schema_version: 2,
        exported_at: None,
        profile,
        extensions,
    })
    .map_err(|e| e.to_string())?;
    let mut plaintext = Vec::new();
    extract_secret_values(&mut value, "", &mut plaintext);
    let mut envelope: ProfileEnvelope = serde_json::from_value(value).map_err(|e| e.to_string())?;
    for (path, secret) in plaintext {
        let reference = seal(&envelope.profile.id, &path, &secret.0, vault)?;
        let path = path
            .strip_prefix("/profile")
            .map(str::to_string)
            .unwrap_or_else(|| format!("$envelope{path}"));
        envelope.profile.secret_references.insert(path, reference);
    }
    for (path, reference) in &mut envelope.profile.secret_references {
        if vault.iter().any(|entry| entry.id == reference.id) {
            continue;
        }
        if reference.provider == secrets::DPAPI_PROVIDER {
            vault.push(vault_entry(conn, &envelope.profile.id, reference)?);
        } else {
            let plaintext = SecretString(secrets::resolve_secret(conn, reference)?);
            *reference = seal(&envelope.profile.id, path, &plaintext.0, vault)?;
        }
    }
    envelope.profile.envelope_extensions = envelope.extensions.clone();
    Ok(envelope)
}

fn freeze_root(snapshot: &mut FrozenRecovery) -> Result<(), String> {
    let mut root = json!({"config":snapshot.config,"settings":snapshot.settings});
    let mut pending = Vec::new();
    extract_secret_values(&mut root, "", &mut pending);
    for (path, plaintext) in pending {
        let reference = seal(
            &snapshot.profiles[0].profile.id,
            &format!("$recovery{path}"),
            &plaintext.0,
            &mut snapshot.vault,
        )?;
        snapshot.secret_references.insert(path, reference);
    }
    snapshot.config = root["config"].take();
    snapshot.settings = root["settings"].take();
    Ok(())
}

fn validate_snapshot(snapshot: &FrozenRecovery, kind: &str) -> Result<(), String> {
    if snapshot.schema_version != 2
        || snapshot.kind != kind
        || snapshot.profiles.is_empty()
        || !snapshot.config.is_object()
        || !snapshot.settings.is_object()
        || (kind == "profile" && snapshot.profiles.len() != 1)
    {
        return Err("Invalid v2 recovery snapshot".into());
    }
    let mut ids = std::collections::HashSet::new();
    for envelope in &snapshot.profiles {
        if envelope.schema_version != 2 || !ids.insert(&envelope.profile.id) {
            return Err("Invalid v2 recovery profile set".into());
        }
        validate_profile(&envelope.profile)?;
        for reference in envelope.profile.secret_references.values() {
            if reference.provider != secrets::DPAPI_PROVIDER
                || !snapshot.vault.iter().any(|entry| {
                    entry.id == reference.id
                        && entry.profile_id == envelope.profile.id
                        && !entry.ciphertext.is_empty()
                })
            {
                return Err("Invalid v2 recovery credential backup".into());
            }
        }
    }
    for reference in snapshot.secret_references.values() {
        if reference.provider != secrets::DPAPI_PROVIDER
            || !snapshot
                .vault
                .iter()
                .any(|entry| entry.id == reference.id && !entry.ciphertext.is_empty())
        {
            return Err("Invalid v2 recovery router credential backup".into());
        }
    }
    // Persisted snapshots must contain credential references/ciphertext only.
    let mut safe = serde_json::to_value(snapshot).map_err(|e| e.to_string())?;
    let mut pending = Vec::new();
    extract_secret_values(&mut safe, "", &mut pending);
    if !pending.is_empty() {
        return Err("V2 recovery snapshot contains unprotected credentials".into());
    }
    Ok(())
}

fn write_profile(conn: &Connection, profile: &LaunchProfileV2) -> Result<(), String> {
    validate_profile(profile)?;
    let envelope = ProfileEnvelope {
        schema_version: 2,
        exported_at: None,
        profile: profile.clone(),
        extensions: profile.envelope_extensions.clone(),
    };
    conn.execute("INSERT INTO launch_profiles_v2(id,revision,envelope_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,envelope_json=excluded.envelope_json,updated_at=excluded.updated_at",
        params![profile.id, i64::try_from(profile.revision).map_err(|e| e.to_string())?, serde_json::to_string(&envelope).map_err(|e| e.to_string())?, profile.created_at, profile.updated_at])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn write_snapshot(conn: &Connection, snapshot: &FrozenRecovery) -> Result<(), String> {
    validate_snapshot(snapshot, &snapshot.kind)?;
    conn.execute("INSERT INTO kv(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
        params![key(&snapshot.kind), serde_json::to_string(snapshot).map_err(|e| e.to_string())?, chrono::Utc::now().to_rfc3339()]).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_snapshot(conn: &Connection, kind: &str) -> Result<Option<FrozenRecovery>, String> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value_json FROM kv WHERE key=?1",
            [key(kind)],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(stored) = stored {
        let mut snapshot: FrozenRecovery =
            serde_json::from_str(&stored).map_err(|e| format!("Invalid v2 recovery JSON: {e}"))?;
        validate_snapshot(&snapshot, kind)?;
        for envelope in &mut snapshot.profiles {
            envelope.profile.envelope_extensions = envelope.extensions.clone();
        }
        return Ok(Some(snapshot));
    }
    let legacy_key = format!("last_known_good_{kind}");
    let mut legacy: Option<String> = conn
        .query_row(
            "SELECT value_json FROM kv WHERE key=?1",
            [legacy_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if legacy.is_none() && kind == "profile" {
        legacy = conn.query_row("SELECT id,name,description,config_json,created_at,updated_at,last_used_at,last_known_good FROM profiles WHERE last_known_good=1 ORDER BY COALESCE(last_used_at,updated_at) DESC LIMIT 1",
            [], crate::profiles::from_row).optional().map_err(|e| e.to_string())?.map(|profile| serde_json::to_string(&profile).map_err(|e| e.to_string())).transpose()?;
    }
    let Some(legacy) = legacy else {
        return Ok(None);
    };
    let value: Value =
        serde_json::from_str(&legacy).map_err(|e| format!("Invalid legacy recovery JSON: {e}"))?;
    if value.get("schemaVersion").is_some() {
        return Err("Legacy recovery key does not contain the original legacy format".into());
    }
    let (profiles, config, settings) = if kind == "profile" {
        (vec![value], json!({}), json!({}))
    } else {
        (
            value
                .get("profiles")
                .and_then(Value::as_array)
                .ok_or_else(|| "Invalid legacy router profile list".to_string())?
                .clone(),
            value
                .get("config")
                .cloned()
                .ok_or_else(|| "Invalid legacy router config".to_string())?,
            value
                .get("settings")
                .cloned()
                .ok_or_else(|| "Invalid legacy router settings".to_string())?,
        )
    };
    let mut snapshot = FrozenRecovery {
        schema_version: 2,
        kind: kind.into(),
        profiles: Vec::new(),
        config,
        settings,
        secret_references: BTreeMap::new(),
        vault: Vec::new(),
    };
    for profile in profiles {
        // Read old snapshots without treating them as new imports. Retired
        // engines remain viewable/exportable, but restore is separately gated.
        let profile = super::convert_legacy_profile(profile)?;
        snapshot
            .profiles
            .push(freeze_profile(conn, profile, &mut snapshot.vault)?);
    }
    if snapshot.profiles.is_empty() {
        return Err("Legacy recovery has no profiles".into());
    }
    freeze_root(&mut snapshot)?;
    validate_snapshot(&snapshot, kind)?;
    Ok(Some(snapshot))
}

fn mark_profile(conn: &Connection, id: &str, expected_revision: u64) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let repository = ProfileRepository::new(&tx);
    let mut profile = repository
        .get(id)?
        .ok_or_else(|| "Profile not found".to_string())?;
    crate::domain::profile::ensure_supported_engine(&profile.engine)?;
    if profile.revision != expected_revision {
        return Err(PROFILE_CONFLICT.into());
    }
    let timestamp = chrono::Utc::now().to_rfc3339();
    for mut current in repository.list()? {
        current.last_known_good = current.id == id;
        if current.id == id {
            current.last_used_at = Some(timestamp.clone());
        }
        write_profile(&tx, &current)?;
    }
    profile.last_known_good = true;
    profile.last_used_at = Some(timestamp);
    let mut snapshot = FrozenRecovery {
        schema_version: 2,
        kind: "profile".into(),
        profiles: Vec::new(),
        config: json!({}),
        settings: json!({}),
        secret_references: BTreeMap::new(),
        vault: Vec::new(),
    };
    snapshot
        .profiles
        .push(freeze_profile(&tx, profile, &mut snapshot.vault)?);
    write_snapshot(&tx, &snapshot)?;
    tx.commit().map_err(|e| e.to_string())
}

fn mark_router(conn: &Connection, input: RouterRecoveryInput) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let repository = ProfileRepository::new(&tx);
    let mut snapshot = FrozenRecovery {
        schema_version: 2,
        kind: "router".into(),
        profiles: Vec::new(),
        config: input.config,
        settings: input.settings,
        secret_references: BTreeMap::new(),
        vault: Vec::new(),
    };
    for input in input.profiles {
        let expected = input.profile;
        let profile = repository
            .get(&expected.id)?
            .ok_or_else(|| "Router profile not found".to_string())?;
        if profile.revision != expected.revision {
            return Err(PROFILE_CONFLICT.into());
        }
        if profile.engine != "llama_cpp" {
            return Err("Router recovery only supports llama_cpp profiles".into());
        }
        snapshot
            .profiles
            .push(freeze_profile(&tx, profile, &mut snapshot.vault)?);
    }
    if snapshot.profiles.is_empty() {
        return Err("Router recovery needs at least one profile".into());
    }
    freeze_root(&mut snapshot)?;
    write_snapshot(&tx, &snapshot)?;
    tx.commit().map_err(|e| e.to_string())
}

fn bind_router_root(snapshot: &mut FrozenRecovery) -> Result<(), String> {
    if snapshot.kind != "router" {
        return Ok(());
    }
    let selected = snapshot
        .config
        .get("profileId")
        .and_then(Value::as_str)
        .unwrap_or(&snapshot.profiles[0].profile.id)
        .to_string();
    if !snapshot
        .profiles
        .iter()
        .any(|envelope| envelope.profile.id == selected)
    {
        return Err("Router recovery selected profile is missing".into());
    }
    for envelope in &mut snapshot.profiles {
        let profile = &mut envelope.profile;
        if profile.id == selected {
            let mut config = profile.legacy_config.take().unwrap_or_else(|| json!({}));
            super::merge_json(&mut config, snapshot.config.clone());
            profile.legacy_config = Some(config);
        }
        for key in ROUTER_SETTINGS {
            if let Some(value) = snapshot.settings.get(*key) {
                profile
                    .engine_options
                    .values
                    .insert((*key).into(), value.clone());
            }
        }
        for (path, reference) in &snapshot.secret_references {
            let destination = if path == "/settings/routerApiKey" {
                Some("/engineOptions/values/routerApiKey".to_string())
            } else if profile.id == selected {
                let prefix = format!("/config/engineOptions/{}/", profile.engine);
                if let Some(tail) = path.strip_prefix(&prefix) {
                    Some(format!("/engineOptions/values/{tail}"))
                } else {
                    path.strip_prefix("/config")
                        .map(|tail| format!("/legacyConfig{tail}"))
                }
            } else {
                None
            };
            let Some(destination) = destination else {
                continue;
            };
            let mut entry = snapshot
                .vault
                .iter()
                .find(|entry| entry.id == reference.id)
                .ok_or_else(|| "Recovery router credential is missing".to_string())?
                .clone();
            entry.id = uuid::Uuid::new_v4().to_string();
            entry.profile_id = profile.id.clone();
            entry.field_path = format!("/profile{destination}");
            profile.secret_references.insert(
                destination,
                SecretReference {
                    provider: secrets::DPAPI_PROVIDER.into(),
                    id: entry.id.clone(),
                },
            );
            snapshot.vault.push(entry);
        }
    }
    Ok(())
}

fn restore(conn: &Connection, kind: &str) -> Result<FrozenRecovery, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let original = read_snapshot(&tx, kind)?
        .ok_or_else(|| "No known-good recovery snapshot is available".to_string())?;
    let mut snapshot = original.clone();
    for envelope in &snapshot.profiles {
        crate::domain::profile::ensure_supported_engine(&envelope.profile.engine)?;
        if kind == "router" && envelope.profile.engine != "llama_cpp" {
            return Err("Router recovery only supports llama_cpp profiles".into());
        }
    }
    bind_router_root(&mut snapshot)?;
    let timestamp = chrono::Utc::now().to_rfc3339();
    for envelope in &mut snapshot.profiles {
        let profile = &mut envelope.profile;
        // Explicit recovery may repair corrupt current JSON. The SQL revision
        // remains the concurrency counter; this is not a legacy fallback read.
        let current: Option<(i64, String)> = tx
            .query_row(
                "SELECT revision,created_at FROM launch_profiles_v2 WHERE id=?1",
                [&profile.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let current = current
            .map(|(revision, created)| {
                u64::try_from(revision)
                    .map(|revision| (revision, created))
                    .map_err(|e| format!("Invalid current profile revision: {e}"))
            })
            .transpose()?;
        profile.revision = current
            .as_ref()
            .map_or(profile.revision, |current| current.0.max(profile.revision))
            .checked_add(1)
            .ok_or_else(|| "Profile revision overflow".to_string())?;
        if let Some(current) = current {
            profile.created_at = current.1;
        }
        profile.updated_at = timestamp.clone();
        write_profile(&tx, profile)?;
        for reference in profile.secret_references.values() {
            let entry = snapshot
                .vault
                .iter()
                .find(|entry| entry.id == reference.id && entry.profile_id == profile.id)
                .ok_or_else(|| "Recovery profile credential backup is missing".to_string())?;
            tx.execute("INSERT INTO profile_secrets(id,profile_id,field_path,provider,ciphertext,created_at) VALUES(?1,?2,?3,?4,?5,?6)
                ON CONFLICT(profile_id,field_path) DO UPDATE SET id=excluded.id,provider=excluded.provider,ciphertext=excluded.ciphertext,created_at=excluded.created_at",
                params![entry.id, entry.profile_id, entry.field_path, secrets::DPAPI_PROVIDER, entry.ciphertext, entry.created_at]).map_err(|e| e.to_string())?;
        }
    }
    if kind == "router" {
        let raw: Option<String> = tx
            .query_row(
                "SELECT value_json FROM kv WHERE key='settings'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let mut settings: Value = raw
            .map(|raw| {
                serde_json::from_str(&raw).map_err(|e| format!("Stored settings are invalid: {e}"))
            })
            .transpose()?
            .unwrap_or_else(|| json!({}));
        let object = settings
            .as_object_mut()
            .ok_or_else(|| "Stored settings must be an object".to_string())?;
        for key in ROUTER_SETTINGS {
            if let Some(value) = snapshot.settings.get(*key) {
                object.insert((*key).into(), value.clone());
            }
        }
        tx.execute("INSERT INTO kv(key,value_json,updated_at) VALUES('settings',?1,?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
            params![serde_json::to_string(&settings).map_err(|e| e.to_string())?, timestamp]).map_err(|e| e.to_string())?;
    }
    // An explicit legacy restore creates a protected v2 checkpoint, without
    // rewriting the original legacy recovery bytes.
    write_snapshot(&tx, &original)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(snapshot)
}

fn router_ipc(snapshot: FrozenRecovery) -> RouterRecoveryIpc {
    RouterRecoveryIpc {
        schema_version: 2,
        profiles: snapshot
            .profiles
            .into_iter()
            .map(|envelope| envelope.profile.into())
            .collect(),
        config: snapshot.config,
        settings: snapshot.settings,
        secret_references: snapshot.secret_references,
    }
}

/// Retained checkpoints are model consumers even after the live profile is
/// deleted. Catalogue callers receive protected metadata, never plaintext keys.
pub(crate) fn catalog_profiles(conn: &Connection) -> Result<Vec<LaunchProfileV2>, String> {
    let mut profiles = Vec::new();
    for kind in ["profile", "router"] {
        if let Some(snapshot) = read_snapshot(conn, kind)? {
            profiles.extend(
                snapshot
                    .profiles
                    .into_iter()
                    .map(|envelope| envelope.profile),
            );
        }
    }
    Ok(profiles)
}

fn duplicate(
    conn: &Connection,
    id: &str,
    new_id: &str,
    name: &str,
    expected_revision: u64,
) -> Result<LaunchProfileV2, String> {
    if new_id.trim().is_empty() || new_id == id || name.trim().is_empty() {
        return Err("A duplicate needs a new id and a name".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let repository = ProfileRepository::new(&tx);
    let source = repository
        .get(id)?
        .ok_or_else(|| "Profile not found".to_string())?;
    if source.revision != expected_revision || repository.get(new_id)?.is_some() {
        return Err(PROFILE_CONFLICT.into());
    }
    let mut vault = Vec::new();
    let mut profile = freeze_profile(&tx, source, &mut vault)?.profile;
    profile.id = new_id.into();
    profile.name = name.into();
    profile.revision = 1;
    profile.created_at = chrono::Utc::now().to_rfc3339();
    profile.updated_at = profile.created_at.clone();
    profile.last_used_at = None;
    profile.last_known_good = false;
    if let Some(config) = profile
        .legacy_config
        .as_mut()
        .and_then(Value::as_object_mut)
    {
        config.insert("profileId".into(), json!(new_id));
        config.insert("profileName".into(), json!(name));
    }
    let mut copied = std::collections::HashMap::<String, String>::new();
    for reference in profile.secret_references.values_mut() {
        if let Some(id) = copied.get(&reference.id) {
            reference.id = id.clone();
            continue;
        }
        let source_id = reference.id.clone();
        let mut entry = vault
            .iter()
            .find(|entry| entry.id == reference.id)
            .ok_or_else(|| "Duplicate credential backup is missing".to_string())?
            .clone();
        entry.id = uuid::Uuid::new_v4().to_string();
        entry.profile_id = new_id.into();
        reference.id = entry.id.clone();
        tx.execute("INSERT INTO profile_secrets(id,profile_id,field_path,provider,ciphertext,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![entry.id, entry.profile_id, entry.field_path, secrets::DPAPI_PROVIDER, entry.ciphertext, entry.created_at]).map_err(|e| e.to_string())?;
        copied.insert(source_id, reference.id.clone());
    }
    write_profile(&tx, &profile)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(profile)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn duplicate_profile_v2(
    db: State<'_, DbState>,
    id: String,
    new_id: String,
    name: String,
    expected_revision: u64,
) -> Result<ProfileIpc, String> {
    let conn = db.0.lock().await;
    Ok(duplicate(&conn, &id, &new_id, &name, expected_revision)?.into())
}
#[tauri::command(rename_all = "camelCase")]
pub async fn mark_profile_good_v2(
    db: State<'_, DbState>,
    id: String,
    expected_revision: u64,
) -> Result<(), String> {
    let conn = db.0.lock().await;
    mark_profile(&conn, &id, expected_revision)
}
#[tauri::command]
pub async fn last_known_good_profile_v2(
    db: State<'_, DbState>,
) -> Result<Option<ProfileIpc>, String> {
    let conn = db.0.lock().await;
    Ok(read_snapshot(&conn, "profile")?
        .map(|snapshot| snapshot.profiles.into_iter().next().unwrap().profile.into()))
}
#[tauri::command]
pub async fn restore_last_known_good_profile_v2(
    db: State<'_, DbState>,
) -> Result<ProfileIpc, String> {
    let conn = db.0.lock().await;
    Ok(restore(&conn, "profile")?
        .profiles
        .into_iter()
        .next()
        .unwrap()
        .profile
        .into())
}
#[tauri::command]
pub async fn mark_router_good_v2(
    db: State<'_, DbState>,
    snapshot: RouterRecoveryInput,
) -> Result<(), String> {
    let conn = db.0.lock().await;
    mark_router(&conn, snapshot)
}
#[tauri::command]
pub async fn last_known_good_router_v2(
    db: State<'_, DbState>,
) -> Result<Option<RouterRecoveryIpc>, String> {
    let conn = db.0.lock().await;
    Ok(read_snapshot(&conn, "router")?.map(router_ipc))
}
#[tauri::command]
pub async fn restore_last_known_good_router_v2(
    db: State<'_, DbState>,
) -> Result<RouterRecoveryIpc, String> {
    let conn = db.0.lock().await;
    Ok(router_ipc(restore(&conn, "router")?))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE profiles(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT,config_json TEXT NOT NULL,
                created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_used_at TEXT,last_known_good INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE kv(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);").unwrap();
        crate::migrations::migrate(&mut conn).unwrap();
        conn
    }
    fn profile(conn: &Connection, id: &str, credential: Option<&str>) -> LaunchProfileV2 {
        let mut profile = LaunchProfileV2::empty(id, id, "llama_cpp");
        profile.legacy_config = Some(
            json!({"profileId":id,"modelPath":"E:/fake/model.gguf","futureLaunch":{"kept":4}}),
        );
        if let Some(credential) = credential {
            profile.legacy_config.as_mut().unwrap()["apiKey"] = json!(credential);
        }
        profile
            .engine_options
            .values
            .insert("futureKnob".into(), json!(13));
        profile
            .extensions
            .insert("futureProfile".into(), json!([1, 2]));
        profile
            .envelope_extensions
            .insert("futureEnvelope".into(), json!({"a":8}));
        ProfileRepository::new(conn).save(profile, None).unwrap()
    }
    fn raw(conn: &Connection, key: &str) -> Option<String> {
        conn.query_row("SELECT value_json FROM kv WHERE key=?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .unwrap()
    }
    #[cfg(windows)]
    #[test]
    fn good_profile_survives_secret_replacement_delete_and_explicit_restore() {
        let conn = db();
        let original = profile(&conn, "good", Some("checkpoint-only-key"));
        let legacy = r#"{"id":"legacy","name":"Legacy","config":{},"createdAt":"a","updatedAt":"b","lastKnownGood":true}"#;
        conn.execute(
            "INSERT INTO kv VALUES('last_known_good_profile',?1,'a')",
            [legacy],
        )
        .unwrap();
        mark_profile(&conn, "good", 1).unwrap();
        let captured = read_snapshot(&conn, "profile").unwrap().unwrap();
        assert_eq!(captured.profiles[0].profile.revision, 1);
        let safe = raw(&conn, "last_known_good_profile_v2").unwrap();
        assert!(!safe.contains("checkpoint-only-key"));
        assert_eq!(
            raw(&conn, "last_known_good_profile").as_deref(),
            Some(legacy)
        );
        let mut changed = original;
        changed.legacy_config.as_mut().unwrap()["apiKey"] = json!("changed-key");
        let changed = ProfileRepository::new(&conn)
            .save(changed, Some(1))
            .unwrap();
        let restored = restore(&conn, "profile").unwrap();
        assert_eq!(restored.profiles[0].profile.revision, 3);
        assert_eq!(
            ProfileRepository::new(&conn)
                .resolve_launch_config("good")
                .unwrap()["apiKey"],
            "checkpoint-only-key"
        );
        assert_eq!(
            restored.profiles[0].profile.envelope_extensions["futureEnvelope"]["a"],
            8
        );
        assert_eq!(
            restored.profiles[0].profile.extensions["futureProfile"][1],
            2
        );
        ProfileRepository::new(&conn)
            .delete("good", changed.revision + 1)
            .unwrap();
        let restored = restore(&conn, "profile").unwrap();
        assert!(restored.profiles[0].profile.revision > captured.profiles[0].profile.revision);
        assert_eq!(
            ProfileRepository::new(&conn)
                .resolve_launch_config("good")
                .unwrap()["apiKey"],
            "checkpoint-only-key"
        );
        assert_eq!(
            raw(&conn, "last_known_good_profile_v2").unwrap(),
            safe,
            "Immutable checkpoint must retain its original revision"
        );
    }
    #[cfg(windows)]
    #[test]
    fn duplicate_rebinds_ciphertext_and_retains_unknowns_without_exposing_credentials() {
        let conn = db();
        let original = profile(&conn, "source", Some("source-key"));
        let copy = duplicate(&conn, "source", "copy", "Copy", 1).unwrap();
        assert_eq!(copy.revision, 1);
        assert_ne!(copy.secret_references, original.secret_references);
        assert_eq!(copy.extensions, original.extensions);
        assert_eq!(copy.envelope_extensions, original.envelope_extensions);
        ProfileRepository::new(&conn).delete("source", 1).unwrap();
        let launch = ProfileRepository::new(&conn)
            .resolve_launch_config("copy")
            .unwrap();
        assert_eq!(launch["apiKey"], "source-key");
        assert_eq!(launch["profileId"], "copy");
        assert!(!super::super::encode_profile_v2(&copy)
            .unwrap()
            .contains("source-key"));
        assert!(duplicate(&conn, "copy", "another", "Another", 2)
            .unwrap_err()
            .contains("revision conflict"));
    }
    #[cfg(windows)]
    #[test]
    fn router_restore_is_atomic_protected_and_preserves_unrelated_settings() {
        let conn = db();
        let first = profile(&conn, "first", Some("first-original"));
        let second = profile(&conn, "second", Some("second-original"));
        let settings = json!({"language":"ru","theme":"dark","futureSettings":{"kept":true},"routerHost":"changed","routerApiKey":"preexisting-global"});
        conn.execute(
            "INSERT INTO kv VALUES('settings',?1,'a')",
            [settings.to_string()],
        )
        .unwrap();
        let legacy_router = r#"{"profiles":[],"config":{},"settings":{}}"#;
        conn.execute(
            "INSERT INTO kv VALUES('last_known_good_router',?1,'a')",
            [legacy_router],
        )
        .unwrap();
        mark_router(&conn, RouterRecoveryInput { profiles: vec![first.clone().into(), second.clone().into()],
            config: json!({"profileId":"first","engine":"llama_cpp","apiKey":"runtime-key","ctxSize":8192}),
            settings: json!({"routerHost":"127.0.0.1","routerPort":8282,"routerApiKey":"router-checkpoint-key"}) }).unwrap();
        let frozen = raw(&conn, "last_known_good_router_v2").unwrap();
        for secret in [
            "first-original",
            "second-original",
            "runtime-key",
            "router-checkpoint-key",
        ] {
            assert!(!frozen.contains(secret));
        }
        assert_eq!(
            raw(&conn, "last_known_good_router").as_deref(),
            Some(legacy_router)
        );
        assert_eq!(
            raw(&conn, "settings").unwrap(),
            settings.to_string(),
            "Mark must not change global settings"
        );
        let mut changed = first;
        changed.legacy_config.as_mut().unwrap()["apiKey"] = json!("edited");
        ProfileRepository::new(&conn)
            .save(changed, Some(1))
            .unwrap();
        ProfileRepository::new(&conn).delete("second", 1).unwrap();
        let restored = restore(&conn, "router").unwrap();
        assert_eq!(restored.profiles[0].profile.revision, 3);
        assert_eq!(restored.profiles[1].profile.revision, 2);
        let first = ProfileRepository::new(&conn)
            .resolve_launch_config("first")
            .unwrap();
        let second = ProfileRepository::new(&conn)
            .resolve_launch_config("second")
            .unwrap();
        assert_eq!(first["apiKey"], "runtime-key");
        assert_eq!(second["apiKey"], "second-original");
        for config in [&first, &second] {
            assert_eq!(
                config["engineOptions"]["llama_cpp"]["routerApiKey"],
                "router-checkpoint-key"
            );
        }
        let recovered: Value = serde_json::from_str(&raw(&conn, "settings").unwrap()).unwrap();
        assert_eq!(recovered["routerHost"], "127.0.0.1");
        assert_eq!(recovered["routerPort"], 8282);
        assert_eq!(recovered["routerApiKey"], "preexisting-global");
        assert_eq!(recovered["futureSettings"], settings["futureSettings"]);
        assert_eq!(raw(&conn, "last_known_good_router_v2").unwrap(), frozen);
    }
    #[test]
    fn legacy_reads_are_unchanged_and_corrupt_new_snapshots_never_fallback() {
        let conn = db();
        profile(&conn, "good", None);
        let legacy = r#"{"id":"legacy","name":"Legacy","config":{"unknown":1},"createdAt":"a","updatedAt":"b","lastKnownGood":true}"#;
        conn.execute(
            "INSERT INTO kv VALUES('last_known_good_profile',?1,'a')",
            [legacy],
        )
        .unwrap();
        let before = raw(&conn, "last_known_good_profile");
        assert_eq!(
            read_snapshot(&conn, "profile").unwrap().unwrap().profiles[0]
                .profile
                .id,
            "legacy"
        );
        assert_eq!(raw(&conn, "last_known_good_profile"), before);
        assert!(raw(&conn, "last_known_good_profile_v2").is_none());
        conn.execute(
            "INSERT INTO kv VALUES('last_known_good_profile_v2','{broken','a')",
            [],
        )
        .unwrap();
        assert!(read_snapshot(&conn, "profile").is_err());
        assert!(restore(&conn, "profile").is_err());
        assert_eq!(
            ProfileRepository::new(&conn)
                .get("good")
                .unwrap()
                .unwrap()
                .revision,
            1
        );
        assert!(ProfileRepository::new(&conn)
            .get("legacy")
            .unwrap()
            .is_none());
    }
    #[test]
    fn recovery_mark_rejects_stale_revision_without_writes() {
        let conn = db();
        profile(&conn, "good", None);
        assert_eq!(
            mark_profile(&conn, "good", 2).unwrap_err(),
            PROFILE_CONFLICT
        );
        assert!(raw(&conn, "last_known_good_profile_v2").is_none());
        assert!(
            !ProfileRepository::new(&conn)
                .get("good")
                .unwrap()
                .unwrap()
                .last_known_good
        );
    }
}
