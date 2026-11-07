//! Local administrative workspace commands. No network mutation API is enabled.
use crate::ServerData;
use aplot_core::{tasks::store, workspace};
use serde_json::{json, Value};
use std::{io, path::Path};

fn saved_data(conn: &rusqlite::Connection) -> io::Result<(Value, u64)> {
    match workspace::read_saved(conn).map_err(io::Error::other)? {
        Some(saved) => {
            if saved["version"] != 2 {
                return Err(io::Error::other("workspace-version"));
            }
            workspace::validate(&saved["data"]).map_err(io::Error::other)?;
            let revision = saved["revision"]
                .as_u64()
                .ok_or_else(|| io::Error::other("workspace-invalid"))?;
            Ok((saved["data"].clone(), revision))
        }
        None => Ok((
            json!({"projects":[],"tasks":[],"presets":[],"threads":{},"memory":[]}),
            0,
        )),
    }
}

impl ServerData {
    /// Registers an existing root. This neither clones nor edits project files.
    pub fn register_project(&mut self, path: &Path, name: &str) -> io::Result<Value> {
        let root = path.canonicalize()?;
        if !root.is_dir() || name.trim().is_empty() || name.chars().count() > 120 {
            return Err(io::Error::other("project-invalid"));
        }
        let (mut data, revision) = saved_data(&self.tasks)?;
        let id = uuid::Uuid::new_v4().to_string();
        let project = json!({"id":id,"name":name.trim(),"path":root.to_string_lossy(),"createdAt":store::millis(),"updatedAt":store::millis()});
        data["projects"]
            .as_array_mut()
            .unwrap()
            .push(project.clone());
        let revision =
            workspace::write_saved(&mut self.tasks, data, revision).map_err(io::Error::other)?;
        Ok(json!({"project":project,"revision":revision}))
    }

    /// Creates workspace metadata and its journal aggregate atomically.
    pub fn new_task(&mut self, project_id: &str, name: &str) -> io::Result<Value> {
        if name.trim().is_empty() || name.chars().count() > 120 {
            return Err(io::Error::other("task-invalid"));
        }
        let (mut data, revision) = saved_data(&self.tasks)?;
        if !data["projects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|project| project["id"] == project_id)
        {
            return Err(io::Error::other("project-missing"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let task = json!({"id":id,"projectId":project_id,"title":name.trim(),"runtime":"codex","accessMode":"restricted","createdAt":store::millis(),"updatedAt":store::millis(),"archived":false,"unread":false});
        data["tasks"].as_array_mut().unwrap().push(task.clone());
        let tx = self.tasks.transaction().map_err(io::Error::other)?;
        let revision =
            workspace::write_saved_in_transaction(&tx, data, revision).map_err(io::Error::other)?;
        store::Journal::new(&tx)
            .ensure_task(&id, "codex")
            .map_err(io::Error::other)?;
        tx.commit().map_err(io::Error::other)?;
        Ok(json!({"task":task,"revision":revision}))
    }

    pub fn workspace_snapshot(&self) -> io::Result<Value> {
        let (data, revision) = saved_data(&self.tasks)?;
        Ok(json!({"version":2,"revision":revision,"data":data}))
    }

    #[cfg(test)]
    fn task_working_directory(&self, task_id: &str) -> io::Result<std::path::PathBuf> {
        task_working_directory(&self.tasks, task_id)
    }
}

pub(crate) fn task_working_directory(
    conn: &rusqlite::Connection,
    task_id: &str,
) -> io::Result<std::path::PathBuf> {
    let (data, _) = saved_data(conn)?;
    let task = data["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == task_id)
        .ok_or_else(|| io::Error::other("task-missing"))?;
    if task["deletedAt"].as_i64().is_some_and(|value| value > 0)
        || task["archived"] == true
        || task["runtime"] != "codex"
    {
        return Err(io::Error::other("task-unavailable"));
    }
    let root = std::path::PathBuf::from(
        workspace::task_project_path(conn, task_id).map_err(io::Error::other)?,
    )
    .canonicalize()?;
    if !root.is_dir() {
        return Err(io::Error::other("folder"));
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registered_project_and_task_survive_reopen_and_failed_creation_is_atomic() {
        let directory =
            std::env::temp_dir().join(format!("aplot-workspace-{}", uuid::Uuid::new_v4()));
        let project_root = directory.join("project");
        std::fs::create_dir_all(&project_root).unwrap();
        let mut server = ServerData::open(&directory.join("server")).unwrap();
        let project = server.register_project(&project_root, "test").unwrap();
        let before = server.workspace_snapshot().unwrap();
        assert!(server.new_task("missing", "task").is_err());
        assert_eq!(server.workspace_snapshot().unwrap(), before);
        let task = server
            .new_task(project["project"]["id"].as_str().unwrap(), "task")
            .unwrap();
        let task_id = task["task"]["id"].as_str().unwrap();
        assert_eq!(
            server.task_working_directory(task_id).unwrap(),
            project_root.canonicalize().unwrap()
        );
        assert!(store::read_task(&server.tasks, task_id).unwrap().is_some());
        let snapshot = server.workspace_snapshot().unwrap();
        drop(server);
        let reopened = ServerData::open(&directory.join("server")).unwrap();
        assert_eq!(reopened.workspace_snapshot().unwrap(), snapshot);
        drop(reopened);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
