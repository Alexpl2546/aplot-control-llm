use crate::db::DbState;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatPreferences {
    #[serde(default)]
    global_instructions: String,
}

#[tauri::command]
pub async fn chat_preferences_load(db: State<'_, DbState>) -> Result<ChatPreferences, String> {
    let conn = db.0.lock().await;
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM kv WHERE key='chat.preferences.v1'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "storage")?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|_| "chat-preferences-invalid".into()))
        .unwrap_or_else(|| Ok(ChatPreferences::default()))
}

#[tauri::command]
pub async fn chat_preferences_save(
    db: State<'_, DbState>,
    preferences: ChatPreferences,
) -> Result<(), String> {
    if preferences.global_instructions.len() > 32000 {
        return Err("limit".into());
    }
    let raw = serde_json::to_string(&preferences).map_err(|_| "chat-preferences-invalid")?;
    db.0.lock().await.execute("INSERT INTO kv(key,value_json,updated_at) VALUES('chat.preferences.v1',?1,?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at", rusqlite::params![raw,chrono::Utc::now().to_rfc3339()]).map_err(|_| "storage")?;
    Ok(())
}
