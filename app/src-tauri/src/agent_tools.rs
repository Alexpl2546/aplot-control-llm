//! App-owned MCP tools. A private stdio proxy connects each runtime to the live
//! workspace through a task-scoped, loopback-only capability.
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{oneshot, Mutex as AsyncMutex},
};

#[derive(Default)]
pub struct AgentTools {
    port: AsyncMutex<Option<u16>>,
    tokens: Mutex<HashMap<String, String>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

pub const INSTRUCTIONS: &str = "Aplot app tools are built into this session. Use aplot_list_agents and aplot_list_projects to discover existing app agents and projects. Use aplot_delegate to give an existing agent a bounded task; this opens a linked task/chat in the app. Use aplot_task_result to read its actual result before reporting success. Prefer existing specialists. If a missing specialist would help, use aplot_propose_agent: creation requires the user's explicit approval in the application, including in full-access mode. Never create app agents by editing workspace files or through computer use. Never claim another agent ran unless the tool confirms it. Delegation cannot increase your access permissions. Do not delegate recursively without need.";

pub(crate) fn tools() -> Value {
    let schema = |properties: Value, required: &[&str]| json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
    json!([
        {"name":"aplot_list_projects","description":"List existing Aplot projects and their IDs.","inputSchema":schema(json!({}), &[])},
        {"name":"aplot_list_agents","description":"List existing app agents, their jobs and execution configuration. Optional project filter.","inputSchema":schema(json!({"projectId":{"type":"string"}}), &[])},
        {"name":"aplot_delegate","description":"Start a linked task/chat with an existing app agent. Returns taskId; read the result separately. Uses the caller's project unless specified.","inputSchema":schema(json!({"agentId":{"type":"string"},"prompt":{"type":"string","minLength":1,"maxLength":16000},"projectId":{"type":"string"}}), &["agentId","prompt"])},
        {"name":"aplot_task_result","description":"Read status and result of a task delegated by this agent. May wait up to 30 seconds.","inputSchema":schema(json!({"taskId":{"type":"string"},"waitSeconds":{"type":"integer","minimum":0,"maximum":30}}), &["taskId"])},
        {"name":"aplot_propose_agent","description":"Propose creating a specialist. Shows the user its name, job and instructions for explicit approval. Only approval creates it. Execution settings are inherited from the caller.","inputSchema":schema(json!({"name":{"type":"string","minLength":1,"maxLength":20},"title":{"type":"string","minLength":1,"maxLength":80},"instructions":{"type":"string","minLength":1,"maxLength":16000}}), &["name","title","instructions"])}
    ])
}

pub(crate) async fn configuration(app: &AppHandle, task_id: &str) -> Result<Value, String> {
    let state = app.state::<AgentTools>();
    let mut port = state.port.lock().await;
    if port.is_none() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| e.to_string())?;
        *port = Some(listener.local_addr().map_err(|e| e.to_string())?.port());
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Ok((mut socket, peer)) = listener.accept().await {
                if !peer.ip().is_loopback() {
                    continue;
                }
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let read = async {
                        let mut bytes = Vec::new();
                        let header_end = loop {
                            let mut buf = [0; 4096];
                            let count = socket.read(&mut buf).await.ok()?;
                            if count == 0 || bytes.len() + count > 100_000 {
                                return None;
                            }
                            bytes.extend_from_slice(&buf[..count]);
                            if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                                break index + 4;
                            }
                            if bytes.len() > 8192 {
                                return None;
                            }
                        };
                        let header = std::str::from_utf8(&bytes[..header_end]).ok()?;
                        if !header.starts_with("POST /tools HTTP/1.1\r\n") {
                            return None;
                        }
                        let length: usize = header.lines().find_map(|line| {
                            line.split_once(':')
                                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                                .and_then(|(_, v)| v.trim().parse().ok())
                        })?;
                        if length > 90_000 {
                            return None;
                        }
                        while bytes.len() < header_end + length {
                            let mut buf = [0; 4096];
                            let count = socket.read(&mut buf).await.ok()?;
                            if count == 0 {
                                return None;
                            }
                            bytes.extend_from_slice(&buf[..count]);
                        }
                        serde_json::from_slice::<Value>(&bytes[header_end..header_end + length])
                            .ok()
                    };
                    let request = tokio::time::timeout(Duration::from_secs(5), read)
                        .await
                        .ok()
                        .flatten();
                    let response = match request {
                        Some(request) => dispatch(&app, request).await,
                        None => json!({"error":"Invalid request"}),
                    };
                    let body = response.to_string();
                    let _ = socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await;
                });
            }
        });
    }
    let token = uuid::Uuid::new_v4().to_string();
    {
        let mut tokens = state.tokens.lock().unwrap();
        tokens.retain(|_, id| id != task_id);
        tokens.insert(token.clone(), task_id.to_owned());
    }
    Ok(
        json!({"command":std::env::current_exe().map_err(|e|e.to_string())?,"args":["--agent-tools"],"env":{"APLOT_AGENT_TOOLS_URL":format!("http://127.0.0.1:{}/tools",port.unwrap()),"APLOT_AGENT_TOOLS_TOKEN":token}}),
    )
}

async fn dispatch(app: &AppHandle, request: Value) -> Value {
    let state = app.state::<AgentTools>();
    let task = state
        .tokens
        .lock()
        .unwrap()
        .get(request["token"].as_str().unwrap_or(""))
        .cloned();
    let Some(task) = task else {
        return json!({"error":"Expired app-tool session"});
    };
    let name = request["name"].as_str().unwrap_or("");
    if !tools()
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["name"] == name)
    {
        return json!({"error":"Unknown tool"});
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut pending = state.pending.lock().unwrap();
        if pending.len() >= 64 {
            return json!({"error":"Too many pending app tool calls"});
        }
        pending.insert(id.clone(), sender);
    }
    let _ = app.emit(
        "agent-tools://request",
        json!({"requestId":id,"taskId":task,"name":name,"arguments":request["arguments"]}),
    );
    let result = tokio::time::timeout(Duration::from_secs(240), receiver).await;
    state.pending.lock().unwrap().remove(&id);
    let _ = app.emit("agent-tools://cancel", json!({"requestId":id}));
    match result {
        Ok(Ok(value)) => value,
        _ => json!({"error":"App tool timed out; no approval was received"}),
    }
}

#[tauri::command]
pub fn agent_tool_reply(
    state: State<'_, AgentTools>,
    request_id: String,
    result: Value,
) -> Result<(), String> {
    let sender = state
        .pending
        .lock()
        .unwrap()
        .remove(&request_id)
        .ok_or("App tool request expired")?;
    sender
        .send(result)
        .map_err(|_| "App tool request expired".to_owned())
}

/// Run before Tauri/single-instance startup so MCP proxies never open app windows.
pub fn stdio_cli() -> Option<i32> {
    if std::env::args().nth(1).as_deref() != Some("--agent-tools") {
        return None;
    }
    Some(if run_stdio().is_ok() { 0 } else { 1 })
}
fn run_stdio() -> Result<(), Box<dyn std::error::Error>> {
    use std::io::{BufRead, Read, Write};
    let url = std::env::var("APLOT_AGENT_TOOLS_URL")?;
    let parsed = reqwest::Url::parse(&url)?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.path() != "/tools"
    {
        return Err("Invalid broker address".into());
    }
    let token = std::env::var("APLOT_AGENT_TOOLS_TOKEN")?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(245))
        .build()?;
    let mut stdout = std::io::stdout().lock();
    let mut input = std::io::stdin().lock();
    loop {
        let mut line = String::new();
        if input.by_ref().take(100_001).read_line(&mut line)? == 0 {
            break;
        }
        if line.len() > 100_000 {
            return Err("Request too large".into());
        }
        let value: Value = serde_json::from_str(&line)?;
        let Some(id) = value.get("id") else {
            continue;
        };
        let result = match value["method"].as_str().unwrap_or("") {
            "initialize" => {
                json!({"protocolVersion":value["params"]["protocolVersion"].as_str().unwrap_or("2024-11-05"),"capabilities":{"tools":{}},"serverInfo":{"name":"aplot-agents","version":"1.0.0"}})
            }
            "ping" => json!({}),
            "tools/list" => json!({"tools":tools()}),
            "tools/call" => {
                let response = runtime.block_on(async { client.post(&url).json(&json!({"token":token,"name":value["params"]["name"],"arguments":value["params"]["arguments"]})).send().await?.json::<Value>().await })
                    .unwrap_or_else(|_|json!({"error":"Aplot workspace unavailable"}));
                json!({"content":[{"type":"text","text":response.to_string()}],"isError":response.get("error").is_some()})
            }
            _ => {
                writeln!(
                    stdout,
                    "{}",
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}})
                )?;
                stdout.flush()?;
                continue;
            }
        };
        writeln!(
            stdout,
            "{}",
            json!({"jsonrpc":"2.0","id":id,"result":result})
        )?;
        stdout.flush()?;
    }
    Ok(())
}
