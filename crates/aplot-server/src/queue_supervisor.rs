//! Bounded serial execution of durable Codex turns accepted by Aplot tools.
use crate::{
    codex_runtime::{self, CodexRunConfig},
    runtime_session,
    turn_runner::{self, ClaimedTurn, TurnExecutionResult},
    ServerData,
};
use aplot_core::{
    tasks::store::{self, TurnRow},
    workspace,
};
use rusqlite::{Transaction, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashSet, io, path::PathBuf};
use tokio::sync::watch;

const MIN_TURNS: usize = 1;
const MAX_TURNS: usize = 64;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueTurnResult {
    pub task_id: String,
    pub turn_id: String,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueDrainReport {
    pub requested: usize,
    pub processed: usize,
    pub completed: usize,
    pub failed: usize,
    pub interrupted: usize,
    pub blocked: usize,
    pub remaining_codex: usize,
    pub unsupported_queued: usize,
    pub cancelled: bool,
    pub turns: Vec<QueueTurnResult>,
}

struct Candidate {
    turn: TurnRow,
    runtime: String,
}

enum PreparationError {
    Invalid(String),
    Internal(String),
}

enum ClaimOutcome {
    Claimed {
        turn: ClaimedTurn,
        blocked: Vec<String>,
    },
    Settled {
        task_id: String,
        turn_id: String,
        error: String,
        blocked: Vec<String>,
    },
    Empty {
        blocked: Vec<String>,
    },
}

impl ServerData {
    /// Drain a bounded number of accepted Codex turns in global FIFO order.
    /// The default config supplies only the executable, isolated home, and
    /// timeout. Each task's pinned saved model is authoritative.
    pub async fn drain_codex_queue(
        &mut self,
        default_config: CodexRunConfig,
        cancel: watch::Receiver<bool>,
        max_turns: usize,
    ) -> io::Result<QueueDrainReport> {
        if !(MIN_TURNS..=MAX_TURNS).contains(&max_turns) {
            return Err(io::Error::other("queue-max-turns-invalid"));
        }
        let mut report = QueueDrainReport {
            requested: max_turns,
            ..QueueDrainReport::default()
        };
        let mut blocked_turns = HashSet::new();

        while report.processed < max_turns {
            if *cancel.borrow() {
                report.cancelled = true;
                break;
            }
            match claim_next_codex_turn(self, &default_config)? {
                ClaimOutcome::Claimed { turn, blocked } => {
                    blocked_turns.extend(blocked);
                    report.processed += 1;
                    let outcome = self.execute_claimed_turn(turn, cancel.clone()).await?;
                    record_outcome(&mut report, outcome);
                    if *cancel.borrow() {
                        report.cancelled = true;
                        break;
                    }
                }
                ClaimOutcome::Settled {
                    task_id,
                    turn_id,
                    error,
                    blocked,
                } => {
                    blocked_turns.extend(blocked);
                    report.processed += 1;
                    report.failed += 1;
                    report.turns.push(QueueTurnResult {
                        task_id,
                        turn_id,
                        status: "failed".into(),
                        error: Some(error),
                    });
                }
                ClaimOutcome::Empty { blocked } => {
                    blocked_turns.extend(blocked);
                    break;
                }
            }
        }

        let (remaining_codex, unsupported_queued) = queue_counts(&self.tasks)?;
        report.remaining_codex = remaining_codex;
        report.unsupported_queued = unsupported_queued;
        report.blocked = blocked_turns.len().saturating_add(unsupported_queued);
        Ok(report)
    }
}

fn record_outcome(report: &mut QueueDrainReport, outcome: TurnExecutionResult) {
    match outcome.status.as_str() {
        "completed" => report.completed += 1,
        "interrupted" => report.interrupted += 1,
        _ => report.failed += 1,
    }
    report.turns.push(QueueTurnResult {
        task_id: outcome.task_id,
        turn_id: outcome.turn_id,
        status: outcome.status,
        error: outcome.error,
    });
}

fn queue_counts(conn: &rusqlite::Connection) -> io::Result<(usize, usize)> {
    let codex: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_turns t JOIN agent_tasks a ON a.id=t.task_id WHERE t.status='queued' AND a.runtime='codex'",
            [],
            |row| row.get(0),
        )
        .map_err(io::Error::other)?;
    let unsupported: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_turns t JOIN agent_tasks a ON a.id=t.task_id WHERE t.status='queued' AND a.runtime!='codex'",
            [],
            |row| row.get(0),
        )
        .map_err(io::Error::other)?;
    Ok((
        usize::try_from(codex).unwrap_or(usize::MAX),
        usize::try_from(unsupported).unwrap_or(usize::MAX),
    ))
}

fn queued_candidates(tx: &Transaction<'_>) -> Result<Vec<Candidate>, String> {
    let mut statement = tx.prepare(
        "SELECT t.id,t.task_id,t.status,t.command_id,t.message_id,t.input_json,t.native_turn_id,t.error,t.created_at,a.runtime FROM agent_turns t JOIN agent_tasks a ON a.id=t.task_id WHERE t.status='queued' ORDER BY t.rowid ASC"
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let input_raw: String = row.get(5)?;
            Ok(Candidate {
                turn: TurnRow {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    status: row.get(2)?,
                    command_id: row.get(3)?,
                    message_id: row.get(4)?,
                    input: serde_json::from_str(&input_raw).unwrap_or(Value::Null),
                    native_turn_id: row.get(6)?,
                    error: row.get(7)?,
                    created_at: row.get(8)?,
                },
                runtime: row.get(9)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string());
    rows
}

fn claim_next_codex_turn(
    server: &mut ServerData,
    default_config: &CodexRunConfig,
) -> io::Result<ClaimOutcome> {
    let tx = server
        .tasks
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(io::Error::other)?;
    let candidates = queued_candidates(&tx).map_err(io::Error::other)?;
    let mut blocked = Vec::new();

    for candidate in candidates
        .into_iter()
        .filter(|candidate| candidate.runtime == "codex")
    {
        match prepare_candidate(&tx, &candidate, default_config) {
            Ok(Prepared::Busy) => {
                blocked.push(candidate.turn.id);
            }
            Ok(Prepared::Invalid(reason)) => {
                settle_invalid(&tx, &candidate.turn, &reason).map_err(io::Error::other)?;
                tx.commit().map_err(io::Error::other)?;
                return Ok(ClaimOutcome::Settled {
                    task_id: candidate.turn.task_id,
                    turn_id: candidate.turn.id,
                    error: reason,
                    blocked,
                });
            }
            Ok(Prepared::Ready(claim)) => {
                let mut journal = store::Journal::new(&tx);
                journal
                    .set_turn(&claim.turn_id, "running", None, None)
                    .map_err(io::Error::other)?
                    .ok_or_else(|| io::Error::other("queue-turn-claim-lost"))?;
                journal
                    .edit_state(&claim.task_id, |state| {
                        state.pending = true;
                        state.starting = true;
                        state.live = false;
                        state.ended = false;
                        state.stopped = false;
                        state.error.clear();
                        state.io_error = None;
                        state.actual_model_id = Some(claim.config.model.clone());
                        state.native_generation = Some(claim.generation);
                    })
                    .map_err(io::Error::other)?;
                drop(journal);
                let turn = claim.into_claim();
                tx.commit().map_err(io::Error::other)?;
                return Ok(ClaimOutcome::Claimed { turn, blocked });
            }
            Err(PreparationError::Internal(error)) => return Err(io::Error::other(error)),
            Err(PreparationError::Invalid(reason)) => {
                settle_invalid(&tx, &candidate.turn, &reason).map_err(io::Error::other)?;
                tx.commit().map_err(io::Error::other)?;
                return Ok(ClaimOutcome::Settled {
                    task_id: candidate.turn.task_id,
                    turn_id: candidate.turn.id,
                    error: reason,
                    blocked,
                });
            }
        }
    }

    tx.commit().map_err(io::Error::other)?;
    Ok(ClaimOutcome::Empty { blocked })
}

enum Prepared {
    Busy,
    Invalid(String),
    Ready(PreparedClaim),
}

struct PreparedClaim {
    task_id: String,
    turn_id: String,
    prompt: String,
    generation: u64,
    config: CodexRunConfig,
    developer_context: String,
}

impl PreparedClaim {
    fn into_claim(self) -> ClaimedTurn {
        ClaimedTurn {
            task_id: self.task_id,
            turn_id: self.turn_id,
            prompt: self.prompt,
            generation: self.generation,
            config: self.config,
            developer_context: self.developer_context,
            command_receipt: None,
        }
    }
}

fn prepare_candidate(
    tx: &Transaction<'_>,
    candidate: &Candidate,
    default_config: &CodexRunConfig,
) -> Result<Prepared, PreparationError> {
    let task = store::read_task(tx, &candidate.turn.task_id)
        .map_err(PreparationError::Internal)?
        .ok_or_else(|| PreparationError::Invalid("task-missing".into()))?;
    if task.runtime != "codex" {
        return Ok(Prepared::Invalid("queue-runtime-unsupported".into()));
    }
    if task.state.stopped {
        return Ok(Prepared::Invalid("queue-task-stopped".into()));
    }
    if task.state.pending || task.state.live {
        return Ok(Prepared::Busy);
    }

    let saved = match workspace::read_saved(tx) {
        Ok(Some(saved)) => saved,
        Ok(None) => return Ok(Prepared::Invalid("workspace-missing".into())),
        Err(error) if error == "workspace-invalid" => {
            return Ok(Prepared::Invalid("workspace-invalid".into()))
        }
        Err(error) => return Err(PreparationError::Internal(error)),
    };
    if saved["version"] != 2 {
        return Ok(Prepared::Invalid("workspace-version".into()));
    }
    let data = saved
        .get("data")
        .ok_or_else(|| PreparationError::Invalid("workspace-invalid".into()))?;
    workspace::validate(data).map_err(PreparationError::Invalid)?;
    let workspace_task = data["tasks"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == candidate.turn.task_id))
        .ok_or_else(|| PreparationError::Invalid("task-missing".into()))?;
    if workspace_task["deletedAt"]
        .as_i64()
        .is_some_and(|value| value > 0)
        || workspace_task["archived"] == true
        || workspace_task["runtime"] != "codex"
    {
        return Ok(Prepared::Invalid("task-unavailable".into()));
    }
    if has_external_profile_fields(workspace_task)
        || task.config.connection_id.is_some()
        || task.config.run_id.is_some()
        || task.config.generation.is_some()
        || task.config.reasoning.is_some()
        || task.config.context.is_some()
        || task.config.skills.is_some()
        || task.config.language.is_some()
    {
        return Ok(Prepared::Invalid(
            "queue-execution-profile-unsupported".into(),
        ));
    }
    let access_mode =
        runtime_session::saved_access_mode(workspace_task).map_err(PreparationError::Invalid)?;
    if task.config.access_mode.as_deref().is_some_and(|saved| {
        runtime_session::normalize_access_mode(Some(saved)).ok() != Some(access_mode)
    }) {
        return Ok(Prepared::Invalid("queue-access-mode-invalid".into()));
    }
    let model = task
        .config
        .model_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| PreparationError::Invalid("queue-model-missing".into()))?;
    if model.len() > 256 {
        return Ok(Prepared::Invalid("queue-model-invalid".into()));
    }
    let input = &candidate.turn.input;
    if input.as_object().is_none_or(|object| {
        object
            .keys()
            .any(|key| !["text", "attachments", "time"].contains(&key.as_str()))
            || input
                .get("attachments")
                .is_some_and(|value| !value.as_array().is_some_and(Vec::is_empty))
    }) {
        return Ok(Prepared::Invalid("queue-turn-input-unsupported".into()));
    }
    let prompt = input["text"]
        .as_str()
        .filter(|text| !text.trim().is_empty() && text.len() <= 64_000)
        .ok_or_else(|| PreparationError::Invalid("queue-turn-input-invalid".into()))?
        .to_owned();
    let existing_message = store::Journal::new(tx)
        .message(&candidate.turn.task_id, &candidate.turn.message_id)
        .map_err(PreparationError::Internal)?;
    let Some(existing_message) = existing_message else {
        return Ok(Prepared::Invalid("queue-input-message-missing".into()));
    };
    if existing_message["kind"] != "user" || existing_message["text"] != prompt {
        return Ok(Prepared::Invalid("queue-input-message-mismatch".into()));
    }

    let project_id = workspace_task["projectId"]
        .as_str()
        .ok_or_else(|| PreparationError::Invalid("workspace-invalid".into()))?;
    let project = data["projects"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == project_id))
        .ok_or_else(|| PreparationError::Invalid("project-missing".into()))?;
    let path = project["path"]
        .as_str()
        .ok_or_else(|| PreparationError::Invalid("project-missing".into()))?;
    let working_directory = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| PreparationError::Invalid("queue-working-directory-unavailable".into()))?;
    if !working_directory.is_dir() {
        return Ok(Prepared::Invalid(
            "queue-working-directory-unavailable".into(),
        ));
    }

    if !runtime_session::has_binding(tx, &candidate.turn.task_id)
        .map_err(PreparationError::Internal)?
    {
        return Ok(Prepared::Invalid("queue-execution-binding-missing".into()));
    }
    let mut config = default_config.clone();
    config.model = model.to_owned();
    config.working_directory = working_directory;
    config.access_mode = Some(access_mode.to_owned());
    config.resume_thread_id = None;
    codex_runtime::prepare_config(&mut config, &prompt).map_err(PreparationError::Invalid)?;
    runtime_session::bind(tx, &candidate.turn.task_id, &mut config).map_err(|error| {
        if error.starts_with("runtime-") || error.starts_with("native-session-") {
            PreparationError::Invalid(error)
        } else {
            PreparationError::Internal(error)
        }
    })?;
    let context = turn_runner::context_for_access_mode(
        project["instructions"].as_str().unwrap_or_default(),
        workspace_task["instructions"].as_str().unwrap_or_default(),
        access_mode,
    );
    let generation = turn_runner::next_generation(tx)
        .map_err(|error| PreparationError::Internal(error.to_string()))?;
    Ok(Prepared::Ready(PreparedClaim {
        task_id: candidate.turn.task_id.clone(),
        turn_id: candidate.turn.id.clone(),
        prompt,
        generation,
        config,
        developer_context: context,
    }))
}

fn has_external_profile_fields(task: &Value) -> bool {
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

fn settle_invalid(tx: &Transaction<'_>, turn: &TurnRow, reason: &str) -> Result<(), String> {
    let mut journal = store::Journal::new(tx);
    journal
        .set_turn(&turn.id, "failed", None, Some(reason))?
        .ok_or_else(|| "queue-turn-claim-lost".to_owned())?;
    journal.edit_state(&turn.task_id, |state| {
        state.pending = false;
        state.starting = false;
        state.live = false;
        state.ended = true;
        state.error = "agent-error".into();
        state.io_error = Some(reason.to_owned());
    })?;
    turn_runner::update_delegation_receipt(tx, &turn.task_id, &turn.id, "failed", Some(reason))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aplot_core::tasks::store::{TaskConfig, TurnRow};
    use serde_json::json;
    use std::time::Duration;

    #[path = "../../../tests/support/codex_fixture.rs"]
    mod codex_fixture;

    struct TestFixture {
        directory: PathBuf,
        project_root: PathBuf,
        project_id: String,
        server: ServerData,
    }

    impl TestFixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("aplot-queue-test-{}", uuid::Uuid::new_v4()));
            let project_root = directory.join("project");
            std::fs::create_dir_all(&project_root).unwrap();
            let mut server = ServerData::open(&directory.join("server")).unwrap();
            let project = server.register_project(&project_root, "Project").unwrap();
            Self {
                directory,
                project_root,
                project_id: project["project"]["id"].as_str().unwrap().to_owned(),
                server,
            }
        }

        fn new_task(&mut self, name: &str) -> String {
            self.server.new_task(&self.project_id, name).unwrap()["task"]["id"]
                .as_str()
                .unwrap()
                .to_owned()
        }

        fn config(&self) -> CodexRunConfig {
            CodexRunConfig {
                executable: std::env::current_exe().unwrap(),
                codex_home: self.directory.join("isolated-home"),
                working_directory: PathBuf::new(),
                model: String::new(),
                timeout: Duration::from_secs(2),
                access_mode: None,
                resume_thread_id: None,
            }
        }

        fn cleanup(self) {
            drop(self.server);
            let _ = std::fs::remove_dir_all(self.directory);
        }
    }

    fn insert_queued_turn(
        server: &mut ServerData,
        task_id: &str,
        turn_id: &str,
        prompt: &str,
        attachments: Value,
    ) {
        let tx = server.tasks.transaction().unwrap();
        let mut journal = store::Journal::new(&tx);
        let message_id = format!("message-{turn_id}");
        journal
            .upsert_message(
                task_id,
                &json!({"id":message_id,"kind":"user","text":prompt,"time":store::millis()}),
            )
            .unwrap();
        journal
            .insert_turn(&TurnRow {
                id: turn_id.into(),
                task_id: task_id.into(),
                status: "queued".into(),
                command_id: Some(format!("command-{turn_id}")),
                message_id,
                input: json!({"text":prompt,"attachments":attachments,"time":store::millis()}),
                native_turn_id: None,
                error: None,
                created_at: store::now(),
            })
            .unwrap();
        drop(journal);
        tx.commit().unwrap();
    }

    fn set_saved_model(server: &mut ServerData, task_id: &str, model: &str) {
        let tx = server.tasks.transaction().unwrap();
        let mut journal = store::Journal::new(&tx);
        journal
            .set_config(
                task_id,
                &TaskConfig {
                    model_id: Some(model.into()),
                    access_mode: Some("restricted".into()),
                    ..TaskConfig::default()
                },
            )
            .unwrap();
        drop(journal);
        tx.commit().unwrap();
    }

    fn pin_execution(
        server: &mut ServerData,
        task_id: &str,
        directory: &PathBuf,
        project_root: &PathBuf,
    ) {
        set_saved_model(server, task_id, "fixture-model");
        let mut config = CodexRunConfig {
            executable: std::env::current_exe().unwrap(),
            codex_home: directory.join("isolated-home"),
            working_directory: project_root.clone(),
            model: "fixture-model".into(),
            timeout: Duration::from_secs(2),
            access_mode: None,
            resume_thread_id: None,
        };
        codex_runtime::prepare_config(&mut config, "queued prompt").unwrap();
        let tx = server.tasks.transaction().unwrap();
        runtime_session::bind(&tx, task_id, &mut config).unwrap();
        runtime_session::attach_account(&tx, task_id, &"a".repeat(64)).unwrap();
        tx.commit().unwrap();
    }

    fn add_hermes_task(fixture: &mut TestFixture, task_id: &str) {
        let saved = workspace::read_saved(&fixture.server.tasks)
            .unwrap()
            .unwrap();
        let mut data = saved["data"].clone();
        data["tasks"].as_array_mut().unwrap().push(json!({
            "id":task_id,
            "projectId":fixture.project_id,
            "title":"Hermes",
            "runtime":"hermes",
            "archived":false,
            "unread":false
        }));
        workspace::write_saved(
            &mut fixture.server.tasks,
            data,
            saved["revision"].as_u64().unwrap(),
        )
        .unwrap();
        let tx = fixture.server.tasks.transaction().unwrap();
        store::Journal::new(&tx)
            .ensure_task(task_id, "hermes")
            .unwrap();
        tx.commit().unwrap();
    }
    #[test]
    fn queue_report_uses_camel_case_and_bounds() {
        let report = QueueDrainReport {
            requested: 2,
            remaining_codex: 1,
            unsupported_queued: 3,
            ..QueueDrainReport::default()
        };
        let value = serde_json::to_value(report).unwrap();
        assert_eq!(value["remainingCodex"], 1);
        assert_eq!(value["unsupportedQueued"], 3);
        assert!(value.get("remaining_codex").is_none());
    }

    #[tokio::test]
    async fn missing_model_and_untrusted_binding_fail_visibly_while_unsupported_runtime_stays_queued(
    ) {
        let mut fixture = TestFixture::new();
        let hermes_id = "hermes-queued";
        add_hermes_task(&mut fixture, hermes_id);
        insert_queued_turn(
            &mut fixture.server,
            hermes_id,
            "hermes-turn",
            "leave me queued",
            json!([]),
        );

        let no_model = fixture.new_task("No model");
        insert_queued_turn(
            &mut fixture.server,
            &no_model,
            "no-model-turn",
            "preserve this prompt",
            json!([]),
        );
        let no_binding = fixture.new_task("No binding");
        set_saved_model(&mut fixture.server, &no_binding, "fixture-model");
        insert_queued_turn(
            &mut fixture.server,
            &no_binding,
            "no-binding-turn",
            "also preserve this",
            json!([]),
        );

        let (_cancel_tx, cancel) = watch::channel(false);
        let report = fixture
            .server
            .drain_codex_queue(fixture.config(), cancel, 2)
            .await
            .unwrap();
        assert_eq!(report.processed, 2);
        assert_eq!(report.failed, 2);
        assert_eq!(report.remaining_codex, 0);
        assert_eq!(report.unsupported_queued, 1);
        assert_eq!(report.blocked, 1);
        assert_eq!(
            report.turns[0].error.as_deref(),
            Some("queue-model-missing")
        );
        assert_eq!(
            report.turns[1].error.as_deref(),
            Some("queue-execution-binding-missing")
        );
        assert_eq!(
            store::turns(&fixture.server.tasks, hermes_id, "queued")
                .unwrap()
                .len(),
            1
        );
        for (task_id, turn_id, prompt) in [
            (no_model.as_str(), "no-model-turn", "preserve this prompt"),
            (no_binding.as_str(), "no-binding-turn", "also preserve this"),
        ] {
            let turns = store::turns(&fixture.server.tasks, task_id, "failed").unwrap();
            assert_eq!(turns.len(), 1);
            assert_eq!(turns[0].id, turn_id);
            assert_eq!(turns[0].input["text"], prompt);
            let messages = store::messages(&fixture.server.tasks, task_id).unwrap();
            assert_eq!(
                messages
                    .iter()
                    .filter(|message| message["kind"] == "user")
                    .count(),
                1
            );
            assert_eq!(messages[0]["text"], prompt);
        }
        assert!(!fixture
            .directory
            .join("isolated-home")
            .join("launches.log")
            .exists());
        fixture.cleanup();
    }

    #[test]
    fn claims_preserve_global_rowid_fifo_and_leave_running_work_ineligible() {
        let mut fixture = TestFixture::new();
        let first_task = fixture.new_task("First");
        let second_task = fixture.new_task("Second");
        let directory = fixture.directory.clone();
        let project_root = fixture.project_root.clone();
        pin_execution(&mut fixture.server, &first_task, &directory, &project_root);
        pin_execution(&mut fixture.server, &second_task, &directory, &project_root);
        insert_queued_turn(
            &mut fixture.server,
            &first_task,
            "first-turn",
            "first prompt",
            json!([]),
        );
        insert_queued_turn(
            &mut fixture.server,
            &second_task,
            "second-turn",
            "second prompt",
            json!([]),
        );

        let config = fixture.config();
        let first = match claim_next_codex_turn(&mut fixture.server, &config).unwrap() {
            ClaimOutcome::Claimed { turn, .. } => turn,
            _ => panic!("the oldest trusted Codex turn should be claimed"),
        };
        assert_eq!(first.turn_id, "first-turn");
        assert_eq!(first.config.model, "fixture-model");
        assert_eq!(
            store::turns(&fixture.server.tasks, &first_task, "queued")
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            store::turns(&fixture.server.tasks, &second_task, "queued").unwrap()[0].id,
            "second-turn"
        );
        assert_eq!(
            store::messages(&fixture.server.tasks, &first_task)
                .unwrap()
                .iter()
                .filter(|message| message["kind"] == "user")
                .count(),
            1
        );

        let tx = fixture.server.tasks.transaction().unwrap();
        let mut journal = store::Journal::new(&tx);
        journal
            .set_turn("first-turn", "completed", None, None)
            .unwrap();
        journal
            .edit_state(&first_task, |state| {
                state.pending = false;
                state.starting = false;
                state.live = false;
                state.ended = true;
            })
            .unwrap();
        drop(journal);
        tx.commit().unwrap();
        drop(first);

        let config = fixture.config();
        let second = match claim_next_codex_turn(&mut fixture.server, &config).unwrap() {
            ClaimOutcome::Claimed { turn, .. } => turn,
            _ => panic!("the next FIFO Codex turn should be claimed"),
        };
        assert_eq!(second.turn_id, "second-turn");
        fixture.cleanup();
    }

    #[tokio::test]
    async fn stopped_tasks_and_unsupported_turn_input_are_settled_without_dispatch() {
        let mut fixture = TestFixture::new();
        let stopped = fixture.new_task("Stopped");
        set_saved_model(&mut fixture.server, &stopped, "fixture-model");
        let directory = fixture.directory.clone();
        let project_root = fixture.project_root.clone();
        pin_execution(&mut fixture.server, &stopped, &directory, &project_root);
        insert_queued_turn(
            &mut fixture.server,
            &stopped,
            "stopped-turn",
            "stopped prompt",
            json!([]),
        );
        let attachments = fixture.new_task("Attachments");
        set_saved_model(&mut fixture.server, &attachments, "fixture-model");
        pin_execution(&mut fixture.server, &attachments, &directory, &project_root);
        insert_queued_turn(
            &mut fixture.server,
            &attachments,
            "attachment-turn",
            "unsupported attachment",
            json!([{"path":"secret"}]),
        );
        let tx = fixture.server.tasks.transaction().unwrap();
        store::Journal::new(&tx)
            .edit_state(&stopped, |state| state.stopped = true)
            .unwrap();
        tx.commit().unwrap();

        let (_cancel_tx, cancel) = watch::channel(false);
        let report = fixture
            .server
            .drain_codex_queue(fixture.config(), cancel, 2)
            .await
            .unwrap();
        assert_eq!(report.failed, 2);
        assert_eq!(report.turns[0].error.as_deref(), Some("queue-task-stopped"));
        assert_eq!(
            report.turns[1].error.as_deref(),
            Some("queue-turn-input-unsupported")
        );
        assert_eq!(
            store::turns(&fixture.server.tasks, &stopped, "failed")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store::turns(&fixture.server.tasks, &attachments, "failed")
                .unwrap()
                .len(),
            1
        );
        assert!(!fixture
            .directory
            .join("isolated-home")
            .join("launches.log")
            .exists());
        fixture.cleanup();
    }

    #[tokio::test]
    async fn cancellation_and_turn_limit_validation_do_not_claim_work() {
        let mut fixture = TestFixture::new();
        let task_id = fixture.new_task("Queued");
        set_saved_model(&mut fixture.server, &task_id, "fixture-model");
        let directory = fixture.directory.clone();
        let project_root = fixture.project_root.clone();
        pin_execution(&mut fixture.server, &task_id, &directory, &project_root);
        insert_queued_turn(
            &mut fixture.server,
            &task_id,
            "queued-turn",
            "queued prompt",
            json!([]),
        );

        let (_cancel_tx, cancel) = watch::channel(true);
        let report = fixture
            .server
            .drain_codex_queue(fixture.config(), cancel, 1)
            .await
            .unwrap();
        assert!(report.cancelled);
        assert_eq!(report.processed, 0);
        assert_eq!(
            store::turns(&fixture.server.tasks, &task_id, "queued")
                .unwrap()
                .len(),
            1
        );
        let (_cancel_tx, cancel) = watch::channel(false);
        assert!(fixture
            .server
            .drain_codex_queue(fixture.config(), cancel, 65)
            .await
            .is_err());
        fixture.cleanup();
    }

    #[tokio::test]
    async fn changed_account_is_rejected_before_the_child_thread_starts() {
        let fake_runtime = codex_fixture::CodexFixture::build().unwrap();
        let mut fixture = TestFixture::new();
        let task_id = fixture.new_task("Pinned child");
        set_saved_model(&mut fixture.server, &task_id, "fixture-model");
        insert_queued_turn(
            &mut fixture.server,
            &task_id,
            "account-turn",
            "account-bound prompt",
            json!([]),
        );
        let home = fake_runtime.root.join("isolated-home");
        fake_runtime.prepare_home(&home, "account-changed").unwrap();
        let mut pinned = CodexRunConfig {
            executable: fake_runtime.executable.clone(),
            codex_home: home.clone(),
            working_directory: fixture.project_root.clone(),
            model: "fixture-model".into(),
            timeout: Duration::from_secs(10),
            access_mode: None,
            resume_thread_id: None,
        };
        codex_runtime::prepare_config(&mut pinned, "account-bound prompt").unwrap();
        let tx = fixture.server.tasks.transaction().unwrap();
        runtime_session::bind(&tx, &task_id, &mut pinned).unwrap();
        runtime_session::attach_account(&tx, &task_id, &"a".repeat(64)).unwrap();
        tx.commit().unwrap();

        let default = CodexRunConfig {
            executable: fake_runtime.executable.clone(),
            codex_home: home.clone(),
            working_directory: PathBuf::new(),
            model: String::new(),
            timeout: Duration::from_secs(10),
            access_mode: None,
            resume_thread_id: None,
        };
        let (_cancel_tx, cancel) = watch::channel(false);
        let report = fixture
            .server
            .drain_codex_queue(default, cancel, 1)
            .await
            .unwrap();
        assert_eq!(report.failed, 1);
        assert!(report.turns[0]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("runtime-account-changed")));
        assert!(!home.join("thread-starts.log").exists());
        assert_eq!(
            store::turns(&fixture.server.tasks, &task_id, "failed")
                .unwrap()
                .len(),
            1
        );
        fixture.cleanup();
    }
}
