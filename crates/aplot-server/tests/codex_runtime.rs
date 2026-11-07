mod support;

use aplot_server::codex_runtime::{run, CodexRunConfig, CodexRuntimeEvent, TurnOutcome};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use support::codex_fixture::CodexFixture;
use tokio::sync::{watch, Notify};

fn setup(mode: &str, resume_thread_id: Option<&str>) -> (CodexFixture, CodexRunConfig) {
    let fixture = CodexFixture::build().expect("compile app-server fixture");
    let home = fixture.root.join("codex-home");
    fixture
        .prepare_home(&home, mode)
        .expect("prepare isolated home");
    let working_directory = fixture.root.join("workspace");
    fs::create_dir_all(&working_directory).expect("prepare workspace fixture");
    let config = CodexRunConfig {
        executable: fixture.executable.clone(),
        codex_home: home,
        working_directory,
        model: "fixture-model".into(),
        timeout: Duration::from_secs(5),
        access_mode: None,
        resume_thread_id: resume_thread_id.map(str::to_owned),
    };
    (fixture, config)
}

fn launch_count(home: &PathBuf) -> usize {
    fs::read_to_string(home.join("launches.log"))
        .map(|value| value.lines().count())
        .unwrap_or(0)
}

#[tokio::test]
async fn starts_one_thread_streams_bounded_frames_and_kills_child() {
    let (_fixture, config) = setup("complete", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = events.clone();

    let outcome = run(&config, "fixture prompt", cancel, move |event| {
        recorded.lock().unwrap().push(event);
        Ok(())
    })
    .await
    .expect("fixture turn completes");

    assert_eq!(outcome.status, "completed");
    #[cfg(windows)]
    assert_eq!(
        fs::read_to_string(config.codex_home.join("system-drive.log")).unwrap(),
        std::env::var("SystemDrive").expect("Windows provides the system drive required by MXC")
    );
    assert_eq!(outcome.thread_id, "fixture-thread");
    assert_eq!(outcome.turn_id, "fixture-turn");
    let events = events.lock().unwrap();
    let account_position = events
        .iter()
        .position(|event| matches!(event, CodexRuntimeEvent::AccountIdentified { .. }))
        .expect("account identity event is emitted");
    let thread_position = events
        .iter()
        .position(|event| matches!(event, CodexRuntimeEvent::ThreadStarted { .. }))
        .expect("thread start event is emitted");
    assert!(account_position < thread_position);
    assert!(events.contains(&CodexRuntimeEvent::ThreadStarted {
        id: "fixture-thread".into()
    }));
    assert!(events.contains(&CodexRuntimeEvent::TurnStarted {
        id: "fixture-turn".into()
    }));
    assert!(events.iter().any(|event| matches!(
        event,
        CodexRuntimeEvent::Frame(aplot_core::tasks::codex_protocol::Frame::Event {
            kind: "message.delta",
            payload,
        }) if payload["text"] == "fixture answer"
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        CodexRuntimeEvent::Frame(aplot_core::tasks::codex_protocol::Frame::Event {
            kind: "tool.complete",
            payload,
        }) if payload["tool_id"] == "fixture-tool"
    )));
    assert_eq!(launch_count(&config.codex_home), 1);
}

#[tokio::test]
async fn owner_selected_modes_send_matching_sandbox_and_instructions() {
    let (_fixture, restricted) = setup("complete", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    run(&restricted, "restricted fixture prompt", cancel, |_| Ok(()))
        .await
        .unwrap();
    let restricted_turn: serde_json::Value = serde_json::from_str(
        fs::read_to_string(restricted.codex_home.join("turn-start-params.log"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(restricted_turn["params"]["approvalPolicy"], "never");
    assert_eq!(
        restricted_turn["params"]["sandboxPolicy"]["type"],
        "readOnly"
    );
    assert_eq!(
        restricted_turn["params"]["sandboxPolicy"]["networkAccess"],
        false
    );
    let restricted_thread: serde_json::Value = serde_json::from_str(
        fs::read_to_string(restricted.codex_home.join("thread-start-params.log"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(restricted_thread["params"]["sandbox"], "read-only");
    assert!(restricted_thread["params"]["developerInstructions"]
        .as_str()
        .unwrap()
        .contains("Project files are read-only"));

    let (_fixture, mut full) = setup("complete", None);
    full.access_mode = Some("full".into());
    let (_cancel_tx, cancel) = watch::channel(false);
    run(&full, "full fixture prompt", cancel, |_| Ok(()))
        .await
        .unwrap();
    let full_turn: serde_json::Value = serde_json::from_str(
        fs::read_to_string(full.codex_home.join("turn-start-params.log"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(full_turn["params"]["approvalPolicy"], "never");
    assert_eq!(
        full_turn["params"]["sandboxPolicy"]["type"],
        "dangerFullAccess"
    );
    let full_thread: serde_json::Value = serde_json::from_str(
        fs::read_to_string(full.codex_home.join("thread-start-params.log"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(full_thread["params"]["sandbox"], "danger-full-access");
    let instructions = full_thread["params"]["developerInstructions"]
        .as_str()
        .unwrap();
    assert!(instructions.contains("owner explicitly selected full access"));
    assert!(!instructions.contains("read-only"));
    assert!(!instructions.contains("no network access"));
}

#[tokio::test]
async fn full_mode_refreshes_policy_on_the_existing_resumed_thread() {
    let (_fixture, mut config) = setup("resume", Some("fixture-thread"));
    config.access_mode = Some("full".into());
    let (_cancel_tx, cancel) = watch::channel(false);
    run(&config, "continue with selected access", cancel, |_| Ok(()))
        .await
        .unwrap();
    let injected: serde_json::Value = serde_json::from_str(
        fs::read_to_string(config.codex_home.join("injected-items.log"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(injected["params"]["threadId"], "fixture-thread");
    let instructions = injected["params"]["items"][0]["content"][0]["text"]
        .as_str()
        .unwrap();
    assert!(instructions.contains("owner explicitly selected full access"));
    assert!(!instructions.contains("read-only"));
    assert!(!instructions.contains("no network access"));
    let turn: serde_json::Value = serde_json::from_str(
        fs::read_to_string(config.codex_home.join("turn-start-params.log"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(turn["params"]["sandboxPolicy"]["type"], "dangerFullAccess");
    assert!(!config.codex_home.join("thread-starts.log").exists());
}

#[tokio::test]
async fn unsupported_manual_mode_fails_before_launch() {
    let (_fixture, mut config) = setup("complete", None);
    config.access_mode = Some("manual".into());
    let (_cancel_tx, cancel) = watch::channel(false);
    assert_eq!(
        run(&config, "manual fixture prompt", cancel, |_| Ok(()))
            .await
            .unwrap_err(),
        "codex-access-mode-invalid"
    );
    assert_eq!(launch_count(&config.codex_home), 0);
}

#[tokio::test]
async fn account_fingerprint_uses_documented_email_and_unknown_accounts_fail_closed() {
    let (_fixture, config) = setup("complete", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = events.clone();
    run(&config, "fixture prompt", cancel, move |event| {
        recorded.lock().unwrap().push(event);
        Ok(())
    })
    .await
    .expect("ChatGPT fixture account is identified");
    let fingerprint = events
        .lock()
        .unwrap()
        .iter()
        .find_map(|event| match event {
            CodexRuntimeEvent::AccountIdentified { fingerprint } => Some(fingerprint.clone()),
            _ => None,
        })
        .expect("fingerprint event");
    assert_eq!(fingerprint.len(), 64);
    assert!(!fingerprint.contains("fixture@example.com"));

    let (_fixture, config) = setup("account-changed", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let changed = Arc::new(Mutex::new(None));
    let recorded = changed.clone();
    run(&config, "fixture prompt", cancel, move |event| {
        if let CodexRuntimeEvent::AccountIdentified { fingerprint } = event {
            *recorded.lock().unwrap() = Some(fingerprint);
        }
        Ok(())
    })
    .await
    .expect("changed-email account is stable by itself");
    assert_ne!(fingerprint, changed.lock().unwrap().clone().unwrap());

    for mode in ["account-null", "account-api-key", "account-no-email"] {
        let (_fixture, config) = setup(mode, None);
        let (_cancel_tx, cancel) = watch::channel(false);
        let error = run(&config, "fixture prompt", cancel, |_| Ok(()))
            .await
            .expect_err("account without documented stable email is rejected");
        assert_eq!(error, "codex-account-identity-unavailable");
        assert!(!config.codex_home.join("thread-starts.log").exists());
        assert!(!config.codex_home.join("thread-resumes.log").exists());
    }
}

#[tokio::test]
async fn resume_uses_the_explicit_thread_and_never_starts_another() {
    let (_fixture, config) = setup("resume", Some("fixture-thread"));
    let (_cancel_tx, cancel) = watch::channel(false);
    let outcome: TurnOutcome = run(&config, "continue fixture", cancel, |_| Ok(()))
        .await
        .expect("bound thread resumes");

    assert_eq!(outcome.status, "completed");
    assert_eq!(outcome.thread_id, "fixture-thread");
    assert!(!config.codex_home.join("thread-starts.log").exists());
    let resume = fs::read_to_string(config.codex_home.join("thread-resumes.log")).unwrap();
    assert!(resume.contains("\"threadId\":\"fixture-thread\""));
    assert!(resume.contains("\"excludeTurns\":true"));
    assert!(resume.contains("\"web_search\":\"live\""));
    let injected: serde_json::Value = serde_json::from_str(
        fs::read_to_string(config.codex_home.join("injected-items.log"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(injected["params"]["threadId"], "fixture-thread");
    assert_eq!(injected["params"]["items"][0]["role"], "developer");
    let policy = injected["params"]["items"][0]["content"][0]["text"]
        .as_str()
        .unwrap();
    assert!(policy.contains("supersedes earlier host statements"));
    assert!(policy.contains("does not enable local command networking or project writes"));
}

#[tokio::test]
async fn resume_preserves_host_disabled_search_instead_of_enabling_it() {
    let (_fixture, config) = setup("hosted-search-disabled", Some("fixture-thread"));
    let (_cancel_tx, cancel) = watch::channel(false);
    run(&config, "continue fixture", cancel, |_| Ok(()))
        .await
        .unwrap();
    let resume = fs::read_to_string(config.codex_home.join("thread-resumes.log")).unwrap();
    assert!(resume.contains("\"web_search\":\"disabled\""));
    let injected = fs::read_to_string(config.codex_home.join("injected-items.log")).unwrap();
    assert!(injected.contains("hosted web search mode is disabled"));
}

#[tokio::test]
async fn rejected_policy_refresh_stops_before_starting_a_resumed_turn() {
    let (_fixture, config) = setup("inject-fail", Some("fixture-thread"));
    let (_cancel_tx, cancel) = watch::channel(false);
    let error = run(&config, "continue fixture", cancel, |_| Ok(()))
        .await
        .unwrap_err();
    assert!(error.contains("fixture policy refresh rejected"));
    assert!(!config.codex_home.join("turn-start-params.log").exists());
    assert!(!config.codex_home.join("thread-starts.log").exists());
}

#[tokio::test]
async fn failed_resume_does_not_fall_back_to_a_new_thread() {
    let (_fixture, config) = setup("resume-fail", Some("fixture-thread"));
    let (_cancel_tx, cancel) = watch::channel(false);
    let error = run(&config, "continue fixture", cancel, |_| Ok(()))
        .await
        .expect_err("missing bound thread fails closed");

    assert!(error.contains("fixture thread missing"));
    assert!(!config.codex_home.join("thread-starts.log").exists());
    assert_eq!(launch_count(&config.codex_home), 1);
}

#[tokio::test]
async fn resume_response_must_match_the_saved_thread_id() {
    let (_fixture, config) = setup("resume-wrong-id", Some("fixture-thread"));
    let (_cancel_tx, cancel) = watch::channel(false);
    let error = run(&config, "continue fixture", cancel, |_| Ok(()))
        .await
        .expect_err("server cannot silently switch threads");

    assert_eq!(error, "codex-thread-resume-mismatch");
    assert!(!config.codex_home.join("thread-starts.log").exists());
}

#[tokio::test]
async fn approval_is_denied_and_user_input_is_rejected() {
    let (_fixture, config) = setup("approval", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let outcome = run(&config, "fixture prompt", cancel, |_| Ok(()))
        .await
        .expect("denied approval is handled without pausing");
    assert_eq!(outcome.status, "completed");

    let (_fixture, config) = setup("user-input", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let outcome = run(&config, "fixture prompt", cancel, |_| Ok(()))
        .await
        .expect("unsupported input request is explicitly rejected");
    assert_eq!(outcome.status, "failed");
    assert_eq!(
        outcome.error_detail.as_deref(),
        Some("unsupported input request")
    );
}

#[tokio::test]
async fn cancellation_interrupts_the_bound_turn_and_reaps_it() {
    let (_fixture, config) = setup("hang", None);
    let (cancel_tx, cancel) = watch::channel(false);
    let turn_started = Arc::new(Notify::new());
    let notify = turn_started.clone();
    let run = tokio::spawn(async move {
        run(&config, "fixture prompt", cancel, move |event| {
            if matches!(event, CodexRuntimeEvent::TurnStarted { .. }) {
                notify.notify_one();
            }
            Ok(())
        })
        .await
    });

    tokio::time::timeout(Duration::from_secs(4), turn_started.notified())
        .await
        .expect("turn start reached");
    cancel_tx.send(true).expect("send cancel");
    let outcome = tokio::time::timeout(Duration::from_secs(4), run)
        .await
        .expect("runtime stopped")
        .expect("runtime task joined")
        .expect("interrupt completed");
    assert_eq!(outcome.status, "interrupted");
    assert_eq!(outcome.error_detail.as_deref(), Some("fixture interrupted"));
}

#[tokio::test]
async fn output_over_limit_and_journal_failure_abort_the_turn() {
    let (_fixture, config) = setup("large", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let error = run(&config, "fixture prompt", cancel, |_| Ok(()))
        .await
        .expect_err("oversized aggregate delta fails closed");
    assert_eq!(error, "codex-output-limit");

    let (_fixture, config) = setup("complete", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let error = run(&config, "fixture prompt", cancel, |_| {
        Err("disk-full".into())
    })
    .await
    .expect_err("failed journal callback aborts child");
    assert_eq!(error, "journal-write-failed: disk-full");
}

#[tokio::test]
async fn out_of_scope_notifications_are_ignored_and_terminal_ids_are_required() {
    let (_fixture, config) = setup("wrong-scope", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = events.clone();
    let outcome = run(&config, "fixture prompt", cancel, move |event| {
        recorded.lock().unwrap().push(event);
        Ok(())
    })
    .await
    .expect("valid terminal notification follows out-of-scope ones");
    assert_eq!(outcome.status, "completed");
    assert!(!events.lock().unwrap().iter().any(|event| matches!(
        event,
        CodexRuntimeEvent::Frame(aplot_core::tasks::codex_protocol::Frame::Event {
            kind: "message.delta",
            payload,
        }) if payload["text"] == "wrong"
    )));

    let (_fixture, config) = setup("missing-ids", None);
    let config = CodexRunConfig {
        timeout: Duration::from_millis(200),
        ..config
    };
    let (_cancel_tx, cancel) = watch::channel(false);
    match run(&config, "fixture prompt", cancel, |_| Ok(())).await {
        Err(error) => assert_eq!(error, "timeout"),
        Ok(outcome) => assert_eq!(outcome.status, "interrupted"),
    }
}

#[tokio::test]
async fn timeout_interrupts_an_active_turn() {
    let (_fixture, config) = setup("hang", None);
    let config = CodexRunConfig {
        timeout: Duration::from_millis(200),
        ..config
    };
    let (_cancel_tx, cancel) = watch::channel(false);
    match run(&config, "fixture prompt", cancel, |_| Ok(())).await {
        Err(error) => assert_eq!(error, "timeout"),
        Ok(outcome) => assert_eq!(outcome.status, "interrupted"),
    }
}

#[tokio::test]
async fn invalid_executable_is_rejected_before_creating_the_isolated_home() {
    let (_fixture, mut config) = setup("complete", None);
    let _ = fs::remove_dir_all(&config.codex_home);
    config.executable = config.codex_home.join("missing-codex.exe");
    let (_cancel_tx, cancel) = watch::channel(false);
    let error = run(&config, "fixture prompt", cancel, |_| Ok(()))
        .await
        .expect_err("missing executable fails validation");
    assert_eq!(error, "codex-executable-invalid");
    assert!(!config.codex_home.exists());
}

#[cfg(windows)]
#[tokio::test]
async fn windows_job_termination_kills_fixture_descendants() {
    let (_fixture, config) = setup("descendant", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let outcome = run(&config, "fixture prompt", cancel, |_| Ok(()))
        .await
        .expect("fixture turn completes");
    assert_eq!(outcome.status, "completed");
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(!config.codex_home.join("descendant-survived").exists());
}
