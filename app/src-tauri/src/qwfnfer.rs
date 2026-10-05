use crate::{gguf, llama, process::StartServerRequest};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct QwfnSettings {
    pub binary_path: String,
    pub model_path: String,
    pub host: String,
    pub port: u16,
    pub api_key: String,
    pub context: u32,
    pub ram_gb: f64,
    pub vram_gb: f64,
    pub reserve_mb: u32,
    pub threads: u32,
    pub kv: String,
    pub async_io: bool,
    pub mtp_path: String,
    pub mtp_gpu: bool,
    pub prefix_cache_gb: f64,
}
impl Default for QwfnSettings {
    fn default() -> Self {
        Self {
            binary_path: String::new(),
            model_path: String::new(),
            host: "127.0.0.1".into(),
            port: 8080,
            api_key: String::new(),
            context: 32768,
            ram_gb: 16.0,
            vram_gb: 12.0,
            reserve_mb: 1024,
            threads: 8,
            kv: "q8_0".into(),
            async_io: false,
            mtp_path: String::new(),
            mtp_gpu: false,
            prefix_cache_gb: 0.0,
        }
    }
}

pub fn build_start_request(settings: QwfnSettings) -> Result<StartServerRequest, String> {
    validate_options(&settings)?;
    let binary = Path::new(&settings.binary_path)
        .canonicalize()
        .map_err(|e| format!("qwfn-server: {e}"))?;
    if !binary.is_file() {
        return Err("Choose qwfn-server.exe.".into());
    }
    let model = Path::new(&settings.model_path)
        .canonicalize()
        .map_err(|e| format!("QwFNfer model: {e}"))?;
    let metadata = gguf::read_metadata(&model)?;
    validate_metadata(&metadata)?;
    let mut args = vec![model.to_string_lossy().into_owned()];
    for (flag, value) in [
        ("--host", settings.host.clone()),
        ("--port", settings.port.to_string()),
        ("--ctx", settings.context.to_string()),
        ("--ram", settings.ram_gb.to_string()),
        ("--vram", settings.vram_gb.to_string()),
        ("--reserve", settings.reserve_mb.to_string()),
        ("--threads", settings.threads.to_string()),
        ("--kv", settings.kv.clone()),
        ("--alias", "qwen3.8-flash-next".into()),
    ] {
        args.extend([flag.into(), value]);
    }
    if settings.async_io {
        args.push("--io-uring".into());
    }
    if !settings.mtp_path.trim().is_empty() {
        let mtp = Path::new(&settings.mtp_path)
            .canonicalize()
            .map_err(|e| format!("MTP: {e}"))?;
        let mtp_metadata = gguf::read_metadata(&mtp)?;
        if mtp_metadata
            .get("general.architecture")
            .and_then(|v| v.as_str())
            != Some("qwen4exp")
        {
            return Err("MTP must belong to Qwen3.8-Flash-Next (qwen4exp).".into());
        }
        args.extend(["--mtp".into(), mtp.to_string_lossy().into_owned()]);
    }
    if settings.prefix_cache_gb > 0.0 {
        args.extend([
            "--prefix-cache".into(),
            settings.prefix_cache_gb.to_string(),
        ]);
    }
    Ok(StartServerRequest {
        binary_path: binary.to_string_lossy().into_owned(),
        args,
        endpoint: Some(format!("http://{}:{}", settings.host, settings.port)),
        profile_id: None,
        backend: Some("qwfnfer".into()),
        working_directory: binary.parent().map(|p| p.to_string_lossy().into_owned()),
        api_key: Some(settings.api_key),
        qwfn_mtp_gpu: Some(settings.mtp_gpu),
    })
}
fn validate_metadata(metadata: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    if metadata
        .get("general.architecture")
        .and_then(|v| v.as_str())
        != Some("qwen4exp")
    {
        return Err("QwFNfer supports only Qwen3.8-Flash-Next (qwen4exp) GGUF.".into());
    }
    if metadata
        .get("split.no")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        != 0
    {
        return Err("Choose the first GGUF shard; the engine finds the remaining shards.".into());
    }
    if metadata
        .get("general.type")
        .and_then(|v| v.as_str())
        .is_some_and(|v| matches!(v, "adapter" | "mtp"))
    {
        return Err("Choose the main model, not an adapter or draft head.".into());
    }
    Ok(())
}
fn validate_options(s: &QwfnSettings) -> Result<(), String> {
    if s.host.trim().is_empty()
        || s.port == 0
        || !(1024..=262144).contains(&s.context)
        || !(1..=512).contains(&s.threads)
        || !matches!(s.kv.as_str(), "q8_0" | "f16")
        || s.reserve_mb > 65536
        || [s.ram_gb, s.vram_gb, s.prefix_cache_gb]
            .iter()
            .any(|v| !v.is_finite() || *v < 0.0 || *v > 4096.0)
    {
        return Err("Invalid QwFNfer context, memory, host, threads or KV type.".into());
    }
    if s.prefix_cache_gb > 0.0 && !s.mtp_path.trim().is_empty() {
        return Err("QwFNfer prefix cache cannot be used together with MTP.".into());
    }
    Ok(())
}

pub async fn metrics(base: &str, api_key: Option<&str>) -> Result<llama::MetricsSnapshot, String> {
    let mut request = reqwest::Client::new()
        .get(format!("{}/stats", base.trim_end_matches('/')))
        .timeout(std::time::Duration::from_secs(3));
    if let Some(key) = api_key.filter(|v| !v.is_empty()) {
        request = request.bearer_auth(key);
    }
    let payload = request
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    Ok(parse_metrics(&payload))
}
fn parse_metrics(p: &serde_json::Value) -> llama::MetricsSnapshot {
    let num = |section: &str, key: &str| {
        p[section][key]
            .as_f64()
            .filter(|v| v.is_finite())
            .unwrap_or(0.0)
            .max(0.0)
    };
    let total = num("context", "n_ctx");
    let used = num("context", "n_past");
    llama::MetricsSnapshot {
        generation_tps: num("generation", "tokens_per_second") as f32,
        generation_mean_tps: None,
        generation_window_seconds: None,
        prompt_tps: num("prompt", "tokens_per_second") as f32,
        requests_processing: usize::from(p["busy"].as_bool().unwrap_or(false)),
        requests_deferred: p["queued"].as_u64().unwrap_or(0) as usize,
        kv_cache_tokens: used as i64,
        n_tokens_max: total as i64,
        kv_cache_usage_ratio: if total > 0.0 {
            (used / total).min(1.0) as f32
        } else {
            0.0
        },
        ttft_ms: p["last"]["ttft_ms"]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(|v| v.round() as u64),
        model_name: Some("qwen3.8-flash-next".into()),
        available: p["context"].is_object(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_wrong_architecture_and_nonprimary_shard() {
        for (arch, shard, valid) in [
            ("llama", 0, false),
            ("qwen4exp", 1, false),
            ("qwen4exp", 0, true),
        ] {
            let p = serde_json::json!({"general.architecture":arch,"split.no":shard});
            assert_eq!(validate_metadata(p.as_object().unwrap()).is_ok(), valid);
        }
    }
    #[test]
    fn rejects_incompatible_cache_and_mtp_and_nonfinite_memory() {
        let mut s = QwfnSettings {
            prefix_cache_gb: 1.0,
            mtp_path: "draft.gguf".into(),
            ..Default::default()
        };
        assert!(validate_options(&s).is_err());
        s.mtp_path.clear();
        assert!(validate_options(&s).is_ok());
        s.ram_gb = f64::NAN;
        assert!(validate_options(&s).is_err());
    }
    #[test]
    fn parses_live_stats_and_context() {
        let m = parse_metrics(
            &serde_json::json!({"busy":true,"prompt":{"tokens_per_second":123},"generation":{"tokens_per_second":12.5},"context":{"n_past":450,"n_ctx":32768},"last":{"ttft_ms":12}}),
        );
        assert_eq!(m.requests_processing, 1);
        assert_eq!(m.kv_cache_tokens, 450);
        assert_eq!(m.n_tokens_max, 32768);
        assert_eq!(m.generation_tps, 12.5);
        assert_eq!(m.ttft_ms, Some(12));
    }
}
