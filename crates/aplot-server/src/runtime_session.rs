//! Native conversation identity belongs to a particular execution profile.
use crate::{codex_runtime::CodexRunConfig, ServerData};
use aplot_core::{tasks::store, workspace};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::io;

pub(crate) fn create_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS server_runtime_bindings(task_id TEXT PRIMARY KEY REFERENCES agent_tasks(id) ON DELETE CASCADE, profile_json TEXT NOT NULL, thread_id TEXT, account_fingerprint TEXT);").map_err(|e|e.to_string())?;
    let has_account:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('server_runtime_bindings') WHERE name='account_fingerprint')",[],|row|row.get(0)).map_err(|e|e.to_string())?;
    if !has_account {
        conn.execute_batch(
            "ALTER TABLE server_runtime_bindings ADD COLUMN account_fingerprint TEXT;",
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_unbound_sessions_require_reset_and_changed_accounts_cannot_attach() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::create_schema(&conn).unwrap();
        create_schema(&conn).unwrap();
        let mut config = CodexRunConfig {
            executable: std::env::current_exe().unwrap(),
            codex_home: std::env::temp_dir().join("fixture-profile"),
            working_directory: std::env::temp_dir(),
            model: "fixture".into(),
            timeout: std::time::Duration::from_secs(1),
            access_mode: None,
            resume_thread_id: None,
        };
        let tx = conn.transaction().unwrap();
        let mut journal = store::Journal::new(&tx);
        journal.ensure_task("task", "codex").unwrap();
        journal
            .edit_state("task", |state| {
                state.native_session_id = Some("legacy-thread".into())
            })
            .unwrap();
        assert_eq!(
            bind(&tx, "task", &mut config).unwrap_err(),
            "runtime-session-binding-missing"
        );
        journal
            .edit_state("task", |state| state.native_session_id = None)
            .unwrap();
        bind(&tx, "task", &mut config).unwrap();
        attach_account(&tx, "task", &"a".repeat(64)).unwrap();
        attach_thread(&tx, "task", "thread").unwrap();
        journal
            .edit_state("task", |state| {
                state.native_session_id = Some("thread".into())
            })
            .unwrap();
        bind(&tx, "task", &mut config).unwrap();
        assert_eq!(config.resume_thread_id.as_deref(), Some("thread"));
        assert_eq!(
            attach_account(&tx, "task", &"b".repeat(64)).unwrap_err(),
            "runtime-account-changed"
        );
        tx.execute(
            "UPDATE server_runtime_bindings SET account_fingerprint=NULL",
            [],
        )
        .unwrap();
        assert_eq!(
            attach_account(&tx, "task", &"a".repeat(64)).unwrap_err(),
            "runtime-account-binding-missing"
        );
    }

    #[test]
    fn reserved_identity_is_enforced_before_a_child_has_a_native_thread() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::create_schema(&conn).unwrap();
        create_schema(&conn).unwrap();
        let mut config = CodexRunConfig {
            executable: std::env::current_exe().unwrap(),
            codex_home: std::env::temp_dir().join("reserved-fixture-home"),
            working_directory: std::env::temp_dir(),
            model: "fixture".into(),
            timeout: std::time::Duration::from_secs(1),
            access_mode: None,
            resume_thread_id: None,
        };
        let tx = conn.transaction().unwrap();
        store::Journal::new(&tx)
            .ensure_task("child", "codex")
            .unwrap();
        bind(&tx, "child", &mut config).unwrap();
        assert!(!has_binding(&tx, "child").unwrap());
        attach_account(&tx, "child", &"a".repeat(64)).unwrap();
        assert!(has_binding(&tx, "child").unwrap());
        assert_eq!(
            attach_account(&tx, "child", &"b".repeat(64)).unwrap_err(),
            "runtime-account-changed"
        );
        let mut changed = config.clone();
        changed.codex_home = std::env::temp_dir().join("different-home");
        assert_eq!(
            bind(&tx, "child", &mut changed).unwrap_err(),
            "runtime-binding-changed"
        );
        bind(&tx, "child", &mut config).unwrap();
        assert!(config.resume_thread_id.is_none());
        let mut legacy = profile(&config);
        legacy.as_object_mut().unwrap().remove("toolset");
        tx.execute(
            "UPDATE server_runtime_bindings SET profile_json=?1",
            [legacy.to_string()],
        )
        .unwrap();
        assert_eq!(
            bind(&tx, "child", &mut config).unwrap_err(),
            "runtime-binding-changed"
        );
    }

    #[test]
    fn explicit_access_change_preserves_account_thread_and_other_profile_fields() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::create_schema(&conn).unwrap();
        create_schema(&conn).unwrap();
        let mut restricted = CodexRunConfig {
            executable: std::env::current_exe().unwrap(),
            codex_home: std::env::temp_dir().join("mode-fixture-home"),
            working_directory: std::env::temp_dir(),
            model: "fixture".into(),
            timeout: std::time::Duration::from_secs(1),
            access_mode: Some("restricted".into()),
            resume_thread_id: None,
        };
        let tx = conn.transaction().unwrap();
        let mut journal = store::Journal::new(&tx);
        journal.ensure_task("task-mode", "codex").unwrap();
        bind(&tx, "task-mode", &mut restricted).unwrap();
        attach_account(&tx, "task-mode", &"a".repeat(64)).unwrap();
        attach_thread(&tx, "task-mode", "thread-kept").unwrap();
        journal
            .edit_state("task-mode", |state| {
                state.native_session_id = Some("thread-kept".into())
            })
            .unwrap();
        drop(journal);

        // A historical read-only profile means restricted, and an explicit
        // owner change is allowed to replace only this profile field.
        let mut legacy = profile(&restricted);
        legacy["access"] = json!("read-only");
        tx.execute(
            "UPDATE server_runtime_bindings SET profile_json=?1",
            [legacy.to_string()],
        )
        .unwrap();
        change_access_mode(&tx, "task-mode", "full").unwrap();
        let mut full = restricted.clone();
        full.access_mode = Some("full".into());
        bind(&tx, "task-mode", &mut full).unwrap();
        assert_eq!(full.resume_thread_id.as_deref(), Some("thread-kept"));

        let (raw, thread, account): (String, Option<String>, Option<String>) = tx
            .query_row(
                "SELECT profile_json,thread_id,account_fingerprint FROM server_runtime_bindings WHERE task_id='task-mode'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let saved: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(saved, profile(&full));
        assert_eq!(thread.as_deref(), Some("thread-kept"));
        assert_eq!(account.as_deref(), Some("a".repeat(64).as_str()));
    }
}

/// Resolve the task's saved access mode. Missing settings and the former
/// read-only spelling are restricted; manual approvals are not implemented
/// by this runtime and must never silently broaden execution.
pub(crate) fn saved_access_mode(task: &Value) -> Result<&'static str, String> {
    match task.get("accessMode") {
        None | Some(Value::Null) => Ok("restricted"),
        Some(Value::String(mode)) => normalize_access_mode(Some(mode)),
        _ => Err("codex-access-mode-invalid".into()),
    }
}

pub(crate) fn normalize_access_mode(mode: Option<&str>) -> Result<&'static str, String> {
    match mode.unwrap_or("restricted") {
        "restricted" | "read-only" => Ok("restricted"),
        "full" => Ok("full"),
        _ => Err("codex-access-mode-invalid".into()),
    }
}

fn config_access_mode(config: &CodexRunConfig) -> Result<&'static str, String> {
    normalize_access_mode(config.access_mode.as_deref())
}

/// Run before thread/resume so a changed login never receives stored context.
pub(crate) fn attach_account(
    tx: &Transaction<'_>,
    task_id: &str,
    fingerprint: &str,
) -> Result<(), String> {
    if fingerprint.len() != 64 || !fingerprint.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("runtime-account-identity-invalid".into());
    }
    let (thread, previous): (Option<String>, Option<String>) = tx
        .query_row(
            "SELECT thread_id,account_fingerprint FROM server_runtime_bindings WHERE task_id=?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    if thread.is_some() && previous.is_none() {
        return Err("runtime-account-binding-missing".into());
    }
    if let Some(old) = previous {
        if old != fingerprint {
            return Err("runtime-account-changed".into());
        }
    }
    tx.execute(
        "UPDATE server_runtime_bindings SET account_fingerprint=?2 WHERE task_id=?1",
        params![task_id, fingerprint],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn profile(config: &CodexRunConfig) -> Value {
    json!({"runtime":"codex","executable":config.executable,"home":config.codex_home,"model":config.model,"cwd":config.working_directory,"access":config_access_mode(config).unwrap_or("restricted"),"toolset":"aplot-dynamic-v1"})
}

/// Apply an owner's explicit task-mode change to an existing runtime binding.
/// The native thread and all profile identity fields are preserved byte for
/// byte; only the profile's access field is replaced.
pub(crate) fn change_access_mode(
    tx: &Transaction<'_>,
    task_id: &str,
    access_mode: &str,
) -> Result<(), String> {
    if !matches!(access_mode, "restricted" | "full") {
        return Err("codex-access-mode-invalid".into());
    }
    let saved: Option<(String, Option<String>)> = tx
        .query_row(
            "SELECT profile_json,thread_id FROM server_runtime_bindings WHERE task_id=?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let native = store::read_task(tx, task_id)?
        .ok_or("task-missing")?
        .state
        .native_session_id;
    let Some((raw, thread)) = saved else {
        return if native.is_some() {
            Err("runtime-session-binding-missing".into())
        } else {
            Ok(())
        };
    };
    if native != thread {
        return Err("runtime-session-binding-mismatch".into());
    }
    let mut execution: Value = serde_json::from_str(&raw).map_err(|_| "runtime-binding-invalid")?;
    if execution["runtime"] != "codex" || execution["toolset"] != "aplot-dynamic-v1" {
        return Err("runtime-binding-invalid".into());
    }
    let object = execution.as_object_mut().ok_or("runtime-binding-invalid")?;
    let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
    keys.sort_unstable();
    if keys
        != [
            "access",
            "cwd",
            "executable",
            "home",
            "model",
            "runtime",
            "toolset",
        ]
        || !["cwd", "executable", "home", "model"]
            .iter()
            .all(|key| object.get(*key).is_some_and(Value::is_string))
    {
        return Err("runtime-binding-invalid".into());
    }
    match object.get("access").and_then(Value::as_str) {
        Some("read-only" | "restricted" | "full") => {}
        _ => return Err("runtime-binding-invalid".into()),
    }
    object.insert("access".into(), json!(access_mode));
    tx.execute(
        "UPDATE server_runtime_bindings SET profile_json=?2 WHERE task_id=?1",
        params![task_id, execution.to_string()],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn has_binding(conn: &Connection, task_id: &str) -> Result<bool, String> {
    let saved: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT profile_json,account_fingerprint FROM server_runtime_bindings WHERE task_id=?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((raw, Some(account))) = saved else {
        return Ok(false);
    };
    let execution: Value = serde_json::from_str(&raw).map_err(|_| "runtime-binding-invalid")?;
    Ok(execution["toolset"] == "aplot-dynamic-v1"
        && execution["runtime"] == "codex"
        && account.len() == 64
        && account.bytes().all(|c| c.is_ascii_hexdigit()))
}

/// Reserve a delegated Codex child's execution identity in the same transaction
/// that accepted it. The queue cannot substitute another home or account later.
pub(crate) fn inherit_execution(
    tx: &Transaction<'_>,
    parent_id: &str,
    child_id: &str,
) -> Result<(), String> {
    if has_binding(tx, child_id)? {
        return Ok(());
    } // Idempotent receipt replay.
    let child = store::read_task(tx, child_id)?.ok_or("task-missing")?;
    if child.runtime != "codex" {
        return Ok(());
    }
    let parent: Option<(String, Option<String>)> = tx
        .query_row(
            "SELECT profile_json,account_fingerprint FROM server_runtime_bindings WHERE task_id=?1",
            [parent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    // Old library-only callers can still prepare work; it stays non-executable
    // until an explicit trusted runtime binding exists.
    let Some((raw, Some(account))) = parent else {
        return Ok(());
    };
    let mut execution: Value = serde_json::from_str(&raw).map_err(|_| "runtime-binding-invalid")?;
    if execution["toolset"] != "aplot-dynamic-v1" {
        return Err("runtime-toolset-reset-required".into());
    }
    let model = child
        .config
        .model_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or("queue-model-missing")?;
    let saved = workspace::read_saved(tx)?.ok_or("workspace-missing")?;
    if saved["version"] != 2 {
        return Err("workspace-version".into());
    }
    let data = saved.get("data").ok_or("workspace-invalid")?;
    workspace::validate(data)?;
    let task = data["tasks"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == child_id))
        .ok_or("task-missing")?;
    let access_mode = saved_access_mode(task)?;
    if child
        .config
        .access_mode
        .as_deref()
        .is_some_and(|saved| normalize_access_mode(Some(saved)).ok() != Some(access_mode))
    {
        return Err("codex-access-mode-invalid".into());
    }
    let cwd =
        crate::workspace_admin::task_working_directory(tx, child_id).map_err(|e| e.to_string())?;
    execution["model"] = json!(model);
    execution["cwd"] = json!(cwd);
    execution["access"] = json!(access_mode);
    tx.execute("INSERT INTO server_runtime_bindings(task_id,profile_json,thread_id,account_fingerprint) VALUES(?1,?2,NULL,?3)", params![child_id,execution.to_string(),account]).map_err(|e|e.to_string())?;
    Ok(())
}

/// Reserve an execution identity before dispatch. A stored native thread is
/// never opened with a different model, home, executable or project directory.
pub(crate) fn bind(
    tx: &Transaction<'_>,
    task_id: &str,
    config: &mut CodexRunConfig,
) -> Result<(), String> {
    config_access_mode(config)?;
    let saved: Option<(String, Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT profile_json,thread_id,account_fingerprint FROM server_runtime_bindings WHERE task_id=?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let identity = profile(config);
    let native = store::read_task(tx, task_id)?
        .ok_or("task-missing")?
        .state
        .native_session_id;
    match saved {
        Some((raw, thread, _account)) => {
            let old: Value = serde_json::from_str(&raw).map_err(|_| "runtime-binding-invalid")?;
            let mut comparable = old.clone();
            if comparable["access"] == "read-only" {
                comparable["access"] = json!("restricted");
            }
            if comparable != identity {
                return Err("runtime-binding-changed".into());
            }
            if native != thread {
                return Err("runtime-session-binding-mismatch".into());
            }
            config.resume_thread_id = thread;
        }
        None if native.is_some() => return Err("runtime-session-binding-missing".into()),
        None => config.resume_thread_id = None,
    }
    tx.execute("INSERT INTO server_runtime_bindings(task_id,profile_json,thread_id) VALUES(?1,?2,NULL) ON CONFLICT(task_id) DO UPDATE SET profile_json=excluded.profile_json",params![task_id,identity.to_string()]).map_err(|e|e.to_string())?;
    Ok(())
}

pub(crate) fn attach_thread(
    tx: &Transaction<'_>,
    task_id: &str,
    thread_id: &str,
) -> Result<(), String> {
    if thread_id.is_empty() || thread_id.len() > 512 {
        return Err("native-session-id-invalid".into());
    }
    let changed=tx.execute("UPDATE server_runtime_bindings SET thread_id=?2 WHERE task_id=?1 AND (thread_id IS NULL OR thread_id=?2)",params![task_id,thread_id]).map_err(|e|e.to_string())?;
    if changed != 1 {
        return Err("runtime-session-binding-mismatch".into());
    }
    Ok(())
}

impl ServerData {
    /// Explicitly abandon the native conversation pointer, retaining history.
    pub fn reset_runtime_session(&mut self, task_id: &str) -> io::Result<Value> {
        let tx = self.tasks.transaction().map_err(io::Error::other)?;
        let mut journal = store::Journal::new(&tx);
        let row = journal
            .task(task_id)
            .map_err(io::Error::other)?
            .ok_or_else(|| io::Error::other("task-missing"))?;
        if row.state.pending
            || row.state.live
            || !journal
                .turns(task_id, "queued")
                .map_err(io::Error::other)?
                .is_empty()
        {
            return Err(io::Error::other("task-busy"));
        }
        tx.execute(
            "DELETE FROM server_runtime_bindings WHERE task_id=?1",
            [task_id],
        )
        .map_err(io::Error::other)?;
        journal
            .edit_state(task_id, |state| {
                state.native_session_id = None;
                state.native_generation = None;
                state.native_connection_id = None;
                state.actual_model_id = None;
                state.context = None;
                state.ended = true;
            })
            .map_err(io::Error::other)?;
        drop(journal);
        tx.commit().map_err(io::Error::other)?;
        Ok(json!({"taskId":task_id,"status":"session-reset"}))
    }
}
