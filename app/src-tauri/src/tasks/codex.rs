//! Codex adapter for host-owned tasks. The shared app-server reader hands
//! every notification to [`route`]; notifications for a thread owned by a
//! host task are applied here and are not forwarded to the window.
use super::codex_protocol::{self, Frame};
use super::driver::{self, Live};
use super::store::{TaskConfig, TaskState};
use super::TaskHost;
use serde_json::{json, Map, Value};
use std::{
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const MAX_GENERATED_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

fn mcp_server_overrides(
    external: Map<String, Value>,
    mut aplot: Value,
) -> Result<Map<String, Value>, String> {
    aplot["tool_timeout_sec"] = json!(250);
    let mut overrides = Map::new();
    for (name, config) in external {
        if name == "aplot" {
            return Err("mcp-name-reserved".into());
        }
        overrides.insert(format!("mcp_servers.{name}"), config);
    }
    overrides.insert("mcp_servers.aplot".into(), aplot);
    Ok(overrides)
}

/// Native-only MCP configuration for this saved project task. Credentials stay
/// in the app-server override and never enter renderer state or the task journal.
pub(crate) async fn mcp_server_config(app: &AppHandle, task_id: &str) -> Result<Value, String> {
    let external = crate::mcp_connections::configuration_for_task(app, task_id).await?;
    let aplot = crate::agent_tools::configuration(app, task_id).await?;
    Ok(Value::Object(mcp_server_overrides(external, aplot)?))
}

fn same_path_component(left: Component<'_>, right: Component<'_>) -> bool {
    let left = left.as_os_str().to_string_lossy();
    let right = right.as_os_str().to_string_lossy();
    #[cfg(windows)]
    {
        left.eq_ignore_ascii_case(&right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn is_image_signature(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(&[0xff, 0xd8, 0xff])
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
        || (bytes.len() >= 12
            && &bytes[4..8] == b"ftyp"
            && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis"))
}

/// Convert Codex's absolute savedPath into a canonical project-relative path
/// only when the existing file is a reasonably sized raster image.
fn project_image_relative(root: &Path, saved_path: &str) -> Option<String> {
    if saved_path.is_empty() || saved_path.len() > 32_768 {
        return None;
    }
    let source_path = PathBuf::from(saved_path);
    if !source_path.is_absolute() {
        return None;
    }
    let root = fs::canonicalize(root).ok()?;
    let source = fs::canonicalize(source_path).ok()?;
    let metadata = fs::metadata(&source).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_GENERATED_IMAGE_BYTES {
        return None;
    }
    let root_components = root.components().collect::<Vec<_>>();
    let source_components = source.components().collect::<Vec<_>>();
    if root_components.len() >= source_components.len()
        || !root_components
            .iter()
            .zip(&source_components)
            .all(|(root, source)| same_path_component(*root, *source))
    {
        return None;
    }
    let parts = source_components[root_components.len()..]
        .iter()
        .map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    if parts.is_empty() {
        return None;
    }
    let mut signature = [0u8; 12];
    let count = File::open(&source).ok()?.read(&mut signature).ok()?;
    if !is_image_signature(&signature[..count]) {
        return None;
    }
    Some(parts.join("/"))
}

async fn save_generated_project_image(
    app: &AppHandle,
    host: &TaskHost,
    task_id: &str,
    saved_path: &str,
) -> Option<Value> {
    let root = host
        .read(app, |conn| crate::agent_workspace::task_root(conn, task_id))
        .await
        .ok()?;
    let root = PathBuf::from(root);
    let saved_path = saved_path.to_owned();
    let relative =
        tauri::async_runtime::spawn_blocking(move || project_image_relative(&root, &saved_path))
            .await
            .ok()??;
    let artifact = crate::user_artifacts::save_for_active_task(app, task_id, &relative)
        .await
        .ok()?;
    Some(json!({
        "id":artifact.id,
        "name":artifact.name,
        "mime":artifact.mime,
        "bytes":artifact.bytes,
        "sha256":artifact.sha256,
        "version":artifact.version,
        "source_relative":artifact.source_relative,
    }))
}

async fn attach_image_artifact(
    app: &AppHandle,
    host: &TaskHost,
    task_id: &str,
    item: &Value,
    frames: &mut [Frame],
) {
    if item["status"] != "completed" || !item["failure"].is_null() {
        return;
    }
    let Some(saved_path) = item["savedPath"].as_str().filter(|value| !value.is_empty()) else {
        return;
    };
    let artifact = save_generated_project_image(app, host, task_id, saved_path).await;
    for frame in frames {
        let Frame::Event {
            kind: "tool.complete",
            payload,
        } = frame
        else {
            continue;
        };
        if payload["tool_id"] != item["id"] {
            continue;
        }
        if let Some(artifact) = artifact.as_ref() {
            let relative = artifact["source_relative"].clone();
            payload["result"]["resolved_path"] = relative.clone();
            payload["result"]["artifact"] = artifact.clone();
            payload["result"]["image_generation"]["saved_to_project"] = json!(true);
            payload["result"]["output"] = json!(format!(
                "Image generated and saved as a project artifact: {}.",
                relative.as_str().unwrap_or("image")
            ));
        } else {
            payload["result"]["image_generation"]["saved_to_project"] = json!(false);
            payload["result"]["output"] = json!(
                "Image generation completed; no project-scoped image file was available to save."
            );
        }
    }
}

/// Returns true when the notification belongs to a host task.
pub(crate) async fn route(app: &AppHandle, value: &Value) -> bool {
    let Some(host) = app.try_state::<TaskHost>() else {
        return false;
    };
    let method = value["method"].as_str().unwrap_or("");
    let connection = value["aplotConnectionId"].as_str().unwrap_or("").to_owned();
    let signed_out =
        method == "account/updated" && value["params"].get("authMode") == Some(&Value::Null);
    if method == "aplot/closed" || signed_out {
        let generation = value["aplotGeneration"].as_u64();
        driver::closed(app, &host, |l| {
            l.runtime == "codex"
                && (connection.is_empty() || l.connection_id == connection)
                && generation.is_none_or(|g| g >= l.generation)
        })
        .await;
        return false;
    }
    let Some(thread) = value["params"]["threadId"].as_str() else {
        return false;
    };
    let Some(task_id) = host.sessions.task_for(&connection, thread) else {
        return false;
    };
    let generation = value["aplotGeneration"].as_u64().unwrap_or(0);
    let item = &value["params"]["item"];
    let (child, started_turn) = {
        let mut live = host.sessions.live.lock().unwrap();
        let Some(live) = live.get_mut(&task_id) else {
            return true;
        };
        // Notifications from a replaced worker can still be in flight. Never
        // let one update the active turn or transcript of its successor.
        if generation != live.generation || live.connection_id != connection {
            return true;
        }
        if item["type"] == "collabAgentToolCall" {
            for id in item["receiverThreadIds"].as_array().into_iter().flatten() {
                if live.children.len() < 32 {
                    live.children
                        .insert(id.as_str().unwrap_or_default().to_owned());
                }
            }
        }
        let mut started_turn = None;
        if method == "turn/started" && live.native == thread {
            live.native_turn = value["params"]["turn"]["id"].as_str().map(str::to_owned);
            if let (Some(host_turn), Some(native_turn)) =
                (live.turn.clone(), live.native_turn.clone())
            {
                started_turn = Some((host_turn, native_turn));
            }
        }
        (live.native != thread, started_turn)
    };
    if let Some((host_turn, native_turn)) = started_turn {
        if let Err(error) = host
            .write(app, |j| {
                j.set_turn(&host_turn, "running", Some(&native_turn), None)?;
                Ok(())
            })
            .await
        {
            eprintln!("agent task {task_id}: {error}");
        }
    }
    let mut frames = if !child || value.get("id").is_some() {
        // Sub-agent threads only report progress; their requests still need an answer.
        codex_protocol::frames(value)
    } else if matches!(method, "item/started" | "item/completed")
        && item["type"] == "imageGeneration"
    {
        codex_protocol::frames(value)
    } else if method == "turn/completed" {
        vec![Frame::Event {
            kind: "agent.update",
            payload: json!({"id":thread,"name":"Codex","status":value["params"]["turn"]["status"].as_str().unwrap_or("unknown")}),
        }]
    } else {
        Vec::new()
    };
    if method == "item/completed" && item["type"] == "imageGeneration" {
        attach_image_artifact(app, &host, &task_id, item, &mut frames).await;
    }
    let request = json!({"method":value["method"],"params":value["params"]});
    if let Err(error) = driver::apply_frames(
        app,
        &host,
        &task_id,
        &connection,
        generation,
        &request,
        frames,
    )
    .await
    {
        eprintln!("agent task {task_id}: {error}");
    }
    let stop_after_start = if method == "turn/started" {
        host.sessions.stopping.lock().unwrap().remove(&task_id)
    } else {
        false
    };
    if stop_after_start {
        let target = {
            let live_sessions = host.sessions.live.lock().unwrap();
            live_sessions.get(&task_id).and_then(|live| {
                Some((
                    live.connection_id.clone(),
                    live.generation,
                    live.native.clone(),
                    live.native_turn.clone()?,
                ))
            })
        };
        if let Some((connection, generation, thread, turn)) = target {
            if let Err(error) = app
                .state::<crate::codex_agent::CodexManager>()
                .interrupt_on_generation(&connection, generation, &thread, &turn)
                .await
            {
                eprintln!("agent task {task_id}: {error}");
            }
        }
    }
    true
}

pub(crate) fn instructions(config: &TaskConfig, skills_label: &str) -> String {
    let language = if config.language.as_deref() == Some("ru") {
        "Общайся с пользователем на русском языке."
    } else {
        "Use the user’s language."
    };
    let skills = config
        .skills
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| format!("{skills_label}: {s}"));
    [
        Some(language.to_owned()),
        Some(crate::agent_tools::INSTRUCTIONS.to_owned()),
        config.context.clone().filter(|s| !s.is_empty()),
        skills,
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n")
}

pub(crate) async fn start_session(
    app: &AppHandle,
    task_id: &str,
    cwd: &str,
    config: &TaskConfig,
    state: &TaskState,
) -> Result<Live, String> {
    let policy = codex_protocol::policy(config.access_mode.as_deref().unwrap_or("manual"), cwd);
    let resume = state.native_session_id.clone().filter(|_| {
        state.native_connection_id == config.connection_id || config.connection_id.is_none()
    });
    let mut params = json!({"cwd":cwd,"model":config.model_id,"approvalPolicy":policy.approval_policy,"sandbox":policy.sandbox,
        "developerInstructions":instructions(config, "Project skill references selected by the user")});
    params["config"] = mcp_server_config(app, task_id).await?;
    if let Some(connection) = &config.connection_id {
        params["aplotConnectionId"] = json!(connection);
    }
    if let Some(thread) = &resume {
        params["threadId"] = json!(thread);
    }
    let codex = app.state::<crate::codex_agent::CodexManager>();
    let (result, (connection_id, generation)) = codex
        .call(
            app,
            if resume.is_some() {
                "thread/resume"
            } else {
                "thread/start"
            },
            params,
        )
        .await?;
    let thread_id = result["thread"]["id"]
        .as_str()
        .ok_or("protocol")?
        .to_owned();
    Ok(Live::new(
        "codex",
        thread_id,
        connection_id,
        generation,
        cwd.into(),
    ))
}

/// Starts a turn; returns the native turn ID.
pub(crate) async fn start_turn(
    app: &AppHandle,
    thread: &str,
    connection: &str,
    cwd: &str,
    input: &Value,
    config: &TaskConfig,
) -> Result<Option<String>, String> {
    let policy = codex_protocol::policy(config.access_mode.as_deref().unwrap_or("manual"), cwd);
    let attachments = input["attachments"].as_array().cloned().unwrap_or_default();
    let files = attachments
        .iter()
        .filter(|a| a["kind"] != "image")
        .filter_map(|a| a["path"].as_str())
        .collect::<Vec<_>>();
    let mut text = input["text"].as_str().unwrap_or("").to_owned();
    if !files.is_empty() {
        text.push_str(&format!(
            "\n\nFiles explicitly attached by the user:\n{}",
            files.join("\n")
        ));
    }
    let mut items = vec![json!({"type":"text","text":text})];
    items.extend(
        attachments
            .iter()
            .filter(|a| a["kind"] == "image")
            .map(|a| json!({"type":"localImage","path":a["path"]})),
    );
    let mut params = json!({"aplotConnectionId":connection,"threadId":thread,"input":items,"model":config.model_id,
        "approvalPolicy":policy.approval_policy,"sandboxPolicy":policy.sandbox_policy});
    // Codex takes the reasoning level per turn, so a change applies to the next message.
    if let Some(effort) = config.reasoning.as_deref().filter(|s| !s.is_empty()) {
        params["effort"] = json!(effort);
    }
    let codex = app.state::<crate::codex_agent::CodexManager>();
    let (result, _) = codex.call(app, "turn/start", params).await?;
    Ok(result["turn"]["id"].as_str().map(str::to_owned))
}

pub(crate) async fn interrupt(
    app: &AppHandle,
    connection: &str,
    thread: &str,
    turn: &str,
) -> Result<(), String> {
    let codex = app.state::<crate::codex_agent::CodexManager>();
    codex
        .call(
            app,
            "turn/interrupt",
            json!({"aplotConnectionId":connection,"threadId":thread,"turnId":turn}),
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_overrides_preserve_project_servers_and_use_the_codex_timeout_field() {
        let external = serde_json::from_value(
            json!({"docs":{"url":"https://mcp.example.test/mcp","enabled":false}}),
        )
        .unwrap();
        let config = mcp_server_overrides(
            external,
            json!({"command":"aplot.exe","args":["agent-tools-stdio"]}),
        )
        .unwrap();
        assert_eq!(config["mcp_servers.docs"]["enabled"], false);
        assert_eq!(config["mcp_servers.aplot"]["tool_timeout_sec"], 250);
        assert!(config["mcp_servers.aplot"]
            .get("tool_call_timeout_sec")
            .is_none());
        let reserved = serde_json::from_value(json!({"aplot":{"command":"other.exe"}})).unwrap();
        assert_eq!(
            mcp_server_overrides(reserved, json!({})).unwrap_err(),
            "mcp-name-reserved"
        );
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("codex-image-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn generated_image_path_must_be_project_scoped_and_have_image_magic() {
        let temp = TempDir::new();
        let root = temp.0.join("project");
        let outside = temp.0.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let image = root.join("generated.png");
        let not_image = root.join("not-image.png");
        let external_image = outside.join("generated.png");
        fs::write(&image, b"\x89PNG\r\n\x1a\nimage data").unwrap();
        fs::write(&not_image, b"this is not an image").unwrap();
        fs::write(&external_image, b"\x89PNG\r\n\x1a\nimage data").unwrap();

        assert_eq!(
            project_image_relative(&root, &image.to_string_lossy()),
            Some("generated.png".into())
        );
        assert_eq!(
            project_image_relative(&root, &not_image.to_string_lossy()),
            None
        );
        assert_eq!(
            project_image_relative(&root, &external_image.to_string_lossy()),
            None
        );
    }
}
