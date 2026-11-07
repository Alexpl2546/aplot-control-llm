use aplot_server::codex_runtime::{run_with_tools, CodexRunConfig, CodexRuntimeEvent, TurnOutcome};
use serde_json::{json, Value};
use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;

struct Fixture {
    executable: PathBuf,
    root: PathBuf,
}

impl Fixture {
    fn build() -> io::Result<Self> {
        let root = env::temp_dir().join(format!(
            "aplot-codex-dynamic-fixture-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root)?;
        let mut executable = root.join("codex-dynamic-fixture");
        if cfg!(windows) {
            executable.set_extension("exe");
        }
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("codex_dynamic_tools.rs");
        let rustc = env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
        let output = Command::new(rustc)
            .arg("--edition=2021")
            .arg(source)
            .arg("-o")
            .arg(&executable)
            .output()?;
        if !output.status.success() {
            let _ = fs::remove_dir_all(&root);
            return Err(io::Error::other(format!(
                "dynamic fixture rustc failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        Ok(Self { executable, root })
    }

    fn prepare_home(&self, mode: &str) -> io::Result<PathBuf> {
        let home = self.root.join("codex-home");
        fs::create_dir_all(&home)?;
        fs::write(home.join("fixture-mode"), mode)?;
        Ok(home)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn setup(mode: &str, resume_thread_id: Option<&str>) -> (Fixture, CodexRunConfig) {
    let fixture = Fixture::build().expect("compile dynamic tool fixture");
    let home = fixture.prepare_home(mode).expect("prepare isolated home");
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

fn descriptors() -> Vec<Value> {
    vec![json!({
        "type":"function",
        "name":"aplot_list_projects",
        "description":"List visible projects.",
        "inputSchema":{
            "type":"object",
            "properties":{"projectId":{"type":"string"}},
            "additionalProperties":false
        }
    })]
}

fn tool_response(text: &str) -> Value {
    json!({"contentItems":[{"type":"inputText","text":text}],"success":true})
}

fn read_json_lines(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .expect("fixture response log")
        .lines()
        .map(|line| serde_json::from_str(line).expect("valid JSON-RPC response"))
        .collect()
}

#[tokio::test]
async fn start_advertises_tools_context_and_replays_duplicate_call_ids() {
    let (_fixture, config) = setup("calls", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let calls = Arc::new(Mutex::new(Vec::new()));
    let recorded = calls.clone();
    let outcome: TurnOutcome = run_with_tools(
        &config,
        "Keep the stored prompt unchanged",
        cancel,
        &descriptors(),
        "Use the caller's selected project.",
        move |event| match event {
            CodexRuntimeEvent::ToolCall {
                call_id,
                tool,
                arguments,
            } => {
                recorded.lock().unwrap().push((call_id, tool, arguments));
                Ok(Some(tool_response("{\"projects\":[]}")))
            }
            _ => Ok(None),
        },
    )
    .await
    .expect("fixture turn completes");

    assert_eq!(outcome.status, "completed");
    assert_eq!(outcome.thread_id, "fixture-thread");
    assert_eq!(
        calls.lock().unwrap().as_slice(),
        &[(
            "call-1".to_owned(),
            "aplot_list_projects".to_owned(),
            json!({"projectId":"p1"}),
        )]
    );
    let initialize = fs::read_to_string(config.codex_home.join("initialize.log")).unwrap();
    assert!(initialize.contains("\"experimentalApi\":true"));
    let thread_start: Value = serde_json::from_str(
        fs::read_to_string(config.codex_home.join("thread-start.log"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        thread_start["params"]["dynamicTools"][0]["type"],
        "function"
    );
    assert!(thread_start["params"]["developerInstructions"].as_str().unwrap().starts_with(
        "Project files are read-only. Local shell commands have no network access; do not request permission to modify files or enable command networking. Hosted web search is separate: use it for current information when it is available in this server's configuration. When available, host-provided Aplot tools may queue work or record proposals within their own policy.\n\nUse the caller's selected project."
    ));
    assert_eq!(thread_start["params"]["config"]["web_search"], "live");
    let turn_start: Value = serde_json::from_str(
        fs::read_to_string(config.codex_home.join("turn-start.log"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        turn_start["params"]["input"][0]["text"],
        "Keep the stored prompt unchanged"
    );
    let responses = read_json_lines(&config.codex_home.join("client-responses.log"));
    assert_eq!(responses[0]["result"], responses[1]["result"]);
    assert_eq!(responses[0]["result"]["success"], true);
    assert!(
        responses[2]["error"].is_object(),
        "changed call id is rejected"
    );
    assert!(
        responses[3]["error"].is_object(),
        "out-of-scope call is rejected"
    );
    assert!(
        responses[4]["error"].is_object(),
        "unknown tool is rejected"
    );
}

#[tokio::test]
async fn tool_call_before_turn_started_fails_closed_then_validated_turn_is_delivered() {
    let (_fixture, config) = setup("unbound", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let calls = Arc::new(Mutex::new(0));
    let recorded = calls.clone();
    let outcome = run_with_tools(
        &config,
        "fixture prompt",
        cancel,
        &descriptors(),
        "",
        move |event| match event {
            CodexRuntimeEvent::ToolCall { .. } => {
                *recorded.lock().unwrap() += 1;
                Ok(Some(tool_response("ok")))
            }
            _ => Ok(None),
        },
    )
    .await
    .expect("validated tool call completes");

    assert_eq!(outcome.status, "completed");
    assert_eq!(*calls.lock().unwrap(), 1);
    let responses = read_json_lines(&config.codex_home.join("client-responses.log"));
    assert!(responses[0]["error"].is_object());
    assert_eq!(responses[1]["result"]["success"], true);
}

#[tokio::test]
async fn resume_uses_persisted_tools_without_resending_descriptors() {
    let (_fixture, config) = setup("unbound", Some("fixture-thread"));
    let (_cancel_tx, cancel) = watch::channel(false);
    let calls = Arc::new(Mutex::new(0));
    let recorded = calls.clone();
    let outcome = run_with_tools(
        &config,
        "continue fixture",
        cancel,
        &descriptors(),
        "Continue with selected project context.",
        move |event| match event {
            CodexRuntimeEvent::ToolCall { .. } => {
                *recorded.lock().unwrap() += 1;
                Ok(Some(tool_response("ok")))
            }
            _ => Ok(None),
        },
    )
    .await
    .expect("resumed thread restores dynamic tools");

    assert_eq!(outcome.status, "completed");
    assert_eq!(*calls.lock().unwrap(), 1);
    let initialize = fs::read_to_string(config.codex_home.join("initialize.log")).unwrap();
    assert!(initialize.contains("\"experimentalApi\":true"));
    let resume = fs::read_to_string(config.codex_home.join("thread-resume.log")).unwrap();
    assert!(!resume.contains("dynamicTools"));
    assert!(resume.contains("Continue with selected project context."));
    let injected: Value = serde_json::from_str(
        fs::read_to_string(config.codex_home.join("injected-items.log"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(injected["params"]["items"][0]["role"], "developer");
    assert!(injected["params"]["items"][0]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Current server capability policy: hosted web search mode is live"));
}

#[tokio::test]
async fn dynamic_tools_keep_approvals_denied_and_bound_arguments_and_call_count() {
    let (_fixture, config) = setup("approval", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let outcome = run_with_tools(
        &config,
        "fixture prompt",
        cancel,
        &descriptors(),
        "",
        |_| Ok(None),
    )
    .await
    .expect("ordinary approvals stay denied");
    assert_eq!(outcome.status, "completed");
    assert!(
        read_json_lines(&config.codex_home.join("client-responses.log"))[0]["result"]["decision"]
            == "decline"
    );

    let (_fixture, config) = setup("oversized-arguments", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let calls = Arc::new(Mutex::new(0));
    let recorded = calls.clone();
    let outcome = run_with_tools(
        &config,
        "fixture prompt",
        cancel,
        &descriptors(),
        "",
        move |event| match event {
            CodexRuntimeEvent::ToolCall { .. } => {
                *recorded.lock().unwrap() += 1;
                Ok(Some(tool_response("ok")))
            }
            _ => Ok(None),
        },
    )
    .await
    .expect("oversized call is rejected without aborting turn");
    assert_eq!(outcome.status, "completed");
    assert_eq!(*calls.lock().unwrap(), 0);
    assert!(
        read_json_lines(&config.codex_home.join("client-responses.log"))[0]["error"].is_object()
    );

    let (_fixture, config) = setup("call-limit", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let calls = Arc::new(Mutex::new(0));
    let recorded = calls.clone();
    let outcome = run_with_tools(
        &config,
        "fixture prompt",
        cancel,
        &descriptors(),
        "",
        move |event| match event {
            CodexRuntimeEvent::ToolCall { .. } => {
                *recorded.lock().unwrap() += 1;
                Ok(Some(tool_response("ok")))
            }
            _ => Ok(None),
        },
    )
    .await
    .expect("call limit rejects the next request");
    assert_eq!(outcome.status, "completed");
    assert_eq!(*calls.lock().unwrap(), 32);
    let responses = read_json_lines(&config.codex_home.join("client-responses.log"));
    assert!(responses[32]["error"].is_object());
}

#[tokio::test]
async fn invalid_tool_output_and_excess_context_fail_before_tool_reply() {
    let (_fixture, config) = setup("tool-result-large", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let calls = Arc::new(Mutex::new(0));
    let recorded = calls.clone();
    let error = run_with_tools(
        &config,
        "fixture prompt",
        cancel,
        &descriptors(),
        "",
        move |event| match event {
            CodexRuntimeEvent::ToolCall { .. } => {
                *recorded.lock().unwrap() += 1;
                Ok(Some(tool_response(&"x".repeat(70_000))))
            }
            _ => Ok(None),
        },
    )
    .await
    .expect_err("oversized tool result fails closed");
    assert_eq!(error, "codex-dynamic-tool-result-too-large");
    assert_eq!(*calls.lock().unwrap(), 1);

    let (_fixture, config) = setup("tool-result-large", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let calls = Arc::new(Mutex::new(0));
    let recorded = calls.clone();
    let error = run_with_tools(
        &config,
        "fixture prompt",
        cancel,
        &descriptors(),
        "",
        move |event| match event {
            CodexRuntimeEvent::ToolCall { .. } => {
                *recorded.lock().unwrap() += 1;
                Ok(Some(
                    json!({"contentItems":[{"type":"text","text":"invalid"}],"success":true}),
                ))
            }
            _ => Ok(None),
        },
    )
    .await
    .expect_err("invalid content item fails closed");
    assert_eq!(error, "codex-dynamic-tool-result-invalid");
    assert_eq!(*calls.lock().unwrap(), 1);

    let (_fixture, config) = setup("tool-result-large", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let calls = Arc::new(Mutex::new(0));
    let recorded = calls.clone();
    let error = run_with_tools(
        &config,
        "fixture prompt",
        cancel,
        &descriptors(),
        "",
        move |event| match event {
            CodexRuntimeEvent::ToolCall { .. } => {
                *recorded.lock().unwrap() += 1;
                Err("broker-failed".into())
            }
            _ => Ok(None),
        },
    )
    .await
    .expect_err("handler failure stops runtime");
    assert_eq!(error, "dynamic-tool-handler-failed: broker-failed");
    assert_eq!(*calls.lock().unwrap(), 1);

    let (_fixture, config) = setup("calls", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let error = run_with_tools(
        &config,
        "fixture prompt",
        cancel,
        &descriptors(),
        &"x".repeat(32 * 1024 + 1),
        |_| Ok(None),
    )
    .await
    .expect_err("oversized developer context rejected");
    assert_eq!(error, "codex-developer-context-too-large");
    assert!(!config.codex_home.join("launches.log").exists());

    let (_fixture, config) = setup("calls", None);
    let (_cancel_tx, cancel) = watch::channel(false);
    let mut invalid = descriptors();
    invalid[0]["inputSchema"] = json!("not-an-object");
    let error = run_with_tools(&config, "fixture prompt", cancel, &invalid, "", |_| {
        Ok(None)
    })
    .await
    .expect_err("invalid dynamic tool descriptor rejected");
    assert_eq!(error, "codex-dynamic-tools-invalid");
    assert!(!config.codex_home.join("launches.log").exists());
}
