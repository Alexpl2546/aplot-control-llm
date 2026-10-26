//! An authenticated, per-run llama.cpp or Strata Web UI window. No credentials in URLs,
//! process arguments or IPC responses, and no remote Tauri capabilities.
use crate::{process::StartServerRequest, runs::RunInfo};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    time::Duration,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

fn label(run_id: &str) -> String {
    let mut hash = DefaultHasher::new();
    run_id.hash(&mut hash);
    format!("webui-{:016x}", hash.finish())
}

pub(crate) fn close(app: &AppHandle, run_id: &str) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label(run_id)) {
        window
            .close()
            .map_err(|_| "Could not close the run's Web UI window")?;
    }
    Ok(())
}

fn target(endpoint: &str) -> Result<reqwest::Url, String> {
    let mut url = crate::domain::http::server_endpoint(endpoint)?;
    if url.scheme() != "http" {
        return Err("The local Web UI requires an HTTP endpoint".into());
    }
    // Wildcard addresses describe a bind interface, not a browser destination.
    match url.host_str() {
        Some("0.0.0.0") => url
            .set_host(Some("127.0.0.1"))
            .map_err(|_| "Invalid Web UI host")?,
        Some("[::]") | Some("::") => url
            .set_host(Some("[::1]"))
            .map_err(|_| "Invalid Web UI host")?,
        _ => {}
    }
    Ok(url)
}

fn enabled(args: &[String]) -> bool {
    args.iter().fold(true, |enabled, flag| match flag.as_str() {
        "--ui" | "--webui" => true,
        "--no-ui" | "--no-webui" => false,
        _ => enabled,
    })
}

fn bootstrap(url: &reqwest::Url, api_key: &str, engine: &str) -> Result<String, String> {
    let source = match engine {
        "llama_cpp" => include_str!("web_ui_bootstrap.js"),
        "strata" => include_str!("strata_web_ui_bootstrap.js"),
        _ => return Err("This engine has no supported Web UI".into()),
    };
    Ok(format!(
        "({})({}, {});",
        source,
        serde_json::to_string(&url.origin().ascii_serialization()).unwrap(),
        serde_json::to_string(api_key).unwrap()
    ))
}

pub(crate) async fn open(
    app: &AppHandle,
    info: &RunInfo,
    request: &StartServerRequest,
) -> Result<(), String> {
    if info.engine == "llama_cpp" && !enabled(&request.args) {
        return Err(
            "Web UI is disabled in this running server. Enable Web UI and restart this run.".into(),
        );
    }
    let url = target(&info.endpoint)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not check Web UI availability")?;
    // Embedded assets are gzip-only in some builds. We inspect headers only;
    // the WebView performs normal gzip decoding when it loads the page.
    let mut query = client
        .get(url.clone())
        .header(reqwest::header::ACCEPT_ENCODING, "gzip");
    let key = request.api_key.as_deref().unwrap_or_default().trim();
    if !key.is_empty() {
        query = query.bearer_auth(key);
    }
    let response = query
        .send()
        .await
        .map_err(|_| "The run's Web UI is not reachable")?;
    if !response.status().is_success()
        || !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/html"))
    {
        return Err(if info.engine == "strata" {
            "This Strata server does not serve Web UI. Check that serve/web is present in the selected Strata installation."
        } else {
            "This server does not serve Web UI. Enable Web UI and restart this run, or select a llama.cpp build with bundled UI."
        }.into());
    }
    let label = label(&info.run_id);
    if let Some(window) = app.get_webview_window(&label) {
        window
            .unminimize()
            .map_err(|_| "Could not restore Web UI")?;
        window.show().map_err(|_| "Could not show Web UI")?;
        return window
            .set_focus()
            .map_err(|_| "Could not focus Web UI".into());
    }
    let script = bootstrap(&url, key, &info.engine)?;
    let origin = url.origin();
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(format!("{} — Web UI — Aplot Control LLM", info.name))
        .inner_size(1200.0, 850.0)
        .min_inner_size(700.0, 500.0)
        .initialization_script(script)
        .on_navigation(move |destination| destination.origin() == origin)
        .build()
        .map_err(|_| "Could not open the run's Web UI window")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_targets_keep_actual_ports_and_normalize_wildcards() {
        assert_eq!(
            target("http://0.0.0.0:8081").unwrap().as_str(),
            "http://127.0.0.1:8081/"
        );
        assert_eq!(
            target("http://[::]:8082").unwrap().as_str(),
            "http://[::1]:8082/"
        );
        for bad in [
            "file:///tmp/ui",
            "http://key@localhost:8080",
            "http://localhost:8080/?api_key=secret",
        ] {
            assert!(target(bad).is_err());
        }
    }

    #[test]
    fn launch_flags_determine_availability_and_run_windows_are_isolated() {
        let args = |values: &[&str]| values.iter().map(|v| v.to_string()).collect::<Vec<_>>();
        assert!(enabled(&args(&[])));
        assert!(!enabled(&args(&["--ui", "--no-webui"])));
        assert!(enabled(&args(&["--no-ui", "--webui"])));
        assert_ne!(label("profile:a"), label("profile:b"));
        assert_eq!(label("profile:a"), label("profile:a"));
    }

    #[test]
    fn bootstrap_uses_json_escaping_without_changing_the_endpoint() {
        let url = target("http://127.0.0.1:8081").unwrap();
        let script = bootstrap(&url, "key\"\\\n", "llama_cpp").unwrap();
        assert!(script.ends_with("(\"http://127.0.0.1:8081\", \"key\\\"\\\\\\n\");"));
        assert_eq!(url.as_str(), "http://127.0.0.1:8081/");
        let strata = bootstrap(&url, "key\"\\\n", "strata").unwrap();
        assert!(strata.contains("strata.apikey"));
        assert!(!strata.contains("LlamaUi.config"));
        assert!(strata.ends_with("(\"http://127.0.0.1:8081\", \"key\\\"\\\\\\n\");"));
        assert!(bootstrap(&url, "private", "ollama").is_err());
    }
}
