//! SQLite schema and journaled writes for server-owned agent tasks.
//!
//! Every change to a task, message, turn or approval is written in the same
//! transaction as its `task_events` row, so a client that reads a snapshot and
//! then replays events after its cursor never misses a change. The legacy app
//! table `events` is unrelated and keeps its own format.
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Events kept for cursor replay. Older clients receive `resync` and reload a snapshot.
pub(crate) const RETAINED_EVENTS: i64 = 50_000;
/// Command records older than this are pruned; a retry after that is treated as new.
const COMMAND_RETENTION_DAYS: i64 = 30;

pub(crate) fn create_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_tasks (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL DEFAULT 'local',
           runtime TEXT NOT NULL,
           config_json TEXT NOT NULL,
           state_json TEXT NOT NULL,
           revision INTEGER NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS agent_messages (
           task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
           id TEXT NOT NULL,
           ord INTEGER NOT NULL,
           kind TEXT NOT NULL,
           entry_json TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           PRIMARY KEY(task_id, id)
         );
         CREATE INDEX IF NOT EXISTS agent_messages_order ON agent_messages(task_id, ord);
         CREATE TABLE IF NOT EXISTS agent_turns (
           id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
           ord INTEGER NOT NULL,
           status TEXT NOT NULL CHECK(status IN ('queued','running','completed','interrupted','failed','cancelled')),
           command_id TEXT,
           message_id TEXT NOT NULL,
           input_json TEXT NOT NULL,
           native_turn_id TEXT,
           error TEXT,
           created_at TEXT NOT NULL,
           started_at TEXT,
           finished_at TEXT
         );
         CREATE INDEX IF NOT EXISTS agent_turns_queue ON agent_turns(task_id, status, ord);
         CREATE TABLE IF NOT EXISTS agent_commands (
           scope TEXT NOT NULL,
           id TEXT NOT NULL,
           kind TEXT NOT NULL,
           task_id TEXT,
           request_hash TEXT NOT NULL,
           result_json TEXT NOT NULL,
           created_at TEXT NOT NULL,
           PRIMARY KEY(scope, id)
         );
         CREATE TABLE IF NOT EXISTS agent_approvals (
           id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
           turn_id TEXT,
           runtime TEXT NOT NULL,
           connection_id TEXT NOT NULL,
           generation INTEGER NOT NULL,
           native_id TEXT NOT NULL,
           method TEXT NOT NULL CHECK(method IN ('approval','clarify')),
           params_json TEXT NOT NULL,
           request_json TEXT NOT NULL,
           status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired','stale')),
           decision_json TEXT,
           delivery TEXT CHECK(delivery IS NULL OR delivery IN ('pending','delivered','failed')),
           resolved_by TEXT,
           created_at TEXT NOT NULL,
           resolved_at TEXT
         );
         CREATE INDEX IF NOT EXISTS agent_approvals_pending ON agent_approvals(task_id, status);
         CREATE TABLE IF NOT EXISTS task_events (
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           task_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           revision INTEGER NOT NULL,
           at TEXT NOT NULL,
           payload TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS agent_task_imports (
           runtime TEXT PRIMARY KEY,
           status TEXT NOT NULL CHECK(status IN ('active','rolled_back')),
           source_revision INTEGER NOT NULL,
           backup_json TEXT NOT NULL,
           task_ids_json TEXT NOT NULL,
           imported_at TEXT NOT NULL,
           rolled_back_at TEXT
         );",
    )
    .map_err(|e| format!("Could not create agent task tables: {e}"))
}

pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
pub(crate) fn millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Runtime state the server owns. Client-only fields (draft, tabs, read state) never live here.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct TaskState {
    pub pending: bool,
    pub starting: bool,
    pub ended: bool,
    pub stopped: bool,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub io_error: Option<String>,
    /// A runtime session for this task is open in this process.
    pub live: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Value>,
    pub children: Vec<Value>,
}

/// What the client last asked the runtime to use. Paths are resolved by the host.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct TaskConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Task instructions and confirmed project memory, composed by the client.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct TaskRow {
    pub id: String,
    pub runtime: String,
    pub config: TaskConfig,
    pub state: TaskState,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TurnRow {
    pub id: String,
    pub task_id: String,
    pub status: String,
    pub command_id: Option<String>,
    pub message_id: String,
    pub input: Value,
    pub native_turn_id: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
}

impl TurnRow {
    pub(crate) fn view(&self) -> Value {
        json!({"id":self.id,"taskId":self.task_id,"status":self.status,"commandId":self.command_id,
            "messageId":self.message_id,"text":self.input["text"],"attachments":self.input["attachments"],
            "time":self.input["time"],"error":self.error})
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ApprovalRow {
    pub id: String,
    pub task_id: String,
    pub turn_id: Option<String>,
    pub runtime: String,
    pub connection_id: String,
    pub generation: u64,
    pub native_id: String,
    pub method: String,
    pub params: Value,
    pub request: Value,
    pub status: String,
    pub decision: Option<Value>,
    pub delivery: Option<String>,
    pub resolved_by: Option<String>,
}

impl ApprovalRow {
    /// Public view: the raw runtime request stays on the host.
    pub(crate) fn view(&self) -> Value {
        json!({"id":self.id,"taskId":self.task_id,"turnId":self.turn_id,"method":self.method,
            "params":self.params,"status":self.status,"decision":self.decision,
            "delivery":self.delivery,"resolvedBy":self.resolved_by})
    }
}

/// One write transaction plus the journal rows it produced.
pub(crate) struct Journal<'a> {
    pub tx: &'a Transaction<'a>,
    pub events: Vec<Value>,
}

impl<'a> Journal<'a> {
    pub(crate) fn new(tx: &'a Transaction<'a>) -> Self {
        Self {
            tx,
            events: Vec::new(),
        }
    }
    fn event(
        &mut self,
        task_id: &str,
        kind: &str,
        revision: i64,
        payload: Value,
    ) -> Result<(), String> {
        let at = now();
        self.tx
            .execute(
                "INSERT INTO task_events(task_id,kind,revision,at,payload) VALUES(?1,?2,?3,?4,?5)",
                params![task_id, kind, revision, at, payload.to_string()],
            )
            .map_err(|e| e.to_string())?;
        let seq = self.tx.last_insert_rowid();
        self.events.push(json!({"seq":seq,"taskId":task_id,"kind":kind,"revision":revision,"at":at,"payload":payload}));
        Ok(())
    }
    /// Increments the task revision and records the event at that revision.
    fn bump(&mut self, task_id: &str, kind: &str, payload: Value) -> Result<i64, String> {
        let revision: i64 = self
            .tx
            .query_row(
                "UPDATE agent_tasks SET revision=revision+1, updated_at=?2 WHERE id=?1 RETURNING revision",
                params![task_id, now()],
                |r| r.get(0),
            )
            .map_err(|_| "task-missing".to_string())?;
        self.event(task_id, kind, revision, payload)?;
        Ok(revision)
    }

    pub(crate) fn task(&self, id: &str) -> Result<Option<TaskRow>, String> {
        read_task(self.tx, id)
    }
    pub(crate) fn ensure_task(&mut self, id: &str, runtime: &str) -> Result<TaskRow, String> {
        if let Some(task) = self.task(id)? {
            if task.runtime != runtime {
                return Err("runtime-changed".into());
            }
            return Ok(task);
        }
        let at = now();
        self.tx
            .execute(
                "INSERT INTO agent_tasks(id,runtime,config_json,state_json,revision,created_at,updated_at) VALUES(?1,?2,'{}',?3,0,?4,?4)",
                params![id, runtime, serde_json::to_string(&TaskState::default()).unwrap(), at],
            )
            .map_err(|e| e.to_string())?;
        let task = self.task(id)?.ok_or("task-missing")?;
        self.publish_task(&task.id)?;
        self.task(id)?.ok_or_else(|| "task-missing".into())
    }
    pub(crate) fn set_state(&mut self, id: &str, state: &TaskState) -> Result<(), String> {
        let current = self.task(id)?.ok_or("task-missing")?;
        if current.state == *state {
            return Ok(());
        }
        self.tx
            .execute(
                "UPDATE agent_tasks SET state_json=?2 WHERE id=?1",
                params![id, serde_json::to_string(state).map_err(|e| e.to_string())?],
            )
            .map_err(|e| e.to_string())?;
        self.publish_task(id)
    }
    pub(crate) fn edit_state(
        &mut self,
        id: &str,
        edit: impl FnOnce(&mut TaskState),
    ) -> Result<TaskState, String> {
        let mut state = self.task(id)?.ok_or("task-missing")?.state;
        edit(&mut state);
        self.set_state(id, &state)?;
        Ok(state)
    }
    pub(crate) fn set_config(&mut self, id: &str, config: &TaskConfig) -> Result<(), String> {
        self.tx
            .execute(
                "UPDATE agent_tasks SET config_json=?2 WHERE id=?1",
                params![
                    id,
                    serde_json::to_string(config).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    fn publish_task(&mut self, id: &str) -> Result<(), String> {
        let task = self.task(id)?.ok_or("task-missing")?;
        self.bump(
            id,
            "task.upsert",
            json!({"runtime":task.runtime,"state":task.state}),
        )?;
        Ok(())
    }

    pub(crate) fn upsert_message(&mut self, task_id: &str, entry: &Value) -> Result<(), String> {
        let id = entry["id"].as_str().ok_or("message-id")?;
        let kind = entry["kind"].as_str().unwrap_or("notice");
        let ord: i64 = self
            .tx
            .query_row(
                "SELECT COALESCE((SELECT ord FROM agent_messages WHERE task_id=?1 AND id=?2),(SELECT COALESCE(MAX(ord),0)+1 FROM agent_messages WHERE task_id=?1))",
                params![task_id, id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        self.tx
            .execute(
                "INSERT INTO agent_messages(task_id,id,ord,kind,entry_json,updated_at) VALUES(?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(task_id,id) DO UPDATE SET kind=excluded.kind,entry_json=excluded.entry_json,updated_at=excluded.updated_at",
                params![task_id, id, ord, kind, entry.to_string(), now()],
            )
            .map_err(|e| e.to_string())?;
        self.bump(task_id, "message.upsert", json!({"message":entry}))?;
        Ok(())
    }
    pub(crate) fn message(&self, task_id: &str, id: &str) -> Result<Option<Value>, String> {
        self.tx
            .query_row(
                "SELECT entry_json FROM agent_messages WHERE task_id=?1 AND id=?2",
                params![task_id, id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .map(|raw| serde_json::from_str(&raw).map_err(|e| e.to_string()))
            .transpose()
    }
    /// Appends streamed text. `limit` keeps only the tail, as tool output does.
    pub(crate) fn append_message(
        &mut self,
        task_id: &str,
        id: &str,
        text: &str,
        reasoning: &str,
        limit: Option<usize>,
    ) -> Result<(), String> {
        if text.is_empty() && reasoning.is_empty() {
            return Ok(());
        }
        let Some(mut entry) = self.message(task_id, id)? else {
            return Ok(());
        };
        if !text.is_empty() {
            let mut joined = format!("{}{}", entry["text"].as_str().unwrap_or(""), text);
            if let Some(limit) = limit {
                joined = tail(&joined, limit);
            }
            entry["text"] = json!(joined);
        }
        if !reasoning.is_empty() {
            entry["reasoning"] = json!(format!(
                "{}{}",
                entry["reasoning"].as_str().unwrap_or(""),
                reasoning
            ));
        }
        self.tx
            .execute(
                "UPDATE agent_messages SET entry_json=?3,updated_at=?4 WHERE task_id=?1 AND id=?2",
                params![task_id, id, entry.to_string(), now()],
            )
            .map_err(|e| e.to_string())?;
        self.bump(
            task_id,
            "message.append",
            json!({"id":id,"text":text,"reasoning":reasoning,"limit":limit}),
        )?;
        Ok(())
    }
    pub(crate) fn delete_message(&mut self, task_id: &str, id: &str) -> Result<(), String> {
        if self
            .tx
            .execute(
                "DELETE FROM agent_messages WHERE task_id=?1 AND id=?2",
                params![task_id, id],
            )
            .map_err(|e| e.to_string())?
            > 0
        {
            self.bump(task_id, "message.remove", json!({"id":id}))?;
        }
        Ok(())
    }
    /// Marks every running tool entry as finished with `status`.
    pub(crate) fn settle_running_tools(
        &mut self,
        task_id: &str,
        status: &str,
    ) -> Result<(), String> {
        let running = messages(self.tx, task_id)?
            .into_iter()
            .filter(|e| e["kind"] == "tool" && e["status"] == "running")
            .collect::<Vec<_>>();
        for mut entry in running {
            entry["status"] = json!(status);
            self.upsert_message(task_id, &entry)?;
        }
        Ok(())
    }

    pub(crate) fn insert_turn(&mut self, turn: &TurnRow) -> Result<(), String> {
        let ord: i64 = self
            .tx
            .query_row(
                "SELECT COALESCE(MAX(ord),0)+1 FROM agent_turns WHERE task_id=?1",
                [&turn.task_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        self.tx
            .execute(
                "INSERT INTO agent_turns(id,task_id,ord,status,command_id,message_id,input_json,native_turn_id,error,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![turn.id, turn.task_id, ord, turn.status, turn.command_id, turn.message_id, turn.input.to_string(), turn.native_turn_id, turn.error, turn.created_at],
            )
            .map_err(|e| e.to_string())?;
        self.bump(&turn.task_id, "turn.upsert", json!({"turn":turn.view()}))?;
        Ok(())
    }
    pub(crate) fn turn(&self, id: &str) -> Result<Option<TurnRow>, String> {
        read_turns(self.tx, "WHERE id=?1", params![id]).map(|mut rows| rows.pop())
    }
    /// Moves a turn to `status`. Terminal turns never change again.
    pub(crate) fn set_turn(
        &mut self,
        id: &str,
        status: &str,
        native_turn_id: Option<&str>,
        error: Option<&str>,
    ) -> Result<Option<TurnRow>, String> {
        let Some(mut turn) = self.turn(id)? else {
            return Ok(None);
        };
        if !["queued", "running"].contains(&turn.status.as_str()) {
            return Ok(None);
        }
        let at = now();
        self.tx
            .execute(
                "UPDATE agent_turns SET status=?2, native_turn_id=COALESCE(?3,native_turn_id), error=COALESCE(?4,error),
                   started_at=CASE WHEN ?2='running' THEN ?5 ELSE started_at END,
                   finished_at=CASE WHEN ?2 IN ('queued','running') THEN finished_at ELSE ?5 END WHERE id=?1",
                params![id, status, native_turn_id, error, at],
            )
            .map_err(|e| e.to_string())?;
        turn = self.turn(id)?.ok_or("turn-missing")?;
        self.bump(
            &turn.task_id.clone(),
            "turn.upsert",
            json!({"turn":turn.view()}),
        )?;
        Ok(Some(turn))
    }
    pub(crate) fn turns(&self, task_id: &str, status: &str) -> Result<Vec<TurnRow>, String> {
        read_turns(
            self.tx,
            "WHERE task_id=?1 AND status=?2 ORDER BY ord",
            params![task_id, status],
        )
    }

    pub(crate) fn insert_approval(&mut self, approval: &ApprovalRow) -> Result<(), String> {
        self.tx
            .execute(
                "INSERT INTO agent_approvals(id,task_id,turn_id,runtime,connection_id,generation,native_id,method,params_json,request_json,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending',?11)",
                params![approval.id, approval.task_id, approval.turn_id, approval.runtime, approval.connection_id, approval.generation as i64, approval.native_id, approval.method, approval.params.to_string(), approval.request.to_string(), now()],
            )
            .map_err(|e| e.to_string())?;
        let row = self.approval(&approval.id)?.ok_or("approval-missing")?;
        self.bump(
            &row.task_id,
            "approval.upsert",
            json!({"approval":row.view()}),
        )?;
        Ok(())
    }
    pub(crate) fn approval(&self, id: &str) -> Result<Option<ApprovalRow>, String> {
        approval(self.tx, id)
    }
    pub(crate) fn approvals(
        &self,
        task_id: &str,
        status: &str,
    ) -> Result<Vec<ApprovalRow>, String> {
        approvals(self.tx, task_id, status)
    }
    /// Applies a state-machine transition. Returns false when the row was not `pending`.
    pub(crate) fn transition_approval(
        &mut self,
        id: &str,
        to: &str,
        decision: Option<&Value>,
        delivery: Option<&str>,
        by: Option<&str>,
    ) -> Result<bool, String> {
        let changed = self
            .tx
            .execute(
                "UPDATE agent_approvals SET status=?2, decision_json=?3, delivery=?4, resolved_by=?5, resolved_at=?6 WHERE id=?1 AND status='pending'",
                params![id, to, decision.map(Value::to_string), delivery, by, now()],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Ok(false);
        }
        let row = self.approval(id)?.ok_or("approval-missing")?;
        self.bump(
            &row.task_id,
            "approval.upsert",
            json!({"approval":row.view()}),
        )?;
        Ok(true)
    }
    pub(crate) fn set_delivery(&mut self, id: &str, delivery: &str) -> Result<(), String> {
        self.tx
            .execute(
                "UPDATE agent_approvals SET delivery=?2 WHERE id=?1",
                params![id, delivery],
            )
            .map_err(|e| e.to_string())?;
        let row = self.approval(id)?.ok_or("approval-missing")?;
        self.bump(
            &row.task_id,
            "approval.upsert",
            json!({"approval":row.view()}),
        )?;
        Ok(())
    }
    /// Every still-pending approval of a task becomes `to` (expired or stale).
    /// Ends every waiting approval of a task: `Expire` when its turn ended,
    /// `Invalidate` when the worker that asked is gone.
    pub(crate) fn close_approvals(
        &mut self,
        task_id: &str,
        event: super::approvals::Event<'_>,
    ) -> Result<Vec<ApprovalRow>, String> {
        let pending = self.approvals(task_id, "pending")?;
        for approval in &pending {
            let current =
                super::approvals::Status::parse(&approval.status).ok_or("approval-invalid")?;
            if let super::approvals::Outcome::Moved(to) =
                super::approvals::transition(current, event)
            {
                self.transition_approval(&approval.id, to.as_str(), None, None, Some("host"))?;
            }
        }
        Ok(pending)
    }

    /// Idempotency check. `Ok(Some(result))` replays an accepted command; a
    /// different request under the same id is rejected.
    pub(crate) fn command(
        &self,
        scope: &str,
        id: &str,
        hash: &str,
    ) -> Result<Option<Value>, String> {
        let row: Option<(String, String)> = self
            .tx
            .query_row(
                "SELECT request_hash,result_json FROM agent_commands WHERE scope=?1 AND id=?2",
                params![scope, id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match row {
            None => Ok(None),
            Some((stored, _)) if stored != hash => Err("command-conflict".into()),
            Some((_, result)) => serde_json::from_str(&result)
                .map(Some)
                .map_err(|e| e.to_string()),
        }
    }
    pub(crate) fn record_command(
        &mut self,
        scope: &str,
        id: &str,
        kind: &str,
        task_id: &str,
        hash: &str,
        result: &Value,
    ) -> Result<(), String> {
        self.tx
            .execute(
                "INSERT INTO agent_commands(scope,id,kind,task_id,request_hash,result_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![scope, id, kind, task_id, hash, result.to_string(), now()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn tail(text: &str, limit: usize) -> String {
    let count = text.chars().count();
    if count <= limit {
        return text.to_owned();
    }
    text.chars().skip(count - limit).collect()
}

pub(crate) fn read_task(conn: &Connection, id: &str) -> Result<Option<TaskRow>, String> {
    conn.query_row(
        "SELECT id,runtime,config_json,state_json,revision FROM agent_tasks WHERE id=?1",
        [id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        },
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|(id, runtime, config, state, revision)| {
        Ok(TaskRow {
            id,
            runtime,
            config: serde_json::from_str(&config).unwrap_or_default(),
            state: serde_json::from_str(&state).unwrap_or_default(),
            revision,
        })
    })
    .transpose()
}

pub(crate) fn task_ids(conn: &Connection, runtime: Option<&str>) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare("SELECT id FROM agent_tasks WHERE ?1 IS NULL OR runtime=?1 ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([runtime], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string());
    rows
}

pub(crate) fn messages(conn: &Connection, task_id: &str) -> Result<Vec<Value>, String> {
    let mut statement = conn
        .prepare("SELECT entry_json FROM agent_messages WHERE task_id=?1 ORDER BY ord")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([task_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|raw| raw.ok().and_then(|raw| serde_json::from_str(&raw).ok()))
        .collect();
    Ok(rows)
}

fn read_turns(
    conn: &Connection,
    filter: &str,
    values: impl rusqlite::Params,
) -> Result<Vec<TurnRow>, String> {
    let mut statement = conn
        .prepare(&format!("SELECT id,task_id,status,command_id,message_id,input_json,native_turn_id,error,created_at FROM agent_turns {filter}"))
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(values, |r| {
            Ok(TurnRow {
                id: r.get(0)?,
                task_id: r.get(1)?,
                status: r.get(2)?,
                command_id: r.get(3)?,
                message_id: r.get(4)?,
                input: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or(Value::Null),
                native_turn_id: r.get(6)?,
                error: r.get(7)?,
                created_at: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    rows
}

pub(crate) fn approval(conn: &Connection, id: &str) -> Result<Option<ApprovalRow>, String> {
    read_approvals(conn, "WHERE id=?1", params![id]).map(|mut rows| rows.pop())
}
pub(crate) fn approvals(
    conn: &Connection,
    task_id: &str,
    status: &str,
) -> Result<Vec<ApprovalRow>, String> {
    read_approvals(
        conn,
        "WHERE task_id=?1 AND status=?2 ORDER BY created_at",
        params![task_id, status],
    )
}

fn read_approvals(
    conn: &Connection,
    filter: &str,
    values: impl rusqlite::Params,
) -> Result<Vec<ApprovalRow>, String> {
    let mut statement = conn
        .prepare(&format!("SELECT id,task_id,turn_id,runtime,connection_id,generation,native_id,method,params_json,request_json,status,decision_json,delivery,resolved_by FROM agent_approvals {filter}"))
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(values, |r| {
            Ok(ApprovalRow {
                id: r.get(0)?,
                task_id: r.get(1)?,
                turn_id: r.get(2)?,
                runtime: r.get(3)?,
                connection_id: r.get(4)?,
                generation: r.get::<_, i64>(5)? as u64,
                native_id: r.get(6)?,
                method: r.get(7)?,
                params: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or(Value::Null),
                request: serde_json::from_str(&r.get::<_, String>(9)?).unwrap_or(Value::Null),
                status: r.get(10)?,
                decision: r
                    .get::<_, Option<String>>(11)?
                    .and_then(|raw| serde_json::from_str(&raw).ok()),
                delivery: r.get(12)?,
                resolved_by: r.get(13)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    rows
}

pub(crate) fn cursor(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COALESCE(MAX(seq),0) FROM task_events", [], |r| {
        r.get(0)
    })
    .map_err(|e| e.to_string())
}

/// Events after `after`, or `None` when the journal no longer holds them.
pub(crate) fn events_after(
    conn: &Connection,
    after: i64,
    limit: i64,
) -> Result<Option<Vec<Value>>, String> {
    let oldest: Option<i64> = conn
        .query_row("SELECT MIN(seq) FROM task_events", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let pruned: i64 = conn
        .query_row(
            "SELECT COALESCE(seq,0) FROM sqlite_sequence WHERE name='task_events'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    // A cursor older than the retained window, or ahead of the journal after a restore, cannot be replayed.
    if after > pruned || oldest.is_some_and(|oldest| after + 1 < oldest) {
        return Ok(None);
    }
    let mut statement = conn
        .prepare("SELECT seq,task_id,kind,revision,at,payload FROM task_events WHERE seq>?1 ORDER BY seq LIMIT ?2")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![after, limit], |r| {
            Ok(json!({"seq":r.get::<_, i64>(0)?,"taskId":r.get::<_, String>(1)?,"kind":r.get::<_, String>(2)?,
                "revision":r.get::<_, i64>(3)?,"at":r.get::<_, String>(4)?,
                "payload":serde_json::from_str::<Value>(&r.get::<_, String>(5)?).unwrap_or(Value::Null)}))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(Some(rows))
}

/// Full view of one task: what a client needs to render it without history replay.
pub(crate) fn task_view(conn: &Connection, id: &str) -> Result<Option<Value>, String> {
    let Some(task) = read_task(conn, id)? else {
        return Ok(None);
    };
    let queue = read_turns(
        conn,
        "WHERE task_id=?1 AND status IN ('queued','running') ORDER BY ord",
        params![id],
    )?;
    let approvals = read_approvals(
        conn,
        "WHERE task_id=?1 AND status='pending' ORDER BY created_at",
        params![id],
    )?;
    Ok(Some(
        json!({"id":task.id,"runtime":task.runtime,"revision":task.revision,"state":task.state,
        "messages":messages(conn,id)?,"turns":queue.iter().map(TurnRow::view).collect::<Vec<_>>(),
        "approvals":approvals.iter().map(ApprovalRow::view).collect::<Vec<_>>()}),
    ))
}

pub(crate) fn server_runtimes(conn: &Connection) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare("SELECT runtime FROM agent_task_imports WHERE status='active' ORDER BY runtime")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string());
    rows
}

/// After a host restart nothing is live: running turns end with an honest
/// `interrupted` outcome (never re-run), and waiting approvals become `stale`.
pub(crate) fn recover(conn: &mut Connection) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut journal = Journal::new(&tx);
        for id in task_ids(&tx, None)? {
            for turn in journal.turns(&id, "running")? {
                journal.set_turn(&turn.id, "interrupted", None, Some("host-restarted"))?;
            }
            journal.close_approvals(&id, super::approvals::Event::Invalidate)?;
            journal.settle_running_tools(&id, "unknown")?;
            journal.edit_state(&id, |state| {
                // A native session survives the host and is resumed on the next message.
                if state.live && state.native_session_id.is_some() {
                    state.ended = false;
                }
                state.live = false;
                state.pending = false;
                state.starting = false;
            })?;
        }
    }
    tx.execute(
        "DELETE FROM task_events WHERE seq <= (SELECT COALESCE(MAX(seq),0) FROM task_events) - ?1",
        [RETAINED_EVENTS],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM agent_commands WHERE created_at < ?1",
        [(chrono::Utc::now() - chrono::Duration::days(COMMAND_RETENTION_DAYS)).to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
pub(crate) fn test_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "PRAGMA foreign_keys=ON; CREATE TABLE kv(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);",
    )
    .unwrap();
    create_schema(&conn).unwrap();
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_records_every_change_in_order() {
        let mut conn = test_db();
        let tx = conn.transaction().unwrap();
        let mut j = Journal::new(&tx);
        j.ensure_task("t", "codex").unwrap();
        j.upsert_message("t", &json!({"id":"m","kind":"assistant","text":"he"}))
            .unwrap();
        j.append_message("t", "m", "llo", "", None).unwrap();
        let kinds: Vec<_> = j
            .events
            .iter()
            .map(|e| e["kind"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(kinds, ["task.upsert", "message.upsert", "message.append"]);
        let revisions: Vec<_> = j
            .events
            .iter()
            .map(|e| e["revision"].as_i64().unwrap())
            .collect();
        assert_eq!(revisions, [1, 2, 3]);
        assert_eq!(j.message("t", "m").unwrap().unwrap()["text"], "hello");
        drop(j);
        tx.commit().unwrap();
        let replay = events_after(&conn, 1, 100).unwrap().unwrap();
        assert_eq!(replay.len(), 2);
        assert_eq!(cursor(&conn).unwrap(), 3);
    }

    #[test]
    fn tool_output_keeps_only_the_tail() {
        let mut conn = test_db();
        let tx = conn.transaction().unwrap();
        let mut j = Journal::new(&tx);
        j.ensure_task("t", "codex").unwrap();
        j.upsert_message("t", &json!({"id":"tool","kind":"tool","text":"abc"}))
            .unwrap();
        j.append_message("t", "tool", "defg", "", Some(4)).unwrap();
        assert_eq!(j.message("t", "tool").unwrap().unwrap()["text"], "defg");
    }

    #[test]
    fn stale_cursor_requires_a_snapshot() {
        let mut conn = test_db();
        {
            let tx = conn.transaction().unwrap();
            let mut j = Journal::new(&tx);
            j.ensure_task("t", "codex").unwrap();
            for n in 0..5 {
                j.upsert_message(
                    "t",
                    &json!({"id":format!("m{n}"),"kind":"notice","text":""}),
                )
                .unwrap();
            }
            drop(j);
            tx.commit().unwrap();
        }
        conn.execute("DELETE FROM task_events WHERE seq<=3", [])
            .unwrap();
        assert!(events_after(&conn, 1, 10).unwrap().is_none());
        assert_eq!(events_after(&conn, 3, 10).unwrap().unwrap().len(), 3);
        // A cursor from a newer journal (e.g. a restored backup) is not silently accepted.
        assert!(events_after(&conn, 99, 10).unwrap().is_none());
    }

    #[test]
    fn recovery_interrupts_running_turns_and_stales_approvals() {
        let mut conn = test_db();
        {
            let tx = conn.transaction().unwrap();
            let mut j = Journal::new(&tx);
            j.ensure_task("t", "codex").unwrap();
            j.edit_state("t", |s| {
                s.live = true;
                s.pending = true;
                s.native_session_id = Some("thread".into());
            })
            .unwrap();
            j.insert_turn(&TurnRow {
                id: "turn".into(),
                task_id: "t".into(),
                status: "running".into(),
                command_id: None,
                message_id: "u".into(),
                input: json!({"text":"hi"}),
                native_turn_id: None,
                error: None,
                created_at: now(),
            })
            .unwrap();
            j.insert_approval(&ApprovalRow {
                id: "a".into(),
                task_id: "t".into(),
                turn_id: Some("turn".into()),
                runtime: "codex".into(),
                connection_id: "c".into(),
                generation: 1,
                native_id: "7".into(),
                method: "approval".into(),
                params: json!({}),
                request: json!({}),
                status: "pending".into(),
                decision: None,
                delivery: None,
                resolved_by: None,
            })
            .unwrap();
            j.upsert_message(
                "t",
                &json!({"id":"tool","kind":"tool","text":"","status":"running"}),
            )
            .unwrap();
            drop(j);
            tx.commit().unwrap();
        }
        recover(&mut conn).unwrap();
        let task = read_task(&conn, "t").unwrap().unwrap();
        assert!(!task.state.live && !task.state.pending && !task.state.ended);
        let view = task_view(&conn, "t").unwrap().unwrap();
        assert_eq!(view["turns"].as_array().unwrap().len(), 0);
        assert_eq!(view["approvals"].as_array().unwrap().len(), 0);
        assert_eq!(view["messages"][0]["status"], "unknown");
        let status: String = conn
            .query_row("SELECT status FROM agent_approvals WHERE id='a'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(status, "stale");
        let turn: String = conn
            .query_row("SELECT status FROM agent_turns WHERE id='turn'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(turn, "interrupted");
    }
}
