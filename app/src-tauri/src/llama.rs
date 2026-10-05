use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HealthResult {
    pub reachable: bool,
    pub ready: bool,
    pub status: u16,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    pub ttft_ms: Option<u64>,
    pub prompt_tps: f32,
    pub generation_tps: f32,
    pub generation_mean_tps: Option<f32>,
    pub generation_window_seconds: Option<f32>,
    pub requests_processing: usize,
    pub requests_deferred: usize,
    pub kv_cache_usage_ratio: f32,
    pub kv_cache_tokens: i64,
    pub n_tokens_max: i64,
    pub model_name: Option<String>,
    pub available: bool,
}

#[derive(Debug, Serialize, Clone, Deserialize, Default)]
pub struct SlotTimings {
    #[serde(default)]
    pub predicted_per_second: f32,
    #[serde(default)]
    pub prompt_per_second: f32,
}

#[derive(Debug, Serialize, Clone, Deserialize, Default)]
pub struct SlotNextToken {
    #[serde(default)]
    pub n_decoded: i64,
}

#[derive(Debug, Serialize, Clone, Deserialize, Default)]
pub struct SlotSnapshot {
    pub id: i64,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub id_task: Option<i64>,
    #[serde(default)]
    pub is_processing: bool,
    #[serde(default)]
    pub n_ctx: i64,
    #[serde(default)]
    pub n_past: i64,
    #[serde(default)]
    pub n_prompt_tokens: Option<i64>,
    #[serde(default)]
    pub next_token: Vec<SlotNextToken>,
    #[serde(default)]
    pub timings: Option<SlotTimings>,
}

impl SlotSnapshot {
    pub fn context_tokens(&self) -> i64 {
        // Current builds retain all cached prompt + generated tokens in this
        // field after release; older builds expose the same count as n_past.
        self.n_prompt_tokens.unwrap_or(self.n_past).max(0)
    }

    pub fn runtime_state(&self) -> &str {
        if !self.is_processing {
            "idle"
        } else if self
            .next_token
            .first()
            .is_some_and(|token| token.n_decoded == 0)
        {
            "prompt"
        } else {
            "generating"
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionResult {
    pub version_output: String,
    pub help_output: String,
    pub devices_output: String,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_default()
}

fn authenticated(
    request: reqwest::RequestBuilder,
    api_key: Option<&str>,
) -> reqwest::RequestBuilder {
    match api_key.filter(|value| !value.is_empty()) {
        Some(key) => request.bearer_auth(key),
        None => request,
    }
}

fn with_model(request: reqwest::RequestBuilder, model_id: Option<&str>) -> reqwest::RequestBuilder {
    match model_id.filter(|value| !value.trim().is_empty()) {
        Some(model_id) => request.query(&[("model", model_id)]),
        None => request,
    }
}

pub async fn health(base: &str, api_key: Option<&str>) -> HealthResult {
    let url = format!("{}/health", base.trim_end_matches('/'));
    match authenticated(client().get(url), api_key).send().await {
        Ok(response) => HealthResult {
            reachable: true,
            ready: response.status().is_success(),
            status: response.status().as_u16(),
        },
        Err(_) => HealthResult {
            reachable: false,
            ready: false,
            status: 0,
        },
    }
}

pub async fn slots(base: &str, api_key: Option<&str>) -> Result<Vec<SlotSnapshot>, String> {
    slots_for_model(base, api_key, None).await
}

pub async fn slots_for_model(
    base: &str,
    api_key: Option<&str>,
    model_id: Option<&str>,
) -> Result<Vec<SlotSnapshot>, String> {
    let response = authenticated(
        with_model(
            client().get(format!("{}/slots", base.trim_end_matches('/'))),
            model_id,
        ),
        api_key,
    )
    .send()
    .await
    .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("/slots returned {}", response.status()));
    }
    let mut slots: Vec<SlotSnapshot> = response.json().await.map_err(|e| e.to_string())?;
    if let Some(model_id) = model_id.filter(|value| !value.trim().is_empty()) {
        for slot in &mut slots {
            slot.model_id = Some(model_id.to_string());
        }
    }
    Ok(slots)
}

fn parse_prometheus(text: &str) -> HashMap<String, f64> {
    let mut metrics = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        if let (Some(name), Some(value)) = (parts.next(), parts.next()) {
            if let Ok(value) = value.parse::<f64>() {
                *metrics
                    .entry(name.split('{').next().unwrap_or(name).into())
                    .or_insert(0.0) += value;
            }
        }
    }
    metrics
}

pub async fn metrics(base: &str, api_key: Option<&str>) -> Result<MetricsSnapshot, String> {
    metrics_for_model(base, api_key, None).await
}

pub async fn metrics_for_model(
    base: &str,
    api_key: Option<&str>,
    model_id: Option<&str>,
) -> Result<MetricsSnapshot, String> {
    let response = authenticated(
        with_model(
            client().get(format!("{}/metrics", base.trim_end_matches('/'))),
            model_id,
        ),
        api_key,
    )
    .send()
    .await
    .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Ok(MetricsSnapshot::default());
    }
    let body = response.text().await.map_err(|e| e.to_string())?;
    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&body) {
        if let Some(snapshot) = parse_strata_metrics(&payload) {
            return Ok(snapshot);
        }
    }
    let map = parse_prometheus(&body);
    let get = |key: &str| *map.get(key).unwrap_or(&0.0);
    Ok(MetricsSnapshot {
        ttft_ms: None,
        prompt_tps: get("llamacpp:prompt_tokens_seconds") as f32,
        generation_tps: get("llamacpp:predicted_tokens_seconds") as f32,
        generation_mean_tps: None,
        generation_window_seconds: None,
        requests_processing: get("llamacpp:requests_processing") as usize,
        requests_deferred: get("llamacpp:requests_deferred") as usize,
        // Not every build currently exports KV cache gauges. Runtime falls back to /slots.
        kv_cache_usage_ratio: get("llamacpp:kv_cache_usage_ratio") as f32,
        kv_cache_tokens: get("llamacpp:kv_cache_tokens") as i64,
        n_tokens_max: get("llamacpp:n_tokens_max") as i64,
        model_name: None,
        available: !map.is_empty(),
    })
}

fn parse_strata_metrics(payload: &serde_json::Value) -> Option<MetricsSnapshot> {
    let engine = payload.get("engine")?;
    let live = payload.get("live")?;
    let model_name = engine.get("model")?.as_str()?.to_string();
    let number = |object: &serde_json::Value, key: &str| {
        object
            .get(key)
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0)
    };
    let requests = payload
        .get("requests")
        .and_then(serde_json::Value::as_array);
    let last = requests.and_then(|items| items.first());
    let prompt_tps = last
        .map(|request| {
            let tokens = (number(request, "prompt_tokens") - number(request, "reused")).max(0.0);
            let millis = number(request, "prompt_ms");
            if millis > 0.0 {
                tokens * 1000.0 / millis
            } else {
                0.0
            }
        })
        .unwrap_or(0.0);
    let live_speed = number(live, "tok_s");
    let generation_tps = if live_speed > 0.0 {
        live_speed
    } else {
        last.map(|request| number(request, "decode_tok_s"))
            .unwrap_or(0.0)
    };
    let busy = live
        .get("state")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|state| matches!(state, "reading" | "generating"));
    let processing = live
        .get("running")
        .and_then(serde_json::Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(usize::from(busy));
    let prompt_tps = if live.get("state").and_then(serde_json::Value::as_str) == Some("reading") {
        live.get("prefill_tok_s_mean")
            .and_then(serde_json::Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .unwrap_or(prompt_tps)
    } else {
        prompt_tps
    };
    let context_used = if busy {
        number(live, "prompt_tokens") + number(live, "generated")
    } else {
        0.0
    };
    Some(MetricsSnapshot {
        ttft_ms: live
            .get("ttft_ms")
            .and_then(serde_json::Value::as_f64)
            .or_else(|| {
                last.and_then(|request| request.get("ttft_ms"))
                    .and_then(serde_json::Value::as_f64)
            })
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| value.round() as u64),
        prompt_tps: prompt_tps as f32,
        generation_tps: generation_tps as f32,
        generation_mean_tps: live
            .get("tok_s_mean")
            .and_then(serde_json::Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| value as f32),
        generation_window_seconds: live
            .get("tok_s_window_s")
            .and_then(serde_json::Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0)
            .map(|value| value as f32),
        requests_processing: processing,
        requests_deferred: number(live, "queued").max(0.0) as usize,
        kv_cache_usage_ratio: 0.0,
        kv_cache_tokens: context_used as i64,
        n_tokens_max: number(engine, "max_context") as i64,
        model_name: Some(model_name),
        available: true,
    })
}

#[cfg(test)]
mod metrics_tests {
    use super::parse_strata_metrics;

    #[test]
    fn parses_strata_metrics_and_live_request_state() {
        let value = serde_json::json!({
            "engine": {"model":"qwen3.8-flash-next-iq2_xs", "max_context":65536},
            "live": {"state":"generating", "queued":2, "prompt_tokens":1200, "generated":80, "tok_s":41.5},
            "requests": [{"prompt_tokens":1200, "prompt_ms":2000.0, "decode_tok_s":39.0}]
        });
        let metrics = parse_strata_metrics(&value).unwrap();
        assert_eq!(
            metrics.model_name.as_deref(),
            Some("qwen3.8-flash-next-iq2_xs")
        );
        assert_eq!(metrics.n_tokens_max, 65_536);
        assert_eq!(metrics.requests_processing, 1);
        assert_eq!(metrics.requests_deferred, 2);
        assert_eq!(metrics.kv_cache_tokens, 1280);
        assert_eq!(metrics.prompt_tps, 600.0);
        assert_eq!(metrics.generation_tps, 41.5);
        assert!(metrics.available);
    }

    #[test]
    fn strata_039_uses_live_prefill_and_parallel_request_count() {
        let value = serde_json::json!({
            "engine": {"model":"fixture", "max_context":65536},
            "live": {"state":"reading", "running":3, "queued":2, "prefill_tok_s_mean":1800.0},
            "requests": [{"prompt_tokens":10000, "reused":9000, "prompt_ms":1000.0}]
        });
        let metrics = parse_strata_metrics(&value).unwrap();
        assert_eq!(metrics.prompt_tps, 1800.0);
        assert_eq!(metrics.requests_processing, 3);
        assert_eq!(metrics.requests_deferred, 2);
    }

    #[test]
    fn strata_retains_live_window_and_whole_request_mean_separately() {
        let value = serde_json::json!({
            "engine": {"model":"fixture", "max_context":131072},
            "live": {"state":"generating", "tok_s":87.8, "tok_s_mean":69.3,
                "tok_s_window_s":2.0, "prompt_tokens":1200, "generated":75959},
            "requests": []
        });
        let metrics = parse_strata_metrics(&value).unwrap();
        assert_eq!(metrics.generation_tps, 87.8);
        assert_eq!(metrics.generation_mean_tps, Some(69.3));
        assert_eq!(metrics.generation_window_seconds, Some(2.0));
        assert_eq!(metrics.kv_cache_tokens, 77159);
        let old = serde_json::json!({"engine":{"model":"old"},"live":{"tok_s":41.0}});
        assert_eq!(
            parse_strata_metrics(&old).unwrap().generation_mean_tps,
            None
        );
    }

    #[test]
    fn strata_unloaded_is_idle_and_cached_prompt_tokens_do_not_inflate_speed() {
        let value = serde_json::json!({
            "engine": {"model":"fixture", "max_context":65536},
            "live": {"state":"unloaded"},
            "requests": [{"prompt_tokens":10000, "reused":9000, "prompt_ms":1000.0}]
        });
        let metrics = parse_strata_metrics(&value).unwrap();
        assert_eq!(metrics.requests_processing, 0);
        assert_eq!(metrics.kv_cache_tokens, 0);
        assert_eq!(metrics.prompt_tps, 1000.0);
    }
}

pub async fn router_loaded_models(
    base: &str,
    api_key: Option<&str>,
) -> Result<Vec<String>, String> {
    let response = authenticated(
        client().get(format!("{}/models", base.trim_end_matches('/'))),
        api_key,
    )
    .send()
    .await
    .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("/models returned {}", response.status()));
    }

    let payload: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    parse_router_loaded_models(&payload)
}

fn parse_router_loaded_models(payload: &serde_json::Value) -> Result<Vec<String>, String> {
    let models = payload
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "/models response did not contain a model list".to_string())?;
    Ok(models
        .iter()
        .filter_map(|model| {
            let id = model.get("id")?.as_str()?;
            let status = model.get("status")?.get("value")?.as_str()?;
            matches!(status, "loaded" | "loading" | "reloading").then(|| id.to_string())
        })
        .collect())
}

#[tauri::command]
pub async fn llama_health(
    base_url: String,
    api_key: Option<String>,
) -> Result<HealthResult, String> {
    Ok(health(&base_url, api_key.as_deref()).await)
}
#[tauri::command]
pub async fn llama_slots(
    base_url: String,
    api_key: Option<String>,
) -> Result<Vec<SlotSnapshot>, String> {
    slots(&base_url, api_key.as_deref()).await
}
#[tauri::command]
pub async fn llama_metrics(
    base_url: String,
    api_key: Option<String>,
) -> Result<MetricsSnapshot, String> {
    metrics(&base_url, api_key.as_deref()).await
}

#[tauri::command]
pub async fn detect_llama(binary_path: String) -> Result<DetectionResult, String> {
    async fn run_hidden(
        binary_path: &str,
        argument: &str,
    ) -> std::io::Result<std::process::Output> {
        let mut command = tokio::process::Command::new(binary_path);
        command.arg(argument);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        command.output().await
    }

    let version = run_hidden(&binary_path, "--version")
        .await
        .map_err(|e| format!("Failed to run --version: {e}"))?;
    let help = run_hidden(&binary_path, "--help")
        .await
        .map_err(|e| format!("Failed to run --help: {e}"))?;
    let devices = run_hidden(&binary_path, "--list-devices").await.ok();
    let combine = |output: std::process::Output| {
        let mut value = String::from_utf8_lossy(&output.stdout).to_string();
        if !output.stderr.is_empty() {
            value.push_str(&String::from_utf8_lossy(&output.stderr));
        }
        value
    };
    Ok(DetectionResult {
        version_output: combine(version),
        help_output: combine(help),
        devices_output: devices.map(combine).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modern_slot_retains_cached_context_when_idle() {
        let slot: SlotSnapshot = serde_json::from_value(serde_json::json!({
            "id": 0, "n_ctx": 131072, "is_processing": false,
            "n_prompt_tokens": 2560, "next_token": [{"n_decoded": 1891}]
        }))
        .unwrap();
        assert_eq!(slot.context_tokens(), 2560);
        assert_eq!(slot.runtime_state(), "idle");
    }

    #[test]
    fn legacy_and_cleared_slot_contexts_remain_supported() {
        let legacy: SlotSnapshot = serde_json::from_value(serde_json::json!({
            "id": 0, "n_ctx": 4096, "n_past": 2048, "is_processing": true
        }))
        .unwrap();
        assert_eq!(legacy.context_tokens(), 2048);
        assert_eq!(legacy.runtime_state(), "generating");
        let cleared = SlotSnapshot {
            n_prompt_tokens: Some(0),
            ..legacy
        };
        assert_eq!(cleared.context_tokens(), 0);
    }

    #[test]
    fn modern_slot_distinguishes_prompt_processing_from_generation() {
        let mut slot: SlotSnapshot = serde_json::from_value(serde_json::json!({
            "id": 0, "is_processing": true, "n_prompt_tokens": 1024,
            "next_token": [{"n_decoded": 0}]
        }))
        .unwrap();
        assert_eq!(slot.runtime_state(), "prompt");
        slot.next_token[0].n_decoded = 1;
        assert_eq!(slot.runtime_state(), "generating");
    }

    #[test]
    fn parses_prometheus_metrics_and_ignores_comments() {
        let parsed = parse_prometheus("# HELP ignored\nllamacpp:prompt_tokens_seconds 123.5\nllamacpp:requests_processing{model=\"x\"} 2\n");
        assert_eq!(
            parsed.get("llamacpp:prompt_tokens_seconds").copied(),
            Some(123.5)
        );
        assert_eq!(
            parsed.get("llamacpp:requests_processing").copied(),
            Some(2.0)
        );
    }

    #[test]
    fn empty_prometheus_payload_is_empty() {
        assert!(parse_prometheus("# only comments\n").is_empty());
    }

    #[test]
    fn router_telemetry_requests_include_the_model_id() {
        let request = with_model(
            client().get("http://127.0.0.1:8080/slots"),
            Some("profile with spaces"),
        )
        .build()
        .unwrap();
        assert_eq!(request.url().query(), Some("model=profile+with+spaces"));
    }

    #[test]
    fn router_model_list_returns_only_loaded_or_loading_routes() {
        let payload = serde_json::json!({
            "data": [
                { "id": "active", "status": { "value": "loaded" }, "args": ["ignored"] },
                { "id": "starting", "status": { "value": "loading" } },
                { "id": "unused", "status": { "value": "unloaded" } }
            ]
        });
        assert_eq!(
            parse_router_loaded_models(&payload).unwrap(),
            ["active", "starting"]
        );
    }
}
