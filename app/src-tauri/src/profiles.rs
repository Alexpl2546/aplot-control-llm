use crate::db::DbState;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProfile {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub config: Value,
    pub created_at: String,
    pub updated_at: String,
    pub last_used_at: Option<String>,
    pub last_known_good: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterRecoverySnapshot {
    pub profiles: Vec<LaunchProfile>,
    pub config: Value,
    pub settings: Value,
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LaunchProfile> {
    let json: String = row.get(3)?;
    Ok(LaunchProfile {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        config: serde_json::from_str(&json).unwrap_or(Value::Null),
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        last_used_at: row.get(6)?,
        last_known_good: row.get::<_, i64>(7)? != 0,
    })
}

#[tauri::command]
pub async fn list_profiles(db: State<'_, DbState>) -> Result<Vec<LaunchProfile>, String> {
    let conn = db.0.lock().await;
    let mut stmt = conn.prepare("SELECT id,name,description,config_json,created_at,updated_at,last_used_at,last_known_good FROM profiles ORDER BY COALESCE(last_used_at, updated_at) DESC").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], from_row).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_profile(
    db: State<'_, DbState>,
    profile: LaunchProfile,
) -> Result<LaunchProfile, String> {
    let conn = db.0.lock().await;
    conn.execute(
        "INSERT INTO profiles(id,name,description,config_json,created_at,updated_at,last_used_at,last_known_good)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, config_json=excluded.config_json, updated_at=excluded.updated_at, last_used_at=excluded.last_used_at, last_known_good=excluded.last_known_good",
        params![&profile.id, &profile.name, &profile.description, profile.config.to_string(), &profile.created_at, &profile.updated_at, &profile.last_used_at, profile.last_known_good as i64]
    ).map_err(|e| e.to_string())?;
    Ok(profile)
}

#[tauri::command]
pub async fn delete_profile(db: State<'_, DbState>, id: String) -> Result<(), String> {
    let conn = db.0.lock().await;
    conn.execute("DELETE FROM profiles WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn mark_profile_good(db: State<'_, DbState>, id: String) -> Result<(), String> {
    let conn = db.0.lock().await;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let timestamp = chrono::Utc::now().to_rfc3339();
    tx.execute("UPDATE profiles SET last_known_good=0", [])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE profiles SET last_known_good=1, last_used_at=?2 WHERE id=?1",
        params![&id, &timestamp],
    )
    .map_err(|e| e.to_string())?;
    let snapshot = tx.query_row(
        "SELECT id,name,description,config_json,created_at,updated_at,last_used_at,last_known_good FROM profiles WHERE id=?1",
        [&id],
        from_row,
    ).map_err(|e| e.to_string())?;
    let snapshot_json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO kv(key,value_json,updated_at) VALUES('last_known_good_profile',?1,?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
        params![snapshot_json, &timestamp],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn last_known_good_profile(
    db: State<'_, DbState>,
) -> Result<Option<LaunchProfile>, String> {
    let conn = db.0.lock().await;
    let snapshot_json: Option<String> = conn
        .query_row(
            "SELECT value_json FROM kv WHERE key='last_known_good_profile'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(json) = snapshot_json {
        if let Ok(profile) = serde_json::from_str::<LaunchProfile>(&json) {
            return Ok(Some(profile));
        }
    }
    conn.query_row(
        "SELECT id,name,description,config_json,created_at,updated_at,last_used_at,last_known_good FROM profiles WHERE last_known_good=1 ORDER BY COALESCE(last_used_at,updated_at) DESC LIMIT 1",
        [],
        from_row,
    ).optional().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mark_router_good(
    db: State<'_, DbState>,
    snapshot: RouterRecoverySnapshot,
) -> Result<(), String> {
    if snapshot.profiles.is_empty() {
        return Err("A router recovery snapshot must contain at least one profile.".into());
    }
    let conn = db.0.lock().await;
    let json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO kv(key,value_json,updated_at) VALUES('last_known_good_router',?1,?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
        params![json, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn last_known_good_router(
    db: State<'_, DbState>,
) -> Result<Option<RouterRecoverySnapshot>, String> {
    let conn = db.0.lock().await;
    let json: Option<String> = conn
        .query_row(
            "SELECT value_json FROM kv WHERE key='last_known_good_router'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(json.and_then(|value| serde_json::from_str(&value).ok()))
}

#[tauri::command]
pub async fn restore_last_known_good_router(
    db: State<'_, DbState>,
) -> Result<RouterRecoverySnapshot, String> {
    let mut conn = db.0.lock().await;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let json: String = tx
        .query_row(
            "SELECT value_json FROM kv WHERE key='last_known_good_router'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No known-good router snapshot is available.".to_string())?;
    let snapshot: RouterRecoverySnapshot =
        serde_json::from_str(&json).map_err(|e| format!("Invalid router snapshot: {e}"))?;
    if snapshot.profiles.is_empty() {
        return Err("The known-good router snapshot has no profiles.".into());
    }

    for profile in &snapshot.profiles {
        let config_json = serde_json::to_string(&profile.config).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO profiles(id,name,description,config_json,created_at,updated_at,last_used_at,last_known_good) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,config_json=excluded.config_json,updated_at=excluded.updated_at,last_used_at=excluded.last_used_at,last_known_good=excluded.last_known_good",
            params![
                &profile.id,
                &profile.name,
                &profile.description,
                config_json,
                &profile.created_at,
                &profile.updated_at,
                &profile.last_used_at,
                profile.last_known_good as i64,
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    let current_settings: Option<String> = tx
        .query_row(
            "SELECT value_json FROM kv WHERE key='settings'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let mut settings = current_settings
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let settings_object = settings
        .as_object_mut()
        .ok_or_else(|| "Stored application settings are invalid.".to_string())?;
    for key in [
        "binaryPath",
        "serverMode",
        "routerHost",
        "routerPort",
        "routerMaxLoadedModels",
        "routerAutoload",
        "routerApiKey",
    ] {
        if let Some(value) = snapshot.settings.get(key) {
            settings_object.insert(key.into(), value.clone());
        }
    }
    tx.execute(
        "INSERT INTO kv(key,value_json,updated_at) VALUES('settings',?1,?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
        params![serde_json::to_string(&settings).map_err(|e| e.to_string())?, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(snapshot)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileExport {
    schema_version: u32,
    exported_at: String,
    profile: LaunchProfile,
}

#[tauri::command]
pub async fn export_profile(
    db: State<'_, DbState>,
    id: String,
    path: String,
) -> Result<(), String> {
    let profile = {
        let conn = db.0.lock().await;
        conn.query_row(
            "SELECT id,name,description,config_json,created_at,updated_at,last_used_at,last_known_good FROM profiles WHERE id=?1",
            [id],
            from_row,
        ).optional().map_err(|e| e.to_string())?
    }.ok_or_else(|| "Profile not found".to_string())?;
    let payload = ProfileExport {
        schema_version: 1,
        exported_at: chrono::Utc::now().to_rfc3339(),
        profile,
    };
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to export profile to {path}: {e}"))
}

#[tauri::command]
pub async fn import_profile(db: State<'_, DbState>, path: String) -> Result<LaunchProfile, String> {
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read profile {path}: {e}"))?;
    let mut profile = serde_json::from_str::<ProfileExport>(&text)
        .map(|x| x.profile)
        .or_else(|_| serde_json::from_str::<LaunchProfile>(&text))
        .map_err(|e| format!("Invalid Aplot Control LLM profile JSON: {e}"))?;
    if profile.config.is_null() || !profile.config.is_object() {
        return Err("Imported profile has no valid config object".into());
    }
    let exists = {
        let conn = db.0.lock().await;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM profiles WHERE id=?1)",
            [&profile.id],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?
            != 0
    };
    if exists {
        profile.id = uuid::Uuid::new_v4().to_string();
        profile.name = format!("{} (Imported)", profile.name);
    }
    if let serde_json::Value::Object(config) = &mut profile.config {
        config.insert(
            "profileId".into(),
            serde_json::Value::String(profile.id.clone()),
        );
        config.insert(
            "profileName".into(),
            serde_json::Value::String(profile.name.clone()),
        );
    }
    profile.created_at = chrono::Utc::now().to_rfc3339();
    profile.updated_at = profile.created_at.clone();
    profile.last_used_at = None;
    profile.last_known_good = false;
    {
        let conn = db.0.lock().await;
        conn.execute(
            "INSERT INTO profiles(id,name,description,config_json,created_at,updated_at,last_used_at,last_known_good) VALUES(?1,?2,?3,?4,?5,?6,NULL,0)",
            params![&profile.id, &profile.name, &profile.description, profile.config.to_string(), &profile.created_at, &profile.updated_at]
        ).map_err(|e| e.to_string())?;
    }
    Ok(profile)
}
