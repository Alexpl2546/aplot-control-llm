//! Static Basalt v2 pack inspection and runtime protocol helpers.
//!
//! Pack inspection reads the fixed header and the small `meta` section only;
//! model weight sections can be many gigabytes and are never loaded here.

use crate::{llama, process::StartServerRequest};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::Duration,
};

const HEADER_BYTES: u64 = 64 * 1024;
const HEADER_FIXED_BYTES: usize = 64;
const SECTION_BYTES: usize = 128;
const SECTION_ALIGNMENT: u64 = 2 * 1024 * 1024;
const MAX_SECTIONS: usize = (HEADER_BYTES as usize - HEADER_FIXED_BYTES) / SECTION_BYTES;
const MAX_META_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BasaltPackInfo {
    pub format_version: u32,
    pub model_name: Option<String>,
    pub architecture: Option<String>,
    pub context_length: Option<u32>,
    pub input_modalities: Vec<String>,
    pub vision: bool,
    pub size_bytes: u64,
}

#[derive(Debug)]
struct Section {
    name: String,
    offset: u64,
    length: u64,
    sha256: [u8; 32],
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or("Basalt pack header is truncated")?;
    Ok(u32::from_le_bytes(slice.try_into().unwrap()))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, String> {
    let slice = bytes
        .get(offset..offset + 8)
        .ok_or("Basalt pack header is truncated")?;
    Ok(u64::from_le_bytes(slice.try_into().unwrap()))
}

fn section_name(raw: &[u8]) -> Result<String, String> {
    let end = raw.iter().position(|byte| *byte == 0).unwrap_or(raw.len());
    if end == raw.len() || raw[end..].iter().any(|byte| *byte != 0) {
        return Err("Basalt pack section name is not NUL-padded".into());
    }
    let name = &raw[..end];
    let name = std::str::from_utf8(name).map_err(|_| "Basalt pack has a non-UTF8 section name")?;
    if name.is_empty() {
        return Err("Basalt pack has an empty section name".into());
    }
    Ok(name.to_string())
}

fn parse_sections(header: &[u8], file_bytes: u64, count: usize) -> Result<Vec<Section>, String> {
    if count == 0 || count > MAX_SECTIONS {
        return Err("Basalt pack has an invalid section count".into());
    }
    let mut sections = Vec::with_capacity(count);
    let mut names = std::collections::HashSet::with_capacity(count);
    for index in 0..count {
        let start = HEADER_FIXED_BYTES + index * SECTION_BYTES;
        let entry = header
            .get(start..start + SECTION_BYTES)
            .ok_or("Basalt pack section table is truncated")?;
        let name = section_name(&entry[..64])?;
        if !names.insert(name.clone()) {
            return Err(format!("Basalt pack repeats section '{name}'"));
        }
        let offset = read_u64(entry, 64)?;
        let length = read_u64(entry, 72)?;
        let end = offset
            .checked_add(length)
            .ok_or("Basalt pack section range overflows")?;
        if offset < HEADER_BYTES || offset % SECTION_ALIGNMENT != 0 || end > file_bytes {
            return Err(format!("Basalt pack section '{name}' is out of bounds"));
        }
        let mut sha256 = [0; 32];
        sha256.copy_from_slice(&entry[80..112]);
        sections.push(Section {
            name,
            offset,
            length,
            sha256,
        });
    }
    let mut ranges = sections
        .iter()
        .map(|section| (section.offset, section.offset + section.length))
        .collect::<Vec<_>>();
    ranges.sort_unstable();
    if ranges.windows(2).any(|pair| pair[0].1 > pair[1].0) {
        return Err("Basalt pack contains overlapping sections".into());
    }
    Ok(sections)
}

/// Inspect a Basalt model by its actual bytes. This intentionally accepts a
/// temporary/staging filename so the signed downloader can validate before
/// publishing it under its final `.basalt` name.
pub(crate) fn inspect_pack(path: &Path) -> Result<BasaltPackInfo, String> {
    let mut file =
        fs::File::open(path).map_err(|error| format!("Cannot open Basalt pack: {error}"))?;
    let actual_size = file
        .metadata()
        .map_err(|error| format!("Cannot read Basalt pack metadata: {error}"))?
        .len();
    if actual_size < HEADER_BYTES {
        return Err("Basalt pack is shorter than its 64 KiB header".into());
    }
    let mut header = vec![0; HEADER_BYTES as usize];
    file.read_exact(&mut header)
        .map_err(|_| "Basalt pack header is truncated")?;
    if header.get(..8) != Some(b"BASALTMF") {
        return Err("File is not a Basalt model pack".into());
    }
    let version = read_u32(&header, 8)?;
    if version != 2 {
        return Err(format!(
            "Unsupported Basalt pack version {version}; version 2 is required"
        ));
    }
    let count = read_u32(&header, 12)? as usize;
    let declared_size = read_u64(&header, 16)?;
    if declared_size < HEADER_BYTES || declared_size > actual_size {
        return Err("Basalt pack declared size is invalid or truncated".into());
    }
    let sections = parse_sections(&header, declared_size, count)?;
    let meta_section = sections
        .iter()
        .find(|section| section.name == "meta")
        .filter(|section| section.length > 0)
        .ok_or("Basalt pack is missing its meta section")?;
    if meta_section.length > MAX_META_BYTES {
        return Err("Basalt pack meta section is too large".into());
    }
    if !sections
        .iter()
        .any(|section| section.name == "tokenizer/vocab.json" && section.length > 0)
    {
        return Err("Basalt pack is missing tokenizer/vocab.json".into());
    }
    if !sections.iter().any(|section| {
        section.length > 0 && matches!(section.name.as_str(), "dense" | "experts" | "gguf")
    }) {
        return Err("Basalt pack has no supported model weight section".into());
    }
    let mut meta_bytes = vec![0; meta_section.length as usize];
    file.seek(SeekFrom::Start(meta_section.offset))
        .and_then(|_| file.read_exact(&mut meta_bytes))
        .map_err(|_| "Cannot read Basalt pack meta section")?;
    let digest = Sha256::digest(&meta_bytes);
    if digest.as_slice() != meta_section.sha256 {
        return Err("Basalt pack meta section checksum does not match".into());
    }
    let metadata: Value = serde_json::from_slice(&meta_bytes)
        .map_err(|error| format!("Invalid Basalt pack metadata: {error}"))?;
    if metadata.get("format").and_then(Value::as_str) != Some("basalt")
        || metadata.get("version").and_then(Value::as_u64) != Some(2)
    {
        return Err("Basalt pack metadata does not declare format basalt version 2".into());
    }
    let model_name = metadata
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned);
    let kv = metadata.get("gguf_kv").and_then(Value::as_object);
    let architecture = kv
        .and_then(|items| items.get("general.architecture"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned);
    let context_length = architecture
        .as_deref()
        .and_then(|arch| kv.and_then(|items| items.get(&format!("{arch}.context_length"))))
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0);
    let vision = sections
        .iter()
        .any(|section| section.name == "vision/mmproj");
    let mut input_modalities = vec!["text".to_string()];
    if vision {
        input_modalities.push("image".to_string());
    }
    Ok(BasaltPackInfo {
        format_version: version,
        model_name,
        architecture,
        context_length,
        input_modalities,
        vision,
        size_bytes: actual_size,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartBasaltServerRequest {
    pub root_path: String,
    pub model_path: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(alias = "ctxSize")]
    pub context_tokens: u32,
    pub parallel: u32,
}

fn resolved_path(value: &str) -> PathBuf {
    PathBuf::from(value.trim())
}

fn root_path(value: &str) -> Result<PathBuf, String> {
    if value.trim().is_empty() {
        return Err("Choose the Basalt installation folder in Settings.".into());
    }
    let root = crate::components::relocated_path("basalt", value.trim())
        .canonicalize()
        .map_err(|error| format!("Cannot open the Basalt folder: {error}"))?;
    let exe = root.join("bin").join("basalt.exe");
    let python = root.join(".venv").join("Scripts").join("python.exe");
    let server = root.join("serve").join("server.py");
    if !exe.is_file() || !python.is_file() || !server.is_file() {
        return Err("This folder is not a prepared Basalt installation. Expected bin/basalt.exe, .venv/Scripts/python.exe, and serve/server.py.".into());
    }
    Ok(root)
}

fn host_endpoint(host: &str, port: u16) -> Result<String, String> {
    let host = host.trim().trim_matches(['[', ']']);
    if host.is_empty() || port == 0 {
        return Err("Set a valid Basalt host and port in Settings.".into());
    }
    if !matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1" | "0.0.0.0" | "::"
    ) && host.parse::<std::net::IpAddr>().is_err()
    {
        return Err("Basalt host must be localhost, an IP address, or a wildcard address.".into());
    }
    let host_for_url = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    Ok(format!("http://{host_for_url}:{port}"))
}

pub(crate) fn prepare_start_request(
    request: StartBasaltServerRequest,
) -> Result<(StartServerRequest, BasaltPackInfo), String> {
    let root = root_path(&request.root_path)?;
    if request.parallel == 0 || request.parallel > 8 {
        return Err("Basalt parallel must be between 1 and 8.".into());
    }
    if request.context_tokens == 0 {
        return Err("Basalt context must be greater than zero.".into());
    }
    let requested_model_path = resolved_path(&request.model_path);
    if crate::domain::paths::is_aplot_staging_path(&requested_model_path) {
        return Err("A model in the download staging folder cannot be launched.".into());
    }
    let model_path = requested_model_path
        .canonicalize()
        .map_err(|error| format!("Cannot open the Basalt model pack: {error}"))?;
    if crate::domain::paths::is_aplot_staging_path(&model_path) {
        return Err("A model in the download staging folder cannot be launched.".into());
    }
    let filename = model_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !filename.to_ascii_lowercase().ends_with(".basalt")
        || filename.contains(".aplot-staging")
        || filename.starts_with(".aplot-")
        || !model_path.is_file()
    {
        return Err("Choose a published .basalt model pack.".into());
    }
    let model = inspect_pack(&model_path)?;
    let endpoint = host_endpoint(&request.host, request.port)?;
    let host = request.host.trim().trim_matches(['[', ']']);
    let is_loopback = matches!(
        host.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1"
    );
    let api_key = request.api_key.unwrap_or_default().trim().to_string();
    if !is_loopback && api_key.trim().is_empty() {
        return Err("Set a Basalt API key before listening on the local network.".into());
    }
    let host_arg = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.into()
    };
    let mut args = vec![
        "serve".into(),
        "--model".into(),
        model_path.to_string_lossy().into_owned(),
        "--host".into(),
        host_arg,
        "--port".into(),
        request.port.to_string(),
        "--max-context".into(),
        request.context_tokens.to_string(),
        "--parallel".into(),
        request.parallel.to_string(),
    ];
    if request.parallel > 1 {
        args.push("--slot-full-context".into());
    }
    if model.vision {
        args.extend(["--vision".into(), "dynamic".into()]);
    }
    Ok((
        StartServerRequest {
            binary_path: root
                .join("bin")
                .join("basalt.exe")
                .to_string_lossy()
                .into_owned(),
            args,
            endpoint: Some(endpoint),
            profile_id: model.model_name.clone(),
            backend: Some("basalt".into()),
            working_directory: Some(root.to_string_lossy().into_owned()),
            api_key: (!api_key.is_empty()).then_some(api_key),
        },
        model,
    ))
}

pub(crate) async fn health(base: &str, api_key: Option<&str>) -> llama::HealthResult {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(_) => return unreachable_health(),
    };
    let mut query = client.get(format!("{}/health", base.trim_end_matches('/')));
    if let Some(key) = api_key.filter(|key| !key.is_empty()) {
        query = query.bearer_auth(key);
    }
    match query.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.json::<Value>().await.ok();
            parse_health(status, body.as_ref())
        }
        Err(_) => unreachable_health(),
    }
}

pub(crate) fn parse_health(status: u16, body: Option<&Value>) -> llama::HealthResult {
    let reachable = (200..300).contains(&status);
    let ready = reachable
        && body.is_some_and(|value| {
            value.get("loaded").and_then(Value::as_bool) == Some(true)
                && value.get("loading").and_then(Value::as_bool) != Some(true)
        });
    llama::HealthResult {
        reachable,
        ready,
        status,
    }
}

fn unreachable_health() -> llama::HealthResult {
    llama::HealthResult {
        reachable: false,
        ready: false,
        status: 0,
    }
}

fn number(value: &Value, key: &str) -> f64 {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number >= 0.0)
        .unwrap_or(0.0)
}

pub(crate) fn parse_metrics(value: &Value) -> Option<llama::MetricsSnapshot> {
    let engine = value.get("engine")?;
    let live = value.get("live")?;
    let model_name = engine.get("model")?.as_str()?.to_owned();
    let requests = value.get("requests").and_then(Value::as_array);
    let latest = requests.and_then(|items| items.first());
    let prompt_tps_from_request = latest
        .map(|request| {
            let uncached = (number(request, "prompt_tokens") - number(request, "reused")).max(0.0);
            let ms = number(request, "prompt_ms");
            if ms > 0.0 {
                uncached * 1000.0 / ms
            } else {
                0.0
            }
        })
        .unwrap_or(0.0);
    let state = live
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let prompt_tps = if state == "reading" {
        number(live, "prefill_tok_s_mean").max(prompt_tps_from_request)
    } else {
        prompt_tps_from_request
    };
    let generation_tps = if number(live, "tok_s") > 0.0 {
        number(live, "tok_s")
    } else {
        latest
            .map(|request| number(request, "decode_tok_s"))
            .unwrap_or(0.0)
    };
    let active = live
        .get("slots")
        .and_then(|slots| slots.get("active"))
        .and_then(Value::as_u64)
        .map(|active| active as usize)
        .unwrap_or_else(|| usize::from(matches!(state, "reading" | "generating")));
    let queued = live
        .get("queued")
        .and_then(Value::as_u64)
        .or_else(|| {
            live.get("slots")
                .and_then(|slots| slots.get("queue_depth"))
                .and_then(Value::as_u64)
        })
        .unwrap_or(0) as usize;
    let slot_total = live
        .get("slots")
        .and_then(|slots| slots.get("total"))
        .and_then(Value::as_u64)
        .unwrap_or(1);
    // Basalt reports the per-slot limit under engine.max_context. The shared
    // runtime DTO presents total capacity, so multiply only for the no-/slots
    // fallback; normal snapshots prefer the sum of each /slots row.
    let max_context = number(engine, "max_context") as i64 * slot_total as i64;
    let ttft = live
        .get("ttft_s")
        .and_then(Value::as_f64)
        .or_else(|| {
            latest
                .and_then(|request| request.get("ttft_s"))
                .and_then(Value::as_f64)
        })
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|seconds| (seconds * 1000.0).round() as u64);
    Some(llama::MetricsSnapshot {
        ttft_ms: ttft,
        prompt_tps: prompt_tps as f32,
        generation_tps: generation_tps as f32,
        generation_mean_tps: None,
        generation_window_seconds: None,
        requests_processing: active,
        requests_deferred: queued,
        kv_cache_usage_ratio: 0.0,
        // Basalt /slots includes held context for every slot. Let runtime sum
        // that endpoint instead of showing only the newest parallel request.
        kv_cache_tokens: 0,
        n_tokens_max: max_context,
        model_name: Some(model_name),
        available: true,
    })
}

pub(crate) async fn metrics(
    base: &str,
    api_key: Option<&str>,
) -> Result<llama::MetricsSnapshot, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let mut query = client.get(format!("{}/metrics", base.trim_end_matches('/')));
    if let Some(key) = api_key.filter(|key| !key.is_empty()) {
        query = query.bearer_auth(key);
    }
    let response = query.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Ok(llama::MetricsSnapshot::default());
    }
    let value = response.json::<Value>().await.map_err(|e| e.to_string())?;
    Ok(parse_metrics(&value).unwrap_or_default())
}

pub(crate) fn parse_slots(value: &Value) -> Result<Vec<llama::SlotSnapshot>, String> {
    let slots = value
        .as_array()
        .ok_or("Basalt /slots did not return an array")?;
    let mut result = Vec::with_capacity(slots.len());
    for slot in slots {
        let number_i64 = |key: &str| slot.get(key).and_then(Value::as_i64).unwrap_or(0).max(0);
        let state = slot.get("state").and_then(Value::as_str).unwrap_or("idle");
        let active = slot
            .get("is_processing")
            .and_then(Value::as_bool)
            .unwrap_or(state != "idle");
        let n_ctx = number_i64("n_ctx");
        let ctx_used = number_i64("ctx_used");
        let generated = number_i64("generated");
        let model_id = slot
            .get("model_id")
            .or_else(|| slot.get("model"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let prompt_ms = number_i64("prompt_ms");
        let prompt_tokens = number_i64("prompt_tokens");
        let reused = number_i64("reused");
        let generation_speed = slot.get("tok_s").and_then(Value::as_f64).unwrap_or(0.0) as f32;
        let prompt_speed = if prompt_ms > 0 {
            (prompt_tokens - reused).max(0) as f32 * 1000.0 / prompt_ms as f32
        } else {
            0.0
        };
        let generated_for_state = if state == "prefill" {
            0
        } else {
            generated.max(1)
        };
        let next_token = if active {
            vec![llama::SlotNextToken {
                n_decoded: generated_for_state,
            }]
        } else {
            Vec::new()
        };
        result.push(llama::SlotSnapshot {
            id: slot.get("id").and_then(Value::as_i64).unwrap_or(0),
            model_id,
            id_task: None,
            is_processing: active,
            n_ctx,
            n_past: ctx_used,
            n_prompt_tokens: Some(ctx_used),
            next_token,
            timings: Some(llama::SlotTimings {
                predicted_per_second: generation_speed,
                prompt_per_second: prompt_speed,
            }),
        });
    }
    Ok(result)
}

pub(crate) async fn slots(
    base: &str,
    api_key: Option<&str>,
) -> Result<Vec<llama::SlotSnapshot>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let mut query = client.get(format!("{}/slots", base.trim_end_matches('/')));
    if let Some(key) = api_key.filter(|key| !key.is_empty()) {
        query = query.bearer_auth(key);
    }
    let response = query.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("/slots returned {}", response.status()));
    }
    parse_slots(&response.json::<Value>().await.map_err(|e| e.to_string())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn temp_file(name: &str, data: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "aplot-basalt-fixture-{}-{name}",
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, data).unwrap();
        path
    }

    fn pack_fixture(meta: &[u8], vision: bool) -> Vec<u8> {
        let mut contents = vec![meta, br"{}".as_slice(), b"fixture weights".as_slice()];
        let mut names = vec!["meta", "tokenizer/vocab.json", "dense"];
        if vision {
            names.push("vision/mmproj");
            contents.push(b"fixture projector".as_slice());
        }
        let count = contents.len();
        let mut pack = vec![0_u8; HEADER_BYTES as usize];
        pack[..8].copy_from_slice(b"BASALTMF");
        pack[8..12].copy_from_slice(&2_u32.to_le_bytes());
        pack[12..16].copy_from_slice(&(count as u32).to_le_bytes());
        let mut offset = HEADER_BYTES;
        for index in 0..count {
            let aligned =
                (pack.len() as u64 + SECTION_ALIGNMENT - 1) / SECTION_ALIGNMENT * SECTION_ALIGNMENT;
            pack.resize(aligned as usize, 0);
            offset = aligned;
            let start = HEADER_FIXED_BYTES + index * SECTION_BYTES;
            pack[start..start + names[index].len()].copy_from_slice(names[index].as_bytes());
            pack[start + 64..start + 72].copy_from_slice(&offset.to_le_bytes());
            pack[start + 72..start + 80]
                .copy_from_slice(&(contents[index].len() as u64).to_le_bytes());
            let digest = Sha256::digest(contents[index]);
            pack[start + 80..start + 112].copy_from_slice(&digest);
            pack.extend_from_slice(contents[index]);
            offset += contents[index].len() as u64;
        }
        pack[16..24].copy_from_slice(&offset.to_le_bytes());
        pack
    }

    #[test]
    fn inspects_v2_metadata_from_staging_filename_without_reading_weight_format() {
        let metadata = br#"{"format":"basalt","version":2,"name":"fixture","gguf_kv":{"general.architecture":"llama","llama.context_length":32768}}"#;
        let path = temp_file(".aplot-staging", &pack_fixture(metadata, false));
        let info = inspect_pack(&path).unwrap();
        assert_eq!(info.format_version, 2);
        assert_eq!(info.model_name.as_deref(), Some("fixture"));
        assert_eq!(info.architecture.as_deref(), Some("llama"));
        assert_eq!(info.context_length, Some(32768));
        assert_eq!(info.input_modalities, ["text"]);
        assert_eq!(info.size_bytes, fs::metadata(&path).unwrap().len());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_metadata_checksum_mismatch_and_non_v2() {
        let metadata = br#"{"format":"basalt","version":2}"#;
        let mut pack = pack_fixture(metadata, false);
        pack[HEADER_FIXED_BYTES + 80] ^= 0xff;
        let path = temp_file("bad-hash", &pack);
        assert!(inspect_pack(&path).unwrap_err().contains("checksum"));
        let _ = fs::remove_file(path);
        let mut pack = pack_fixture(metadata, false);
        pack[8..12].copy_from_slice(&1_u32.to_le_bytes());
        let path = temp_file("old-version", &pack);
        assert!(inspect_pack(&path).unwrap_err().contains("version 2"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn maps_basalt_health_and_metric_shape_without_claiming_ready_on_http_200() {
        let loading = serde_json::json!({"loaded":false,"loading":true});
        assert!(parse_health(200, Some(&loading)).reachable);
        assert!(!parse_health(200, Some(&loading)).ready);
        let ready = serde_json::json!({"loaded":true,"loading":false});
        assert!(parse_health(200, Some(&ready)).ready);
        assert!(!parse_health(503, Some(&ready)).ready);
        let metrics = parse_metrics(&serde_json::json!({
            "engine":{"model":"fixture","max_context":8192},
            "live":{"state":"generating","queued":2,"prompt_tokens":100,"generated":7,"tok_s":21.5,"slots":{"active":1}},
            "requests":[{"prompt_tokens":100,"reused":25,"prompt_ms":500,"decode_tok_s":20,"ttft_s":0.2}]
        })).unwrap();
        assert_eq!(metrics.model_name.as_deref(), Some("fixture"));
        assert_eq!(metrics.n_tokens_max, 8192);
        // Active context is aggregated from every /slots row, not just the
        // newest request described by /metrics.live.
        assert_eq!(metrics.kv_cache_tokens, 0);
        assert_eq!(metrics.requests_processing, 1);
        assert_eq!(metrics.requests_deferred, 2);
        assert_eq!(metrics.prompt_tps, 150.0);
        assert_eq!(metrics.generation_tps, 21.5);
        assert_eq!(metrics.ttft_ms, Some(200));
    }

    #[test]
    fn maps_basalt_slots_into_shared_runtime_shape() {
        let slots = parse_slots(&serde_json::json!([{
            "id":0,"n_ctx":4096,"is_processing":true,"state":"decoding","tok_s":22.0,
            "generated":9,"prompt_tokens":120,"ctx_used":129,"reused":10,"prompt_ms":550
        }]))
        .unwrap();
        assert_eq!(slots[0].n_ctx, 4096);
        assert_eq!(slots[0].context_tokens(), 129);
        assert_eq!(slots[0].runtime_state(), "generating");
        assert_eq!(
            slots[0].timings.as_ref().unwrap().predicted_per_second,
            22.0
        );
    }

    #[test]
    fn prepares_native_launch_with_per_slot_context_and_pack_vision() {
        let root = std::env::temp_dir().join(format!(
            "aplot-basalt-install-fixture-{}",
            uuid::Uuid::new_v4()
        ));
        let pack_path = std::env::temp_dir().join(format!(
            "aplot-basalt-model-fixture-{}.basalt",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(root.join(".venv/Scripts")).unwrap();
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::write(root.join("bin/basalt.exe"), b"fixture").unwrap();
        fs::write(root.join(".venv/Scripts/python.exe"), b"fixture").unwrap();
        fs::write(root.join("serve/server.py"), b"fixture").unwrap();
        let metadata = br#"{"format":"basalt","version":2,"name":"vision-fixture","gguf_kv":{"general.architecture":"llama","llama.context_length":32768}}"#;
        fs::write(&pack_path, pack_fixture(metadata, true)).unwrap();

        let (launch, model) = prepare_start_request(StartBasaltServerRequest {
            root_path: root.to_string_lossy().into_owned(),
            model_path: pack_path.to_string_lossy().into_owned(),
            host: "127.0.0.1".into(),
            port: 8123,
            api_key: None,
            context_tokens: 32768,
            parallel: 2,
        })
        .unwrap();

        assert_eq!(launch.backend.as_deref(), Some("basalt"));
        assert_eq!(launch.endpoint.as_deref(), Some("http://127.0.0.1:8123"));
        assert_eq!(
            crate::engine_adapters::argument_value(&launch.args, &["--max-context"]),
            Some("32768")
        );
        assert_eq!(
            crate::engine_adapters::argument_value(&launch.args, &["--parallel"]),
            Some("2")
        );
        assert!(launch.args.iter().any(|arg| arg == "--slot-full-context"));
        assert!(launch
            .args
            .windows(2)
            .any(|pair| { pair[0] == "--vision" && pair[1] == "dynamic" }));
        let expected_model_path = pack_path
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(
            crate::engine_adapters::argument_value(&launch.args, &["--model"]),
            Some(expected_model_path.as_str())
        );
        assert_eq!(model.input_modalities, ["text", "image"]);

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(pack_path);
    }
}
