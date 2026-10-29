//! Owned background Hermes conversations. The UI never receives connection credentials.
use crate::runs::{self, RunManager};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, process::Stdio, sync::Arc, time::Duration};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::ChildStdin,
    sync::{oneshot, Mutex, Notify},
};

#[derive(Default)]
pub struct HermesAgents(Mutex<HashMap<String, Arc<Worker>>>);
/// Each bridge process gets a new generation; host approvals are bound to it.
static NEXT_PROCESS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
/// Where a bridge's frames go: the window that started it, or the host task owner.
pub(crate) enum Sink {
    Window(Channel<Value>),
    Host(AppHandle),
}
impl Sink {
    async fn send(&self, id: &str, process: u64, frame: Value) {
        match self {
            Self::Window(channel) => {
                let _ = channel.send(frame);
            }
            Self::Host(app) => crate::tasks::hermes::route(app, id, process, &frame).await,
        }
    }
}
struct Worker {
    run_id: String,
    generation: u64,
    process: u64,
    stdin: Mutex<ChildStdin>,
    sid: Mutex<Option<String>>,
    pending: Mutex<HashMap<String, String>>,
    replies: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    offered: Mutex<HashMap<String, Vec<String>>>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    busy: Mutex<bool>,
    finished: Notify,
}
impl Worker {
    async fn rpc(&self, method: &str, mut params: Value) -> Result<Value, String> {
        let sid = self.sid.lock().await.clone().ok_or("closed")?;
        if method != "voice.toggle" {
            params["session_id"] = json!(sid);
        }
        let id = format!("aplot-rpc-{}", uuid::Uuid::new_v4());
        let (send, receive) = oneshot::channel();
        self.replies.lock().await.insert(id.clone(), send);
        if self
            .write(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await
            .is_err()
        {
            self.replies.lock().await.remove(&id);
            return Err("closed".into());
        }
        let result = tokio::time::timeout(Duration::from_secs(40), receive).await;
        self.replies.lock().await.remove(&id);
        result
            .map_err(|_| "rpc-timeout".to_owned())?
            .map_err(|_| "closed".to_owned())?
    }
    async fn write(&self, frame: Value) -> Result<(), String> {
        self.stdin
            .lock()
            .await
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .map_err(|_| "closed".into())
    }
}
impl HermesAgents {
    pub async fn shutdown(&self) {
        let workers: Vec<_> = self.0.lock().await.drain().map(|(_, w)| w).collect();
        for worker in &workers {
            if let Some(stop) = worker.stop.lock().await.take() {
                let _ = stop.send(());
            }
        }
        for worker in workers {
            let _ = tokio::time::timeout(Duration::from_secs(7), worker.finished.notified()).await;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentStart {
    pub(crate) id: String,
    pub(crate) run_id: String,
    pub(crate) generation: u64,
    pub(crate) cwd: String,
    pub(crate) skills: Option<String>,
    pub(crate) language: String,
    #[serde(default)]
    pub(crate) context: String,
    #[serde(default)]
    pub(crate) home_id: Option<String>,
    #[serde(default)]
    pub(crate) access_mode: String,
    #[serde(default)]
    pub(crate) reasoning: Option<String>,
}
/// Window sessions use a UUID; host task sessions use `host:<task UUID>`.
fn valid_id(id: &str) -> bool {
    let uuid = id.strip_prefix("host:").unwrap_or(id);
    uuid::Uuid::parse_str(uuid).is_ok_and(|u| u.to_string() == uuid)
}

fn directory(path: &str) -> Result<String, String> {
    let path = std::path::Path::new(path);
    if !path.is_absolute() || !path.is_dir() {
        return Err("folder".into());
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| "folder")?;
    Ok(crate::agent_workspace::display_path(&canonical))
}
fn redact(value: &mut Value, secret: &str) {
    match value {
        Value::String(s) if !secret.is_empty() => *s = s.replace(secret, "[redacted]"),
        Value::Array(items) => {
            for item in items {
                redact(item, secret);
            }
        }
        Value::Object(items) => {
            for (key, item) in items {
                if ["id", "tool_id", "request_id", "session_id", "qid"].contains(&key.as_str()) {
                    continue;
                }
                if ["api_key", "apikey", "authorization", "password", "secret"]
                    .contains(&key.to_lowercase().as_str())
                {
                    *item = json!("[redacted]");
                } else {
                    redact(item, secret);
                }
            }
        }
        _ => {}
    }
}

#[tauri::command]
pub async fn hermes_agent_start(
    app: AppHandle,
    request: AgentStart,
    on_event: Channel<Value>,
) -> Result<(), String> {
    if request.id.starts_with("host:") {
        return Err("limit".into());
    }
    start(app, request, Sink::Window(on_event))
        .await
        .map(|_| ())
}
/// Starts a bridge and waits for its session. Returns the process generation.
pub(crate) async fn start(app: AppHandle, request: AgentStart, sink: Sink) -> Result<u64, String> {
    let manager = app.state::<RunManager>();
    let agents = app.state::<HermesAgents>();
    if !valid_id(&request.id) {
        return Err("limit".into());
    }
    let cwd = directory(&request.cwd)?;
    if request.context.len() > 64_000 {
        return Err("limit".into());
    }
    let skills = request
        .skills
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(directory)
        .transpose()?;
    let (root, python) = super::hermes::agent_runtime().ok_or("not-installed")?;
    if !runs::chat_generation_current(&manager, &request.run_id, request.generation).await {
        return Err("changed".into());
    }
    let target = runs::run_connection(manager.clone(), request.run_id.clone())
        .await
        .map_err(|_| "unavailable")?;
    if target.context_tokens < 64_000 {
        return Err("context".into());
    }
    let home = app
        .path()
        .app_data_dir()
        .map_err(|_| "runtime-failed")?
        .join("hermes-conversations")
        .join(
            request
                .home_id
                .as_deref()
                .filter(|s| uuid::Uuid::parse_str(s).is_ok())
                .unwrap_or(request.id.trim_start_matches("host:")),
        );
    if !["", "manual", "full", "restricted"].contains(&request.access_mode.as_str()) {
        return Err("limit".into());
    }
    let instruction = if request.language == "ru" {
        "Отвечай по-русски, если пользователь не попросил иной язык. Код и команды сохраняй в исходном виде."
    } else {
        "Respond in English unless the user requests another language."
    };
    let instruction = format!("{}\nThe user explicitly selected this working folder: {}. Resolve relative file paths from that folder. This is a starting directory, not a security sandbox.{}", instruction, cwd, request.context);
    let bootstrap = json!({"home":home,"cwd":cwd,"skills":skills,"target":target,"instruction":instruction,"accessMode":request.access_mode,"reasoning":request.reasoning.as_deref().filter(|r|["none","low","medium","high"].contains(r))});
    let mut map = agents.0.lock().await;
    if map.len() >= 4 || map.contains_key(&request.id) {
        return Err("limit".into());
    }
    let mut cmd = tokio::process::Command::new(python);
    cmd.args([
        "-X",
        "utf8",
        "-c",
        include_str!("hermes_agent_bootstrap.py"),
    ])
    .current_dir(root)
    .env("HERMES_HOME", &home)
    .env("PYTHONIOENCODING", "utf-8")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let mut child = cmd.spawn().map_err(|_| "runtime-failed")?;
    let mut stdin = child.stdin.take().ok_or("runtime-failed")?;
    stdin
        .write_all(format!("{bootstrap}\n").as_bytes())
        .await
        .map_err(|_| "runtime-failed")?;
    let stdout = child.stdout.take().ok_or("runtime-failed")?;
    let (stop, mut stopped) = oneshot::channel();
    let process = NEXT_PROCESS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let worker = Arc::new(Worker {
        run_id: request.run_id.clone(),
        generation: request.generation,
        process,
        stdin: Mutex::new(stdin),
        sid: Mutex::new(None),
        pending: Mutex::new(HashMap::new()),
        replies: Mutex::new(HashMap::new()),
        offered: Mutex::new(HashMap::new()),
        stop: Mutex::new(Some(stop)),
        busy: Mutex::new(false),
        finished: Notify::new(),
    });
    map.insert(request.id.clone(), worker.clone());
    drop(map);
    let (ready, wait_ready) = oneshot::channel::<Result<(), String>>();
    let id = request.id.clone();
    let start_worker = worker.clone();
    tauri::async_runtime::spawn(async move {
        let mut ready = Some(ready);
        let mut reader = BufReader::new(stdout).lines();
        let mut timer = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                _ = timer.tick() => {
                    if !runs::chat_generation_current(&app.state::<RunManager>(), &request.run_id, request.generation).await {
                        sink.send(&id, process, json!({"kind":"error","code":"changed"})).await; break;
                    }
                }
                line = reader.next_line() => {
                    let Ok(Some(line)) = line else { break; };
                    if line.len() > 4_000_000 { break; }
                    let Ok(frame) = serde_json::from_str::<Value>(&line) else { continue; };
                    if let Some(rid) = frame["id"].as_str().filter(|id| id.starts_with("aplot-rpc-")) {
                        if let Some(reply) = worker.replies.lock().await.remove(rid) {
                            let result = if frame["error"].is_null() { Ok(frame["result"].clone()) } else { Err(format!("Hermes RPC: {}", frame["error"]["message"].as_str().unwrap_or("request failed"))) };
                            let _ = reply.send(result);
                        }
                        continue;
                    }
                    // Never redact protocol identifiers/methods before routing; short keys can occur inside them.
                    let mut public_params = frame["params"].clone();
                    redact(&mut public_params, &target.api_key);
                    if frame["aplot_error"].is_string() { break; }
                    let event = frame["params"]["type"].as_str().unwrap_or("").to_owned();
                    if event == "gateway.ready" {
                        let _ = worker.write(json!({"jsonrpc":"2.0","id":"aplot-cap","method":"client.capabilities","params":{"server_requests":true}})).await;
                        let _ = worker.write(json!({"jsonrpc":"2.0","id":"aplot-create","method":"session.create","params":{"cwd":cwd,"model":target.model_id,"provider":"custom:aplot","source":"cli","title":"Aplot Hermes"}})).await;
                    } else if frame["id"] == "aplot-create" {
                        if let Some(sid) = frame["result"]["session_id"].as_str() {
                            *worker.sid.lock().await = Some(sid.to_owned());
                            sink.send(&id, process, json!({"kind":"event","type":"session.created","payload":{"sessionId":frame["result"]["stored_session_id"],"modelId":target.model_id,"contextTokens":target.context_tokens}})).await;
                            if let Some(ready) = ready.take() { let _ = ready.send(Ok(())); }
                        } else { break; }
                    } else if frame["method"] == "event" {
                        if event == "request.cancel" { if let Some(rid) = frame["params"]["payload"]["id"].as_str() { worker.pending.lock().await.remove(rid); } }
                        if event == "message.complete" || event == "error" { *worker.busy.lock().await = false; worker.pending.lock().await.clear(); }
                        if ["message.start","message.delta","message.interim","message.complete","reasoning.delta","reasoning.available","thinking.delta","tool.start","tool.complete","status.update","session.usage","voice.status","voice.transcript","error","request.cancel"].contains(&event.as_str()) {
                            sink.send(&id, process, json!({"kind":"event","type":event,"payload":public_params["payload"]})).await;
                        }
                    } else if let (Some(method), Some(rid)) = (frame["method"].as_str(), frame["id"].as_str()) {
                        if ["approval","clarify"].contains(&method) {
                            worker.pending.lock().await.insert(rid.to_owned(), method.to_owned());
                            if method == "approval" {
                                let choices = frame["params"]["choices"].as_array().map(|items| items.iter().filter_map(Value::as_str).filter(|choice| !(*choice=="always"&&frame["params"]["allow_permanent"]==false)&&!(*choice=="session"&&frame["params"]["allow_session"]==false)).map(str::to_owned).collect()).unwrap_or_else(|| vec!["once".into(), "deny".into()]);
                                worker.offered.lock().await.insert(rid.to_owned(), choices);
                            }
                            sink.send(&id, process, json!({"kind":"request","id":rid,"method":method,"params":public_params})).await;
                        } else { let _ = worker.write(json!({"jsonrpc":"2.0","id":rid,"error":{"code":-32601,"message":"Not supported by Aplot"}})).await; }
                    } else if !frame["error"].is_null() && frame["id"] != "aplot-cap" {
                        *worker.busy.lock().await = false;
                        sink.send(&id, process, json!({"kind":"error","code":"agent-error"})).await;
                    }
                }
            }
        }
        if let Some(ready) = ready.take() {
            let _ = ready.send(Err("runtime-failed".into()));
        }
        // Only this owned process tree; never touch an external Hermes Desktop/runtime.
        #[cfg(windows)]
        if let Some(pid) = child.id() {
            let mut kill = tokio::process::Command::new("taskkill.exe");
            kill.args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let _ = tokio::time::timeout(Duration::from_secs(5), kill.status()).await;
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
        app.state::<HermesAgents>().0.lock().await.remove(&id);
        worker.replies.lock().await.clear();
        sink.send(&id, process, json!({"kind":"closed"})).await;
        worker.finished.notify_one();
    });
    match tokio::time::timeout(Duration::from_secs(45), wait_ready).await {
        Ok(Ok(result)) => result.map(|_| process),
        _ => {
            if let Some(stop) = start_worker.stop.lock().await.take() {
                let _ = stop.send(());
            }
            Err("runtime-failed".into())
        }
    }
}

async fn get(agents: &HermesAgents, id: &str) -> Result<Arc<Worker>, String> {
    agents
        .0
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or("closed".into())
}
#[tauri::command]
pub async fn hermes_agent_context(
    agents: State<'_, HermesAgents>,
    id: String,
) -> Result<Value, String> {
    get(&agents, &id)
        .await?
        .rpc("session.context_breakdown", json!({}))
        .await
}
#[tauri::command]
pub async fn hermes_agent_access(
    agents: State<'_, HermesAgents>,
    id: String,
    mode: String,
) -> Result<(), String> {
    if !["manual", "full"].contains(&mode.as_str()) {
        return Err("new-session-required".into());
    }
    let worker = get(&agents, &id).await?;
    worker
        .rpc(
            "config.set",
            json!({"key":"approvals.mode","value":if mode=="full" {"off"} else {"manual"}}),
        )
        .await?;
    Ok(())
}
#[tauri::command]
pub async fn hermes_agent_voice(
    agents: State<'_, HermesAgents>,
    id: String,
    action: String,
) -> Result<Value, String> {
    let worker = get(&agents, &id).await?;
    match action.as_str() {
        "status" => worker.rpc("voice.toggle", json!({"action":"status"})).await,
        "start" => {
            let status = worker
                .rpc("voice.toggle", json!({"action":"status"}))
                .await?;
            if status["available"] != true {
                return Err(format!(
                    "voice-unavailable: {}",
                    status["details"]
                        .as_str()
                        .unwrap_or("audio dependencies unavailable")
                ));
            }
            worker.rpc("voice.toggle", json!({"action":"on"})).await?;
            worker.rpc("voice.record", json!({"action":"start"})).await
        }
        "stop" => worker.rpc("voice.record", json!({"action":"stop"})).await,
        "cancel" => worker.rpc("voice.toggle", json!({"action":"off"})).await,
        "level" => worker.rpc("aplot.voice.level", json!({})).await,
        _ => Err("limit".into()),
    }
}
#[tauri::command]
pub async fn hermes_agent_prompt(
    manager: State<'_, RunManager>,
    agents: State<'_, HermesAgents>,
    id: String,
    text: String,
    attachments: Option<Vec<String>>,
) -> Result<(), String> {
    prompt(&manager, &agents, &id, text, attachments).await
}
pub(crate) async fn prompt(
    manager: &RunManager,
    agents: &HermesAgents,
    id: &str,
    text: String,
    attachments: Option<Vec<String>>,
) -> Result<(), String> {
    let attachments = attachments.unwrap_or_default();
    if (text.trim().is_empty() && attachments.is_empty())
        || text.len() > 100_000
        || attachments.len() > 8
    {
        return Err("limit".into());
    }
    let worker = get(agents, id).await?;
    if !runs::chat_generation_current(manager, &worker.run_id, worker.generation).await {
        return Err("changed".into());
    }
    let sid = worker.sid.lock().await.clone().ok_or("closed")?;
    let mut busy = worker.busy.lock().await;
    if *busy {
        return Err("busy".into());
    }
    *busy = true;
    let mut prompt = text;
    let mut queued_images = Vec::new();
    let prepared = async {
        let paths = crate::agent_media::inspect_paths(attachments)?;
        for attachment in paths {
            let is_image = attachment["kind"] == "image";
            // Track before awaiting: attach can succeed even if the RPC reply times out.
            if is_image {
                if let Some(path) = attachment["path"].as_str() {
                    queued_images.push(path.to_owned());
                }
            }
            let value = worker
                .rpc(
                    if is_image {
                        "image.attach"
                    } else {
                        "file.attach"
                    },
                    json!({"path":attachment["path"]}),
                )
                .await?;
            if value["attached"] != true {
                return Err("attachment-failed".to_owned());
            }
            if is_image {
                if let Some(path) = value["path"].as_str() {
                    queued_images.push(path.to_owned());
                }
            } else if let Some(reference) = value["ref_text"].as_str() {
                prompt.push_str(&format!("\n{reference}"));
            }
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = prepared {
        for path in queued_images {
            let _ = worker.rpc("image.detach", json!({"path":path})).await;
        }
        *busy = false;
        return Err(error);
    }
    let result = worker.write(json!({"jsonrpc":"2.0","id":uuid::Uuid::new_v4().to_string(),"method":"prompt.submit","params":{"session_id":sid,"text":prompt}})).await;
    if result.is_err() {
        for path in queued_images {
            let _ = worker.rpc("image.detach", json!({"path":path})).await;
        }
        *busy = false;
    }
    result
}
#[tauri::command]
pub async fn hermes_agent_respond(
    manager: State<'_, RunManager>,
    agents: State<'_, HermesAgents>,
    id: String,
    request_id: String,
    result: Value,
) -> Result<(), String> {
    respond(&manager, &agents, &id, None, &request_id, result).await
}
/// Answers a request. With `process`, only that exact bridge process may receive it.
pub(crate) async fn respond(
    manager: &RunManager,
    agents: &HermesAgents,
    id: &str,
    process: Option<u64>,
    request_id: &str,
    result: Value,
) -> Result<(), String> {
    let worker = get(agents, id).await?;
    if process.is_some_and(|p| p != worker.process) {
        return Err("stale".into());
    }
    if !runs::chat_generation_current(manager, &worker.run_id, worker.generation).await {
        return Err("changed".into());
    }
    let mut pending = worker.pending.lock().await;
    let method = pending.get(request_id).ok_or("expired")?;
    if !valid_reply(method, &result) {
        return Err("limit".into());
    }
    if method == "approval"
        && !worker
            .offered
            .lock()
            .await
            .get(request_id)
            .is_some_and(|choices| {
                choices
                    .iter()
                    .any(|s| Some(s.as_str()) == result["choice"].as_str())
            })
    {
        return Err("limit".into());
    }
    worker
        .write(json!({"jsonrpc":"2.0","id":request_id,"result":result}))
        .await?;
    pending.remove(request_id);
    worker.offered.lock().await.remove(request_id);
    Ok(())
}
/// The bridge process still waits for this request.
pub(crate) async fn has_request(
    agents: &HermesAgents,
    id: &str,
    process: u64,
    request_id: &str,
) -> bool {
    match get(agents, id).await {
        Ok(worker) if worker.process == process => {
            worker.pending.lock().await.contains_key(request_id)
        }
        _ => false,
    }
}
pub(crate) async fn set_access(agents: &HermesAgents, id: &str, mode: &str) -> Result<(), String> {
    if !["manual", "full"].contains(&mode) {
        return Err("new-session-required".into());
    }
    get(agents, id)
        .await?
        .rpc(
            "config.set",
            json!({"key":"approvals.mode","value":if mode=="full" {"off"} else {"manual"}}),
        )
        .await?;
    Ok(())
}
fn valid_reply(method: &str, result: &Value) -> bool {
    let valid = match method {
        "approval" => result.as_object().is_some_and(|o| {
            o.len() == 1
                && ["once", "session", "always", "deny"]
                    .contains(&o.get("choice").and_then(Value::as_str).unwrap_or(""))
        }),
        "clarify" => result.as_object().is_some_and(|o| {
            o.len() <= 1
                && (o.is_empty()
                    || o.get("answer").is_some_and(Value::is_string)
                    || o.get("answers").is_some_and(|a| {
                        a.as_object()
                            .is_some_and(|a| a.values().all(Value::is_string))
                    }))
        }),
        _ => false,
    };
    valid && result.to_string().len() <= 20_000
}
#[tauri::command]
pub async fn hermes_agent_stop(
    agents: State<'_, HermesAgents>,
    id: String,
    close: bool,
) -> Result<(), String> {
    stop(&agents, &id, close).await
}
pub(crate) async fn stop(agents: &HermesAgents, id: &str, close: bool) -> Result<(), String> {
    let worker = get(agents, id).await?;
    if close {
        if let Some(stop) = worker.stop.lock().await.take() {
            let _ = stop.send(());
        }
    } else if let Some(sid) = worker.sid.lock().await.clone() {
        worker.write(json!({"jsonrpc":"2.0","id":uuid::Uuid::new_v4().to_string(),"method":"session.interrupt","params":{"session_id":sid}})).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_explicit_scoped_approval_choices() {
        assert!(valid_reply("approval", &json!({"choice":"once"})));
        assert!(valid_reply("approval", &json!({"choice":"deny"})));
        assert!(valid_reply("approval", &json!({"choice":"always"})));
        assert!(!valid_reply(
            "approval",
            &json!({"choice":"once","all":true})
        ));
        assert!(!valid_reply("sudo", &json!({"value":"anything"})));
    }
    #[test]
    fn validates_clarifications_and_redacts_the_launch_secret() {
        assert!(valid_reply("clarify", &json!({"answers":{"q1":"Yes"}})));
        assert!(valid_reply("clarify", &json!({})));
        assert!(!valid_reply("clarify", &json!({"answers":{"q1":true}})));
        let mut value = json!({"apiKey":"other", "result":["token fixture-key", {"authorization":"Bearer other"}]});
        redact(&mut value, "fixture-key");
        assert_eq!(value["apiKey"], "[redacted]");
        assert_eq!(value["result"][0], "token [redacted]");
        assert_eq!(value["result"][1]["authorization"], "[redacted]");
        let mut question = json!({"id":"srq-1", "questions":[{"qid":"q1", "question":"Key 1"}]});
        redact(&mut question, "1");
        assert_eq!(question["id"], "srq-1");
        assert_eq!(question["questions"][0]["qid"], "q1");
        assert_eq!(question["questions"][0]["question"], "Key [redacted]");
    }
}
