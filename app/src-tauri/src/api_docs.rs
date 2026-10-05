use reqwest::Url;
use serde_json::Value;
use std::net::IpAddr;

fn is_local_host(host: &str) -> bool {
    if let Ok(address) = host.parse::<IpAddr>() {
        return match address {
            IpAddr::V4(address) => {
                address.is_loopback() || address.is_private() || address.is_unspecified()
            }
            IpAddr::V6(address) => {
                address.is_loopback() || address.is_unique_local() || address.is_unspecified()
            }
        };
    }

    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local")
}

#[tauri::command]
pub async fn fetch_openapi_spec(
    endpoint: String,
    api_key: String,
    engine: Option<String>,
) -> Result<Value, String> {
    if engine.as_deref() == Some("ollama") {
        crate::ollama::request(&endpoint, "version", None).await?;
        let mut spec: Value =
            serde_json::from_str(include_str!("ollama_openapi.json")).map_err(|e| e.to_string())?;
        spec["servers"] = serde_json::json!([{"url":endpoint}]);
        return Ok(spec);
    }
    let mut url =
        Url::parse(&endpoint).map_err(|error| format!("Invalid server address: {error}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| "The server address has no host name.".to_string())?;
    if url.scheme() != "http" || !is_local_host(host) {
        return Err("API Docs can only connect to a local HTTP server.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Credentials must not be included in the server address.".into());
    }
    url.set_path("/openapi.json");
    url.set_query(None);
    url.set_fragment(None);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|error| format!("Could not create an API Docs request: {error}"))?;
    let mut request = client.get(url);
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Could not load the OpenAPI document: {error}"))?;
    let status = response.status();
    if status.as_u16() == 404 && engine.as_deref() == Some("qwfnfer") {
        let mut spec: Value =
            serde_json::from_str(include_str!("qwfn_openapi.json")).map_err(|e| e.to_string())?;
        spec["servers"] = serde_json::json!([{ "url": endpoint }]);
        return Ok(spec);
    }
    if status.as_u16() == 404 && engine.as_deref() == Some("llama_cpp") {
        let mut spec: Value = serde_json::from_str(include_str!("llama_openapi.json"))
            .map_err(|error| error.to_string())?;
        spec["servers"] = serde_json::json!([{ "url": endpoint }]);
        return Ok(spec);
    }
    if !status.is_success() {
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err("The server rejected its saved API key while opening API Docs.".into());
        }
        return Err(format!(
            "The server returned HTTP {status} for /openapi.json."
        ));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("The server returned an invalid OpenAPI document: {error}"))
}
