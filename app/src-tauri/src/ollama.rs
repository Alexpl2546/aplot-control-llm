use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tauri::{AppHandle, State};
use tokio::{process::Child, sync::Mutex};

#[derive(Default)]
pub struct OllamaState(pub Mutex<Option<Child>>);

pub(crate) fn endpoint(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value.trim()).map_err(|_| "Enter an HTTP address for Ollama.")?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Use an HTTP server address without a path, credentials or query.".into());
    }
    Ok(url)
}

pub(crate) async fn request(
    base: &str,
    action: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    if !["tags", "ps", "version", "generate", "show", "pull"].contains(&action) {
        return Err("Unsupported Ollama action.".into());
    }
    let url = endpoint(base)?
        .join(&format!("api/{action}"))
        .map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(if action == "pull" {
            3600
        } else if action == "generate" {
            300
        } else {
            10
        }))
        .build()
        .map_err(|e| e.to_string())?;
    let response = match body {
        Some(value) => client.post(url).json(&value),
        None => client.get(url),
    }
    .send()
    .await
    .map_err(|e| format!("Ollama is unavailable: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| format!("Ollama returned invalid JSON (HTTP {status})."))?;
    if !status.is_success() || value.get("error").is_some() {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Ollama request failed.")
            .to_string());
    }
    Ok(value)
}

fn bundled_binary(root: Option<PathBuf>) -> Option<PathBuf> {
    root.map(|root| root.join("engines/Ollama/ollama.exe"))
        .filter(|path| path.is_file())
}

pub(crate) fn detected_binary() -> Option<PathBuf> {
    if let Some(path) = bundled_binary(crate::db::installation_root()) {
        return Some(path);
    }
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|p| p.join("Programs/Ollama/ollama.exe"));
    if local.as_ref().is_some_and(|p| p.is_file()) {
        return local;
    }
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|p| p.join("ollama.exe"))
            .find(|p| p.is_file())
    })
}

#[tauri::command]
pub async fn ollama_status(
    endpoint_value: String,
    state: State<'_, OllamaState>,
) -> Result<Value, String> {
    let mut child = state.0.lock().await;
    if child
        .as_mut()
        .is_some_and(|c| c.try_wait().ok().flatten().is_some())
    {
        *child = None;
    }
    let managed = child.is_some();
    drop(child);
    let (version, models, running) = tokio::try_join!(
        request(&endpoint_value, "version", None),
        request(&endpoint_value, "tags", None),
        request(&endpoint_value, "ps", None)
    )?;
    if !models["models"].is_array()
        || !running["models"].is_array()
        || !version["version"].is_string()
    {
        return Err("The address did not return an Ollama API response.".into());
    }
    Ok(
        json!({"version":version["version"],"models":models["models"],"running":running["models"],"managed":managed}),
    )
}

#[tauri::command]
pub async fn ollama_model_action(
    endpoint_value: String,
    model: String,
    action: String,
    prompt: String,
    context: u32,
) -> Result<Value, String> {
    model_action(&endpoint_value, &model, &action, &prompt, context).await
}

pub(crate) async fn model_action(
    endpoint_value: &str,
    model: &str,
    action: &str,
    prompt: &str,
    context: u32,
) -> Result<Value, String> {
    if !["load", "unload", "generate"].contains(&action) {
        return Err("Unsupported model action.".into());
    }
    if !(512..=262144).contains(&context) {
        return Err("Context must be between 512 and 262144 tokens.".into());
    }
    let tags = request(&endpoint_value, "tags", None).await?;
    let installed = tags["models"].as_array().and_then(|items| {
        items
            .iter()
            .find(|item| item["name"].as_str() == Some(model))
    });
    let item = installed.ok_or("Select a model installed in Ollama first.")?;
    if item
        .get("remote_host")
        .is_some_and(|value| value.as_str().is_some_and(|s| !s.is_empty()))
        || model.ends_with("-cloud")
    {
        return Err("Choose a locally installed model for this control panel.".into());
    }
    if action != "unload" {
        let show = request(endpoint_value, "show", Some(json!({"model":model}))).await?;
        if !show["capabilities"]
            .as_array()
            .is_some_and(|items| items.iter().any(|v| v.as_str() == Some("completion")))
        {
            return Err("This Ollama model does not support text generation.".into());
        }
    }
    request(&endpoint_value,"generate",Some(json!({"model":model,"prompt":if action=="generate" {prompt} else {""},"stream":false,"keep_alive":if action=="unload" {json!(0)} else {json!("10m")},"options":{"num_ctx":context,"num_predict":128}}))).await
}

#[tauri::command]
pub async fn start_ollama(
    endpoint_value: String,
    binary_path: String,
    app: AppHandle,
    state: State<'_, OllamaState>,
) -> Result<(), String> {
    let url = endpoint(&endpoint_value)?;
    if ![
        Some("localhost"),
        Some("127.0.0.1"),
        Some("[::1]"),
        Some("::1"),
    ]
    .contains(&url.host_str())
        || url.scheme() != "http"
    {
        return Err(
            "A local Ollama process can only be started for a loopback HTTP address.".into(),
        );
    }
    if request(&endpoint_value, "version", None).await.is_ok() {
        return Ok(());
    }
    let path = if binary_path.trim().is_empty() {
        detected_binary()
            .ok_or("Ollama is not installed. Install Ollama for Windows or choose ollama.exe.")?
    } else {
        PathBuf::from(binary_path.trim())
    };
    if !path.is_file()
        || path
            .file_name()
            .and_then(|n| n.to_str())
            .is_none_or(|n| !n.eq_ignore_ascii_case("ollama.exe"))
    {
        return Err("Choose the installed ollama.exe executable.".into());
    }
    let mut guard = state.0.lock().await;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Err("Ollama is already starting. Refresh the connection shortly.".into());
        }
    }
    let mut command = tokio::process::Command::new(path);
    command
        .arg("serve")
        .env("OLLAMA_HOST", endpoint_value)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(root) = crate::db::installation_root() {
        let models = root.join("models/ollama");
        std::fs::create_dir_all(&models)
            .map_err(|e| format!("Cannot create Ollama model directory: {e}"))?;
        command.env("OLLAMA_MODELS", models);
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot start Ollama: {e}"))?;
    if let Some(out) = child.stdout.take() {
        tokio::spawn(crate::process::pump(out, app.clone(), "ollama"));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(crate::process::pump(err, app, "ollama"));
    }
    *guard = Some(child);
    drop(guard);
    for _ in 0..20 {
        if request(url.as_str(), "version", None).await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("Ollama has not responded yet. Check Logs and refresh the connection.".into())
}

#[tauri::command]
pub async fn stop_ollama(state: State<'_, OllamaState>) -> Result<(), String> {
    if let Some(mut child) = state.0.lock().await.take() {
        crate::process::terminate(&mut child).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovers_bundled_engine_without_path_or_user_installation() {
        let root = std::env::temp_dir().join(format!("aplot-ollama-{}", uuid::Uuid::new_v4()));
        assert_eq!(bundled_binary(None), None);
        assert_eq!(bundled_binary(Some(root.clone())), None);
        let executable = root.join("engines/Ollama/ollama.exe");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, b"fixture").unwrap();
        assert_eq!(bundled_binary(Some(root.clone())), Some(executable.clone()));
        std::fs::remove_file(executable).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    fn api(replies: Vec<Value>) -> (String, std::thread::JoinHandle<Vec<Value>>) {
        use std::io::{BufRead, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut received = Vec::new();
            for reply in replies {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                received.push(if body.is_empty() {
                    json!({"method":first.trim()})
                } else {
                    serde_json::from_slice(&body).unwrap()
                });
                let response = reply.to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            }
            received
        });
        (address, handle)
    }

    #[tokio::test]
    async fn local_model_actions_use_the_documented_api() {
        for action in ["load", "unload", "generate"] {
            let mut replies = vec![
                json!({"models":[{"name":"fixture:latest","size":123}]}),
                json!({"capabilities":["completion"]}),
                json!({"response":"hello","done":true,"eval_count":2,"eval_duration":1000000000}),
            ];
            if action == "unload" {
                replies.remove(1);
            }
            let (address, server) = api(replies);
            let result = model_action(&address, "fixture:latest", action, "test prompt", 4096)
                .await
                .unwrap();
            assert_eq!(result["response"], "hello");
            let calls = server.join().unwrap();
            assert!(calls[0]["method"].as_str().unwrap().contains("/api/tags"));
            let generation = calls.last().unwrap();
            assert_eq!(generation["model"], "fixture:latest");
            assert_eq!(generation["stream"], false);
            assert_eq!(generation["options"]["num_ctx"], 4096);
            assert_eq!(
                generation["prompt"],
                if action == "generate" {
                    "test prompt"
                } else {
                    ""
                }
            );
            assert_eq!(
                generation["keep_alive"],
                if action == "unload" {
                    json!(0)
                } else {
                    json!("10m")
                }
            );
        }
    }

    #[tokio::test]
    async fn missing_and_cloud_models_are_not_loaded() {
        for (model, tags) in [
            ("missing", json!({"models":[]})),
            (
                "fixture-cloud",
                json!({"models":[{"name":"fixture-cloud","remote_host":"https://ollama.com"}]}),
            ),
        ] {
            let (address, server) = api(vec![tags]);
            assert!(model_action(&address, model, "load", "", 4096)
                .await
                .is_err());
            assert_eq!(server.join().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn api_errors_are_reported() {
        let (address, server) = api(vec![json!({"error":"model failed to load"})]);
        assert_eq!(
            request(&address, "generate", Some(json!({})))
                .await
                .unwrap_err(),
            "model failed to load"
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn embedding_only_model_is_rejected_before_generate() {
        let (address, server) = api(vec![
            json!({"models":[{"name":"embed:latest"}]}),
            json!({"capabilities":["embedding"]}),
        ]);
        let error = model_action(&address, "embed:latest", "load", "", 4096)
            .await
            .unwrap_err();
        assert!(error.contains("does not support text generation"));
        assert_eq!(server.join().unwrap().len(), 2);
    }
    #[test]
    fn validates_server_address() {
        assert!(endpoint("http://127.0.0.1:11434").is_ok());
        assert!(endpoint("https://example.com").is_ok());
        for bad in [
            "file:///secret",
            "http://user:pass@localhost",
            "http://localhost/api",
            "http://localhost?x=1",
        ] {
            assert!(endpoint(bad).is_err());
        }
    }
}
