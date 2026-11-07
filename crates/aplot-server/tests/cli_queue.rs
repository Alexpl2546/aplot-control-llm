//! No desktop, subscription, or network: real aplotd processes and a local
//! app-server fixture exercise durable acceptance followed by queue execution.
#[path = "support/codex_fixture.rs"]
mod codex_fixture;

use codex_fixture::CodexFixture;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn cli(directory: &Path, args: &[&str]) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_aplotd"));
    command
        .arg("--data-dir")
        .arg(directory)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(45);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            panic!("queue CLI fixture exceeded deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    child.wait_with_output().unwrap()
}

fn success(directory: &Path, args: &[&str]) -> Value {
    let result = cli(directory, args);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    serde_json::from_slice(&result.stdout).unwrap()
}

#[test]
fn tools_accept_one_child_and_standalone_queue_executes_it_once_after_restart() {
    let fixture = CodexFixture::build().unwrap();
    let root = fixture.root.join("project");
    fs::create_dir(&root).unwrap();
    let directory = fixture.root.join("server");
    let home = fixture.root.join("isolated-home");
    fixture.prepare_home(&home, "delegate-tools").unwrap();
    let prompt = fixture.root.join("prompt.txt");
    fs::write(&prompt, "parent delegation request").unwrap();
    let project = success(
        &directory,
        &[
            "--register-project",
            root.to_str().unwrap(),
            "--name",
            "Project",
        ],
    );
    let task = success(
        &directory,
        &[
            "--new-task",
            project["project"]["id"].as_str().unwrap(),
            "--name",
            "Parent",
        ],
    );
    let parent_id = task["task"]["id"].as_str().unwrap();

    // Prepare trusted user-configured metadata in the isolated fixture DB,
    // while no aplotd owns it. This is not a model or production admin route.
    {
        let mut conn = rusqlite::Connection::open(directory.join("server-tasks.sqlite3")).unwrap();
        let envelope = aplot_core::workspace::read_saved(&conn).unwrap().unwrap();
        let mut data = envelope["data"].clone();
        data["projects"][0]["instructions"] = json!("Project developer instruction");
        data["presets"] = json!([{"id":"specialist","name":"Specialist","runtime":"codex","instructions":"Specialist developer instruction","accessMode":"restricted"}]);
        aplot_core::workspace::write_saved(&mut conn, data, envelope["revision"].as_u64().unwrap())
            .unwrap();
    }
    let result = success(
        &directory,
        &[
            "--run-codex",
            parent_id,
            "--codex-executable",
            fixture.executable.to_str().unwrap(),
            "--codex-home",
            home.to_str().unwrap(),
            "--model",
            "fixture-model",
            "--prompt-file",
            prompt.to_str().unwrap(),
            "--command-id",
            "parent-turn",
            "--timeout-seconds",
            "10",
        ],
    );
    assert_eq!(result["status"], "completed");
    let before = success(&directory, &["--snapshot"]);
    assert_eq!(
        before["workspace"]["data"]["tasks"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let child = before["workspace"]["data"]["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["parentTaskId"] == parent_id)
        .unwrap();
    let child_id = child["id"].as_str().unwrap();
    let child_view = before["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == child_id)
        .unwrap();
    assert_eq!(child_view["turns"][0]["status"], "queued");
    let accepted_turn_id = child_view["turns"][0]["id"].clone();
    let parent_native = before["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == parent_id)
        .unwrap()["state"]["nativeSessionId"]
        .clone();
    let args = [
        "--drain-codex-queue",
        "--codex-executable",
        fixture.executable.to_str().unwrap(),
        "--codex-home",
        home.to_str().unwrap(),
        "--max-turns",
        "1",
        "--timeout-seconds",
        "10",
    ];
    let report = success(&directory, &args);
    assert_eq!(report["processed"], 1);
    assert_eq!(report["completed"], 1);
    assert_eq!(report["remainingCodex"], 0);
    let after = success(&directory, &["--snapshot"]);
    let child_view = after["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == child_id)
        .unwrap();
    // Snapshot turns contain only queued/running work. Inspect terminal rows
    // in the fixture DB to verify reuse of the original accepted turn.
    assert!(child_view["turns"].as_array().unwrap().is_empty());
    assert_eq!(report["turns"][0]["turnId"], accepted_turn_id);
    {
        let conn = rusqlite::Connection::open_with_flags(
            directory.join("server-tasks.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_turns WHERE task_id=?1",
                [child_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let terminal = aplot_core::tasks::store::turns(&conn, child_id, "completed").unwrap();
        assert_eq!(terminal.len(), 1);
        assert_eq!(terminal[0].id, accepted_turn_id.as_str().unwrap());
    }
    assert_ne!(child_view["state"]["nativeSessionId"], parent_native);
    assert_eq!(
        child_view["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["kind"] == "user")
            .count(),
        1
    );
    assert!(child_view["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["kind"] == "assistant" && m["text"] == "standalone tool answer"));
    assert_eq!(success(&directory, &args)["processed"], 0);
    assert_eq!(
        fs::read_to_string(home.join("launches.log"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    let params = fs::read_to_string(home.join("tool-thread-params.log")).unwrap();
    assert!(params.contains("Specialist developer instruction"));
    assert!(params.contains("Project developer instruction"));
    assert_eq!(
        fs::read_to_string(home.join("delegation-replies.log"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    fs::write(home.join("result-task-id"), child_id).unwrap();
    fs::write(&prompt, "collect result").unwrap();
    let collected = success(
        &directory,
        &[
            "--run-codex",
            parent_id,
            "--codex-executable",
            fixture.executable.to_str().unwrap(),
            "--codex-home",
            home.to_str().unwrap(),
            "--model",
            "fixture-model",
            "--prompt-file",
            prompt.to_str().unwrap(),
            "--command-id",
            "collect-result",
            "--timeout-seconds",
            "10",
        ],
    );
    assert_eq!(collected["status"], "completed");
    let final_snapshot = success(&directory, &["--snapshot"]);
    let parent_view = final_snapshot["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == parent_id)
        .unwrap();
    assert_eq!(parent_view["state"]["nativeSessionId"], parent_native);
    assert!(parent_view["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["kind"] == "assistant" && m["text"] == "collected child result"));
    assert_eq!(
        fs::read_to_string(home.join("launches.log"))
            .unwrap()
            .lines()
            .count(),
        3
    );
}
