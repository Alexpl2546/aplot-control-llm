use super::{lock, read_note, vault, KnowledgeState};
use crate::db::DbState;
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Manager};

async fn scope(app: &AppHandle, task_id: &str) -> Result<(String, Vec<String>), String> {
    let db = app.state::<DbState>();
    let conn = db.0.lock().await;
    let saved = aplot_core::workspace::read_saved(&conn)?.ok_or("project-missing")?;
    let data = &saved["data"];
    let project_id = data["tasks"]
        .as_array()
        .and_then(|tasks| {
            tasks
                .iter()
                .find(|task| task["id"] == task_id && task["deletedAt"].is_null())
        })
        .and_then(|task| task["projectId"].as_str())
        .ok_or("project-missing")?;
    let project = data["projects"]
        .as_array()
        .and_then(|projects| projects.iter().find(|project| project["id"] == project_id))
        .ok_or("project-missing")?;
    let vaults = project["knowledge"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .take(32)
        .map(str::to_owned)
        .collect();
    Ok((project_id.to_owned(), vaults))
}

fn visible_path(project_id: &str, path: &str) -> bool {
    let mut parts = path.split('/');
    if !parts
        .next()
        .is_some_and(|part| part.eq_ignore_ascii_case("Aplot"))
    {
        return true;
    }
    let Some(folder) = parts.next() else {
        return true;
    };
    let suffix = folder.rsplit(" -- ").next().unwrap_or_default();
    uuid::Uuid::parse_str(suffix).map_or(true, |other| other.to_string() == project_id)
}

pub(crate) async fn search(app: &AppHandle, task_id: &str, query: &str) -> Result<Value, String> {
    if query.trim().is_empty() || query.len() > 2048 {
        return Err("knowledge-query".into());
    }
    let (project_id, vault_ids) = scope(app, task_id).await?;
    if vault_ids.is_empty() {
        return Ok(json!([]));
    }
    let inner = app.state::<KnowledgeState>().inner.clone();
    let query = query.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let index = inner.index.as_ref().map_err(Clone::clone)?;
        let hits = lock(index).search(query.as_str(), &vault_ids, 40)?;
        Ok(json!(hits
            .into_iter()
            .filter(|hit| visible_path(&project_id, &hit.path))
            .take(12)
            .collect::<Vec<_>>()))
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) async fn read(
    app: &AppHandle,
    task_id: &str,
    vault_id: &str,
    path: &str,
) -> Result<Value, String> {
    let (project_id, vault_ids) = scope(app, task_id).await?;
    let path = path.replace('\\', "/");
    if !vault_ids.iter().any(|id| id == vault_id) || !visible_path(&project_id, &path) {
        return Err("knowledge-path".into());
    }
    let vault = app.state::<KnowledgeState>().vault(vault_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&vault.path);
        let actual = vault::resolve_inside(root, &path)?;
        let relative = vault::relative(root, &actual).ok_or("knowledge-path")?;
        if !visible_path(&project_id, &relative) {
            return Err("knowledge-path".into());
        }
        let note = read_note(&vault, &path)?;
        let body: String = note.body.chars().take(16_000).collect();
        Ok(json!({"title": note.title, "path": note.path, "body": body, "truncated": body.len() < note.body.len()}))
    }).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_vault_hides_other_projects_generated_notes() {
        let id = uuid::Uuid::new_v4().to_string();
        assert!(visible_path(&id, "Design/Overview.md"));
        assert!(visible_path(
            &id,
            &format!("Aplot/Design -- {id}/Decision.md")
        ));
        assert!(!visible_path(
            &id,
            &format!("Aplot/Other -- {}/Decision.md", uuid::Uuid::new_v4())
        ));
    }
}
