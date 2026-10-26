//! Bounded, structured application events; raw stdout remains in the technical log.
use crate::db::DbState;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn activity_list(db: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let conn = db.0.lock().await;
    let mut query = conn
        .prepare(
            "SELECT payload_json FROM events WHERE kind='activity.v1' ORDER BY id DESC LIMIT 500",
        )
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    Ok(rows
        .filter_map(|r| r.ok().and_then(|s| serde_json::from_str(&s).ok()))
        .collect())
}

#[tauri::command]
pub async fn activity_record(db: State<'_, DbState>, event: Value) -> Result<(), String> {
    if !event.is_object()
        || event.to_string().len() > 12_000
        || !event["id"].is_string()
        || !event["time"].is_u64()
        || ![
            "server.state",
            "server.issue",
            "profile.saved",
            "agent.started",
            "agent.completed",
            "agent.closed",
            "agent.tool",
            "agent.approval",
            "agent.access",
        ]
        .contains(&event["kind"].as_str().unwrap_or(""))
    {
        return Err("activity-invalid".into());
    }
    let conn = db.0.lock().await;
    conn.execute(
        "INSERT INTO events(timestamp,kind,payload_json) VALUES(?1,'activity.v1',?2)",
        rusqlite::params![chrono::Utc::now().to_rfc3339(), event.to_string()],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM events WHERE kind='activity.v1' AND id NOT IN (SELECT id FROM events WHERE kind='activity.v1' ORDER BY id DESC LIMIT 2000)",[]).map_err(|e|e.to_string())?;
    Ok(())
}
