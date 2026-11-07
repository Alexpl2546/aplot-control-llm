//! A bounded, single-turn Codex app-server driver for the standalone server.
//!
//! The caller owns task persistence. This module owns only the child process
//! and JSON-RPC session, and synchronously hands journal events to a callback.
//! It never discovers or reads the user's Codex home. Callers must pass an
//! isolated home explicitly.

use aplot_core::{
    owned_job::OwnedJob,
    tasks::codex_protocol::{self, Frame},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    env, fs, io,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::watch,
    time::{sleep_until, Instant},
};

const MAX_PROMPT_BYTES: usize = 64 * 1024;
const MAX_LINE_BYTES: usize = 1024 * 1024;
const MAX_PROTOCOL_BYTES: usize = 16 * 1024 * 1024;
const MAX_DELTA_CHARS: usize = 64_000;
const MAX_FRAME_CHARS: usize = 16_000;
const MAX_JOURNAL_FRAME_BYTES: usize = 512 * 1024;
const MAX_DEVELOPER_CONTEXT_BYTES: usize = 32 * 1024;
const MAX_DYNAMIC_TOOL_COUNT: usize = 64;
const MAX_DYNAMIC_TOOL_BYTES: usize = 256 * 1024;
const MAX_DYNAMIC_TOOL_ARGUMENT_BYTES: usize = 64 * 1024;
const MAX_DYNAMIC_TOOL_RESULT_BYTES: usize = 64 * 1024;
const MAX_DYNAMIC_TOOL_CALLS: usize = 32;
const MAX_DYNAMIC_TOOL_CALL_ID_BYTES: usize = 256;
const MAX_DYNAMIC_TOOL_CONTENT_ITEMS: usize = 64;
const MAX_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const INTERRUPT_GRACE: Duration = Duration::from_secs(1);
const RESTRICTED_INSTRUCTIONS: &str = "Project files are read-only. Local shell commands have no network access; do not request permission to modify files or enable command networking. Hosted web search is separate: use it for current information when it is available in this server's configuration. When available, host-provided Aplot tools may queue work or record proposals within their own policy.";
const FULL_INSTRUCTIONS: &str = "The task owner explicitly selected full access for this task. You may modify project files and use local shell commands with network access, within the permissions available to the Aplot server process. This owner-approved grant supersedes earlier Aplot task-mode restrictions on project writes and local shell networking. Commands run as the configured server OS user; this does not create a Windows administrator account or provide mouse-control APIs. Hosted web search is separate and is available only when enabled by this server's configuration. When available, host-provided Aplot tools may queue work or record proposals within their own policy.";

/// Explicit process configuration. `codex_home` must be isolated from the
/// user's normal `~/.codex`; no authentication setup is performed here.
#[derive(Clone, Debug)]
pub struct CodexRunConfig {
    pub executable: PathBuf,
    pub codex_home: PathBuf,
    pub working_directory: PathBuf,
    pub model: String,
    pub timeout: Duration,
    /// Owner-selected task access. `None` is deliberately restricted.
    pub access_mode: Option<String>,
    /// Existing native thread explicitly bound by the task owner; `None`
    /// starts a fresh thread and a failed resume never falls back to start.
    pub resume_thread_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CodexRuntimeEvent {
    AccountIdentified {
        fingerprint: String,
    },
    ThreadStarted {
        id: String,
    },
    TurnStarted {
        id: String,
    },
    ToolCall {
        call_id: String,
        tool: String,
        arguments: Value,
    },
    Frame(Frame),
}

#[derive(Clone, Debug, PartialEq)]
pub struct TurnOutcome {
    pub thread_id: String,
    pub turn_id: String,
    /// One of `completed`, `failed`, or `interrupted`.
    pub status: String,
    pub error_detail: Option<String>,
}

/// Run exactly one read-only app-server turn without dynamic tools. The
/// callback is synchronous so journal write failures stop the process before
/// more output is accepted.
pub async fn run<F>(
    config: &CodexRunConfig,
    prompt: &str,
    cancel: watch::Receiver<bool>,
    mut on_event: F,
) -> Result<TurnOutcome, String>
where
    F: FnMut(CodexRuntimeEvent) -> Result<(), String>,
{
    run_with_tools(config, prompt, cancel, &[], "", move |event| {
        on_event(event)?;
        Ok(None)
    })
    .await
}

/// Run one Codex turn with optional experimental dynamic tools supplied by the
/// host. Tool descriptors are sent only when a thread is created; a resumed
/// Codex thread restores descriptors persisted by app-server.
pub async fn run_with_tools<F>(
    config: &CodexRunConfig,
    prompt: &str,
    cancel: watch::Receiver<bool>,
    descriptors: &[Value],
    developer_context: &str,
    on_event: F,
) -> Result<TurnOutcome, String>
where
    F: FnMut(CodexRuntimeEvent) -> Result<Option<Value>, String>,
{
    if *cancel.borrow() {
        return Err("cancelled".into());
    }
    let tool_names = validate_dynamic_tools(descriptors)?;
    if developer_context.len() > MAX_DEVELOPER_CONTEXT_BYTES {
        return Err("codex-developer-context-too-large".into());
    }
    let mut prepared = config.clone();
    prepare_config(&mut prepared, prompt)?;
    let access_mode = effective_access_mode(&prepared.access_mode)?;
    let policy_instructions = match access_mode {
        "restricted" => RESTRICTED_INSTRUCTIONS,
        "full" => FULL_INSTRUCTIONS,
        _ => unreachable!("validated access mode"),
    };
    let developer_instructions = if developer_context.is_empty() {
        policy_instructions.to_owned()
    } else {
        format!("{policy_instructions}\n\n{developer_context}")
    };
    let home = prepared.codex_home.clone();
    let cwd = prepared.working_directory.clone();
    let deadline = Instant::now() + prepared.timeout;

    let mut command = command(&prepared, &home, &cwd);
    let mut child = command
        .spawn()
        .map_err(|_| "codex-process-start-failed".to_owned())?;
    let job = match OwnedJob::assign(&child) {
        Ok(job) => job,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("codex-process-job-assignment-failed".into());
        }
    };

    let result = async {
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "codex-stdin-unavailable".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "codex-stdout-unavailable".to_owned())?;
        let mut driver = Driver::new(stdin, stdout, deadline, cancel, tool_names, on_event);
        drive_turn(
            &mut driver,
            &prepared,
            prompt,
            &cwd,
            descriptors,
            &developer_instructions,
        )
        .await
    }
    .await;

    job.terminate();
    let cleanup = kill_and_reap(&mut child).await;
    match (result, cleanup) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(outcome), Ok(())) => Ok(outcome),
    }
}

fn validate_dynamic_tools(descriptors: &[Value]) -> Result<HashSet<String>, String> {
    if descriptors.len() > MAX_DYNAMIC_TOOL_COUNT {
        return Err("codex-dynamic-tool-count-invalid".into());
    }
    let encoded =
        serde_json::to_vec(descriptors).map_err(|_| "codex-dynamic-tools-invalid".to_owned())?;
    if encoded.len() > MAX_DYNAMIC_TOOL_BYTES {
        return Err("codex-dynamic-tools-too-large".into());
    }
    let mut names = HashSet::new();
    for descriptor in descriptors {
        let Some(object) = descriptor.as_object() else {
            return Err("codex-dynamic-tools-invalid".into());
        };
        let name = descriptor["name"].as_str().unwrap_or("");
        let description = descriptor["description"].as_str().unwrap_or("");
        if descriptor["type"] != "function"
            || !valid_dynamic_tool_name(name)
            || description.trim().is_empty()
            || description.len() > 4096
            || !descriptor["inputSchema"].is_object()
            || !object.contains_key("inputSchema")
            || !names.insert(name.to_owned())
        {
            return Err("codex-dynamic-tools-invalid".into());
        }
    }
    Ok(names)
}

fn valid_dynamic_tool_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_protocol_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

fn validate_dynamic_tool_response(response: &Value) -> Result<Value, String> {
    let success = response["success"]
        .as_bool()
        .ok_or_else(|| "codex-dynamic-tool-result-invalid".to_owned())?;
    let content_items = response["contentItems"]
        .as_array()
        .filter(|items| items.len() <= MAX_DYNAMIC_TOOL_CONTENT_ITEMS)
        .ok_or_else(|| "codex-dynamic-tool-result-invalid".to_owned())?;
    let mut normalized_items = Vec::with_capacity(content_items.len());
    for item in content_items {
        if item["type"] != "inputText" {
            return Err("codex-dynamic-tool-result-invalid".into());
        }
        let text = item["text"]
            .as_str()
            .ok_or_else(|| "codex-dynamic-tool-result-invalid".to_owned())?;
        normalized_items.push(json!({"type":"inputText","text":text}));
    }
    let normalized = json!({"contentItems":normalized_items,"success":success});
    let encoded = serde_json::to_vec(&normalized)
        .map_err(|_| "codex-dynamic-tool-result-invalid".to_owned())?;
    if encoded.len() > MAX_DYNAMIC_TOOL_RESULT_BYTES {
        return Err("codex-dynamic-tool-result-too-large".into());
    }
    Ok(normalized)
}

/// Validate and canonicalize the executable, isolated home, and workspace
/// before the task owner persists them as a durable runtime binding.
pub fn prepare_config(config: &mut CodexRunConfig, prompt: &str) -> Result<(), String> {
    validate_input(config, prompt)?;
    let executable =
        fs::canonicalize(&config.executable).map_err(|_| "codex-executable-invalid".to_owned())?;
    let (home, cwd) = prepare_paths(config)?;
    config.executable = executable;
    config.codex_home = home;
    config.working_directory = cwd;
    Ok(())
}

fn validate_input(config: &CodexRunConfig, prompt: &str) -> Result<(), String> {
    if prompt.trim().is_empty() || prompt.len() > MAX_PROMPT_BYTES {
        return Err("turn-input-invalid".into());
    }
    if config.model.trim().is_empty() || config.model.len() > 256 {
        return Err("codex-model-invalid".into());
    }
    effective_access_mode(&config.access_mode)?;
    if config.resume_thread_id.as_deref().is_some_and(|id| {
        id.trim().is_empty() || id.len() > 512 || id.chars().any(char::is_control)
    }) {
        return Err("codex-thread-id-invalid".into());
    }
    if config.timeout.is_zero() || config.timeout > MAX_TIMEOUT {
        return Err("codex-timeout-invalid".into());
    }
    if !config.executable.is_absolute() || !config.executable.is_file() {
        return Err("codex-executable-invalid".into());
    }
    if !config.codex_home.is_absolute() || !config.working_directory.is_absolute() {
        return Err("codex-paths-must-be-absolute".into());
    }
    Ok(())
}

fn effective_access_mode(mode: &Option<String>) -> Result<&str, String> {
    match mode.as_deref().unwrap_or("restricted") {
        "restricted" => Ok("restricted"),
        "full" => Ok("full"),
        _ => Err("codex-access-mode-invalid".into()),
    }
}

fn prepare_paths(config: &CodexRunConfig) -> Result<(PathBuf, PathBuf), String> {
    let requested_home = canonical_or_normalized(&config.codex_home);
    if user_codex_home()
        .is_some_and(|user_home| same_path(&requested_home, &canonical_or_normalized(&user_home)))
    {
        return Err("codex-home-not-isolated".into());
    }
    fs::create_dir_all(&config.codex_home).map_err(|_| "codex-home-unavailable".to_owned())?;
    let home =
        fs::canonicalize(&config.codex_home).map_err(|_| "codex-home-unavailable".to_owned())?;
    fs::create_dir_all(home.join("tmp")).map_err(|_| "codex-home-unavailable".to_owned())?;
    let cwd = fs::canonicalize(&config.working_directory)
        .map_err(|_| "codex-working-directory-unavailable".to_owned())?;
    if !cwd.is_dir() {
        return Err("codex-working-directory-unavailable".into());
    }
    Ok((home, cwd))
}

/// Resolve only the standard home path for an identity comparison. No files
/// inside it are opened or inspected.
fn user_codex_home() -> Option<PathBuf> {
    let configured = env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| {
        #[cfg(windows)]
        let base = env::var_os("USERPROFILE").map(PathBuf::from);
        #[cfg(not(windows))]
        let base = env::var_os("HOME").map(PathBuf::from);
        base.map(|path| path.join(".codex"))
    })?;
    Some(configured)
}

fn canonical_or_normalized(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| {
        let mut result = PathBuf::new();
        for component in path.components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    result.pop();
                }
                component => result.push(component.as_os_str()),
            }
        }
        result
    })
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn command(config: &CodexRunConfig, home: &Path, cwd: &Path) -> Command {
    let temp = home.join("tmp");
    // All implicit home/temp/config locations point under the explicit
    // isolated directory; other inherited environment variables are stripped.
    let mut command = Command::new(&config.executable);
    command
        .args([
            "-c",
            "cli_auth_credentials_store=\"file\"",
            "app-server",
            "--listen",
            "stdio://",
        ])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .env_clear()
        .env("CODEX_HOME", home)
        .env("HOME", home)
        .env("TMPDIR", &temp)
        .env("TMP", &temp)
        .env("TEMP", &temp);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    if let Some(path) = env::var_os("PATH") {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    {
        command
            .env("USERPROFILE", home)
            .env("APPDATA", home.join("AppData").join("Roaming"))
            .env("LOCALAPPDATA", home.join("AppData").join("Local"));
        // MXC command startup requires the host drive as well as SystemRoot.
        // Preserve only these Windows runtime values; user credentials and
        // unrelated environment variables still do not reach app-server.
        for key in ["SYSTEMROOT", "WINDIR", "COMSPEC", "SystemDrive"] {
            if let Some(value) = env::var_os(key) {
                command.env(key, value);
            }
        }
    }
    #[cfg(not(windows))]
    {
        command
            .env("XDG_CONFIG_HOME", home.join("config"))
            .env("XDG_DATA_HOME", home.join("data"))
            .env("XDG_CACHE_HOME", home.join("cache"));
    }
    command
}

struct Terminal {
    thread_id: Option<String>,
    turn_id: Option<String>,
    status: String,
    error_detail: Option<String>,
}

#[derive(Clone)]
struct CachedDynamicCall {
    tool: String,
    arguments: Value,
    response: Value,
}

struct Driver<F> {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    deadline: Instant,
    cancel: watch::Receiver<bool>,
    cancel_open: bool,
    read_buffer: Vec<u8>,
    next_id: u64,
    protocol_bytes: usize,
    delta_chars: [usize; 3],
    journal_frame_bytes: usize,
    thread_id: Option<String>,
    turn_id: Option<String>,
    provisional_turn_id: Option<String>,
    turn_start_pending: bool,
    terminal: Option<Terminal>,
    tool_names: HashSet<String>,
    tool_calls: HashMap<String, CachedDynamicCall>,
    on_event: F,
}

impl<F> Driver<F>
where
    F: FnMut(CodexRuntimeEvent) -> Result<Option<Value>, String>,
{
    fn new(
        stdin: ChildStdin,
        stdout: ChildStdout,
        deadline: Instant,
        cancel: watch::Receiver<bool>,
        tool_names: HashSet<String>,
        on_event: F,
    ) -> Self {
        Self {
            stdin,
            stdout: BufReader::new(stdout),
            deadline,
            cancel,
            cancel_open: true,
            read_buffer: Vec::new(),
            next_id: 1,
            protocol_bytes: 0,
            delta_chars: [0; 3],
            journal_frame_bytes: 0,
            thread_id: None,
            turn_id: None,
            provisional_turn_id: None,
            turn_start_pending: false,
            terminal: None,
            tool_names,
            tool_calls: HashMap::new(),
            on_event,
        }
    }

    fn emit(&mut self, event: CodexRuntimeEvent) -> Result<(), String> {
        let result = (self.on_event)(event)
            .map_err(|error| format!("journal-write-failed: {}", clip(&error, 512)))?;
        if result.is_some() {
            return Err("codex-unexpected-tool-result".into());
        }
        Ok(())
    }

    fn emit_tool_call(
        &mut self,
        call_id: String,
        tool: String,
        arguments: Value,
    ) -> Result<Value, String> {
        let response = (self.on_event)(CodexRuntimeEvent::ToolCall {
            call_id,
            tool,
            arguments,
        })
        .map_err(|error| format!("dynamic-tool-handler-failed: {}", clip(&error, 512)))?
        .ok_or_else(|| "codex-dynamic-tool-result-missing".to_owned())?;
        validate_dynamic_tool_response(&response)
    }

    async fn write(
        &mut self,
        value: &Value,
        deadline: Instant,
        watch_cancel: bool,
    ) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(value).map_err(|_| "codex-protocol-serialize-failed")?;
        if bytes.len() > MAX_LINE_BYTES {
            return Err("codex-protocol-message-too-large".into());
        }
        bytes.push(b'\n');
        if watch_cancel && *self.cancel.borrow_and_update() {
            return Err("cancelled".into());
        }
        let stdin = &mut self.stdin;
        let write = async move {
            stdin.write_all(&bytes).await?;
            stdin.flush().await
        };
        tokio::pin!(write);
        loop {
            tokio::select! {
                biased;
                changed=self.cancel.changed(), if watch_cancel && self.cancel_open => {
                    if changed.is_err() {self.cancel_open=false;} else if *self.cancel.borrow_and_update() {return Err("cancelled".into());}
                }
                _=sleep_until(deadline)=>return Err("timeout".into()),
                result=&mut write=>return result.map_err(|_|"codex-stdin-write-failed".into()),
            }
        }
    }

    async fn next_value(&mut self, deadline: Instant, watch_cancel: bool) -> Result<Value, String> {
        if watch_cancel && *self.cancel.borrow_and_update() {
            return Err("cancelled".into());
        }
        let line = loop {
            tokio::select! {
                biased;
                changed = self.cancel.changed(), if watch_cancel && self.cancel_open => {
                    if changed.is_err() {
                        self.cancel_open = false;
                    } else if *self.cancel.borrow_and_update() {
                        return Err("cancelled".into());
                    }
                }
                _ = sleep_until(deadline) => return Err("timeout".into()),
                result = read_bounded_line(&mut self.stdout, &mut self.read_buffer, MAX_LINE_BYTES) => {
                    match result.map_err(|error| match error.kind() {
                        io::ErrorKind::InvalidData => "codex-protocol-line-too-large",
                        _ => "codex-stdout-read-failed",
                    }.to_owned())? {
                        None => return Err("codex-process-closed".into()),
                        Some(line) => break line,
                    }
                }
            }
        };
        self.protocol_bytes = self
            .protocol_bytes
            .checked_add(line.len())
            .ok_or_else(|| "codex-protocol-output-too-large".to_owned())?;
        if self.protocol_bytes > MAX_PROTOCOL_BYTES {
            return Err("codex-protocol-output-too-large".into());
        }
        serde_json::from_slice(&line).map_err(|_| "codex-protocol-invalid-json".into())
    }

    async fn call(
        &mut self,
        method: &str,
        params: Value,
        deadline: Instant,
        watch_cancel: bool,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| "codex-protocol-id-exhausted".to_owned())?;
        self.write(
            &json!({"id":id,"method":method,"params":params}),
            deadline,
            watch_cancel,
        )
        .await?;
        loop {
            let message = self.next_value(deadline, watch_cancel).await?;
            if message.get("id") == Some(&json!(id)) && message.get("method").is_none() {
                if let Some(error) = message.get("error") {
                    let detail = error["message"]
                        .as_str()
                        .unwrap_or("Codex protocol request failed");
                    return Err(format!("codex-protocol-error: {}", clip(detail, 1000)));
                }
                return message
                    .get("result")
                    .cloned()
                    .ok_or_else(|| "codex-protocol-result-missing".into());
            }
            self.dispatch(message).await?;
        }
    }

    async fn dispatch(&mut self, message: Value) -> Result<(), String> {
        if message.get("method").and_then(Value::as_str).is_some() {
            if message.get("id").is_some_and(|id| !id.is_null()) {
                if message["method"] == "item/tool/call" {
                    return self.handle_dynamic_tool_call(&message).await;
                }
                return self.reject_request(&message).await;
            }
            self.dispatch_notification(&message)?;
        }
        Ok(())
    }

    async fn handle_dynamic_tool_call(&mut self, request: &Value) -> Result<(), String> {
        let request_id = request["id"].clone();
        if !request_id.is_string() && !request_id.is_number() {
            return Err("codex-dynamic-tool-request-id-invalid".into());
        }
        let params = &request["params"];
        if self.tool_names.is_empty() {
            return self
                .write_tool_error(request_id, -32601, "Dynamic tools are unavailable.")
                .await;
        }

        let call_id = params["callId"].as_str().unwrap_or("");
        let tool = params["tool"].as_str().unwrap_or("");
        let arguments = &params["arguments"];
        let namespace = &params["namespace"];
        let expected_turn_id = self
            .turn_id
            .as_deref()
            .or(self.provisional_turn_id.as_deref());
        let in_scope = self.terminal.is_none()
            && self
                .thread_id
                .as_deref()
                .is_some_and(|expected| params["threadId"].as_str() == Some(expected))
            && expected_turn_id.is_some_and(|expected| params["turnId"].as_str() == Some(expected));
        if !in_scope {
            return self
                .write_tool_error(
                    request_id,
                    -32602,
                    "Dynamic tool call is outside the active turn.",
                )
                .await;
        }
        if call_id.is_empty()
            || call_id.len() > MAX_DYNAMIC_TOOL_CALL_ID_BYTES
            || call_id.chars().any(char::is_control)
            || !self.tool_names.contains(tool)
            || !namespace.is_null()
        {
            return self
                .write_tool_error(request_id, -32602, "Dynamic tool call is invalid.")
                .await;
        }
        let raw_argument_bytes = serde_json::to_vec(arguments)
            .map_err(|_| "codex-dynamic-tool-arguments-invalid".to_owned())?;
        if raw_argument_bytes.len() > MAX_DYNAMIC_TOOL_ARGUMENT_BYTES {
            return self
                .write_tool_error(request_id, -32602, "Dynamic tool arguments are too large.")
                .await;
        }
        let arguments = if arguments.is_object() {
            arguments.clone()
        } else if let Some(encoded) = arguments.as_str() {
            serde_json::from_str::<Value>(encoded).unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        if !arguments.is_object()
            || serde_json::to_vec(&arguments)
                .map_err(|_| "codex-dynamic-tool-arguments-invalid".to_owned())?
                .len()
                > MAX_DYNAMIC_TOOL_ARGUMENT_BYTES
        {
            return self
                .write_tool_error(request_id, -32602, "Dynamic tool arguments are invalid.")
                .await;
        }
        if let Some(cached) = self.tool_calls.get(call_id) {
            if cached.tool != tool || &cached.arguments != &arguments {
                return self
                    .write_tool_error(request_id, -32602, "Dynamic tool call ID was reused.")
                    .await;
            }
            return self
                .write(
                    &json!({"id":request_id,"result":cached.response}),
                    self.deadline,
                    true,
                )
                .await;
        }
        if self.tool_calls.len() >= MAX_DYNAMIC_TOOL_CALLS {
            return self
                .write_tool_error(request_id, -32602, "Dynamic tool call limit reached.")
                .await;
        }

        let call_id = call_id.to_owned();
        let tool = tool.to_owned();
        let response = self.emit_tool_call(call_id.clone(), tool.clone(), arguments.clone())?;
        let response_bytes = serde_json::to_vec(&response)
            .map_err(|_| "codex-dynamic-tool-result-invalid".to_owned())?;
        if response_bytes.len() > MAX_DYNAMIC_TOOL_RESULT_BYTES {
            return Err("codex-dynamic-tool-result-too-large".into());
        }
        self.tool_calls.insert(
            call_id,
            CachedDynamicCall {
                tool,
                arguments,
                response: response.clone(),
            },
        );
        self.write(
            &json!({"id":request_id,"result":response}),
            self.deadline,
            true,
        )
        .await
    }

    async fn write_tool_error(
        &mut self,
        id: Value,
        code: i64,
        message: &str,
    ) -> Result<(), String> {
        self.write(
            &json!({"id":id,"error":{"code":code,"message":message}}),
            self.deadline,
            true,
        )
        .await
    }

    async fn reject_request(&mut self, request: &Value) -> Result<(), String> {
        let id = request["id"].clone();
        let method = request["method"].as_str().unwrap_or("");
        let requests = codex_protocol::frames(request);
        let recognized_approval = requests.iter().any(|frame| {
            matches!(
                frame,
                Frame::Request {
                    method: "approval",
                    ..
                }
            )
        });
        let response = if recognized_approval && method.ends_with("/requestApproval") {
            let result = codex_protocol::approval_result(request, &json!({"choice":"deny"}))?;
            json!({"id":id,"result":result})
        } else {
            json!({"id":id,"error":{"code":-32601,"message":"Standalone runtime does not support approval or user input requests."}})
        };
        let deadline = self.deadline;
        self.write(&response, deadline, true).await
    }

    fn dispatch_notification(&mut self, message: &Value) -> Result<(), String> {
        if !self.notification_matches_current(message) {
            return Ok(());
        }
        if message["method"] == "turn/started" && self.turn_start_pending {
            let params = &message["params"];
            let thread_id = params["threadId"].as_str();
            let turn_id = params["turn"]["id"].as_str();
            if thread_id == self.thread_id.as_deref() && turn_id.is_some_and(valid_protocol_id) {
                let turn_id = turn_id.unwrap().to_owned();
                if self
                    .provisional_turn_id
                    .as_deref()
                    .is_some_and(|existing| existing != turn_id.as_str())
                {
                    return Err("codex-turn-start-mismatch".into());
                }
                self.provisional_turn_id = Some(turn_id);
            }
        }
        if message["method"] == "turn/completed" {
            let Some(thread_id) = message["params"]["threadId"].as_str().map(str::to_owned) else {
                return Ok(());
            };
            let Some(turn_id) = message["params"]["turn"]["id"].as_str().map(str::to_owned) else {
                return Ok(());
            };
            if thread_id.is_empty() || turn_id.is_empty() {
                return Ok(());
            }
            let native_status = message["params"]["turn"]["status"].as_str().unwrap_or("");
            let status = match native_status {
                "completed" => "completed",
                "interrupted" => "interrupted",
                _ => "failed",
            };
            let error_detail = message["params"]["turn"]["error"]["message"]
                .as_str()
                .map(|value| clip(value, 1000))
                .or_else(|| (status == "failed").then(|| "Codex turn failed".into()));
            self.terminal = Some(Terminal {
                thread_id: Some(thread_id),
                turn_id: Some(turn_id),
                status: status.into(),
                error_detail,
            });
        }

        for frame in codex_protocol::frames(message) {
            match frame {
                Frame::Request { .. } => {}
                Frame::Event { kind, mut payload } => {
                    if !self.bound_event(kind, &mut payload)? {
                        continue;
                    }
                    let size = serde_json::to_vec(&payload).map_or(MAX_LINE_BYTES, |v| v.len());
                    if self.journal_frame_bytes.saturating_add(size) > MAX_JOURNAL_FRAME_BYTES {
                        return Err("codex-output-limit".into());
                    }
                    self.journal_frame_bytes += size;
                    self.emit(CodexRuntimeEvent::Frame(Frame::Event { kind, payload }))?;
                }
                Frame::Error { code, detail } => {
                    let size = code
                        .len()
                        .saturating_add(detail.as_ref().map_or(0, String::len));
                    if self.journal_frame_bytes.saturating_add(size) > MAX_JOURNAL_FRAME_BYTES {
                        return Err("codex-output-limit".into());
                    }
                    self.journal_frame_bytes += size;
                    self.emit(CodexRuntimeEvent::Frame(Frame::Error { code, detail }))?;
                }
            }
        }
        Ok(())
    }

    fn notification_matches_current(&self, message: &Value) -> bool {
        let params = &message["params"];
        if self.thread_id.as_deref().is_some_and(|expected| {
            params["threadId"]
                .as_str()
                .or_else(|| params["thread"]["id"].as_str())
                .is_some_and(|actual| actual != expected)
        }) {
            return false;
        }
        let event_turn = params["turnId"]
            .as_str()
            .or_else(|| params["turn"]["id"].as_str());
        let expected_turn = self
            .turn_id
            .as_deref()
            .or(self.provisional_turn_id.as_deref());
        if expected_turn.is_some_and(|expected| event_turn.is_some_and(|actual| actual != expected))
        {
            return false;
        }
        true
    }

    fn bound_event(&mut self, kind: &'static str, payload: &mut Value) -> Result<bool, String> {
        let budget_slot = match kind {
            "message.delta" => Some(0),
            "reasoning.delta" => Some(1),
            "tool.output" => Some(2),
            _ => None,
        };
        if let Some(slot) = budget_slot {
            let Some(text) = payload["text"].as_str() else {
                return Ok(false);
            };
            let remaining = MAX_DELTA_CHARS.saturating_sub(self.delta_chars[slot]);
            if text.chars().count() > remaining {
                return Err("codex-output-limit".into());
            }
            let chars = text.chars().count();
            self.delta_chars[slot] += chars;
            return Ok(chars > 0);
        }
        let mut remaining = MAX_FRAME_CHARS;
        if !bound_value(payload, &mut remaining, 0) {
            return Err("codex-output-limit".into());
        }
        Ok(true)
    }

    fn terminal(&self) -> Option<TurnOutcome> {
        let terminal = self.terminal.as_ref()?;
        if terminal.thread_id.as_deref().is_some_and(|id| {
            self.thread_id
                .as_deref()
                .is_some_and(|expected| id != expected)
        }) || terminal.turn_id.as_deref().is_some_and(|id| {
            self.turn_id
                .as_deref()
                .is_some_and(|expected| id != expected)
        }) {
            return None;
        }
        Some(TurnOutcome {
            thread_id: self.thread_id.clone()?,
            turn_id: self.turn_id.clone()?,
            status: terminal.status.clone(),
            error_detail: terminal.error_detail.clone(),
        })
    }

    async fn wait_for_turn_end(&mut self) -> Result<TurnOutcome, String> {
        loop {
            if let Some(outcome) = self.terminal() {
                return Ok(outcome);
            }
            let message = self.next_value(self.deadline, true).await?;
            self.dispatch(message).await?;
        }
    }

    async fn interrupt_and_wait(&mut self, thread_id: &str, turn_id: &str) -> Result<(), String> {
        let deadline = Instant::now() + INTERRUPT_GRACE;
        if self.terminal().is_some() {
            return Ok(());
        }
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.write(&json!({"id":id,"method":"turn/interrupt","params":{"threadId":thread_id,"turnId":turn_id}}), deadline, false).await?;
        while self.terminal().is_none() {
            let message = self.next_value(deadline, false).await?;
            self.dispatch(message).await?;
        }
        Ok(())
    }
}

async fn drive_turn<F>(
    driver: &mut Driver<F>,
    config: &CodexRunConfig,
    prompt: &str,
    cwd: &Path,
    descriptors: &[Value],
    developer_instructions: &str,
) -> Result<TurnOutcome, String>
where
    F: FnMut(CodexRuntimeEvent) -> Result<Option<Value>, String>,
{
    let initialize_deadline = driver.deadline;
    let mut initialize_params = json!({"clientInfo":{"name":"aplot_server","title":"Aplot Server","version":env!("CARGO_PKG_VERSION")}});
    if !driver.tool_names.is_empty() || config.resume_thread_id.is_some() {
        initialize_params["capabilities"] = json!({"experimentalApi":true});
    }
    driver
        .call("initialize", initialize_params, initialize_deadline, true)
        .await?;
    let initialized_deadline = driver.deadline;
    driver
        .write(&json!({"method":"initialized"}), initialized_deadline, true)
        .await?;

    let account_deadline = driver.deadline;
    let account = driver
        .call(
            "account/read",
            json!({"refreshToken":false}),
            account_deadline,
            true,
        )
        .await?;
    let fingerprint = account_fingerprint(&account)?;
    driver.emit(CodexRuntimeEvent::AccountIdentified { fingerprint })?;

    let cwd_string = cwd.to_string_lossy().into_owned();
    let config_deadline = driver.deadline;
    let effective_config = driver
        .call(
            "config/read",
            json!({"cwd":cwd_string,"includeLayers":false}),
            config_deadline,
            true,
        )
        .await?;
    let search_mode = effective_config["config"]["web_search"].as_str();
    if search_mode.is_some_and(|mode| !["disabled", "cached", "indexed", "live"].contains(&mode)) {
        return Err("codex-web-search-mode-unsupported".into());
    }
    let host_policy = if config.access_mode.as_deref().unwrap_or("restricted") == "restricted" {
        "This current host policy supersedes earlier host statements that all network access was unavailable; it does not enable local command networking or project writes. Treat earlier assistant claims about tool availability as historical, and check the currently available tools."
    } else {
        "This current owner-approved grant supersedes earlier Aplot task-mode restrictions on project writes and local shell networking. Treat earlier Aplot task-mode claims as historical, and check the currently available tools."
    };
    let current_instructions = format!(
        "{developer_instructions}\n\nCurrent server capability policy: hosted web search mode is {}. Use hosted search only when enabled and exposed as a tool. {host_policy}",
        search_mode.unwrap_or("unspecified (use only tools currently exposed)")
    );
    let mode = config.access_mode.as_deref().unwrap_or("restricted");
    let policy = codex_protocol::policy(mode, &cwd_string);
    let mut thread_params = json!({
        "cwd":cwd_string,"model":config.model,"approvalPolicy":policy.approval_policy,
        "sandbox":policy.sandbox,
        "developerInstructions":current_instructions
    });
    if let Some(mode) = search_mode {
        // Resume may otherwise retain the thread's old search selection.
        // Use the host's effective setting, including an explicit disabled mode.
        thread_params["config"] = json!({"web_search":mode});
    }
    let thread_method = if let Some(thread_id) = &config.resume_thread_id {
        thread_params["threadId"] = json!(thread_id);
        thread_params["excludeTurns"] = json!(true);
        "thread/resume"
    } else {
        if !descriptors.is_empty() {
            thread_params["dynamicTools"] = json!(descriptors);
        }
        "thread/start"
    };
    let thread_deadline = driver.deadline;
    let thread = driver
        .call(thread_method, thread_params, thread_deadline, true)
        .await?;
    let thread_id = thread["thread"]["id"]
        .as_str()
        .filter(|value| valid_protocol_id(value))
        .ok_or_else(|| "codex-thread-id-missing".to_owned())?
        .to_owned();
    if config
        .resume_thread_id
        .as_deref()
        .is_some_and(|expected| expected != thread_id)
    {
        return Err("codex-thread-resume-mismatch".into());
    }
    driver.thread_id = Some(thread_id.clone());
    driver.emit(CodexRuntimeEvent::ThreadStarted {
        id: thread_id.clone(),
    })?;

    if config.resume_thread_id.is_some() {
        // developerInstructions on resume is not sufficient to replace an old
        // model-visible policy item. Append the current trusted host context
        // before the next user turn, preserving the existing thread/history.
        let refresh_deadline = driver.deadline;
        driver
            .call(
                "thread/inject_items",
                json!({"threadId":thread_id,"items":[{"type":"message","role":"developer","content":[{"type":"input_text","text":current_instructions}]}]}),
                refresh_deadline,
                true,
            )
            .await?;
    }

    let turn_deadline = driver.deadline;
    driver.turn_start_pending = true;
    let turn_result = driver
        .call(
            "turn/start",
            json!({"threadId":thread_id,"input":[{"type":"text","text":prompt}],
                "model":config.model,"approvalPolicy":policy.approval_policy,"sandboxPolicy":policy.sandbox_policy}),
            turn_deadline,
            true,
        )
        .await;
    driver.turn_start_pending = false;
    let turn = match turn_result {
        Ok(turn) => turn,
        Err(error) if matches!(error.as_str(), "cancelled" | "timeout") => return Err(error),
        Err(error) => return Err(error),
    };
    let turn_id = turn["turn"]["id"]
        .as_str()
        .filter(|value| valid_protocol_id(value))
        .ok_or_else(|| "codex-turn-id-missing".to_owned())?
        .to_owned();
    if driver
        .provisional_turn_id
        .as_deref()
        .is_some_and(|provisional| provisional != turn_id)
    {
        return Err("codex-turn-start-mismatch".into());
    }
    driver.turn_id = Some(turn_id.clone());
    driver.provisional_turn_id = None;
    driver.emit(CodexRuntimeEvent::TurnStarted {
        id: turn_id.clone(),
    })?;

    if let Some(outcome) = driver.terminal() {
        return Ok(outcome);
    }
    match driver.wait_for_turn_end().await {
        Ok(outcome) => Ok(outcome),
        Err(error) if matches!(error.as_str(), "cancelled" | "timeout") => {
            let _ = driver.interrupt_and_wait(&thread_id, &turn_id).await;
            if let Some(mut outcome) = driver.terminal() {
                outcome.status = "interrupted".into();
                if outcome.error_detail.is_none() {
                    outcome.error_detail = Some(error.into());
                }
                Ok(outcome)
            } else {
                Err(error.into())
            }
        }
        Err(error) => Err(error),
    }
}

fn account_fingerprint(account_result: &Value) -> Result<String, String> {
    // The official account/read contract documents `type` and optional
    // `email` for ChatGPT accounts. It does not document an account ID, and
    // API key/Bedrock responses do not include a stable identity. Do not
    // inspect auth files or derive a value from credentials.
    if account_result["account"]["type"] != "chatgpt" {
        return Err("codex-account-identity-unavailable".into());
    }
    let email = account_result["account"]["email"]
        .as_str()
        .map(str::trim)
        .filter(|value| {
            !value.is_empty() && value.len() <= 320 && !value.chars().any(char::is_control)
        })
        .ok_or_else(|| "codex-account-identity-unavailable".to_owned())?;
    let identity = format!("codex-account-v1\0chatgpt\0{}", email.to_lowercase());
    Ok(format!("{:x}", Sha256::digest(identity.as_bytes())))
}

async fn read_bounded_line<R>(
    reader: &mut R,
    buffered: &mut Vec<u8>,
    max: usize,
) -> io::Result<Option<Vec<u8>>>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        if let Some(index) = buffered.iter().position(|byte| *byte == b'\n') {
            if index + 1 > max {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "line-limit"));
            }
            return Ok(Some(buffered.drain(..=index).collect()));
        }
        if buffered.len() > max {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "line-limit"));
        }
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return if buffered.is_empty() {
                Ok(None)
            } else {
                Ok(Some(buffered.drain(..).collect()))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |index| index + 1);
        if buffered.len().saturating_add(count) > max {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "line-limit"));
        }
        buffered.extend_from_slice(&available[..count]);
        reader.consume(count);
        if newline.is_some() {
            return Ok(Some(buffered.drain(..).collect()));
        }
    }
}

fn bound_value(value: &mut Value, remaining_chars: &mut usize, depth: usize) -> bool {
    if depth > 8 || *remaining_chars == 0 {
        return false;
    }
    match value {
        Value::String(text) => {
            let count = text.chars().count();
            if count > (*remaining_chars).min(4_096) {
                return false;
            }
            *remaining_chars = (*remaining_chars).saturating_sub(count);
        }
        Value::Array(items) => {
            if items.len() > 64 {
                return false;
            }
            for item in items.iter_mut() {
                if !bound_value(item, remaining_chars, depth + 1) {
                    return false;
                }
            }
        }
        Value::Object(object) => {
            if object.len() > 128 {
                return false;
            }
            for item in object.values_mut() {
                if !bound_value(item, remaining_chars, depth + 1) {
                    return false;
                }
            }
        }
        _ => {}
    }
    true
}

fn take_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn clip(value: &str, limit: usize) -> String {
    take_chars(value, limit)
}

async fn kill_and_reap(child: &mut Child) -> Result<(), String> {
    let kill_result = child.kill().await;
    let wait_result = child.wait().await;
    match wait_result {
        Ok(_) => Ok(()),
        Err(_) => Err(if kill_result.is_err() {
            "codex-process-cleanup-failed".into()
        } else {
            "codex-process-reap-failed".into()
        }),
    }
}
