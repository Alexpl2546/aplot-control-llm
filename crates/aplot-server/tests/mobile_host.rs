//! Durable mobile command and live worker behavior with a local fake Codex app-server.
#[path = "support/codex_fixture.rs"]
mod codex_fixture;

use aplot_server::{
    codex_runtime::CodexRunConfig,
    mobile_host::{start_mobile_host, MobileHost, MobileWorker},
    ServerData,
};
use codex_fixture::CodexFixture;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::time::sleep;

struct TestEnvironment {
    root: PathBuf,
    data_dir: PathBuf,
    project: PathBuf,
    project_id: String,
    fixture: CodexFixture,
}

impl TestEnvironment {
    fn new(mode: &str) -> Self {
        let fixture = CodexFixture::build().expect("build fake Codex executable");
        let root = std::env::temp_dir().join(format!("aplot-mobile-host-{}", uuid::Uuid::new_v4()));
        let data_dir = root.join("server");
        let project = root.join("project");
        let home = root.join("codex-home");
        fs::create_dir_all(&data_dir).unwrap();
        fs::create_dir_all(&project).unwrap();
        fixture.prepare_home(&home, mode).unwrap();

        // Initialize the journal schema before seeding its versioned workspace.
        drop(ServerData::open(&data_dir).unwrap());
        let project_id = uuid::Uuid::new_v4().to_string();
        let mut database = Connection::open(data_dir.join("server-tasks.sqlite3")).unwrap();
        aplot_core::workspace::write_saved(
            &mut database,
            json!({
                "projects":[{"id":project_id,"name":"Mobile host test","path":project}],
                "tasks":[],
                "presets":[],
                "threads":{},
                "memory":[]
            }),
            0,
        )
        .unwrap();

        Self {
            root,
            data_dir,
            project,
            project_id,
            fixture,
        }
    }

    fn home(&self) -> PathBuf {
        self.root.join("codex-home")
    }

    fn config(&self, home: PathBuf) -> CodexRunConfig {
        CodexRunConfig {
            executable: self.fixture.executable.clone(),
            codex_home: home,
            working_directory: self.project.clone(),
            model: "fixture-model".into(),
            timeout: Duration::from_secs(30),
            access_mode: None,
            resume_thread_id: None,
        }
    }

    fn start(&self, config: Option<CodexRunConfig>) -> (MobileHost, MobileWorker) {
        start_mobile_host(ServerData::open(&self.data_dir).unwrap(), config).unwrap()
    }

    fn create_task(&self, host: &MobileHost, suffix: &str) -> String {
        host.create_task(
            &self.project_id,
            &uuid::Uuid::new_v4().to_string(),
            &format!("Mobile task {suffix}"),
        )
        .unwrap()["taskId"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn command_status(host: &MobileHost, task_id: &str, command_id: &str) -> Option<String> {
        host.task(task_id).ok()?["commands"]
            .as_array()?
            .iter()
            .find(|command| command["commandId"] == command_id)?["status"]
            .as_str()
            .map(str::to_owned)
    }

    fn database(&self) -> Connection {
        Connection::open(self.data_dir.join("server-tasks.sqlite3")).unwrap()
    }
}

impl Drop for TestEnvironment {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn send(host: &MobileHost, task_id: &str, command_id: &str, text: &str) -> Value {
    host.send(task_id, command_id, text).unwrap()
}

async fn wait_for<F>(mut predicate: F, what: &str)
where
    F: FnMut() -> bool,
{
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if predicate() {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn create_and_send_retries_are_stable_and_payload_conflicts_are_rejected() {
    let env = TestEnvironment::new("complete");
    let (host, worker) = env.start(Some(env.config(env.home())));
    let create_id = uuid::Uuid::new_v4().to_string();
    let first = host
        .create_task(&env.project_id, &create_id, "Stable task")
        .unwrap();
    assert_eq!(first["status"], "created");
    let replay = host
        .create_task(&env.project_id, &create_id, "Stable task")
        .unwrap();
    assert_eq!(replay["taskId"], first["taskId"]);
    assert_eq!(replay["status"], "created");
    assert_eq!(
        host.create_task(&env.project_id, &create_id, "Changed title")
            .unwrap_err(),
        "mobile-command-conflict"
    );

    let task_id = first["taskId"].as_str().unwrap();
    let stale_stop_id = uuid::Uuid::new_v4().to_string();
    let stale_turn_id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        host.interrupt(&task_id, &stale_stop_id, 1, &stale_turn_id)
            .unwrap_err(),
        "mobile-generation-stale"
    );
    assert_eq!(
        host.interrupt(&task_id, &stale_stop_id, 1, &stale_turn_id)
            .unwrap_err(),
        "mobile-generation-stale"
    );

    let command_id = uuid::Uuid::new_v4().to_string();
    let accepted = send(&host, task_id, &command_id, " same prompt ");
    assert_eq!(accepted["status"], "queued");
    assert_eq!(send(&host, task_id, &command_id, " same prompt "), accepted);
    assert_eq!(
        host.send(task_id, &command_id, "different prompt")
            .unwrap_err(),
        "mobile-command-conflict"
    );

    let command_rows = host.task(task_id).unwrap()["commands"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(command_rows.len(), 2);
    assert!(command_rows
        .iter()
        .all(|command| command["kind"] != "create-task"));
    assert_eq!(
        command_rows
            .iter()
            .filter(|command| command["commandId"] == command_id)
            .count(),
        1
    );
    let command = command_rows
        .iter()
        .find(|command| command["commandId"] == command_id)
        .unwrap();
    assert_eq!(command["text"], " same prompt ");
    let failed_stop = command_rows
        .iter()
        .find(|command| command["commandId"] == stale_stop_id)
        .unwrap();
    assert_eq!(failed_stop["kind"], "interrupt");
    assert_eq!(failed_stop["status"], "failed");
    assert_eq!(failed_stop["error"], "mobile-generation-stale");
    host.shutdown();
    drop(worker);
}

#[test]
fn access_mode_change_uses_task_revision_and_replays_without_mutating_again() {
    let env = TestEnvironment::new("complete");
    let (host, worker) = env.start(None);
    let task_id = env.create_task(&host, "access mode CAS");
    let listed = host.workspace().unwrap();
    let task = listed["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["id"] == task_id)
        .unwrap();
    assert_eq!(task["accessMode"], "restricted");
    assert!(task["revision"].as_u64().unwrap() > 0);
    let expected_revision = task["revision"].as_u64().unwrap();
    assert_eq!(listed["capabilities"]["changeAccessMode"], true);
    assert_eq!(
        listed["capabilities"]["allowedAccessModes"],
        json!(["restricted", "full"])
    );

    let command_id = uuid::Uuid::new_v4().to_string();
    let updated = host
        .change_access_mode(&task_id, &command_id, expected_revision, "full")
        .unwrap();
    assert_eq!(updated["status"], "updated");
    assert_eq!(updated["accessMode"], "full");
    assert_eq!(updated["revision"].as_u64().unwrap(), expected_revision + 1);
    assert_eq!(
        host.task(&task_id).unwrap()["metadata"]["accessMode"],
        "full"
    );

    let replay = host
        .change_access_mode(&task_id, &command_id, expected_revision, "full")
        .unwrap();
    assert_eq!(replay, updated);
    assert_eq!(
        host.workspace().unwrap()["tasks"][0]["revision"],
        updated["revision"]
    );
    assert_eq!(
        host.change_access_mode(&task_id, &command_id, expected_revision, "restricted")
            .unwrap_err(),
        "mobile-command-conflict"
    );
    assert_eq!(
        host.change_access_mode(
            &task_id,
            &uuid::Uuid::new_v4().to_string(),
            expected_revision,
            "restricted",
        )
        .unwrap_err(),
        "mobile-task-revision-stale"
    );
    assert_eq!(
        host.task(&task_id).unwrap()["metadata"]["accessMode"],
        "full"
    );
    host.shutdown();
    drop(worker);
}

#[test]
fn access_mode_cannot_change_while_a_mobile_send_is_queued() {
    let env = TestEnvironment::new("complete");
    let (host, worker) = env.start(Some(env.config(env.home())));
    let task_id = env.create_task(&host, "queued access mode");
    let initial = host.task(&task_id).unwrap();
    let revision = initial["task"]["revision"].as_u64().unwrap();
    host.change_access_mode(
        &task_id,
        &uuid::Uuid::new_v4().to_string(),
        revision,
        "full",
    )
    .unwrap();
    let revision = host.task(&task_id).unwrap()["task"]["revision"]
        .as_u64()
        .unwrap();
    let accepted = send(
        &host,
        &task_id,
        &uuid::Uuid::new_v4().to_string(),
        "queued work",
    );
    assert_eq!(accepted["status"], "queued");
    assert_eq!(
        host.change_access_mode(
            &task_id,
            &uuid::Uuid::new_v4().to_string(),
            revision,
            "restricted"
        )
        .unwrap_err(),
        "mobile-task-busy"
    );
    assert_eq!(
        host.task(&task_id).unwrap()["metadata"]["accessMode"],
        "full"
    );
    host.shutdown();
    drop(worker);
}

#[test]
fn access_mode_cannot_change_while_a_native_turn_is_queued() {
    let env = TestEnvironment::new("complete");
    let (host, worker) = env.start(None);
    let task_id = env.create_task(&host, "native queue access mode");
    let mut database = env.database();
    let tx = database.transaction().unwrap();
    aplot_core::tasks::store::Journal::new(&tx)
        .insert_turn(&aplot_core::tasks::store::TurnRow {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: task_id.clone(),
            status: "queued".into(),
            command_id: None,
            message_id: uuid::Uuid::new_v4().to_string(),
            input: json!({"text":"already accepted","attachments":[],"time":1}),
            native_turn_id: None,
            error: None,
            created_at: aplot_core::tasks::store::now(),
        })
        .unwrap();
    tx.commit().unwrap();
    let revision = host.task(&task_id).unwrap()["task"]["revision"]
        .as_u64()
        .unwrap();
    assert_eq!(
        host.change_access_mode(
            &task_id,
            &uuid::Uuid::new_v4().to_string(),
            revision,
            "full"
        )
        .unwrap_err(),
        "mobile-task-busy"
    );
    assert_eq!(
        host.task(&task_id).unwrap()["metadata"]["accessMode"],
        "restricted"
    );
    host.shutdown();
    drop(worker);
}

#[tokio::test(flavor = "current_thread")]
async fn task_saved_mode_overrides_server_config_and_untrusted_manual_mode_fails_closed() {
    let env = TestEnvironment::new("complete");
    let mut server_config = env.config(env.home());
    server_config.access_mode = Some("full".into());
    let (host, worker) = env.start(Some(server_config));
    let task_id = env.create_task(&host, "no implicit access fallthrough");
    assert_eq!(
        host.task(&task_id).unwrap()["metadata"]["accessMode"],
        "restricted"
    );
    let command_id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        send(&host, &task_id, &command_id, "restricted by task")["status"],
        "queued"
    );
    let worker_task = tokio::spawn(worker.run());
    wait_for(
        || {
            TestEnvironment::command_status(&host, &task_id, &command_id).as_deref()
                == Some("completed")
        },
        "task-selected restricted turn",
    )
    .await;
    let wire: Value = serde_json::from_str(
        fs::read_to_string(env.home().join("turn-start-params.log"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(wire["params"]["sandboxPolicy"]["type"], "readOnly");
    host.shutdown();
    worker_task.await.unwrap().unwrap();

    let env = TestEnvironment::new("complete");
    let (host, worker) = env.start(Some(env.config(env.home())));
    let task_id = env.create_task(&host, "invalid manual mode");
    let database = env.database();
    let mut config: Value = database
        .query_row(
            "SELECT config_json FROM agent_tasks WHERE id=?1",
            [&task_id],
            |row| row.get::<_, String>(0),
        )
        .map(|raw| serde_json::from_str(&raw).unwrap())
        .unwrap();
    config["accessMode"] = json!("manual");
    database
        .execute(
            "UPDATE agent_tasks SET config_json=?2 WHERE id=?1",
            rusqlite::params![task_id, config.to_string()],
        )
        .unwrap();
    assert_eq!(
        host.send(
            &task_id,
            &uuid::Uuid::new_v4().to_string(),
            "do not broaden"
        )
        .unwrap_err(),
        "mobile-execution-profile-invalid"
    );
    host.shutdown();
    drop(worker);
}

#[tokio::test]
async fn http_replays_accepted_send_after_restart_without_runtime_but_rejects_new_work() {
    use aplot_server::mobile_api::{mobile_router, MobileApiConfig};
    use axum::{
        body::{to_bytes, Body},
        http::{header, Request, StatusCode},
    };
    use tower::ServiceExt;

    let env = TestEnvironment::new("complete");
    let (host, worker) = env.start(Some(env.config(env.home())));
    let task_id = env.create_task(&host, "replay without runtime");
    let command_id = uuid::Uuid::new_v4().to_string();
    let accepted = send(&host, &task_id, &command_id, "accepted before restart");
    host.shutdown();
    drop(worker);
    drop(host);

    let (host, worker) = env.start(None);
    assert!(!host.send_enabled());
    let assets = env.root.join("assets");
    fs::create_dir(&assets).unwrap();
    fs::write(
        assets.join("index.html"),
        "<!doctype html><title>Test</title>",
    )
    .unwrap();
    let token = "mobile-replay-test-key-with-at-least-32-characters";
    let app = mobile_router(
        host.clone(),
        MobileApiConfig {
            public_origin: "http://127.0.0.1:8123".into(),
            access_token: token.into(),
            assets_dir: assets,
            allow_private_http: false,
        },
    )
    .unwrap();
    let request = |id: &str, text: &str| {
        Request::builder()
            .method("POST")
            .uri(format!("/api/v1/tasks/{task_id}/messages"))
            .header(header::HOST, "127.0.0.1:8123")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({"commandId":id,"text":text}).to_string()))
            .unwrap()
    };
    let replay = app
        .clone()
        .oneshot(request(&command_id, "accepted before restart"))
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::ACCEPTED);
    let replay: Value =
        serde_json::from_slice(&to_bytes(replay.into_body(), 1024).await.unwrap()).unwrap();
    assert_eq!(replay, accepted);
    let changed = app
        .clone()
        .oneshot(request(&command_id, "changed payload"))
        .await
        .unwrap();
    assert_eq!(changed.status(), StatusCode::CONFLICT);
    let fresh = app
        .oneshot(request(&uuid::Uuid::new_v4().to_string(), "new work"))
        .await
        .unwrap();
    assert_eq!(fresh.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        host.task(&task_id).unwrap()["commands"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(host.task(&task_id).unwrap()["task"]["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    host.shutdown();
    drop(worker);
}

#[tokio::test(flavor = "current_thread")]
async fn snapshots_stay_responsive_while_turn_runs_and_interrupt_uses_internal_turn_id() {
    let env = TestEnvironment::new("hang");
    let (host, worker) = env.start(Some(env.config(env.home())));
    let task_id = env.create_task(&host, "interruptible");
    let send_id = uuid::Uuid::new_v4().to_string();
    send(&host, &task_id, &send_id, "wait for interruption");

    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let worker_task = tokio::task::spawn_local(worker.run());
            let (generation, turn_id) = loop {
                let snapshot = host.task(&task_id).unwrap();
                let generation = snapshot["task"]["state"]["nativeGeneration"].as_u64();
                let running = snapshot["task"]["turns"]
                    .as_array()
                    .and_then(|turns| turns.iter().find(|turn| turn["status"] == "running"));
                if let (Some(generation), Some(turn)) = (generation, running) {
                    break (generation, turn["id"].as_str().unwrap().to_owned());
                }
                sleep(Duration::from_millis(20)).await;
            };

            // These calls use the API's separate SQLite connection while the
            // worker awaits the fake Codex process.
            assert_eq!(host.workspace().unwrap()["tasks"][0]["id"], task_id);
            assert_eq!(host.task(&task_id).unwrap()["task"]["id"], task_id);
            let stop_id = uuid::Uuid::new_v4().to_string();
            let stop = host
                .interrupt(&task_id, &stop_id, generation, &turn_id)
                .unwrap();
            assert_eq!(stop["status"], "cancel_requested");

            wait_for(
                || {
                    TestEnvironment::command_status(&host, &task_id, &send_id).as_deref()
                        == Some("interrupted")
                },
                "interrupted mobile command",
            )
            .await;
            // Matching retries keep the original acceptance shape even after
            // the command has reached its terminal state.
            assert_eq!(
                send(&host, &task_id, &send_id, "wait for interruption")["status"],
                "queued"
            );
            assert_eq!(
                host.task(&task_id).unwrap()["commands"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|command| command["commandId"] == stop_id)
                    .unwrap()["status"],
                "completed"
            );
            host.shutdown();
            worker_task.await.unwrap().unwrap();
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn restart_marks_uncertain_dispatch_unknown_and_preserves_queued_work() {
    let env = TestEnvironment::new("complete");
    let config = env.config(env.home());
    let (host, worker) = env.start(Some(config.clone()));
    let task_id = env.create_task(&host, "restart");
    let uncertain = uuid::Uuid::new_v4().to_string();
    let queued = uuid::Uuid::new_v4().to_string();
    send(&host, &task_id, &uncertain, "maybe dispatched");
    send(&host, &task_id, &queued, "still queued");
    env.database()
        .execute(
            "UPDATE mobile_commands SET status='dispatching' WHERE command_id=?1",
            [&uncertain],
        )
        .unwrap();
    host.shutdown();
    drop(worker);
    drop(host);

    let (reopened, worker) = env.start(Some(config));
    assert_eq!(
        TestEnvironment::command_status(&reopened, &task_id, &uncertain).as_deref(),
        Some("unknown")
    );
    assert_eq!(
        TestEnvironment::command_status(&reopened, &task_id, &queued).as_deref(),
        Some("queued")
    );
    let commands = reopened.task(&task_id).unwrap()["commands"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(
        commands
            .iter()
            .find(|command| command["commandId"] == uncertain)
            .unwrap()["error"],
        "host-restarted"
    );
    reopened.shutdown();
    drop(worker);
}

#[tokio::test(flavor = "current_thread")]
async fn changed_execution_profile_fails_queued_prompt_without_launching_codex() {
    let env = TestEnvironment::new("complete");
    let original = env.config(env.home());
    let (host, worker) = env.start(Some(original));
    let task_id = env.create_task(&host, "profile pin");
    let command_id = uuid::Uuid::new_v4().to_string();
    send(
        &host,
        &task_id,
        &command_id,
        "must not run under new profile",
    );
    host.shutdown();
    drop(worker);
    drop(host);

    let changed_home = env.root.join("changed-home");
    env.fixture.prepare_home(&changed_home, "complete").unwrap();
    let (host, worker) = env.start(Some(env.config(changed_home)));
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let worker_task = tokio::task::spawn_local(worker.run());
            wait_for(
                || {
                    TestEnvironment::command_status(&host, &task_id, &command_id).as_deref()
                        == Some("failed")
                },
                "profile mismatch failure",
            )
            .await;
            let commands = host.task(&task_id).unwrap()["commands"]
                .as_array()
                .unwrap()
                .clone();
            assert_eq!(
                commands
                    .iter()
                    .find(|command| command["commandId"] == command_id)
                    .unwrap()["error"],
                "mobile-execution-profile-changed"
            );
            host.shutdown();
            worker_task.await.unwrap().unwrap();
        })
        .await;
    assert!(!env.home().join("launches.log").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn queued_cancel_prevents_process_dispatch() {
    let env = TestEnvironment::new("complete");
    let (host, worker) = env.start(Some(env.config(env.home())));
    let task_id = env.create_task(&host, "cancel before start");
    let command_id = uuid::Uuid::new_v4().to_string();
    send(&host, &task_id, &command_id, "cancel this prompt");
    assert_eq!(
        host.cancel_command(&command_id).unwrap()["status"],
        "cancelled"
    );

    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let worker_task = tokio::task::spawn_local(worker.run());
            sleep(Duration::from_millis(150)).await;
            assert_eq!(
                TestEnvironment::command_status(&host, &task_id, &command_id).as_deref(),
                Some("cancelled")
            );
            host.shutdown();
            tokio::time::timeout(Duration::from_secs(3), worker_task)
                .await
                .expect("cancelled idle worker should stop promptly")
                .unwrap()
                .unwrap();
        })
        .await;
    assert!(!env.home().join("launches.log").exists());
}
