//! Official Codex account/limits only. No inference, shell, or renderer-supplied tokens.
use crate::connection_profiles::Profile;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
};

static NEXT: AtomicU64 = AtomicU64::new(1);
type Reply = oneshot::Sender<Result<Value, String>>;
struct Attempt {
    id: String,
    deadline: Instant,
}
struct Worker {
    job: crate::owned_job::OwnedJob,
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, Reply>>,
    dead: AtomicBool,
    login: Mutex<Option<Attempt>>,
    completed: Mutex<HashMap<String, bool>>,
    error: Mutex<Option<String>>,
}
#[derive(Default)]
pub struct CodexLimits {
    operation: Mutex<()>,
    workers: Mutex<HashMap<String, Arc<Worker>>>,
}
fn home(app: &AppHandle, p: &Profile, id: &str) -> Result<PathBuf, String> {
    Ok(crate::connection_profiles::home(app, p)?
        .join("codex-limits")
        .join(format!("{:x}", Sha256::digest(id.as_bytes()))))
}
fn account_matches(account: &Value, email: Option<&str>) -> bool {
    account["type"] == "chatgpt"
        && email
            .filter(|s| !s.trim().is_empty())
            .zip(account["email"].as_str())
            .is_some_and(|(a, b)| a.trim().eq_ignore_ascii_case(b.trim()))
}
fn auth_url(value: &Value) -> Result<String, String> {
    let raw = value["authUrl"].as_str().ok_or("codex-auth")?;
    let u = reqwest::Url::parse(raw).map_err(|_| "codex-auth")?;
    if u.scheme() != "https"
        || ![Some("auth.openai.com"), Some("chatgpt.com")].contains(&u.host_str())
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some_and(|p| p != 443)
    {
        return Err("codex-auth".into());
    }
    Ok(raw.into())
}
fn changed(app: &AppHandle, id: &str, reason: &str) {
    let _ = app.emit(
        "codex-limits://changed",
        json!({"connectionId":id,"reason":reason}),
    );
}
impl Worker {
    async fn write(&self, v: Value) -> Result<(), String> {
        if self.dead.load(Ordering::Acquire) {
            return Err("closed".into());
        }
        let mut bytes = serde_json::to_vec(&v).map_err(|_| "protocol")?;
        bytes.push(b'\n');
        self.input
            .lock()
            .await
            .write_all(&bytes)
            .await
            .map_err(|_| "closed".into())
    }
    async fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let (send, receive) = oneshot::channel();
        self.pending.lock().await.insert(id, send);
        if let Err(e) = self
            .write(json!({"id":id,"method":method,"params":params}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        let result = tokio::time::timeout(Duration::from_secs(40), receive).await;
        self.pending.lock().await.remove(&id);
        result.map_err(|_| "timeout")?.map_err(|_| "closed")?
    }
    async fn close(&self) {
        self.dead.store(true, Ordering::Release);
        self.job.terminate();
        let _ = self.child.lock().await.kill().await;
        for (_, send) in self.pending.lock().await.drain() {
            let _ = send.send(Err("closed".into()));
        }
    }
}
impl CodexLimits {
    async fn ensure(&self, app: &AppHandle, p: &Profile, id: &str) -> Result<Arc<Worker>, String> {
        let mut workers = self.workers.lock().await;
        if let Some(w) = workers.get(id).filter(|w| !w.dead.load(Ordering::Acquire)) {
            return Ok(w.clone());
        }
        let root = home(app, p, id)?;
        std::fs::create_dir_all(&root).map_err(|_| "storage")?;
        let mut command = Command::new(crate::codex_agent::configured(app)?);
        command
            .args([
                "app-server",
                "--listen",
                "stdio://",
                "-c",
                "analytics.enabled=false",
                "-c",
                "cli_auth_credentials_store=\"keyring\"",
                "-c",
                "model_provider=\"openai\"",
            ])
            .current_dir(&root)
            .env("CODEX_HOME", &root)
            .env_remove("OPENAI_API_KEY")
            .env_remove("OPENAI_BASE_URL")
            .env_remove("CODEX_API_KEY")
            .env_remove("CODEX_ACCESS_TOKEN")
            .env_remove("APLOT_OPENAI_ACCESS_TOKEN")
            .env_remove("CODEX_SQLITE_HOME")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|_| "not-installed")?;
        let job = match crate::owned_job::OwnedJob::assign(&child) {
            Ok(j) => j,
            Err(e) => {
                let _ = child.kill().await;
                return Err(e);
            }
        };
        let input = child.stdin.take().ok_or("closed")?;
        let output = child.stdout.take().ok_or("closed")?;
        let worker = Arc::new(Worker {
            job,
            child: Mutex::new(child),
            input: Mutex::new(input),
            pending: Mutex::new(HashMap::new()),
            dead: AtomicBool::new(false),
            login: Mutex::new(None),
            completed: Mutex::new(HashMap::new()),
            error: Mutex::new(None),
        });
        let reader = worker.clone();
        let events = app.clone();
        let connection = id.to_owned();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(output).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.len() > 4_000_000 {
                    break;
                }
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(method) = v["method"].as_str() {
                    if let Some(request) = v.get("id") {
                        // This broker supports no server-requested tools or credential refresh callbacks.
                        let _=reader.write(json!({"id":request,"error":{"code":-32601,"message":"Unsupported host request"}})).await;
                    } else if method == "account/login/completed" {
                        if let Some(login_id) = v["params"]["loginId"].as_str() {
                            reader
                                .completed
                                .lock()
                                .await
                                .insert(login_id.into(), v["params"]["success"] == true);
                        }
                        changed(&events, &connection, "auth");
                    } else if method == "account/updated" {
                        changed(&events, &connection, "auth");
                    } else if method == "account/rateLimits/updated" {
                        changed(&events, &connection, "limits");
                    }
                } else if let Some(id) = v["id"].as_u64() {
                    if let Some(send) = reader.pending.lock().await.remove(&id) {
                        // Do not send raw native auth errors (or OAuth data) to the renderer/logs.
                        let result = if v.get("error").is_some() {
                            Err("codex-service".into())
                        } else {
                            Ok(v["result"].clone())
                        };
                        let _ = send.send(result);
                    }
                }
            }
            reader.dead.store(true, Ordering::Release);
            for (_, send) in reader.pending.lock().await.drain() {
                let _ = send.send(Err("closed".into()));
            }
            changed(&events, &connection, "closed");
        });
        if let Err(e)=worker.rpc("initialize",json!({"clientInfo":{"name":"aplot_limits","title":"Aplot Control LLM","version":env!("CARGO_PKG_VERSION")}})).await{worker.close().await;return Err(e)}
        if let Err(e) = worker.write(json!({"method":"initialized"})).await {
            worker.close().await;
            return Err(e);
        }
        workers.insert(id.into(), worker.clone());
        Ok(worker)
    }
    async fn status(
        &self,
        app: &AppHandle,
        p: &Profile,
        id: &str,
        w: &Worker,
    ) -> Result<Value, String> {
        let mut just_connected = false;
        let mut login = w.login.lock().await;
        if let Some(attempt) = login.as_ref() {
            let completed = w.completed.lock().await.remove(&attempt.id);
            if completed == Some(false) || Instant::now() >= attempt.deadline {
                let _ = w
                    .rpc("account/login/cancel", json!({"loginId":attempt.id}))
                    .await;
                let _ = w.rpc("account/logout", json!({})).await;
                *w.error.lock().await = Some(
                    if completed == Some(false) {
                        "login-denied"
                    } else {
                        "login-timeout"
                    }
                    .into(),
                );
                login.take();
            } else if completed.is_none() {
                return Ok(json!({"connected":false,"pending":true}));
            } else {
                login.take();
                just_connected = true;
            }
        }
        drop(login);
        let account =
            w.rpc("account/read", json!({"refreshToken":false})).await?["account"].clone();
        if account.is_null() {
            return Ok(
                json!({"connected":false,"pending":false,"error":w.error.lock().await.clone()}),
            );
        }
        if !account_matches(&account, p.email.as_deref()) {
            w.rpc("account/logout", json!({})).await?;
            *w.error.lock().await = Some("account-mismatch".into());
            return Ok(json!({"connected":false,"pending":false,"error":"account-mismatch"}));
        }
        // Recheck profile ownership after the asynchronous account RPC.
        let current = crate::connection_profiles::for_connection(app, "openai", Some(id))?;
        if current.id != p.id || !account_matches(&account, current.email.as_deref()) {
            return Err("changed".into());
        }
        *w.error.lock().await = None;
        if just_connected {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        Ok(
            json!({"connected":true,"pending":false,"email":account["email"],"planType":account["planType"]}),
        )
    }
    pub async fn shutdown(&self) {
        let _op = self.operation.lock().await;
        let workers = std::mem::take(&mut *self.workers.lock().await);
        for w in workers.into_values() {
            w.close().await;
        }
    }
    pub async fn close_profile(
        &self,
        app: &AppHandle,
        p: &Profile,
        id: &str,
        disconnect: bool,
    ) -> Result<(), String> {
        let _op = self.operation.lock().await;
        if disconnect && home(app, p, id)?.exists() {
            let w = self.ensure(app, p, id).await?;
            if let Some(attempt) = w.login.lock().await.take() {
                let _ = w
                    .rpc("account/login/cancel", json!({"loginId":attempt.id}))
                    .await;
            }
            w.rpc("account/logout", json!({})).await?;
        }
        if let Some(w) = self.workers.lock().await.remove(id) {
            w.close().await;
        }
        Ok(())
    }
}
#[tauri::command]
pub async fn codex_limits(
    app: AppHandle,
    state: State<'_, CodexLimits>,
    action: String,
    connection_id: String,
) -> Result<Value, String> {
    if !["status", "read", "login", "cancel", "logout"].contains(&action.as_str()) {
        return Err("unsupported-method".into());
    }
    let _op = state.operation.lock().await;
    let p = crate::connection_profiles::for_connection(&app, "openai", Some(&connection_id))?;
    let root = home(&app, &p, &connection_id)?;
    if !root.exists() && action != "login" {
        return if action == "read" {
            Err("codex-login-required".into())
        } else {
            Ok(json!({"connected":false,"pending":false}))
        };
    }
    let w = state.ensure(&app, &p, &connection_id).await?;
    match action.as_str() {
        "status" => state.status(&app, &p, &connection_id, &w).await,
        "read" => {
            if state.status(&app, &p, &connection_id, &w).await?["connected"] != true {
                return Err("codex-login-required".into());
            }
            let limits = w.rpc("account/rateLimits/read", json!({})).await?;
            // Disabling/signing out while the service responds invalidates this result.
            crate::connection_profiles::for_connection(&app, "openai", Some(&connection_id))?;
            Ok(limits)
        }
        "login" => {
            for other in state.workers.lock().await.values() {
                if let Some(a) = other.login.lock().await.as_ref() {
                    if Instant::now() < a.deadline {
                        return Err("login-busy".into());
                    }
                }
            }
            *w.error.lock().await = None;
            let result = w
                .rpc("account/login/start", json!({"type":"chatgpt"}))
                .await?;
            let login_id = result["loginId"].as_str().ok_or("codex-auth")?.to_owned();
            *w.login.lock().await = Some(Attempt {
                id: login_id.clone(),
                deadline: Instant::now() + Duration::from_secs(600),
            });
            match auth_url(&result) {
                Ok(url) => {
                    changed(&app, &connection_id, "auth");
                    Ok(json!({"authUrl":url}))
                }
                Err(e) => {
                    let _ = w
                        .rpc("account/login/cancel", json!({"loginId":login_id}))
                        .await;
                    w.login.lock().await.take();
                    Err(e)
                }
            }
        }
        "cancel" | "logout" => {
            if let Some(a) = w.login.lock().await.take() {
                let _ = w.rpc("account/login/cancel", json!({"loginId":a.id})).await;
            }
            w.rpc("account/logout", json!({})).await?;
            *w.error.lock().await = None;
            changed(&app, &connection_id, "auth");
            Ok(json!({"connected":false,"pending":false}))
        }
        _ => unreachable!(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verifies_account_type_and_email_before_limits() {
        assert!(account_matches(
            &json!({"type":"chatgpt","email":"Person@Example.com"}),
            Some("person@example.com")
        ));
        assert!(!account_matches(
            &json!({"type":"chatgpt","email":"other@example.com"}),
            Some("person@example.com")
        ));
        assert!(!account_matches(
            &json!({"type":"apiKey","email":"person@example.com"}),
            Some("person@example.com")
        ));
        assert!(!account_matches(
            &json!({"type":"chatgpt"}),
            Some("person@example.com")
        ));
        assert!(!account_matches(
            &json!({"type":"chatgpt","email":"person@example.com"}),
            None
        ));
    }
    #[test]
    fn accepts_only_official_browser_auth_urls() {
        for url in [
            "https://auth.openai.com/oauth/authorize?state=example",
            "https://chatgpt.com/auth/login",
        ] {
            assert!(auth_url(&json!({"authUrl":url})).is_ok())
        }
        for url in [
            "http://auth.openai.com/",
            "https://auth.openai.com.evil.test/",
            "https://evil.test/",
            "https://user@auth.openai.com/",
            "https://auth.openai.com:123/",
        ] {
            assert!(auth_url(&json!({"authUrl":url})).is_err())
        }
    }
}
