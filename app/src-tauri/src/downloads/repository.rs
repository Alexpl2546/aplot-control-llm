use super::DownloadTask;
use rusqlite::{params, Connection};

/// An independent durable store: rebuilding model_artifacts cannot erase history.
pub fn init_schema(conn: &Connection) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("
        CREATE TABLE IF NOT EXISTS model_download_schema(version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS model_downloads(id TEXT PRIMARY KEY, task_json TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS model_download_files(download_id TEXT NOT NULL, path TEXT NOT NULL, file_json TEXT NOT NULL, PRIMARY KEY(download_id,path), FOREIGN KEY(download_id) REFERENCES model_downloads(id));
        CREATE TABLE IF NOT EXISTS model_installations(id TEXT PRIMARY KEY, installed_path TEXT NOT NULL, manifest_json TEXT NOT NULL, installed_at TEXT NOT NULL);
        INSERT OR IGNORE INTO model_download_schema(version) VALUES(1);").map_err(|e| e.to_string())?;
    let version: i64 = tx
        .query_row(
            "SELECT MAX(version) FROM model_download_schema",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if version > 1 {
        return Err("Download history uses a newer schema version".into());
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn save(conn: &mut Connection, task: &DownloadTask) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO model_downloads(id,task_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET task_json=excluded.task_json,updated_at=excluded.updated_at",params![task.id, serde_json::to_string(task).map_err(|e| e.to_string())?,task.updated_at]).map_err(|e|e.to_string())?;
    for file in &task.plan.files {
        tx.execute("INSERT INTO model_download_files(download_id,path,file_json) VALUES(?1,?2,?3) ON CONFLICT(download_id,path) DO UPDATE SET file_json=excluded.file_json",params![task.id,file.path,serde_json::to_string(file).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    }
    if let Some(path) = &task.installed_path {
        tx.execute("INSERT INTO model_installations(id,installed_path,manifest_json,installed_at) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET installed_path=excluded.installed_path,manifest_json=excluded.manifest_json",params![task.id,path,serde_json::to_string(task).map_err(|e|e.to_string())?,task.updated_at]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn list(conn: &Connection) -> Result<Vec<DownloadTask>, String> {
    let mut stmt = conn
        .prepare("SELECT task_json FROM model_downloads ORDER BY updated_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|e| e.to_string())?)
            .map_err(|e| format!("Invalid download history: {e}"))
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn schema_is_repeatable_and_independent() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        init_schema(&conn).unwrap();
        conn.execute_batch("CREATE TABLE model_artifacts(id TEXT); DROP TABLE model_artifacts;")
            .unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }
}
