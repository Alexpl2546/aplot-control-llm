//! Persistent mobile-facing host commands and a serial task worker.
//!
//! The API owns a second SQLite connection so snapshots and command acceptance
//! remain responsive while the worker waits on a Codex process. The worker
//! retains `ServerData` and its exclusive data-directory lock for its lifetime.
use crate::{
    codex_runtime::{self, CodexRunConfig},
    queue_supervisor::QueueTurnResult,
    ServerData,
};
use aplot_core::{tasks::store, workspace};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tokio::{
    sync::{watch, Notify},
    time,
};

const MAX_PENDING_PER_TASK: i64 = 10;
const MAX_PENDING_GLOBAL: i64 = 128;
const MAX_PROMPT_BYTES: usize = 64_000;
const MAX_TITLE_CHARS: usize = 120;
const MAX_COMMAND_ID_CHARS: usize = 128;
const IDLE_POLL: Duration = Duration::from_millis(100);
const ACTIVE_POLL: Duration = Duration::from_millis(20);

#[derive(Clone)]
pub struct MobileHost {
    shared: Arc<Shared>,
}

pub struct MobileWorker {
    server: ServerData,
    host: MobileHost,
    config: Option<CodexRunConfig>,
    shutdown: watch::Receiver<bool>,
}

struct Shared {
    server_id: String,
    database: Mutex<Connection>,
    config: Option<CodexRunConfig>,
    active: Mutex<Option<ActiveJob>>,
    shutdown: watch::Sender<bool>,
    wake: Notify,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum JobKind {
    RootCommand,
    CodexQueue,
}

#[derive(Clone)]
struct ActiveJob {
    token: String,
    kind: JobKind,
    task_id: Option<String>,
    command_id: Option<String>,
    turn_id: Option<String>,
    generation: Option<u64>,
    cancel: watch::Sender<bool>,
}

struct PreparedExecution {
    config: CodexRunConfig,
    fingerprint: String,
}

struct QueuedRootCommand {
    command_id: String,
    task_id: String,
    prompt: String,
    execution: CodexRunConfig,
}

struct ExistingCommand {
    command_id: String,
    task_id: String,
    kind: String,
    request_hash: String,
    execution_profile_hash: Option<String>,
    status: String,
    error: Option<String>,
    turn_id: Option<String>,
    cancel_requested: bool,
    payload_json: String,
    result_json: String,
    created_at: String,
    updated_at: String,
}

enum RootClaim {
    Ready(QueuedRootCommand),
    Settled,
    Empty,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandSummary {
    command_id: String,
    task_id: String,
    kind: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    cancel_requested: bool,
    created_at: String,
    updated_at: String,
}

/// Open a UI-side SQLite connection and return the API handle and the worker
/// that owns the server database lock. This adds only a local mobile command
/// table; it does not advance the shared task schema version.
pub fn start_mobile_host(
    data: ServerData,
    config: Option<CodexRunConfig>,
) -> io::Result<(MobileHost, MobileWorker)> {
    if let Some(config) = &config {
        validate_server_config(config)?;
    }
    let database_path = database_path(&data.tasks)?;
    let mut database = Connection::open(database_path).map_err(io::Error::other)?;
    database
        .busy_timeout(Duration::from_secs(5))
        .map_err(io::Error::other)?;
    database
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
        .map_err(io::Error::other)?;
    let tx = database
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(io::Error::other)?;
    create_mobile_schema(&tx).map_err(io::Error::other)?;
    // A dispatching send may or may not have reached Codex before a crash.
    // It becomes an honest unknown result, never an automatic retry.
    tx.execute(
        "UPDATE mobile_commands SET status='unknown',error='host-restarted',updated_at=?1 WHERE status='dispatching'",
        [store::now()],
    )
    .map_err(io::Error::other)?;
    tx.execute(
        "UPDATE mobile_commands SET status='unknown',error='host-restarted',updated_at=?1 WHERE kind='interrupt' AND status='cancel_requested'",
        [store::now()],
    )
    .map_err(io::Error::other)?;
    tx.commit().map_err(io::Error::other)?;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let host = MobileHost {
        shared: Arc::new(Shared {
            server_id: data.info().server_id,
            database: Mutex::new(database),
            config: config.clone(),
            active: Mutex::new(None),
            shutdown: shutdown_tx,
            wake: Notify::new(),
        }),
    };
    let worker = MobileWorker {
        server: data,
        host: host.clone(),
        config,
        shutdown: shutdown_rx,
    };
    Ok((host, worker))
}

impl MobileHost {
    /// Whether the server has a trusted Codex execution configuration and is
    /// accepting new prompts. Existing queued prompts remain durable without it.
    pub fn send_enabled(&self) -> bool {
        self.shared.config.is_some() && !*self.shared.shutdown.borrow()
    }

    /// Synchronously stop accepting work and signal the current per-job token.
    pub fn shutdown(&self) {
        self.shared.shutdown.send_replace(true);
        if let Ok(active) = self.shared.active.lock() {
            if let Some(active) = active.as_ref() {
                let _ = active.cancel.send(true);
            }
        }
        self.shared.wake.notify_waiters();
    }

    /// Restricted snapshot for the mobile UI. Local paths, workspace threads,
    /// instructions, profile objects, and private key/value rows are excluded.
    pub fn workspace(&self) -> Result<Value, String> {
        let mut database = self.database()?;
        let tx = database
            .transaction()
            .map_err(|_| "mobile-database-error")?;
        let data = saved_workspace(&tx)?;
        let projects = data["projects"]
            .as_array()
            .ok_or("mobile-workspace-invalid")?
            .iter()
            .map(|project| json!({"id":project["id"],"name":project["name"]}))
            .collect::<Vec<_>>();
        let mut tasks = Vec::new();
        for task in data["tasks"].as_array().ok_or("mobile-workspace-invalid")? {
            let id = task["id"].as_str().ok_or("mobile-workspace-invalid")?;
            let task_row = store::read_task(&tx, id).map_err(|_| "mobile-database-error")?;
            let state = task_row
                .as_ref()
                .map(|row| row.state.clone())
                .unwrap_or_default();
            tasks.push(json!({
                "id":id,
                "projectId":task["projectId"],
                "title":task["title"],
                "runtime":task["runtime"],
                "accessMode":access_mode_for_view(task),
                "revision":task_row.map(|row| row.revision.max(0) as u64).unwrap_or(0),
                "pending":state.pending,
                "starting":state.starting,
                "ended":state.ended,
                "error":state.error,
                "archived":json_truthy(&task["archived"]),
                "deletedAt":task.get("deletedAt").cloned().unwrap_or(Value::Null),
            }));
        }
        let model = self
            .shared
            .config
            .as_ref()
            .map(|config| config.model.clone())
            .unwrap_or_default();
        let snapshot = json!({
            "serverId":self.shared.server_id,
            "projects":projects,
            "tasks":tasks,
            "capabilities":{"createTask":true,"send":self.send_enabled(),"interrupt":true,"changeAccessMode":true,"allowedAccessModes":["restricted","full"]},
            "model":model,
        });
        tx.commit().map_err(|_| "mobile-database-error")?;
        Ok(snapshot)
    }

    /// Full conversation view for one known task plus allowlisted workspace
    /// metadata and recent command status. Workspace paths are never returned.
    pub fn task(&self, task_id: &str) -> Result<Value, String> {
        if task_id.trim().is_empty() || task_id.chars().count() > 200 {
            return Err("task-not-found".into());
        }
        let mut database = self.database()?;
        let tx = database
            .transaction()
            .map_err(|_| "mobile-database-error")?;
        let data = saved_workspace(&tx)?;
        let metadata = task_metadata(&data, task_id)?;
        let task_view = store::task_view(&tx, task_id)
            .map_err(|_| "mobile-database-error")?
            .ok_or("task-not-found")?;
        let commands = command_summaries(&tx, task_id)?;
        let snapshot = json!({
            "cursor":store::cursor(&tx).map_err(|_| "mobile-database-error")?,
            "task":task_view,
            "metadata":metadata,
            "commands":commands,
        });
        tx.commit().map_err(|_| "mobile-database-error")?;
        Ok(snapshot)
    }

    /// Change an idle task's owner-selected access mode. The workspace edit,
    /// task journal event, and replay-safe command receipt share one write.
    pub fn change_access_mode(
        &self,
        task_id: &str,
        command_id: &str,
        expected_revision: u64,
        access_mode: &str,
    ) -> Result<Value, String> {
        validate_command_id(command_id)?;
        if !matches!(access_mode, "restricted" | "full") {
            return Err("mobile-access-mode-invalid".into());
        }
        if task_id.trim().is_empty() || task_id.chars().count() > 200 {
            return Err("task-not-found".into());
        }
        let hash = request_hash(&json!({
            "kind":"access-mode",
            "taskId":task_id,
            "expectedRevision":expected_revision,
            "accessMode":access_mode,
        }))?;
        let mut database = self.database()?;
        let tx = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "mobile-database-error")?;
        if let Some(existing) = existing_command(&tx, command_id)? {
            if existing.request_hash != hash
                || existing.kind != "access-mode"
                || existing.task_id != task_id
            {
                return Err("mobile-command-conflict".into());
            }
            let receipt = serde_json::from_str(&existing.result_json)
                .map_err(|_| "mobile-command-invalid")?;
            tx.commit().map_err(|_| "mobile-database-error")?;
            return Ok(receipt);
        }

        let mut data = saved_workspace(&tx)?;
        let task = data["tasks"]
            .as_array_mut()
            .and_then(|tasks| tasks.iter_mut().find(|task| task["id"] == task_id))
            .ok_or("task-not-found")?;
        if json_truthy(&task["archived"]) || json_truthy(&task["deletedAt"]) {
            return Err("task-archived".into());
        }
        if task["runtime"] != "codex" {
            return Err("task-runtime-unsupported".into());
        }
        let row = store::read_task(&tx, task_id)
            .map_err(|_| "mobile-database-error")?
            .ok_or("task-not-found")?;
        if row.revision < 0 || u64::try_from(row.revision).ok() != Some(expected_revision) {
            return Err("mobile-task-revision-stale".into());
        }
        if row.state.pending
            || row.state.live
            || row.state.starting
            || !store::turns(&tx, task_id, "queued")
                .map_err(|_| "mobile-database-error")?
                .is_empty()
            || !store::turns(&tx, task_id, "running")
                .map_err(|_| "mobile-database-error")?
                .is_empty()
        {
            return Err("mobile-task-busy".into());
        }
        let queued_commands: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM mobile_commands WHERE task_id=?1 AND kind='send' AND status IN ('queued','dispatching')",
                [task_id],
                |row| row.get(0),
            )
            .map_err(|_| "mobile-database-error")?;
        if queued_commands != 0 {
            return Err("mobile-task-busy".into());
        }

        crate::runtime_session::change_access_mode(&tx, task_id, access_mode)?;
        task["accessMode"] = json!(access_mode);
        let workspace_revision = workspace_revision(&tx)?;
        let next_workspace_revision =
            workspace::write_saved_in_transaction(&tx, data, workspace_revision).map_err(
                |error| {
                    if error == "workspace-conflict" {
                        "mobile-task-revision-stale"
                    } else {
                        "mobile-workspace-invalid"
                    }
                },
            )?;
        let mut journal = store::Journal::new(&tx);
        let mut config = row.config;
        config.access_mode = Some(access_mode.to_owned());
        journal
            .set_config(task_id, &config)
            .map_err(|_| "mobile-database-error")?;
        journal
            .record_workspace_revision(task_id, next_workspace_revision, None)
            .map_err(|_| "mobile-database-error")?;
        let revision = journal
            .task(task_id)
            .map_err(|_| "mobile-database-error")?
            .ok_or("task-not-found")?
            .revision;
        let revision = u64::try_from(revision).map_err(|_| "mobile-database-error")?;
        let receipt = json!({
            "commandId":command_id,
            "taskId":task_id,
            "status":"updated",
            "accessMode":access_mode,
            "revision":revision,
        });
        let now = store::now();
        tx.execute(
            "INSERT INTO mobile_access_mode_commands(command_id,task_id,request_hash,result_json,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![command_id, task_id, hash, receipt.to_string(), now],
        )
        .map_err(|_| "mobile-database-error")?;
        drop(journal);
        tx.commit().map_err(|_| "mobile-database-error")?;
        Ok(receipt)
    }

    /// Atomically add task workspace metadata, its journal row, and a durable
    /// create receipt. Replaying the same command ID returns the same task ID.
    pub fn create_task(
        &self,
        project_id: &str,
        command_id: &str,
        title: &str,
    ) -> Result<Value, String> {
        validate_command_id(command_id)?;
        let title = title.trim();
        if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
            return Err("task-title-invalid".into());
        }
        if project_id.trim().is_empty() || project_id.chars().count() > 200 {
            return Err("project-not-found".into());
        }
        let hash =
            request_hash(&json!({"kind":"create-task","projectId":project_id,"title":title}))?;
        let mut database = self.database()?;
        let tx = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "mobile-database-error")?;
        if let Some(existing) = existing_command(&tx, command_id)? {
            if existing.request_hash != hash || existing.kind != "create-task" {
                return Err("mobile-command-conflict".into());
            }
            let mut receipt: Value = serde_json::from_str(&existing.result_json)
                .map_err(|_| "mobile-command-invalid")?;
            receipt["commandId"] = json!(command_id);
            receipt["taskId"] = json!(existing.task_id);
            receipt["status"] = json!("created");
            tx.commit().map_err(|_| "mobile-database-error")?;
            return Ok(receipt);
        }
        let mut data = saved_workspace(&tx)?;
        if !data["projects"]
            .as_array()
            .is_some_and(|projects| projects.iter().any(|project| project["id"] == project_id))
        {
            return Err("project-not-found".into());
        }
        let task_id = uuid::Uuid::new_v4().to_string();
        let now_ms = store::millis();
        let task = json!({
            "id":task_id,
            "projectId":project_id,
            "title":title,
            "runtime":"codex",
            "accessMode":"restricted",
            "createdAt":now_ms,
            "updatedAt":now_ms,
            "archived":false,
            "unread":false,
        });
        data["tasks"]
            .as_array_mut()
            .ok_or("mobile-workspace-invalid")?
            .push(task.clone());
        let revision = workspace_revision(&tx)?;
        workspace::write_saved_in_transaction(&tx, data, revision)
            .map_err(|_| "mobile-workspace-conflict")?;
        let mut journal = store::Journal::new(&tx);
        journal
            .ensure_task(&task_id, "codex")
            .map_err(|_| "mobile-database-error")?;
        let task_config = store::TaskConfig {
            model_id: self
                .shared
                .config
                .as_ref()
                .map(|config| config.model.clone()),
            access_mode: Some("restricted".into()),
            ..store::TaskConfig::default()
        };
        journal
            .set_config(&task_id, &task_config)
            .map_err(|_| "mobile-database-error")?;
        let receipt =
            json!({"commandId":command_id,"taskId":task_id,"status":"created","task":task});
        insert_command(
            &tx,
            command_id,
            &task_id,
            "create-task",
            &hash,
            "completed",
            &json!({}),
            None,
            &receipt,
            None,
        )?;
        drop(journal);
        tx.commit().map_err(|_| "mobile-database-error")?;
        Ok(receipt)
    }

    /// Persist a send request and return the same acceptance receipt on every
    /// matching retry, even after the worker has completed or cancelled it.
    pub fn send(&self, task_id: &str, command_id: &str, text: &str) -> Result<Value, String> {
        validate_command_id(command_id)?;
        if text.trim().is_empty() || text.len() > MAX_PROMPT_BYTES {
            return Err("prompt-invalid".into());
        }
        let prompt = text;
        if task_id.trim().is_empty() || task_id.chars().count() > 200 {
            return Err("task-not-found".into());
        }
        let hash = request_hash(&json!({"kind":"send","taskId":task_id,"text":prompt}))?;
        let mut database = self.database()?;
        let tx = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "mobile-database-error")?;
        if let Some(existing) = existing_command(&tx, command_id)? {
            if existing.request_hash != hash
                || existing.kind != "send"
                || existing.task_id != task_id
            {
                return Err("mobile-command-conflict".into());
            }
            tx.commit().map_err(|_| "mobile-database-error")?;
            return Ok(send_acceptance(command_id, task_id));
        }
        let config = self
            .shared
            .config
            .as_ref()
            .ok_or("mobile-host-send-disabled")?;
        if *self.shared.shutdown.borrow() {
            return Err("mobile-host-send-disabled".into());
        }
        let (task, prepared) = prepare_execution(&tx, config, task_id, prompt)?;
        let task_row = store::read_task(&tx, task_id)
            .map_err(|_| "mobile-database-error")?
            .ok_or("task-not-found")?;
        if task_row.state.pending
            || task_row.state.live
            || task_row.state.starting
            || task_row.state.stopped
        {
            return Err("mobile-task-busy".into());
        }
        if !store::turns(&tx, task_id, "queued")
            .map_err(|_| "mobile-database-error")?
            .is_empty()
        {
            return Err("mobile-task-busy".into());
        }
        let per_task: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM mobile_commands WHERE task_id=?1 AND kind='send' AND status IN ('queued','dispatching')",
                [task_id],
                |row| row.get(0),
            )
            .map_err(|_| "mobile-database-error")?;
        let global: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM mobile_commands WHERE kind='send' AND status IN ('queued','dispatching')",
                [],
                |row| row.get(0),
            )
            .map_err(|_| "mobile-database-error")?;
        if per_task >= MAX_PENDING_PER_TASK || global >= MAX_PENDING_GLOBAL {
            return Err("mobile-command-capacity".into());
        }
        let acceptance = send_acceptance(command_id, task_id);
        insert_command(
            &tx,
            command_id,
            task_id,
            "send",
            &hash,
            "queued",
            &json!({"text":prompt}),
            Some(&prepared.fingerprint),
            &acceptance,
            None,
        )?;
        let _ = task; // The validated metadata/project path is intentionally never returned here.
        tx.commit().map_err(|_| "mobile-database-error")?;
        self.shared.wake.notify_one();
        Ok(acceptance)
    }

    /// Cancel a queued send or request cancellation of the exact currently
    /// registered root job. A dispatching request remains fenced by its sender.
    pub fn cancel_command(&self, command_id: &str) -> Result<Value, String> {
        validate_command_id(command_id)?;
        // Clone before the database read. If this job ends and another starts,
        // the cloned sender still addresses only the original receiver.
        let cancel = self.clone_root_cancel_sender(command_id);
        let mut database = self.database()?;
        let tx = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "mobile-database-error")?;
        let Some(existing) = existing_command(&tx, command_id)? else {
            return Err("mobile-command-not-found".into());
        };
        if existing.kind != "send" {
            return Err("mobile-command-not-found".into());
        }
        match existing.status.as_str() {
            "queued" => {
                tx.execute(
                    "UPDATE mobile_commands SET status='cancelled',updated_at=?2 WHERE command_id=?1 AND status='queued'",
                    params![command_id, store::now()],
                )
                .map_err(|_| "mobile-database-error")?;
            }
            "dispatching" => {
                tx.execute(
                    "UPDATE mobile_commands SET cancel_requested=1,updated_at=?2 WHERE command_id=?1 AND status='dispatching'",
                    params![command_id, store::now()],
                )
                .map_err(|_| "mobile-database-error")?;
            }
            _ => {
                let summary = command_summary(&existing);
                tx.commit().map_err(|_| "mobile-database-error")?;
                return Ok(serde_json::to_value(summary).map_err(|_| "mobile-command-invalid")?);
            }
        }
        tx.commit().map_err(|_| "mobile-database-error")?;
        if existing.status == "dispatching" {
            if let Some(cancel) = cancel {
                let _ = cancel.send(true);
            }
        }
        self.shared.wake.notify_one();
        drop(database);
        self.command(command_id)
    }

    /// Request interruption using the internal durable turn UUID and generation
    /// shown by the task snapshot. It is allowed during `starting`, before the
    /// native Codex turn ID exists.
    pub fn interrupt(
        &self,
        task_id: &str,
        command_id: &str,
        expected_generation: u64,
        expected_turn_id: &str,
    ) -> Result<Value, String> {
        validate_command_id(command_id)?;
        if task_id.trim().is_empty()
            || task_id.chars().count() > 200
            || expected_generation == 0
            || uuid::Uuid::parse_str(expected_turn_id).is_err()
        {
            return Err("mobile-task-not-interruptible".into());
        }
        // Capture the current per-job sender before opening the DB transaction;
        // never look up a replacement sender after the persisted fence check.
        let cancel = self.clone_interrupt_cancel_sender(task_id);
        let hash = request_hash(&json!({
            "kind":"interrupt",
            "taskId":task_id,
            "expectedGeneration":expected_generation,
            "expectedTurnId":expected_turn_id
        }))?;
        let mut database = self.database()?;
        let tx = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "mobile-database-error")?;
        if let Some(existing) = existing_command(&tx, command_id)? {
            if existing.request_hash != hash
                || existing.kind != "interrupt"
                || existing.task_id != task_id
            {
                return Err("mobile-command-conflict".into());
            }
            if existing.status == "failed" {
                return Err(existing
                    .error
                    .unwrap_or_else(|| "mobile-task-not-interruptible".into()));
            }
            tx.commit().map_err(|_| "mobile-database-error")?;
            return Ok(interrupt_acceptance(command_id, task_id));
        }
        let task = store::read_task(&tx, task_id)
            .map_err(|_| "mobile-database-error")?
            .ok_or("task-not-found")?;
        if task.state.native_generation != Some(expected_generation) {
            return self.record_interrupt_failure(
                tx,
                command_id,
                task_id,
                &hash,
                expected_generation,
                expected_turn_id,
                "mobile-generation-stale",
            );
        }
        if !task.state.pending || task.state.ended || task.state.stopped {
            return self.record_interrupt_failure(
                tx,
                command_id,
                task_id,
                &hash,
                expected_generation,
                expected_turn_id,
                "mobile-task-not-interruptible",
            );
        }
        let running = store::turns(&tx, task_id, "running").map_err(|_| "mobile-database-error")?;
        if running.len() != 1 || running[0].id != expected_turn_id {
            return self.record_interrupt_failure(
                tx,
                command_id,
                task_id,
                &hash,
                expected_generation,
                expected_turn_id,
                "mobile-turn-stale",
            );
        }
        let Some(cancel) = cancel else {
            return self.record_interrupt_failure(
                tx,
                command_id,
                task_id,
                &hash,
                expected_generation,
                expected_turn_id,
                "mobile-active-worker-unavailable",
            );
        };
        let request =
            json!({"expectedGeneration":expected_generation,"expectedTurnId":expected_turn_id});
        insert_command(
            &tx,
            command_id,
            task_id,
            "interrupt",
            &hash,
            "cancel_requested",
            &request,
            None,
            &interrupt_acceptance(command_id, task_id),
            Some(expected_turn_id),
        )?;
        tx.commit().map_err(|_| "mobile-database-error")?;
        if cancel.send(true).is_err() {
            self.fail_command(command_id, "mobile-active-worker-unavailable")?;
            return Err("mobile-active-worker-unavailable".into());
        }
        Ok(interrupt_acceptance(command_id, task_id))
    }

    fn command(&self, command_id: &str) -> Result<Value, String> {
        let database = self.database()?;
        let command = existing_command(&database, command_id)?.ok_or("mobile-command-not-found")?;
        serde_json::to_value(command_summary(&command)).map_err(|_| "mobile-command-invalid".into())
    }

    fn database(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.shared
            .database
            .lock()
            .map_err(|_| "mobile-database-error".into())
    }

    fn clone_root_cancel_sender(&self, command_id: &str) -> Option<watch::Sender<bool>> {
        self.shared.active.lock().ok()?.as_ref().and_then(|active| {
            (active.kind == JobKind::RootCommand
                && active.command_id.as_deref() == Some(command_id))
            .then(|| active.cancel.clone())
        })
    }

    fn clone_interrupt_cancel_sender(&self, task_id: &str) -> Option<watch::Sender<bool>> {
        self.shared
            .active
            .lock()
            .ok()?
            .as_ref()
            .and_then(|active| match active.kind {
                JobKind::RootCommand if active.task_id.as_deref() == Some(task_id) => {
                    Some(active.cancel.clone())
                }
                JobKind::CodexQueue
                    if active
                        .task_id
                        .as_deref()
                        .is_none_or(|active_task| active_task == task_id) =>
                {
                    Some(active.cancel.clone())
                }
                _ => None,
            })
    }

    fn record_interrupt_failure(
        &self,
        tx: Transaction<'_>,
        command_id: &str,
        task_id: &str,
        hash: &str,
        expected_generation: u64,
        expected_turn_id: &str,
        error: &'static str,
    ) -> Result<Value, String> {
        insert_command(
            &tx,
            command_id,
            task_id,
            "interrupt",
            hash,
            "failed",
            &json!({"expectedGeneration":expected_generation,"expectedTurnId":expected_turn_id}),
            None,
            &json!({"commandId":command_id,"taskId":task_id,"status":"failed","error":error}),
            Some(expected_turn_id),
        )?;
        tx.execute(
            "UPDATE mobile_commands SET error=?2 WHERE command_id=?1",
            params![command_id, error],
        )
        .map_err(|_| "mobile-database-error")?;
        tx.commit().map_err(|_| "mobile-database-error")?;
        Err(error.into())
    }

    fn fail_command(&self, command_id: &str, error: &str) -> Result<(), String> {
        let database = self.database()?;
        database.execute(
            "UPDATE mobile_commands SET status='failed',error=?2,updated_at=?3 WHERE command_id=?1 AND status='cancel_requested'",
            params![command_id, error, store::now()],
        ).map_err(|_| "mobile-database-error")?;
        Ok(())
    }
}

impl MobileWorker {
    /// Run the serial actor until shutdown. It prioritizes mobile root commands,
    /// then executes at most one accepted Codex child turn per queue step.
    pub async fn run(mut self) -> io::Result<()> {
        loop {
            if *self.shutdown.borrow() {
                self.host.cancel_active();
                return Ok(());
            }
            if let Some(config) = self.config.clone() {
                match self.host.claim_root_command(&config)? {
                    RootClaim::Ready(command) => {
                        self.run_root_command(command).await?;
                        continue;
                    }
                    RootClaim::Settled => continue,
                    RootClaim::Empty => {}
                }
                if self.host.has_eligible_codex_queue()? {
                    self.run_codex_queue_step(config).await?;
                    continue;
                }
            }
            tokio::select! {
                _ = time::sleep(IDLE_POLL) => {},
                _ = self.host.shared.wake.notified() => {},
                changed = self.shutdown.changed() => {
                    if changed.is_err() || *self.shutdown.borrow() {
                        self.host.cancel_active();
                        return Ok(());
                    }
                }
            }
        }
    }

    async fn run_root_command(&mut self, command: QueuedRootCommand) -> io::Result<()> {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let token = self.host.register_active(
            JobKind::RootCommand,
            Some(command.task_id.clone()),
            Some(command.command_id.clone()),
            cancel_tx.clone(),
        )?;
        match self.host.root_cancel_requested(&command.command_id) {
            Ok(true) => {
                let _ = cancel_tx.send(true);
            }
            Ok(false) => {}
            Err(error) => {
                self.host.clear_active(&token);
                return Err(error);
            }
        }
        let mut execution = Box::pin(self.server.run_codex(
            &command.task_id,
            &command.command_id,
            &command.prompt,
            command.execution.clone(),
            cancel_rx,
        ));
        let host = self.host.clone();
        let mut poll = time::interval(ACTIVE_POLL);
        let result = loop {
            tokio::select! {
                result = &mut execution => break result,
                _ = poll.tick() => {
                    if let Err(error) = host.refresh_active(&token) {
                        let _ = cancel_tx.send(true);
                        break Err(io::Error::other(error));
                    }
                }
                changed = self.shutdown.changed() => {
                    if changed.is_err() || *self.shutdown.borrow() {
                        let _ = cancel_tx.send(true);
                    }
                }
            }
        };
        host.clear_active(&token);
        let (status, error, turn_id) = match result {
            Ok(receipt) => (
                receipt["status"].as_str().unwrap_or("failed").to_owned(),
                safe_error(receipt["error"].as_str()),
                receipt["turnId"].as_str().map(str::to_owned),
            ),
            Err(error) => ("failed".into(), safe_error(Some(&error.to_string())), None),
        };
        host.finish_root_command(&command, &status, error.as_deref(), turn_id.as_deref())?;
        Ok(())
    }

    async fn run_codex_queue_step(&mut self, config: CodexRunConfig) -> io::Result<()> {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let token =
            self.host
                .register_active(JobKind::CodexQueue, None, None, cancel_tx.clone())?;
        let mut drain = Box::pin(self.server.drain_codex_queue(config, cancel_rx, 1));
        let host = self.host.clone();
        let mut poll = time::interval(ACTIVE_POLL);
        let result = loop {
            tokio::select! {
                result = &mut drain => break result,
                _ = poll.tick() => {
                    if let Err(error) = host.refresh_active(&token) {
                        let _ = cancel_tx.send(true);
                        break Err(io::Error::other(error));
                    }
                }
                changed = self.shutdown.changed() => {
                    if changed.is_err() || *self.shutdown.borrow() {
                        let _ = cancel_tx.send(true);
                    }
                }
            }
        };
        host.clear_active(&token);
        let report = result?;
        for turn in report.turns {
            host.finish_interrupt_commands(&turn)?;
        }
        Ok(())
    }
}

impl MobileHost {
    fn claim_root_command(&self, current_config: &CodexRunConfig) -> io::Result<RootClaim> {
        let mut database = self.database().map_err(io::Error::other)?;
        let tx = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(io::Error::other)?;
        let row: Option<(String, String, String, Option<String>)> = tx
            .query_row(
                "SELECT command_id,task_id,payload_json,execution_profile_hash FROM mobile_commands WHERE kind='send' AND status='queued' ORDER BY rowid ASC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(io::Error::other)?;
        let Some((command_id, task_id, payload_json, expected_fingerprint)) = row else {
            tx.commit().map_err(io::Error::other)?;
            return Ok(RootClaim::Empty);
        };
        let prompt = serde_json::from_str::<Value>(&payload_json)
            .ok()
            .and_then(|payload| payload["text"].as_str().map(str::to_owned))
            .filter(|prompt| !prompt.trim().is_empty() && prompt.len() <= MAX_PROMPT_BYTES);
        let Some(prompt) = prompt else {
            mark_root_command_failed(&tx, &command_id, "mobile-command-invalid")?;
            tx.commit().map_err(io::Error::other)?;
            return Ok(RootClaim::Settled);
        };
        let prepared = prepare_execution(&tx, current_config, &task_id, &prompt);
        let prepared = match prepared {
            Ok((_, prepared))
                if Some(prepared.fingerprint.as_str()) == expected_fingerprint.as_deref() =>
            {
                prepared
            }
            Ok(_) => {
                mark_root_command_failed(&tx, &command_id, "mobile-execution-profile-changed")?;
                tx.commit().map_err(io::Error::other)?;
                return Ok(RootClaim::Settled);
            }
            Err(error) => {
                mark_root_command_failed(&tx, &command_id, &error)?;
                tx.commit().map_err(io::Error::other)?;
                return Ok(RootClaim::Settled);
            }
        };
        tx.execute(
            "UPDATE mobile_commands SET status='dispatching',turn_id=NULL,error=NULL,updated_at=?2 WHERE command_id=?1 AND status='queued'",
            params![command_id, store::now()],
        )
        .map_err(io::Error::other)?;
        tx.commit().map_err(io::Error::other)?;
        Ok(RootClaim::Ready(QueuedRootCommand {
            command_id,
            task_id,
            prompt,
            execution: prepared.config,
        }))
    }

    fn has_eligible_codex_queue(&self) -> io::Result<bool> {
        let database = self.database().map_err(io::Error::other)?;
        let mut statement = database
            .prepare("SELECT t.task_id FROM agent_turns t JOIN agent_tasks a ON a.id=t.task_id WHERE t.status='queued' AND a.runtime='codex' GROUP BY t.task_id ORDER BY MIN(t.rowid)")
            .map_err(io::Error::other)?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(io::Error::other)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?;
        for task_id in ids {
            let Some(task) = store::read_task(&database, &task_id).map_err(io::Error::other)?
            else {
                continue;
            };
            if !task.state.pending && !task.state.live && !task.state.starting {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn register_active(
        &self,
        kind: JobKind,
        task_id: Option<String>,
        command_id: Option<String>,
        cancel: watch::Sender<bool>,
    ) -> io::Result<String> {
        let mut active = self
            .shared
            .active
            .lock()
            .map_err(|_| io::Error::other("mobile-worker-state-unavailable"))?;
        if active.is_some() {
            return Err(io::Error::other("mobile-worker-already-active"));
        }
        if *self.shared.shutdown.borrow() {
            return Err(io::Error::other("mobile-host-shutting-down"));
        }
        let token = uuid::Uuid::new_v4().to_string();
        *active = Some(ActiveJob {
            token: token.clone(),
            kind,
            task_id,
            command_id,
            turn_id: None,
            generation: None,
            cancel,
        });
        Ok(token)
    }

    fn refresh_active(&self, token: &str) -> Result<(), String> {
        let Some(active_snapshot) = self
            .shared
            .active
            .lock()
            .map_err(|_| "mobile-worker-state-unavailable")?
            .as_ref()
            .filter(|active| active.token == token)
            .cloned()
        else {
            return Ok(());
        };
        let database = self.database()?;
        let details = match active_snapshot.kind {
            JobKind::RootCommand => locate_root_turn(
                &database,
                active_snapshot
                    .task_id
                    .as_deref()
                    .ok_or("mobile-worker-state-invalid")?,
                active_snapshot
                    .command_id
                    .as_deref()
                    .ok_or("mobile-worker-state-invalid")?,
            )?,
            JobKind::CodexQueue => locate_any_running_turn(&database)?,
        };
        let root_cancel_requested = if active_snapshot.kind == JobKind::RootCommand {
            if let Some(command_id) = active_snapshot.command_id.as_deref() {
                database
                    .query_row(
                        "SELECT cancel_requested FROM mobile_commands WHERE command_id=?1 AND status='dispatching'",
                        [command_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?
                    .unwrap_or(false)
            } else {
                false
            }
        } else {
            false
        };
        drop(database);
        if root_cancel_requested {
            let _ = active_snapshot.cancel.send(true);
        }
        let mut active = self
            .shared
            .active
            .lock()
            .map_err(|_| "mobile-worker-state-unavailable")?;
        let Some(current) = active.as_mut().filter(|current| current.token == token) else {
            return Ok(());
        };
        if let Some((task_id, turn_id, generation)) = details {
            let turn_changed = current.turn_id.as_deref() != Some(turn_id.as_str());
            current.task_id = Some(task_id.clone());
            current.turn_id = Some(turn_id.clone());
            current.generation = Some(generation);
            if current.kind == JobKind::RootCommand && turn_changed {
                if let Ok(database) = self.database() {
                    let _ = database.execute(
                        "UPDATE mobile_commands SET turn_id=?2,updated_at=?3 WHERE command_id=?1 AND status='dispatching' AND (turn_id IS NULL OR turn_id<>?2)",
                        params![current.command_id, turn_id, store::now()],
                    );
                }
            }
        }
        Ok(())
    }

    fn clear_active(&self, token: &str) {
        if let Ok(mut active) = self.shared.active.lock() {
            if active.as_ref().is_some_and(|job| job.token == token) {
                *active = None;
            }
        }
    }

    fn cancel_active(&self) {
        if let Ok(active) = self.shared.active.lock() {
            if let Some(active) = active.as_ref() {
                let _ = active.cancel.send(true);
            }
        }
    }

    fn root_cancel_requested(&self, command_id: &str) -> io::Result<bool> {
        let database = self.database().map_err(io::Error::other)?;
        database
            .query_row(
                "SELECT cancel_requested FROM mobile_commands WHERE command_id=?1 AND status='dispatching'",
                [command_id],
                |row| row.get(0),
            )
            .optional()
            .map(|value| value.unwrap_or(false))
            .map_err(io::Error::other)
    }

    fn finish_root_command(
        &self,
        command: &QueuedRootCommand,
        status: &str,
        error: Option<&str>,
        turn_id: Option<&str>,
    ) -> io::Result<()> {
        let database = self.database().map_err(io::Error::other)?;
        let tx = database.unchecked_transaction().map_err(io::Error::other)?;
        let cancel_requested: bool = tx
            .query_row(
                "SELECT cancel_requested FROM mobile_commands WHERE command_id=?1",
                [&command.command_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(io::Error::other)?
            .unwrap_or(false);
        let final_status = if cancel_requested && status == "interrupted" {
            "cancelled"
        } else if ["completed", "failed", "interrupted", "cancelled", "unknown"].contains(&status) {
            status
        } else {
            "failed"
        };
        let safe_error = error.map(|value| stable_runtime_error(value));
        let result = json!({"status":final_status,"turnId":turn_id,"error":safe_error});
        tx.execute(
            "UPDATE mobile_commands SET status=?2,error=?3,turn_id=COALESCE(?4,turn_id),result_json=?5,updated_at=?6 WHERE command_id=?1",
            params![command.command_id, final_status, safe_error, turn_id, result.to_string(), store::now()],
        )
        .map_err(io::Error::other)?;
        if let Some(turn_id) = turn_id {
            let generation = store::read_task(&tx, &command.task_id)
                .map_err(io::Error::other)?
                .and_then(|task| task.state.native_generation);
            if let Some(generation) = generation {
                settle_interrupt_commands(
                    &tx,
                    &command.task_id,
                    turn_id,
                    generation,
                    final_status,
                )?;
            }
        }
        tx.commit().map_err(io::Error::other)
    }

    fn finish_interrupt_commands(&self, turn: &QueueTurnResult) -> io::Result<()> {
        let database = self.database().map_err(io::Error::other)?;
        let tx = database.unchecked_transaction().map_err(io::Error::other)?;
        let generation = store::read_task(&tx, &turn.task_id)
            .map_err(io::Error::other)?
            .and_then(|task| task.state.native_generation);
        if let Some(generation) = generation {
            settle_interrupt_commands(&tx, &turn.task_id, &turn.turn_id, generation, &turn.status)?;
        }
        tx.commit().map_err(io::Error::other)
    }
}

fn create_mobile_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mobile_commands (
           command_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
           kind TEXT NOT NULL CHECK(kind IN ('create-task','send','interrupt')),
           request_hash TEXT NOT NULL,
           execution_profile_hash TEXT,
           status TEXT NOT NULL CHECK(status IN ('queued','dispatching','cancel_requested','completed','failed','interrupted','cancelled','unknown')),
           cancel_requested INTEGER NOT NULL DEFAULT 0,
           payload_json TEXT NOT NULL,
           result_json TEXT NOT NULL,
           error TEXT,
           turn_id TEXT,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS mobile_commands_queue ON mobile_commands(status,kind);
         CREATE INDEX IF NOT EXISTS mobile_commands_task ON mobile_commands(task_id,created_at);
         CREATE TABLE IF NOT EXISTS mobile_access_mode_commands (
           command_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
           request_hash TEXT NOT NULL,
           result_json TEXT NOT NULL,
           created_at TEXT NOT NULL
         );",
    )
    .map_err(|error| error.to_string())
}

fn database_path(conn: &Connection) -> io::Result<PathBuf> {
    let mut statement = conn
        .prepare("PRAGMA database_list")
        .map_err(io::Error::other)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })
        .map_err(io::Error::other)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io::Error::other)?;
    rows.into_iter()
        .find(|(name, path)| name == "main" && !path.is_empty())
        .map(|(_, path)| PathBuf::from(path))
        .ok_or_else(|| io::Error::other("mobile-database-path-unavailable"))
}

fn validate_server_config(config: &CodexRunConfig) -> io::Result<()> {
    if !config.executable.is_absolute()
        || !config.codex_home.is_absolute()
        || config.model.trim().is_empty()
        || config.model.len() > 256
        || config.timeout.is_zero()
        || config.resume_thread_id.is_some()
        || config
            .access_mode
            .as_deref()
            .is_some_and(|mode| !matches!(mode, "restricted" | "full"))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "mobile-execution-profile-invalid",
        ));
    }
    Ok(())
}

fn saved_workspace(conn: &Connection) -> Result<Value, String> {
    let data = match workspace::read_saved(conn).map_err(|_| "mobile-workspace-invalid")? {
        Some(saved) => {
            if saved["version"] != 2 {
                return Err("mobile-workspace-invalid".into());
            }
            saved
                .get("data")
                .cloned()
                .ok_or("mobile-workspace-invalid")?
        }
        None => json!({"projects":[],"tasks":[],"presets":[],"threads":{},"memory":[]}),
    };
    workspace::validate(&data).map_err(|_| "mobile-workspace-invalid")?;
    Ok(data)
}

fn workspace_revision(conn: &Connection) -> Result<u64, String> {
    let saved = workspace::read_saved(conn).map_err(|_| "mobile-workspace-invalid")?;
    match saved {
        Some(saved) if saved["version"] == 2 => Ok(saved["revision"].as_u64().unwrap_or(0)),
        Some(_) => Err("mobile-workspace-invalid".into()),
        None => Ok(0),
    }
}

fn task_metadata(data: &Value, task_id: &str) -> Result<Value, String> {
    let task = data["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id))
        .ok_or("task-not-found")?;
    Ok(json!({
        "id":task["id"],
        "title":task["title"],
        "projectId":task["projectId"],
        "runtime":task["runtime"],
        "accessMode":access_mode_for_view(task),
        "archived":json_truthy(&task["archived"]),
        "deletedAt":task.get("deletedAt").cloned().unwrap_or(Value::Null),
    }))
}

fn access_mode_for_view(task: &Value) -> Value {
    match crate::runtime_session::saved_access_mode(task) {
        Ok(mode) => json!(mode),
        Err(_) => task.get("accessMode").cloned().unwrap_or(Value::Null),
    }
}

fn prepare_execution(
    conn: &Connection,
    base: &CodexRunConfig,
    task_id: &str,
    prompt: &str,
) -> Result<(Value, PreparedExecution), String> {
    let data = saved_workspace(conn)?;
    let task = data["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id))
        .ok_or("task-not-found")?;
    if json_truthy(&task["archived"]) || json_truthy(&task["deletedAt"]) {
        return Err("task-archived".into());
    }
    if task["runtime"] != "codex" {
        return Err("task-runtime-unsupported".into());
    }
    if has_unsupported_profile_fields(task) {
        return Err("mobile-execution-profile-invalid".into());
    }
    let project_id = task["projectId"].as_str().ok_or("project-not-found")?;
    let project = data["projects"]
        .as_array()
        .and_then(|projects| projects.iter().find(|project| project["id"] == project_id))
        .ok_or("project-not-found")?;
    let path = project["path"].as_str().ok_or("project-not-found")?;
    let working_directory = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "mobile-execution-profile-invalid")?;
    if !working_directory.is_dir() {
        return Err("mobile-execution-profile-invalid".into());
    }
    let task_row = store::read_task(conn, task_id)
        .map_err(|_| "mobile-database-error")?
        .ok_or("task-not-found")?;
    if task_row.runtime != "codex" {
        return Err("task-runtime-unsupported".into());
    }
    let access_mode = crate::runtime_session::saved_access_mode(task)
        .map_err(|_| "mobile-execution-profile-invalid")?;
    if task_row.config.access_mode.as_deref().is_some_and(|saved| {
        crate::runtime_session::normalize_access_mode(Some(saved)).ok() != Some(access_mode)
    }) {
        return Err("mobile-execution-profile-invalid".into());
    }
    if task_row.config.connection_id.is_some()
        || task_row.config.run_id.is_some()
        || task_row.config.generation.is_some()
        || task_row.config.reasoning.is_some()
        || task_row.config.context.is_some()
        || task_row.config.skills.is_some()
        || task_row.config.language.is_some()
    {
        return Err("mobile-execution-profile-invalid".into());
    }
    if task_row
        .config
        .model_id
        .as_deref()
        .is_some_and(|model| !model.trim().is_empty() && model.trim() != base.model.trim())
    {
        return Err("mobile-execution-profile-invalid".into());
    }
    let mut config = base.clone();
    config.working_directory = working_directory;
    config.access_mode = Some(access_mode.to_owned());
    config.resume_thread_id = None;
    codex_runtime::prepare_config(&mut config, prompt)
        .map_err(|_| "mobile-execution-profile-invalid")?;
    let fingerprint_value = json!({
        "executable":config.executable,
        "home":config.codex_home,
        "model":config.model,
        "timeoutMs":config.timeout.as_millis(),
        "workingDirectory":config.working_directory,
        "accessMode":config.access_mode,
    });
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&fingerprint_value)
                .map_err(|_| "mobile-execution-profile-invalid")?
        )
    );
    Ok((
        task.clone(),
        PreparedExecution {
            config,
            fingerprint,
        },
    ))
}

fn has_unsupported_profile_fields(task: &Value) -> bool {
    [
        "connectionId",
        "connectionProfileId",
        "binding",
        "runId",
        "generation",
    ]
    .iter()
    .any(|field| task.get(*field).is_some_and(|value| !value.is_null()))
        || task["autoStartServer"] == true
}

fn json_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn validate_command_id(command_id: &str) -> Result<(), String> {
    if command_id.chars().count() > MAX_COMMAND_ID_CHARS
        || uuid::Uuid::parse_str(command_id).is_err()
    {
        return Err("mobile-command-id-invalid".into());
    }
    Ok(())
}

fn request_hash(value: &Value) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).map_err(|_| "mobile-command-invalid")?)
    ))
}

fn send_acceptance(command_id: &str, task_id: &str) -> Value {
    json!({"commandId":command_id,"taskId":task_id,"status":"queued"})
}

fn interrupt_acceptance(command_id: &str, task_id: &str) -> Value {
    json!({"commandId":command_id,"taskId":task_id,"status":"cancel_requested"})
}

fn existing_command(
    conn: &Connection,
    command_id: &str,
) -> Result<Option<ExistingCommand>, String> {
    let existing = conn.query_row(
        "SELECT command_id,task_id,kind,request_hash,execution_profile_hash,status,error,turn_id,cancel_requested,payload_json,result_json,created_at,updated_at FROM mobile_commands WHERE command_id=?1",
        [command_id],
        |row| Ok(ExistingCommand {
            command_id: row.get(0)?,
            task_id: row.get(1)?,
            kind: row.get(2)?,
            request_hash: row.get(3)?,
            execution_profile_hash: row.get(4)?,
            status: row.get(5)?,
            error: row.get(6)?,
            turn_id: row.get(7)?,
            cancel_requested: row.get(8)?,
            payload_json: row.get(9)?,
            result_json: row.get(10)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
        }),
    )
    .optional()
    .map_err(|_| "mobile-database-error")?;
    if existing.is_some() {
        return Ok(existing);
    }
    conn.query_row(
        "SELECT command_id,task_id,request_hash,result_json,created_at FROM mobile_access_mode_commands WHERE command_id=?1",
        [command_id],
        |row| {
            let created_at: String = row.get(4)?;
            Ok(ExistingCommand {
                command_id: row.get(0)?,
                task_id: row.get(1)?,
                kind: "access-mode".into(),
                request_hash: row.get(2)?,
                execution_profile_hash: None,
                status: "completed".into(),
                error: None,
                turn_id: None,
                cancel_requested: false,
                payload_json: "{}".into(),
                result_json: row.get(3)?,
                created_at: created_at.clone(),
                updated_at: created_at,
            })
        },
    )
    .optional()
    .map_err(|_| "mobile-database-error".into())
}

fn insert_command(
    tx: &Transaction<'_>,
    command_id: &str,
    task_id: &str,
    kind: &str,
    request_hash: &str,
    status: &str,
    payload: &Value,
    execution_profile_hash: Option<&str>,
    result: &Value,
    turn_id: Option<&str>,
) -> Result<(), String> {
    let now = store::now();
    tx.execute(
        "INSERT INTO mobile_commands(command_id,task_id,kind,request_hash,execution_profile_hash,status,cancel_requested,payload_json,result_json,error,turn_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,0,?7,?8,NULL,?9,?10,?10)",
        params![command_id, task_id, kind, request_hash, execution_profile_hash, status, payload.to_string(), result.to_string(), turn_id, now],
    )
    .map_err(|_| "mobile-database-error")?;
    Ok(())
}

fn command_summary(command: &ExistingCommand) -> CommandSummary {
    let _ = (
        &command.request_hash,
        &command.execution_profile_hash,
        &command.payload_json,
        &command.result_json,
    );
    CommandSummary {
        command_id: command.command_id.clone(),
        task_id: command.task_id.clone(),
        kind: command.kind.clone(),
        status: command.status.clone(),
        error: command.error.clone(),
        turn_id: command.turn_id.clone(),
        text: if command.kind == "send" {
            serde_json::from_str::<Value>(&command.payload_json)
                .ok()
                .and_then(|payload| payload["text"].as_str().map(str::to_owned))
        } else {
            None
        },
        cancel_requested: command.cancel_requested,
        created_at: command.created_at.clone(),
        updated_at: command.updated_at.clone(),
    }
}

fn command_summaries(conn: &Connection, task_id: &str) -> Result<Vec<Value>, String> {
    let mut statement = conn
        .prepare("SELECT command_id,task_id,kind,request_hash,execution_profile_hash,status,error,turn_id,cancel_requested,payload_json,result_json,created_at,updated_at FROM mobile_commands WHERE task_id=?1 AND kind IN ('send','interrupt') ORDER BY rowid DESC LIMIT 20")
        .map_err(|_| "mobile-database-error")?;
    let rows = statement
        .query_map([task_id], |row| {
            Ok(ExistingCommand {
                command_id: row.get(0)?,
                task_id: row.get(1)?,
                kind: row.get(2)?,
                request_hash: row.get(3)?,
                execution_profile_hash: row.get(4)?,
                status: row.get(5)?,
                error: row.get(6)?,
                turn_id: row.get(7)?,
                cancel_requested: row.get(8)?,
                payload_json: row.get(9)?,
                result_json: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        })
        .map_err(|_| "mobile-database-error")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "mobile-database-error")?;
    rows.iter()
        .map(|row| {
            serde_json::to_value(command_summary(row)).map_err(|_| "mobile-command-invalid".into())
        })
        .collect()
}

fn mark_root_command_failed(tx: &Transaction<'_>, command_id: &str, error: &str) -> io::Result<()> {
    tx.execute(
        "UPDATE mobile_commands SET status='failed',error=?2,result_json=?3,updated_at=?4 WHERE command_id=?1 AND status='queued'",
        params![command_id, error, json!({"status":"failed","error":error}).to_string(), store::now()],
    )
    .map_err(io::Error::other)?;
    Ok(())
}

fn locate_root_turn(
    conn: &Connection,
    task_id: &str,
    command_id: &str,
) -> Result<Option<(String, String, u64)>, String> {
    let Some(task) = store::read_task(conn, task_id)? else {
        return Ok(None);
    };
    let generation = match task.state.native_generation {
        Some(value) => value,
        None => return Ok(None),
    };
    let turn = store::turns(conn, task_id, "running")?
        .into_iter()
        .find(|turn| turn.command_id.as_deref() == Some(command_id));
    Ok(turn.map(|turn| (task_id.to_owned(), turn.id, generation)))
}

fn locate_any_running_turn(conn: &Connection) -> Result<Option<(String, String, u64)>, String> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT task_id,id FROM agent_turns WHERE status='running' ORDER BY rowid DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((task_id, turn_id)) = row else {
        return Ok(None);
    };
    let Some(task) = store::read_task(conn, &task_id)? else {
        return Ok(None);
    };
    Ok(task
        .state
        .native_generation
        .map(|generation| (task_id, turn_id, generation)))
}

fn settle_interrupt_commands(
    tx: &Transaction<'_>,
    task_id: &str,
    turn_id: &str,
    generation: u64,
    turn_status: &str,
) -> io::Result<()> {
    let mut statement = tx
        .prepare("SELECT command_id,payload_json FROM mobile_commands WHERE task_id=?1 AND kind='interrupt' AND status='cancel_requested'")
        .map_err(io::Error::other)?;
    let rows = statement
        .query_map([task_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(io::Error::other)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io::Error::other)?;
    drop(statement);
    for (command_id, raw) in rows {
        let Ok(payload) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if payload["expectedTurnId"] != turn_id
            || payload["expectedGeneration"].as_u64() != Some(generation)
        {
            continue;
        }
        let (status, error) = if matches!(turn_status, "interrupted" | "cancelled") {
            ("completed", None)
        } else {
            ("failed", Some("mobile-turn-already-finished"))
        };
        tx.execute(
            "UPDATE mobile_commands SET status=?2,error=?3,result_json=?4,updated_at=?5 WHERE command_id=?1 AND status='cancel_requested'",
            params![command_id,status,error,json!({"status":status,"error":error}).to_string(),store::now()],
        ).map_err(io::Error::other)?;
    }
    Ok(())
}

fn safe_error(error: Option<&str>) -> Option<String> {
    error.map(stable_runtime_error)
}

fn stable_runtime_error(error: &str) -> String {
    let candidate = error
        .rsplit_once(": ")
        .map(|(_, detail)| detail)
        .unwrap_or(error);
    if !candidate.is_empty()
        && candidate.len() <= 96
        && candidate
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        candidate.to_owned()
    } else {
        "mobile-runtime-error".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("aplot-mobile-host-unit-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn refresh_observes_cancel_committed_before_active_sender_registration() {
        let directory = TestDirectory::new();
        let mut server = ServerData::open(&directory.0).unwrap();
        let task_id = uuid::Uuid::new_v4().to_string();
        {
            let tx = server.tasks.transaction().unwrap();
            store::Journal::new(&tx)
                .ensure_task(&task_id, "codex")
                .unwrap();
            tx.commit().unwrap();
        }
        let (host, _worker) = start_mobile_host(server, None).unwrap();
        let command_id = uuid::Uuid::new_v4().to_string();
        {
            let mut database = host.database().unwrap();
            let tx = database.transaction().unwrap();
            insert_command(
                &tx,
                &command_id,
                &task_id,
                "send",
                "request-hash",
                "dispatching",
                &json!({"text":"cancel me"}),
                Some("profile-hash"),
                &send_acceptance(&command_id, &task_id),
                None,
            )
            .unwrap();
            tx.commit().unwrap();
        }

        let (cancel, receiver) = watch::channel(false);
        let token = uuid::Uuid::new_v4().to_string();
        *host.shared.active.lock().unwrap() = Some(ActiveJob {
            token: token.clone(),
            kind: JobKind::RootCommand,
            task_id: Some(task_id),
            command_id: Some(command_id.clone()),
            turn_id: None,
            generation: None,
            cancel,
        });
        // This represents the worker's initial check before the API commits
        // its cancel request and before the cancellation sender was registered.
        assert!(!host.root_cancel_requested(&command_id).unwrap());
        assert!(!*receiver.borrow());
        host.database()
            .unwrap()
            .execute(
                "UPDATE mobile_commands SET cancel_requested=1 WHERE command_id=?1",
                [&command_id],
            )
            .unwrap();

        host.refresh_active(&token).unwrap();
        assert!(*receiver.borrow());
        host.clear_active(&token);
        host.shutdown();
    }
}
