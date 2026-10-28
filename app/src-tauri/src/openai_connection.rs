//! Public-client ChatGPT plan OAuth. Secrets never cross the renderer boundary.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, time::Duration};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{oneshot, Mutex},
};

const AUTH: &str = "https://auth.openai.com";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

#[derive(Default)]
pub struct OpenAiConnection {
    operation: Mutex<()>,
    pending: Mutex<Option<String>>,
    requests: Mutex<HashMap<String, (String, oneshot::Sender<()>)>>,
    pending_profile: Mutex<Option<String>>,
    error: Mutex<HashMap<String, String>>,
}
#[derive(Serialize, Deserialize)]
struct Credentials {
    client_id: String,
    subject: String,
    email: Option<String>,
    access_token: String,
    refresh_token: String,
    id_token: String,
    expires_at: i64,
    scope: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    connected: bool,
    email: Option<String>,
    connection_id: Option<String>,
    pending: bool,
    error: Option<String>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| "network".into())
}
fn load(
    app: &AppHandle,
    profile: &crate::connection_profiles::Profile,
) -> Result<Option<Credentials>, String> {
    let path = crate::connection_profiles::home(app, profile)?.join("chatgpt.dpapi");
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|_| "storage")?;
    let text = crate::domain::secrets::unseal_connection_secret(&bytes)?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|_| "credentials".into())
}
fn save(
    app: &AppHandle,
    profile: &crate::connection_profiles::Profile,
    value: &Credentials,
) -> Result<(), String> {
    let bytes = crate::domain::secrets::seal_recovery_secret(
        &serde_json::to_string(value).map_err(|_| "credentials")?,
    )?;
    crate::connection_profiles::atomic_write(
        &crate::connection_profiles::home(app, profile)?.join("chatgpt.dpapi"),
        &bytes,
    )?;
    crate::connection_profiles::remember(
        app,
        &profile.id,
        Some(crate::connection_profiles::key(
            profile,
            &connection_key(value),
        )),
        value.email.clone(),
    )
}
fn permitted(scope: &str) -> bool {
    let s: Vec<_> = scope.split_whitespace().collect();
    ["resource.invoke", "chatgpt.tokens.use.direct"]
        .iter()
        .all(|v| s.contains(v))
}
fn valid_identity(claims: &Value, nonce: Option<&str>) -> bool {
    claims["sub"].as_str().is_some_and(|s| !s.is_empty())
        && nonce.is_none_or(|value| claims["nonce"].as_str() == Some(value))
}
async fn discovery() -> Result<Value, String> {
    let v: Value = client()?
        .get(format!("{AUTH}/.well-known/openid-configuration"))
        .send()
        .await
        .map_err(|_| "network")?
        .error_for_status()
        .map_err(|_| "auth")?
        .json()
        .await
        .map_err(|_| "auth")?;
    if v["issuer"] != AUTH {
        return Err("issuer".into());
    }
    Ok(v)
}
async fn verify(token: &str, client_id: &str, nonce: Option<&str>) -> Result<Value, String> {
    let config = discovery().await?;
    let uri = config["jwks_uri"].as_str().ok_or("jwks")?;
    let url = reqwest::Url::parse(uri).map_err(|_| "jwks")?;
    if url.scheme() != "https" || url.host_str() != Some("auth.openai.com") {
        return Err("jwks".into());
    }
    let keys: JwkSet = client()?
        .get(url)
        .send()
        .await
        .map_err(|_| "network")?
        .error_for_status()
        .map_err(|_| "jwks")?
        .json()
        .await
        .map_err(|_| "jwks")?;
    let header = decode_header(token).map_err(|_| "identity")?;
    if header.alg != jsonwebtoken::Algorithm::RS256 {
        return Err("identity".into());
    }
    let key = keys
        .find(header.kid.as_deref().ok_or("identity")?)
        .ok_or("identity")?;
    let mut validation = Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&[client_id]);
    validation.set_issuer(&[AUTH]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    let claims = decode::<Value>(
        token,
        &DecodingKey::from_jwk(key).map_err(|_| "identity")?,
        &validation,
    )
    .map_err(|_| "identity")?
    .claims;
    if !valid_identity(&claims, nonce) {
        return Err("identity".into());
    }
    Ok(claims)
}
async fn token_form(form: &[(&str, &str)]) -> Result<Value, String> {
    let response = client()?
        .post(format!("{AUTH}/api/accounts/oauth/token"))
        .form(form)
        .send()
        .await
        .map_err(|_| "network")?;
    if !response.status().is_success() {
        return Err("auth".into());
    }
    response.json().await.map_err(|_| "auth".into())
}
fn credentials(
    value: &Value,
    client_id: String,
    identity: &Value,
    previous: Option<&Credentials>,
) -> Result<Credentials, String> {
    let scope = value["scope"]
        .as_str()
        .or(previous.map(|c| c.scope.as_str()))
        .ok_or("scope")?
        .to_string();
    if !permitted(&scope)
        || value["token_type"]
            .as_str()
            .is_some_and(|s| !s.eq_ignore_ascii_case("Bearer"))
    {
        return Err("plan-permission".into());
    }
    Ok(Credentials {
        client_id,
        subject: identity["sub"].as_str().ok_or("identity")?.into(),
        email: identity["email"].as_str().map(String::from),
        access_token: value["access_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("auth")?
            .into(),
        refresh_token: value["refresh_token"]
            .as_str()
            .or(previous.map(|c| c.refresh_token.as_str()))
            .unwrap_or("")
            .into(),
        id_token: value["id_token"]
            .as_str()
            .or(previous.map(|c| c.id_token.as_str()))
            .unwrap_or("")
            .into(),
        expires_at: chrono::Utc::now().timestamp()
            + value["expires_in"]
                .as_i64()
                .filter(|v| *v > 0)
                .ok_or("expiry")?,
        scope,
    })
}
pub(crate) struct PlanSession {
    pub token: String,
    pub connection_id: String,
}
fn connection_key(c: &Credentials) -> String {
    format!(
        "openai:{:x}",
        Sha256::digest(format!("{}:{}", c.client_id, c.subject))
    )
}
pub async fn access_token(app: &AppHandle, expected: &str) -> Result<String, String> {
    Ok(plan_session(app, Some(expected)).await?.token)
}
pub(crate) async fn plan_session(
    app: &AppHandle,
    expected: Option<&str>,
) -> Result<PlanSession, String> {
    let state = app.state::<OpenAiConnection>();
    let _lock = state.operation.lock().await;
    let profile = crate::connection_profiles::for_connection(app, "openai", expected)?;
    let mut c = load(app, &profile)?.ok_or("auth")?;
    if expected
        .is_some_and(|id| id != crate::connection_profiles::key(&profile, &connection_key(&c)))
    {
        return Err("changed".into());
    }
    if c.expires_at <= chrono::Utc::now().timestamp() + 90 {
        if c.refresh_token.is_empty() {
            return Err("auth".into());
        }
        let value = token_form(&[
            ("grant_type", "refresh_token"),
            ("client_id", &c.client_id),
            ("refresh_token", &c.refresh_token),
            ("resource", RESOURCE),
        ])
        .await?;
        let identity = if let Some(token) = value["id_token"].as_str() {
            verify(token, &c.client_id, None).await?
        } else {
            json!({"sub":c.subject,"email":c.email})
        };
        if identity["sub"] != c.subject {
            return Err("identity".into());
        }
        c = credentials(&value, c.client_id.clone(), &identity, Some(&c))?;
        save(app, &profile, &c)?;
    }
    Ok(PlanSession {
        connection_id: crate::connection_profiles::key(&profile, &connection_key(&c)),
        token: c.access_token,
    })
}
#[tauri::command]
pub async fn openai_status(
    app: AppHandle,
    state: State<'_, OpenAiConnection>,
    profile_id: Option<String>,
) -> Result<ConnectionStatus, String> {
    let profile = crate::connection_profiles::profile(&app, "openai", profile_id.as_deref())?;
    let c = match &profile {
        Some(p) if p.enabled => load(&app, p)?,
        _ => None,
    };
    let connection_id = c
        .as_ref()
        .map(|c| crate::connection_profiles::key(profile.as_ref().unwrap(), &connection_key(c)));
    if let Some(p) = &profile {
        if p.enabled {
            crate::connection_profiles::remember(
                &app,
                &p.id,
                connection_id.clone(),
                c.as_ref().and_then(|c| c.email.clone()),
            )?;
        }
    }
    Ok(ConnectionStatus {
        connected: c.is_some(),
        email: c.as_ref().and_then(|c| c.email.clone()),
        connection_id,
        pending: state.pending.lock().await.is_some()
            && state.pending_profile.lock().await.as_deref()
                == profile.as_ref().map(|p| p.id.as_str()),
        error: match &profile {
            Some(p) => state.error.lock().await.get(&p.id).cloned(),
            None => None,
        },
    })
}
fn return_to_app(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
fn callback_page(success: bool) -> String {
    let (title, text) = if success {
        (
            "Подключение готово",
            "Вы вошли в ChatGPT. Возвращаемся в Aplot Control. Эту вкладку можно закрыть.",
        )
    } else {
        (
            "Вход не завершён",
            "Вернитесь в Aplot Control, чтобы посмотреть состояние подключения и повторить вход.",
        )
    };
    format!(
        r##"<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Aplot Control — {title}</title><style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c1013;color:#eef1f3;font:18px/1.6 system-ui}}main{{max-width:560px;padding:40px;border:1px solid #30383e;border-radius:20px;background:#141a1f}}b{{color:#cdf57d}}h1{{font-size:28px}}p{{color:#b7c1ca}}</style><main><b>Aplot Control</b><h1>{title}</h1><p>{text}</p></main><script>history.replaceState(null,'','/auth/complete')</script></html>"##
    )
}
#[tauri::command]
pub async fn openai_login(
    app: AppHandle,
    state: State<'_, OpenAiConnection>,
    profile_id: Option<String>,
) -> Result<String, String> {
    let profile = crate::connection_profiles::profile(&app, "openai", profile_id.as_deref())?
        .filter(|p| p.enabled)
        .ok_or("profile-disabled")?;
    let mut pending = state.pending.lock().await;
    if pending.is_some() {
        return Err("busy".into());
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "callback")?;
    let redirect = format!(
        "http://127.0.0.1:{}/auth/callback",
        listener.local_addr().map_err(|_| "callback")?.port()
    );
    let home = crate::connection_profiles::home(&app, &profile)?;
    std::fs::create_dir_all(&home).map_err(|_| "storage")?;
    let host_path = home.join("host-id");
    let host = match std::fs::read_to_string(&host_path) {
        Ok(id) => id,
        Err(_) => {
            let id = format!("urn:uuid:{}", uuid::Uuid::new_v4());
            std::fs::write(host_path, &id).map_err(|_| "storage")?;
            id
        }
    };
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let transaction = uuid::Uuid::new_v4().to_string();
    let nonce = uuid::Uuid::new_v4().to_string();
    let old = load(&app, &profile)?;
    let client_id = old
        .as_ref()
        .map(|c| c.client_id.as_str())
        .unwrap_or("dynamic_agent_client");
    let mut url =
        reqwest::Url::parse(&format!("{AUTH}/api/accounts/authorize")).map_err(|_| "auth")?;
    {
        let mut q = url.query_pairs_mut();
        q.extend_pairs([
            ("client_id", client_id),
            ("ext_agent_host_id", &host),
            ("redirect_uri", &redirect),
            ("response_type", "code"),
            ("scope", SCOPES),
            ("resource", RESOURCE),
            ("state", &transaction),
            ("nonce", &nonce),
            ("code_challenge_method", "S256"),
            ("code_challenge", &challenge),
        ]);
        if let Some(c) = &old {
            q.append_pair("id_token_hint", &c.id_token);
        } else {
            q.append_pair("agent_name_hint", "aplot_control_llm");
        }
    }
    *pending = Some(transaction.clone());
    *state.pending_profile.lock().await = Some(profile.id.clone());
    state.error.lock().await.remove(&profile.id);
    drop(pending);
    tauri::async_runtime::spawn(async move {
        let result=async {
            let deadline=tokio::time::Instant::now()+Duration::from_secs(300);
            loop{
                if app.state::<OpenAiConnection>().pending.lock().await.as_deref()!=Some(&transaction){return Err("cancelled".to_string())}
                let (mut socket,_)=tokio::time::timeout_at(deadline,listener.accept()).await.map_err(|_|"login-timeout")?.map_err(|_|"callback")?;
                let mut bytes=vec![0;16384];let n=tokio::time::timeout(Duration::from_secs(3),socket.read(&mut bytes)).await.map_err(|_|"callback")?.map_err(|_|"callback")?;
                let line=String::from_utf8_lossy(&bytes[..n]);let target=line.lines().next().and_then(|s|s.strip_prefix("GET ")).and_then(|s|s.split_whitespace().next()).unwrap_or("");
                let callback=reqwest::Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_|"callback")?;let params:HashMap<String,String>=callback.query_pairs().into_owned().collect();
                if callback.path()!="/auth/callback"||params.get("state")!=Some(&transaction){let _=socket.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;continue}
                let outcome=async{
                    if params.contains_key("error"){return Err("login-denied".to_string())}
                    let issued=params.get("client_id").or(old.as_ref().map(|c|&c.client_id)).filter(|s|s.as_str()!="dynamic_agent_client"&&!s.is_empty()).ok_or("client-id")?;
                    if old.as_ref().is_some_and(|c|&c.client_id!=issued){return Err("identity".into())}
                    let value=token_form(&[("grant_type","authorization_code"),("client_id",issued),("code",params.get("code").ok_or("code")?),("code_verifier",&verifier),("redirect_uri",&redirect),("resource",RESOURCE)]).await?;
                    let identity=verify(value["id_token"].as_str().ok_or("identity")?,issued,Some(&nonce)).await?;
                    if old.as_ref().is_some_and(|c|identity["sub"]!=c.subject){return Err("identity".into())}
                    let c=credentials(&value,issued.clone(),&identity,None)?;let state=app.state::<OpenAiConnection>();let _lock=state.operation.lock().await;
                    if state.pending.lock().await.as_deref()!=Some(&transaction)||!crate::connection_profiles::is_enabled(&app,&profile){return Err("cancelled".into())}
                    save(&app,&profile,&c)?;Ok(())
                }.await;
                let body=callback_page(outcome.is_ok());let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);let _=socket.write_all(response.as_bytes()).await;let _=socket.shutdown().await;
                if outcome.is_ok(){return_to_app(&app);}return outcome;
            }
        }.await;
        let state = app.state::<OpenAiConnection>();
        let mut current = state.pending.lock().await;
        if current.as_deref() == Some(&transaction) {
            *current = None;
            *state.pending_profile.lock().await = None;
            if let Err(error) = result {
                state.error.lock().await.insert(profile.id.clone(), error);
            }
        }
        drop(current);
        let _ = app.emit("openai://changed", ());
    });
    Ok(url.to_string())
}
#[tauri::command]
pub async fn openai_cancel_login(state: State<'_, OpenAiConnection>) -> Result<(), String> {
    state.pending.lock().await.take();
    state.pending_profile.lock().await.take();
    Ok(())
}
pub(crate) async fn close_profile(
    app: &AppHandle,
    profile: &crate::connection_profiles::Profile,
    disconnect: bool,
) -> Result<(), String> {
    let state = app.state::<OpenAiConnection>();
    let cancel_pending = { state.pending_profile.lock().await.as_deref() == Some(&profile.id) };
    if cancel_pending {
        state.pending.lock().await.take();
    }
    let lock = state.operation.lock().await;
    let c = load(app, profile)?;
    let connection = c
        .as_ref()
        .map(|c| crate::connection_profiles::key(profile, &connection_key(c)));
    let mut requests = state.requests.lock().await;
    let ids: Vec<_> = requests
        .iter()
        .filter(|(_, (id, _))| Some(id) == connection.as_ref())
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some((_, cancel)) = requests.remove(&id) {
            let _ = cancel.send(());
        }
    }
    drop(requests);
    if let Some(id) = &connection {
        app.state::<crate::codex_limits::CodexLimits>()
            .close_profile(app, profile, id, disconnect)
            .await?;
    }
    if disconnect {
        let path = crate::connection_profiles::home(app, profile)?.join("chatgpt.dpapi");
        if path.exists() {
            std::fs::remove_file(path).map_err(|_| "storage")?;
        }
        crate::connection_profiles::remember(app, &profile.id, None, None)?;
    }
    drop(lock);
    if let Some(id) = connection {
        app.state::<crate::codex_agent::CodexManager>()
            .shutdown_connection(&id)
            .await;
    }
    let _ = app.emit("openai://changed", ());
    if disconnect {
        if let Some(c) = c {
            let revoked = async {
                let d = discovery().await?;
                let u = reqwest::Url::parse(d["revocation_endpoint"].as_str().ok_or("revoke")?)
                    .map_err(|_| "revoke")?;
                if u.scheme() != "https" || u.host_str() != Some("auth.openai.com") {
                    return Err("revoke".to_string());
                }
                client()?
                    .post(u)
                    .form(&[
                        ("client_id", c.client_id),
                        (
                            "token",
                            if c.refresh_token.is_empty() {
                                c.access_token
                            } else {
                                c.refresh_token
                            },
                        ),
                    ])
                    .send()
                    .await
                    .map_err(|_| "network")?
                    .error_for_status()
                    .map_err(|_| "revoke")?;
                Ok::<_, String>(())
            }
            .await
            .is_ok();
            if !revoked {
                return Err("signed-out-locally-revoke-unconfirmed".into());
            }
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn openai_logout(app: AppHandle, profile_id: Option<String>) -> Result<(), String> {
    let p = crate::connection_profiles::profile(&app, "openai", profile_id.as_deref())?
        .ok_or("profile")?;
    close_profile(&app, &p, true).await
}
#[tauri::command]
pub async fn openai_models(app: AppHandle, connection_id: String) -> Result<Value, String> {
    let token = access_token(&app, &connection_id).await?;
    client()?
        .get(format!("{RESOURCE}/models"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "network")?
        .error_for_status()
        .map_err(|_| "auth")?
        .json()
        .await
        .map_err(|_| "network".into())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudRequest {
    connection_id: String,
    model: String,
    messages: Vec<CloudMessage>,
    #[serde(default)]
    effort: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CloudMessage {
    role: String,
    content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    images: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    documents: Vec<crate::chat_media::Document>,
}
#[derive(Clone, Serialize)]
pub struct CloudEvent {
    kind: &'static str,
    bytes: Vec<u8>,
}
#[tauri::command]
pub async fn openai_chat_cancel(
    state: State<'_, OpenAiConnection>,
    request_id: String,
) -> Result<(), String> {
    if let Some((_, cancel)) = state.requests.lock().await.remove(&request_id) {
        let _ = cancel.send(());
    }
    Ok(())
}
#[tauri::command]
pub async fn openai_chat_send(
    app: AppHandle,
    state: State<'_, OpenAiConnection>,
    request_id: String,
    request: CloudRequest,
    on_event: Channel<CloudEvent>,
) -> Result<(), String> {
    if request.messages.is_empty()
        || request.messages.len() > 100
        || request.model.len() > 200
        || request.model.is_empty()
        || request.messages.iter().any(|m| {
            !["user", "assistant"].contains(&m.role.as_str())
                || !crate::chat_media::valid_images(&m.images)
                || !crate::chat_media::valid_documents(&m.documents)
                || m.role != "user" && (!m.images.is_empty() || !m.documents.is_empty())
        })
        || request
            .messages
            .iter()
            .map(|m| {
                m.content.len()
                    + m.images.iter().map(String::len).sum::<usize>()
                    + m.documents.iter().map(|d| d.data.len()).sum::<usize>()
            })
            .sum::<usize>()
            > 32_000_000
    {
        return Err("limit".into());
    }
    let (cancel, mut cancelled) = oneshot::channel();
    {
        let mut map = state.requests.lock().await;
        if map.contains_key(&request_id) {
            return Err("busy".into());
        }
        map.insert(request_id.clone(), (request.connection_id.clone(), cancel));
    }
    let _ = on_event.send(CloudEvent {
        kind: "ready",
        bytes: vec![],
    });
    let result = tokio::select! {_=&mut cancelled=>Err("cancelled".into()),result=async {
        let token=access_token(&app,&request.connection_id).await?;
        let mut body=json!({"model":request.model,"store":false,"stream":true,"instructions":"Отвечай на русском языке, если пользователь не попросил другой язык.","input":request.messages.iter().map(|m|crate::chat_media::response_message(&m.role,&m.content,&m.images,&m.documents)).collect::<Vec<_>>()});
        if let Some(effort)=request.effort.as_deref().filter(|e|["low","medium","high","xhigh"].contains(e)){body["reasoning"]=json!({"effort":effort,"summary":"auto"});}
        let mut response=client()?.post(format!("{RESOURCE}/responses")).timeout(Duration::from_secs(900)).bearer_auth(token).json(&body).send().await.map_err(|_|"network")?;
        if !response.status().is_success(){return Err(if [401,403].contains(&response.status().as_u16()){"auth"}else if response.status().as_u16()==429{"quota"}else{"failed"}.into())}
        let mut total=0;while let Some(bytes)=response.chunk().await.map_err(|_|"network")?{total+=bytes.len();if total>16_000_000{return Err("limit".into())}on_event.send(CloudEvent{kind:"chunk",bytes:bytes.to_vec()}).map_err(|_|"unavailable")?;}Ok(())
    }=>result};
    state.requests.lock().await.remove(&request_id);
    let _ = on_event.send(CloudEvent {
        kind: "finished",
        bytes: vec![],
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_survives_token_rotation_but_not_an_account_switch() {
        let mut c = Credentials {
            client_id: "app".into(),
            subject: "user-one".into(),
            email: None,
            access_token: "first".into(),
            refresh_token: "refresh".into(),
            id_token: "id".into(),
            expires_at: 1,
            scope: SCOPES.into(),
        };
        let first = connection_key(&c);
        c.access_token = "second".into();
        assert_eq!(first, connection_key(&c));
        c.subject = "user-two".into();
        assert_ne!(first, connection_key(&c));
    }
    #[test]
    fn plan_scopes_required() {
        assert!(!permitted("openid profile email"));
        assert!(permitted(SCOPES));
    }
    #[test]
    fn pkce_is_url_safe() {
        let hash = URL_SAFE_NO_PAD.encode(Sha256::digest(b"verifier"));
        assert!(!hash.contains('='));
        assert_eq!(hash.len(), 43);
    }
    #[test]
    fn signed_identity_still_requires_subject_and_matching_nonce() {
        assert!(valid_identity(
            &json!({"sub":"account","nonce":"attempt"}),
            Some("attempt")
        ));
        assert!(!valid_identity(
            &json!({"sub":"account","nonce":"other"}),
            Some("attempt")
        ));
        assert!(!valid_identity(
            &json!({"nonce":"attempt"}),
            Some("attempt")
        ));
    }
    #[test]
    fn token_response_requires_plan_permission_and_expiry() {
        let identity = json!({"sub":"account"});
        assert!(credentials(
            &json!({"access_token":"test","scope":"openid","expires_in":3600}),
            "issued".into(),
            &identity,
            None
        )
        .is_err());
        assert!(credentials(
            &json!({"access_token":"test","scope":SCOPES}),
            "issued".into(),
            &identity,
            None
        )
        .is_err());
        assert!(credentials(
            &json!({"access_token":"test","scope":SCOPES,"expires_in":3600}),
            "issued".into(),
            &identity,
            None
        )
        .is_ok());
    }
}
