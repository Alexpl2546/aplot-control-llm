//! Exercise the installed CLI flow with a local fake Codex app-server process.
//! No real model runtime, credentials, or network access are involved.
use std::{
    fs, io,
    path::PathBuf,
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

#[path = "support/codex_fixture.rs"]
mod codex_fixture;

use codex_fixture::CodexFixture;
use serde_json::Value;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("aplot-cli-turn-{}", uuid::Uuid::new_v4())))
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct FixtureDirectory(PathBuf);

impl Drop for FixtureDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_aplotd"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

fn run_bounded(command: &mut Command) -> io::Result<Output> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output()?;
            panic!(
                "CLI process exceeded 45 seconds; stderr: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn cli(data_dir: &std::path::Path) -> Command {
    let mut command = command();
    command.arg("--data-dir").arg(data_dir);
    command
}

fn success_json(output: Output, operation: &str) -> Value {
    assert!(
        output.status.success(),
        "{operation} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "{operation} returned invalid JSON ({error}): {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })
}

fn run_codex(
    data_dir: &std::path::Path,
    task_id: &str,
    fixture: &CodexFixture,
    prompt_file: &std::path::Path,
    command_id: &str,
    timeout_seconds: u64,
) -> io::Result<Output> {
    let mut command = cli(data_dir);
    command
        .arg("--run-codex")
        .arg(task_id)
        .arg("--codex-executable")
        .arg(&fixture.executable)
        .arg("--codex-home")
        .arg(&fixture.root)
        .arg("--model")
        .arg("fixture-model")
        .arg("--prompt-file")
        .arg(prompt_file)
        .arg("--command-id")
        .arg(command_id)
        .arg("--timeout-seconds")
        .arg(timeout_seconds.to_string());
    run_bounded(&mut command)
}

fn turn_count(data_dir: &std::path::Path, task_id: &str) -> i64 {
    let conn = rusqlite::Connection::open(data_dir.join("server-tasks.sqlite3")).unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM agent_turns WHERE task_id=?1",
        [task_id],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn cli_creates_a_project_and_task_then_replays_one_fake_codex_turn() {
    let directory = TestDirectory::new();
    let server_data = directory.0.join("server");
    let project_root = directory.0.join("project");
    fs::create_dir_all(&project_root).unwrap();

    let fixture = CodexFixture::build().expect("build stdlib fake Codex runtime");
    let _fixture_directory = FixtureDirectory(fixture.root.clone());
    fixture.prepare_home(&fixture.root, "complete").unwrap();

    let project = success_json(
        run_bounded(
            cli(&server_data)
                .arg("--register-project")
                .arg(&project_root)
                .arg("--name")
                .arg("Acceptance project"),
        )
        .unwrap(),
        "register project",
    );
    let project_id = project["project"]["id"].as_str().unwrap();
    let task = success_json(
        run_bounded(
            cli(&server_data)
                .arg("--new-task")
                .arg(project_id)
                .arg("--name")
                .arg("CLI acceptance"),
        )
        .unwrap(),
        "create task",
    );
    let task_id = task["task"]["id"].as_str().unwrap().to_owned();
    let prompt_file = directory.0.join("prompt.txt");
    fs::write(&prompt_file, "Say hello from the fixture.").unwrap();

    let first = success_json(
        run_codex(
            &server_data,
            &task_id,
            &fixture,
            &prompt_file,
            "cli-command-1",
            30,
        )
        .unwrap(),
        "run Codex fixture",
    );
    assert_eq!(first["status"], "completed");
    assert_eq!(turn_count(&server_data, &task_id), 1);

    let replay = success_json(
        run_codex(
            &server_data,
            &task_id,
            &fixture,
            &prompt_file,
            "cli-command-1",
            30,
        )
        .unwrap(),
        "replay command receipt",
    );
    assert_eq!(replay, first);
    assert_eq!(
        turn_count(&server_data, &task_id),
        1,
        "replay created another turn"
    );
    let launches = fs::read_to_string(fixture.root.join("launches.log")).unwrap();
    assert_eq!(
        launches.lines().count(),
        1,
        "replay launched the fake runtime again"
    );

    fs::write(&prompt_file, "A different request under the same id.").unwrap();
    let changed_prompt = run_codex(
        &server_data,
        &task_id,
        &fixture,
        &prompt_file,
        "cli-command-1",
        30,
    )
    .unwrap();
    assert!(!changed_prompt.status.success());
    assert!(String::from_utf8_lossy(&changed_prompt.stderr).contains("command-conflict"));

    fs::write(&prompt_file, "Say hello from the fixture.").unwrap();
    let changed_timeout = run_codex(
        &server_data,
        &task_id,
        &fixture,
        &prompt_file,
        "cli-command-1",
        31,
    )
    .unwrap();
    assert!(!changed_timeout.status.success());
    assert!(String::from_utf8_lossy(&changed_timeout.stderr).contains("command-conflict"));
    assert_eq!(turn_count(&server_data, &task_id), 1);
    assert_eq!(
        fs::read_to_string(fixture.root.join("launches.log"))
            .unwrap()
            .lines()
            .count(),
        1
    );

    let workspace = success_json(
        run_bounded(cli(&server_data).arg("--workspace")).unwrap(),
        "read persisted workspace",
    );
    assert_eq!(workspace["data"]["projects"][0]["id"], project_id);
    assert_eq!(workspace["data"]["tasks"][0]["id"], task_id);

    let snapshot = success_json(
        run_bounded(cli(&server_data).arg("--snapshot")).unwrap(),
        "read journal snapshot",
    );
    assert_eq!(snapshot["tasks"][0]["id"], task_id);
    assert_eq!(snapshot["workspace"], workspace);
    assert_eq!(snapshot["tasks"][0]["state"]["pending"], false);
    let messages = snapshot["tasks"][0]["messages"].as_array().unwrap();
    assert_eq!(
        messages
            .iter()
            .filter(|message| message["kind"] == "user")
            .count(),
        1
    );
    assert_eq!(
        messages
            .iter()
            .filter(|message| message["kind"] == "assistant")
            .count(),
        1
    );

    // A different command resumes the bound native conversation after the
    // server process restarts; it must retain both turns' tool messages.
    let continued = success_json(
        run_codex(
            &server_data,
            &task_id,
            &fixture,
            &prompt_file,
            "cli-command-2",
            30,
        )
        .unwrap(),
        "continue saved session",
    );
    assert_eq!(continued["status"], "completed");
    assert_eq!(
        fs::read_to_string(fixture.root.join("thread-starts.log"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("thread-resumes.log"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    let conn = rusqlite::Connection::open(server_data.join("server-tasks.sqlite3")).unwrap();
    let tool_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_messages WHERE task_id=?1 AND kind='tool'",
            [&task_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tool_count, 2);
    drop(conn);

    let other_home = directory.0.join("other-home");
    fs::create_dir_all(&other_home).unwrap();
    let mut changed_profile = cli(&server_data);
    changed_profile
        .args([
            "--run-codex",
            &task_id,
            "--model",
            "fixture-model",
            "--command-id",
            "different-profile",
            "--timeout-seconds",
            "30",
        ])
        .arg("--codex-executable")
        .arg(&fixture.executable)
        .arg("--codex-home")
        .arg(&other_home)
        .arg("--prompt-file")
        .arg(&prompt_file);
    let denied = run_bounded(&mut changed_profile).unwrap();
    assert!(!denied.status.success());
    assert!(String::from_utf8_lossy(&denied.stderr).contains("runtime-binding-changed"));
    assert_eq!(turn_count(&server_data, &task_id), 2);

    success_json(
        run_bounded(cli(&server_data).arg("--reset-session").arg(&task_id)).unwrap(),
        "explicit session reset",
    );
    success_json(
        run_codex(
            &server_data,
            &task_id,
            &fixture,
            &prompt_file,
            "cli-command-3",
            30,
        )
        .unwrap(),
        "start after explicit reset",
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("thread-starts.log"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    assert_eq!(turn_count(&server_data, &task_id), 3);

    // A different login in the same home must be rejected before sending the
    // saved native thread ID back to app-server.
    let resumes_before = fs::read_to_string(fixture.root.join("thread-resumes.log"))
        .unwrap()
        .lines()
        .count();
    fixture
        .prepare_home(&fixture.root, "account-changed")
        .unwrap();
    let changed_account = run_codex(
        &server_data,
        &task_id,
        &fixture,
        &prompt_file,
        "changed-account",
        30,
    )
    .unwrap();
    assert!(!changed_account.status.success());
    let failed: Value = serde_json::from_slice(&changed_account.stdout).unwrap();
    assert!(failed["error"]
        .as_str()
        .unwrap()
        .contains("runtime-account-changed"));
    assert_eq!(
        fs::read_to_string(fixture.root.join("thread-resumes.log"))
            .unwrap()
            .lines()
            .count(),
        resumes_before
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("thread-starts.log"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    fixture.prepare_home(&fixture.root, "complete").unwrap();
    success_json(
        run_codex(
            &server_data,
            &task_id,
            &fixture,
            &prompt_file,
            "original-account",
            30,
        )
        .unwrap(),
        "resume original account after rejected login change",
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("thread-resumes.log"))
            .unwrap()
            .lines()
            .count(),
        resumes_before + 1
    );
}
