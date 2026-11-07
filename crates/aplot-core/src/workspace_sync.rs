//! Versioned workspace snapshots for clients that perform three-way merging.
//!
//! Snapshot reads are deliberately read-only. The desktop's ordinary load
//! path still owns legacy import and artifact relocation; this module reads
//! only the persisted v2 envelope and supplies an empty one when no workspace
//! has been saved yet.

use crate::workspace;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const VERSION: u32 = 2;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct WorkspaceSnapshot {
    pub version: u32,
    pub revision: u64,
    pub data: Value,
}

impl WorkspaceSnapshot {
    /// Empty persisted shape used before the first workspace save.
    pub fn empty() -> Self {
        Self {
            version: VERSION,
            revision: 0,
            data: json!({
                "projects": [],
                "tasks": [],
                "threads": {},
                "memory": [],
            }),
        }
    }

    fn from_value(value: Value) -> Result<Self, String> {
        if value["version"].as_u64() != Some(VERSION as u64) {
            return Err("workspace-version".into());
        }
        let revision = value["revision"].as_u64().ok_or("workspace-invalid")?;
        let data = value.get("data").cloned().ok_or("workspace-invalid")?;
        workspace::validate(&data)?;
        Ok(Self {
            version: VERSION,
            revision,
            data,
        })
    }
}

/// Read the saved v2 envelope without importing legacy data or modifying it.
pub fn read_saved(conn: &Connection) -> Result<Option<WorkspaceSnapshot>, String> {
    workspace::read_saved(conn)?
        .map(WorkspaceSnapshot::from_value)
        .transpose()
}

/// Return the saved workspace or a valid empty v2 snapshot.
pub fn snapshot(conn: &Connection) -> Result<WorkspaceSnapshot, String> {
    Ok(read_saved(conn)?.unwrap_or_else(WorkspaceSnapshot::empty))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE kv(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    fn data() -> Value {
        let path = if cfg!(windows) {
            "C:\\workspace"
        } else {
            "/workspace"
        };
        json!({
            "projects":[{"id":"project-1","name":"Project","path":path}],
            "tasks":[],
            "threads":{},
            "memory":[]
        })
    }

    #[test]
    fn missing_workspace_returns_an_empty_v2_snapshot_without_persisting_it() {
        let conn = db();
        assert_eq!(read_saved(&conn).unwrap(), None);
        assert_eq!(
            snapshot(&conn).unwrap(),
            WorkspaceSnapshot {
                version: 2,
                revision: 0,
                data: json!({"projects":[],"tasks":[],"threads":{},"memory":[]}),
            }
        );
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM kv", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn saved_snapshot_preserves_revision_and_validates_the_data() {
        let conn = db();
        let envelope = json!({"version":2,"revision":13,"data":data()});
        conn.execute(
            "INSERT INTO kv(key,value_json,updated_at) VALUES(?1,?2,'now')",
            rusqlite::params![workspace::KEY, envelope.to_string()],
        )
        .unwrap();
        assert_eq!(
            snapshot(&conn).unwrap(),
            WorkspaceSnapshot {
                version: 2,
                revision: 13,
                data: data(),
            }
        );
    }

    #[test]
    fn wrong_version_or_invalid_saved_data_is_rejected() {
        let conn = db();
        let envelope = json!({"version":3,"revision":1,"data":data()});
        conn.execute(
            "INSERT INTO kv(key,value_json,updated_at) VALUES(?1,?2,'now')",
            rusqlite::params![workspace::KEY, envelope.to_string()],
        )
        .unwrap();
        assert_eq!(snapshot(&conn).unwrap_err(), "workspace-version");
        conn.execute(
            "UPDATE kv SET value_json=?2 WHERE key=?1",
            rusqlite::params![
                workspace::KEY,
                json!({"version":2,"revision":1,"data":{"projects":[]}}).to_string()
            ],
        )
        .unwrap();
        assert_eq!(snapshot(&conn).unwrap_err(), "workspace-invalid");
    }

    #[test]
    fn snapshot_reads_share_the_caller_transaction_and_rollback_cleanly() {
        let mut conn = db();
        let first = json!({"version":2,"revision":1,"data":data()});
        conn.execute(
            "INSERT INTO kv(key,value_json,updated_at) VALUES(?1,?2,'now')",
            rusqlite::params![workspace::KEY, first.to_string()],
        )
        .unwrap();
        let tx = conn.transaction().unwrap();
        assert_eq!(snapshot(&tx).unwrap().revision, 1);
        let mut changed = data();
        changed["projects"][0]["name"] = json!("Changed in transaction");
        workspace::write_saved_in_transaction(&tx, changed, 1).unwrap();
        let uncommitted = snapshot(&tx).unwrap();
        assert_eq!(uncommitted.revision, 2);
        assert_eq!(
            uncommitted.data["projects"][0]["name"],
            "Changed in transaction"
        );
        tx.rollback().unwrap();
        let after_rollback = snapshot(&conn).unwrap();
        assert_eq!(after_rollback.revision, 1);
        assert_eq!(after_rollback.data["projects"][0]["name"], "Project");
    }

    #[test]
    fn workspace_and_task_cursor_are_visible_from_one_transactional_snapshot() {
        let mut conn = db();
        crate::tasks::store::create_schema(&conn).unwrap();
        let setup = conn.transaction().unwrap();
        let mut journal = crate::tasks::store::Journal::new(&setup);
        journal.ensure_task("caller", "codex").unwrap();
        setup.commit().unwrap();
        workspace::write_saved(&mut conn, data(), 0).unwrap();
        let starting_cursor = crate::tasks::store::cursor(&conn).unwrap();

        let tx = conn.transaction().unwrap();
        let mut changed = data();
        changed["projects"][0]["name"] = json!("Delegated project");
        let next_revision = workspace::write_saved_in_transaction(&tx, changed, 1).unwrap();
        let mut journal = crate::tasks::store::Journal::new(&tx);
        journal
            .record_workspace_revision("caller", next_revision, Some("child"))
            .unwrap();
        let workspace = snapshot(&tx).unwrap();
        let cursor = crate::tasks::store::cursor(&tx).unwrap();
        assert_eq!(workspace.revision, 2);
        assert!(cursor > starting_cursor);
        tx.rollback().unwrap();

        assert_eq!(snapshot(&conn).unwrap().revision, 1);
        assert_eq!(crate::tasks::store::cursor(&conn).unwrap(), starting_cursor);
    }

    #[test]
    fn newer_snapshot_revision_causes_stale_cas_writes_to_conflict() {
        let mut conn = db();
        let initial = data();
        workspace::write_saved(&mut conn, initial.clone(), 0).unwrap();
        let mut newer = initial.clone();
        newer["projects"][0]["name"] = json!("Remote update");
        assert_eq!(workspace::write_saved(&mut conn, newer, 1).unwrap(), 2);
        let remote = snapshot(&conn).unwrap();
        assert_eq!(remote.revision, 2);
        assert_eq!(remote.data["projects"][0]["name"], "Remote update");
        assert_eq!(
            workspace::write_saved(&mut conn, initial, 1).unwrap_err(),
            "workspace-conflict"
        );
        assert_eq!(snapshot(&conn).unwrap(), remote);
    }
}
