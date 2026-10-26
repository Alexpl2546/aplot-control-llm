//! Read-only bridge from real run launch requests and native telemetry to P07.
//! No engine launch, lifecycle mutation, DB write or resource lease admission.
use crate::{
    hardware, resource_planner as rp,
    runs::{RunInfo, RunManager, RunRequest},
};
use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{BufReader, Read, Seek, SeekFrom},
    path::Path,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::State;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveResourceSummary {
    run_id: String,
    generation: u64,
    state: String,
    estimate: rp::ResourceEstimate,
    accounting_mode: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResourcePlan {
    #[serde(flatten)]
    plan: rp::ResourcePlan,
    warnings: Vec<String>,
    active_runs: Vec<ActiveResourceSummary>,
}
fn field_u64(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}
fn cli_value(args: &[String], flags: &[&str]) -> Option<String> {
    // Last occurrence wins. Handle common --flag=value without interpreting shell text.
    let mut result = None;
    for (index, arg) in args.iter().enumerate() {
        if flags.contains(&arg.as_str()) {
            result = args.get(index + 1).cloned();
        } else if let Some((name, value)) = arg.split_once('=') {
            if flags.contains(&name) {
                result = Some(value.into());
            }
        }
    }
    result
}
fn cli_number(args: &[String], flags: &[&str]) -> Option<u64> {
    cli_value(args, flags).and_then(|s| s.parse().ok())
}
fn has_flag(args: &[String], flags: &[&str]) -> bool {
    args.iter()
        .any(|arg| flags.contains(&arg.split('=').next().unwrap_or(arg)))
}
fn cache_bytes(value: Option<String>) -> Option<f64> {
    match value.as_deref()? {
        "f32" => Some(4.0),
        "f16" | "bf16" => Some(2.0),
        "q8_0" => Some(34.0 / 32.0),
        "q4_0" | "iq4_nl" => Some(18.0 / 32.0),
        "q4_1" => Some(20.0 / 32.0),
        "q5_0" => Some(22.0 / 32.0),
        "q5_1" => Some(24.0 / 32.0),
        _ => None,
    }
}
fn unknown_model() -> rp::ModelResourceMetadata {
    rp::ModelResourceMetadata {
        artifact_bytes: None,
        format: "unknown".into(),
        weights_complete: false,
        architecture: "unknown".into(),
        attention: "unknown".into(),
        kv: None,
    }
}
fn options() -> rp::EngineResourceOptions {
    rp::EngineResourceOptions {
        placement: "engineManaged".into(),
        gpu_id: Some("gpu0".into()),
        gpu_layers: None,
        kv_on_gpu: false,
        kv_capacity_tokens: None,
        kv_capacity_scales_with_context: false,
        unmodelled_allocations: true,
        workspace_ram: None,
        workspace_gpu: None,
        extra_ram_bytes: 0,
        pinned_ram_bytes: 0,
        extra_gpu_bytes: BTreeMap::new(),
        gpu_budget_bytes: BTreeMap::new(),
        spare_ram_bytes: 0,
        spare_gpu_bytes: BTreeMap::new(),
    }
}

// The catalogue GGUF reader filters expert/SWA/head-dimension keys.
// This narrower bounded reader keeps the required shape metadata; no tensor payloads are read.
fn read_u32(r: &mut impl Read) -> Result<u32, String> {
    let mut b = [0; 4];
    r.read_exact(&mut b)
        .map_err(|_| "Truncated GGUF metadata")?;
    Ok(u32::from_le_bytes(b))
}
fn read_u64(r: &mut impl Read) -> Result<u64, String> {
    let mut b = [0; 8];
    r.read_exact(&mut b)
        .map_err(|_| "Truncated GGUF metadata")?;
    Ok(u64::from_le_bytes(b))
}
fn skip(r: &mut BufReader<File>, n: u64, file_len: u64) -> Result<(), String> {
    let end = r
        .stream_position()
        .map_err(|_| "Cannot seek GGUF metadata")?
        .checked_add(n)
        .ok_or("GGUF metadata overflow")?;
    if end > file_len || end > 64 * 1024 * 1024 {
        return Err("GGUF metadata scan exceeds its read-only header limit".into());
    }
    r.seek(SeekFrom::Start(end))
        .map_err(|_| "Cannot seek GGUF metadata")?;
    Ok(())
}
fn metadata_string(r: &mut BufReader<File>) -> Result<String, String> {
    let n = read_u64(r)?;
    if n > 64 * 1024 {
        return Err("Oversized captured GGUF metadata string".into());
    }
    let mut bytes = vec![0; n as usize];
    r.read_exact(&mut bytes)
        .map_err(|_| "Truncated GGUF string")?;
    String::from_utf8(bytes).map_err(|_| "Invalid GGUF metadata string".into())
}
fn metadata_value(
    r: &mut BufReader<File>,
    ty: u32,
    capture: bool,
    file_len: u64,
) -> Result<Value, String> {
    let width = match ty {
        0 | 1 | 7 => Some(1),
        2 | 3 => Some(2),
        4 | 5 | 6 => Some(4),
        10 | 11 | 12 => Some(8),
        _ => None,
    };
    if let Some(width) = width {
        if !capture {
            skip(r, width, file_len)?;
            return Ok(Value::Null);
        }
        let mut bytes = [0u8; 8];
        r.read_exact(&mut bytes[..width as usize])
            .map_err(|_| "Truncated GGUF scalar")?;
        return Ok(match ty {
            0 => Value::from(bytes[0]),
            1 => Value::from(bytes[0] as i8),
            7 => Value::Bool(bytes[0] != 0),
            2 => Value::from(u16::from_le_bytes(bytes[..2].try_into().unwrap())),
            3 => Value::from(i16::from_le_bytes(bytes[..2].try_into().unwrap())),
            4 => Value::from(u32::from_le_bytes(bytes[..4].try_into().unwrap())),
            5 => Value::from(i32::from_le_bytes(bytes[..4].try_into().unwrap())),
            6 => Value::from(f32::from_le_bytes(bytes[..4].try_into().unwrap())),
            10 => Value::from(u64::from_le_bytes(bytes)),
            11 => Value::from(i64::from_le_bytes(bytes)),
            12 => Value::from(f64::from_le_bytes(bytes)),
            _ => unreachable!(),
        });
    }
    match ty {
        8 if capture => Ok(Value::String(metadata_string(r)?)),
        8 => {
            let n = read_u64(r)?;
            skip(r, n, file_len)?;
            Ok(Value::Null)
        }
        9 => {
            let item_type = read_u32(r)?;
            let count = read_u64(r)?;
            if count > 2_000_000 || item_type == 9 {
                return Err("Unsupported/oversized GGUF metadata array".into());
            }
            for _ in 0..count {
                metadata_value(r, item_type, false, file_len)?;
            }
            // A per-layer array is not uniform metadata and must remain unknown.
            Ok(Value::Null)
        }
        _ => Err("Unsupported GGUF metadata value type".into()),
    }
}
fn resource_metadata(path: &Path) -> Result<Map<String, Value>, String> {
    let mut result = Map::new();
    let file = File::open(path).map_err(|_| "Cannot open GGUF metadata")?;
    let len = file
        .metadata()
        .map_err(|_| "Cannot inspect GGUF file")?
        .len();
    let mut r = BufReader::new(file);
    let mut magic = [0; 4];
    r.read_exact(&mut magic)
        .map_err(|_| "Truncated GGUF header")?;
    if magic != *b"GGUF" || !(2..=3).contains(&read_u32(&mut r)?) {
        return Err("Unsupported GGUF header".into());
    }
    let _tensors = read_u64(&mut r)?;
    let count = read_u64(&mut r)?;
    if count > 100_000 {
        return Err("Oversized GGUF metadata".into());
    }
    for _ in 0..count {
        if r.stream_position()
            .map_err(|_| "Cannot inspect GGUF metadata")?
            > 64 * 1024 * 1024
        {
            return Err("GGUF metadata header limit".into());
        }
        let key = metadata_string(&mut r)?;
        let ty = read_u32(&mut r)?;
        let capture = key == "general.architecture"
            || key.starts_with("split.")
            || [
                ".expert_count",
                ".attention.sliding_window",
                ".attention.key_length",
                ".attention.value_length",
                ".block_count",
                ".embedding_length",
                ".attention.head_count",
                ".attention.head_count_kv",
            ]
            .iter()
            .any(|suffix| key.ends_with(suffix));
        let value = metadata_value(&mut r, ty, capture, len)?;
        if capture {
            if result.insert(key, value).is_some() {
                return Err("Duplicate resource metadata key".into());
            }
        }
    }
    Ok(result)
}
fn artifact_bytes(path: &Path, metadata: &Map<String, Value>) -> Result<(u64, bool), String> {
    let one = fs::metadata(path)
        .map_err(|_| "Model artifact is unavailable")?
        .len();
    let count = metadata
        .get("split.count")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let file_name = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("Invalid artifact name")?;
    let shard = file_name
        .strip_suffix(".gguf")
        .and_then(|s| s.rsplit_once("-of-"))
        .and_then(|(left, total)| {
            left.rsplit_once('-')
                .map(|(prefix, index)| (prefix, index, total))
        });
    if count <= 1 && shard.is_none() {
        return Ok((one, true));
    }
    let Some((prefix, index, total)) = shard else {
        return Ok((one, false));
    };
    let n = total
        .parse::<u64>()
        .map_err(|_| "Unrecognized shard count")?;
    if n == 0 || n > 512 || n != count || index.parse::<u64>().ok().is_none_or(|i| i == 0 || i > n)
    {
        return Ok((one, false));
    }
    let mut bytes = 0u64;
    for i in 1..=n {
        let candidate = path.with_file_name(format!(
            "{prefix}-{i:0width$}-of-{total}.gguf",
            width = index.len()
        ));
        let Ok(info) = fs::metadata(candidate) else {
            return Ok((one, false));
        };
        if !info.is_file() {
            return Ok((one, false));
        }
        bytes = bytes
            .checked_add(info.len())
            .ok_or("Artifact byte sum overflow")?;
    }
    Ok((bytes, true))
}
fn model_from_metadata(
    path: &Path,
    metadata: &Map<String, Value>,
    args: &[String],
) -> Result<rp::ModelResourceMetadata, String> {
    let arch = metadata
        .get("general.architecture")
        .and_then(Value::as_str)
        .unwrap_or("");
    let number = |suffix: &str| {
        metadata
            .get(&format!("{arch}.{suffix}"))
            .and_then(Value::as_u64)
    };
    let expert_key = format!("{arch}.expert_count");
    let swa_key = format!("{arch}.attention.sliding_window");
    let experts = number("expert_count");
    let dense = arch == "llama" && (!metadata.contains_key(&expert_key) || experts == Some(0));
    let standard = dense && !metadata.contains_key(&swa_key)
        || dense && number("attention.sliding_window") == Some(0);
    let layers = number("block_count");
    let heads = number("attention.head_count");
    let kv_heads = number("attention.head_count_kv");
    let embedding = number("embedding_length");
    let head_dim = embedding.zip(heads).and_then(|(e, h)| {
        if h > 0 && e % h == 0 {
            Some(e / h)
        } else {
            None
        }
    });
    let kd = if metadata.contains_key(&format!("{arch}.attention.key_length")) {
        number("attention.key_length")
    } else {
        head_dim
    };
    let vd = if metadata.contains_key(&format!("{arch}.attention.value_length")) {
        number("attention.value_length")
    } else {
        head_dim
    };
    let k_bytes = cache_bytes(cli_value(args, &["--cache-type-k", "-ctk"]));
    let v_bytes = cache_bytes(cli_value(args, &["--cache-type-v", "-ctv"]));
    let kv = match (layers, kv_heads, kd, vd, k_bytes, v_bytes) {
        (Some(l), Some(h), Some(k), Some(v), Some(kb), Some(vb))
            if l > 0 && h > 0 && k > 0 && v > 0 =>
        {
            Some(rp::KvMetadata {
                layers: l,
                kv_heads: h,
                key_head_dim: k,
                value_head_dim: v,
                key_bytes_per_element: kb,
                value_bytes_per_element: vb,
            })
        }
        _ => None,
    };
    let (bytes, complete) = artifact_bytes(path, metadata)?;
    Ok(rp::ModelResourceMetadata {
        artifact_bytes: Some(bytes),
        format: "gguf".into(),
        weights_complete: complete,
        architecture: if experts.is_some_and(|v| v > 0) {
            "moe"
        } else if dense {
            "dense"
        } else {
            "unknown"
        }
        .into(),
        attention: if standard { "standard" } else { "other" }.into(),
        kv,
    })
}
fn request_resources(
    request: &RunRequest,
    warnings: &mut Vec<String>,
) -> Result<rp::ResourceRequest, String> {
    let mut model = unknown_model();
    let mut o = options();
    let mut context = u64::from(request.context_tokens);
    let minimum;
    match request.engine.as_str() {
        "llama_cpp" => {
            let args: Vec<String> = request
                .launch
                .get("args")
                .and_then(Value::as_array)
                .ok_or("Launch args are required")?
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .ok_or("Launch args must be strings")
                })
                .collect::<Result<_, _>>()?;
            if request.mode != "single" {
                warnings.push("Router allocation is unknown: active child residency and per-route cache capacity are not inferred from the preset.".into());
            } else if let Some(path) = cli_value(&args, &["--model", "-m"]) {
                match resource_metadata(Path::new(&path)).and_then(|meta|model_from_metadata(Path::new(&path),&meta,&args)) {Ok(value)=>model=value,Err(_)=>warnings.push("Model metadata or complete weight shards are unavailable; allocation is unknown.".into())}
            }
            let explicit_context = cli_number(&args, &["--ctx-size", "-c"]);
            context = explicit_context.filter(|v| *v > 0).unwrap_or(context);
            minimum = cli_number(&args, &["--fit-ctx", "-fitc"])
                .filter(|v| *v > 0)
                .unwrap_or(context);
            let parallel = cli_number(&args, &["--parallel", "-np"]);
            let fixed_capacity = explicit_context.is_some_and(|v| v > 0) && parallel == Some(1);
            o.kv_capacity_tokens = if fixed_capacity { Some(context) } else { None };
            o.kv_capacity_scales_with_context = fixed_capacity;
            if !fixed_capacity {
                warnings.push("Total KV capacity is unverified: explicit positive context and one parallel slot are required for the native dense strategy.".into());
            }
            let device = cli_value(&args, &["--device", "-dev"]);
            let gpu_layers = cli_value(&args, &["--gpu-layers", "--n-gpu-layers", "-ngl"]);
            let cpu = device.as_deref() == Some("none")
                || gpu_layers.as_deref() == Some("0")
                    && has_flag(&args, &["--no-kv-offload", "-nkvo"]);
            o.kv_on_gpu = !cpu && !has_flag(&args, &["--no-kv-offload", "-nkvo"]);
            if cpu {
                o.placement = "cpu".into();
                o.gpu_layers = Some(0);
            } else if let Some(layers) = model.kv.as_ref().map(|k| k.layers) {
                match gpu_layers.as_deref() {
                    Some("all" | "-1") => o.placement = "allGpu".into(),
                    Some(s) if s.parse::<u64>().ok().is_some_and(|v| v >= layers) => {
                        o.placement = "allGpu".into()
                    }
                    Some(s) if s.parse::<u64>().is_ok() => {
                        o.placement = "hybrid".into();
                        o.gpu_layers = s.parse().ok();
                    }
                    _ => {}
                }
            }
            if cpu && !matches!(device.as_deref(), Some("CUDA0" | "0")) {
                o.gpu_id = None;
            }
            let supported_device = (cpu || matches!(device.as_deref(), Some("CUDA0" | "0")))
                && cli_number(&args, &["--main-gpu", "-mg"]).unwrap_or(0) == 0;
            let auto_fit = !matches!(
                cli_value(&args, &["--fit", "-fit"]).as_deref(),
                Some("off" | "0")
            );
            let dependencies = has_flag(
                &args,
                &[
                    "--mmproj",
                    "--lora",
                    "--model-draft",
                    "-md",
                    "--ngram-volume",
                    "--override-kv",
                    "--mlock",
                ],
            );
            let conflicting_kv_flags = has_flag(&args, &["--kv-offload", "-kvo"])
                && has_flag(&args, &["--no-kv-offload", "-nkvo"]);
            let multi_gpu = cli_value(&args, &["--tensor-split", "-ts"]).is_some()
                || !matches!(
                    cli_value(&args, &["--split-mode", "-sm"]).as_deref(),
                    None | Some("none")
                );
            o.unmodelled_allocations = request.mode != "single"
                || auto_fit
                || dependencies
                || multi_gpu
                || !supported_device
                || conflicting_kv_flags;
            if auto_fit {
                warnings.push("Automatic fit/default allocator adjustment is not resolved by planning; the configured allocation remains unknown.".into());
            }
            if dependencies || multi_gpu || !supported_device {
                warnings.push("Additional allocations or GPU placement lack a validated native resource strategy.".into());
            }
            if let Some(spare) =
                cli_number(&args, &["--fit-target", "-fitt"]).and_then(|v| v.checked_mul(1_048_576))
            {
                o.spare_gpu_bytes.insert("gpu0".into(), spare);
            }
        }
        "strata" => {
            context = field_u64(&request.launch, "context")
                .filter(|v| *v > 0)
                .unwrap_or(context);
            minimum = context;
            warnings.push(format!("{} allocation has no calibrated native strategy; configured budgets are not resident memory.",request.engine));
        }
        _ => return Err("Unsupported resource planning engine".into()),
    }
    if context == 0 {
        return Err("Choose an explicit positive context before planning resources".into());
    }
    Ok(rp::ResourceRequest {
        engine: request.engine.clone(),
        model,
        context_tokens: context,
        minimum_context_tokens: minimum,
        options: o,
    })
}
fn pool_from_mib(total: f64, used: f64) -> rp::PoolBudget {
    let valid =
        total.is_finite() && used.is_finite() && total > 0.0 && used >= 0.0 && used <= total;
    let valid = valid && total * 1_048_576.0 <= 9_007_199_254_740_991.0;
    let capacity = (total * 1_048_576.0).floor() as u64;
    rp::PoolBudget {
        total_bytes: if valid { Some(capacity) } else { None },
        observed_used_bytes: if valid {
            Some(((used * 1_048_576.0).ceil() as u64).min(capacity))
        } else {
            None
        },
        free_bytes: None,
        limit_bytes: None,
        spare_bytes: 0,
    }
}
fn hardware_budget(snapshot: hardware::HardwareSnapshot, age: u64) -> rp::HardwareBudget {
    let mut gpus = BTreeMap::new();
    if let Some(gpu) = snapshot.gpu {
        gpus.insert(
            "gpu0".into(),
            pool_from_mib(
                f64::from(gpu.memory_total_mi_b),
                f64::from(gpu.memory_used_mi_b),
            ),
        );
    }
    rp::HardwareBudget {
        snapshot_id: format!(
            "native-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ),
        snapshot_age_ms: age,
        max_snapshot_age_ms: 2000,
        ram: pool_from_mib(
            snapshot.memory_total_mi_b as f64,
            snapshot.memory_used_mi_b as f64,
        ),
        pinned_ram: None,
        gpus,
    }
}
fn combine_plan(
    hardware: rp::HardwareBudget,
    request: rp::ResourceRequest,
    active: Vec<(rp::ResourceRequest, RunInfo)>,
    mut warnings: Vec<String>,
) -> Result<NativeResourcePlan, String> {
    let baseline = rp::ResourcePlannerInput {
        hardware: hardware.clone(),
        claims: vec![],
        observations: vec![],
        request: request.clone(),
    };
    let baseline_plan = rp::plan_resources(&baseline).map_err(|e| e.to_string())?;
    let mut input = baseline;
    let mut active_runs = Vec::new();
    let mut active_unknown = false;
    for (active_request, info) in active {
        let active_input = rp::ResourcePlannerInput {
            request: active_request,
            ..input.clone()
        };
        let estimate = rp::plan_resources(&active_input)
            .map_err(|e| e.to_string())?
            .candidates
            .remove(0)
            .estimate;
        let complete = estimate.ram.max.is_some()
            && estimate.pinned_ram.max.is_some()
            && estimate.gpus.values().all(|v| v.max.is_some());
        if complete {
            input.claims.push(rp::ResourceClaim {
                claim_id: format!("planning:{}:{}", info.run_id, info.generation),
                owner_id: format!("run:{}", info.run_id),
                generation: info.generation,
                amounts: rp::ResourceAmounts {
                    ram_bytes: estimate.ram.max.unwrap(),
                    pinned_ram_bytes: estimate.pinned_ram.max.unwrap(),
                    gpu_bytes: estimate
                        .gpus
                        .iter()
                        .map(|(id, v)| (id.clone(), v.max.unwrap()))
                        .collect(),
                },
            });
        } else {
            active_unknown = true;
        }
        active_runs.push(ActiveResourceSummary {
            run_id: info.run_id,
            generation: info.generation,
            state: info.state,
            estimate,
            accounting_mode: if complete {
                "conservativeEstimateClaim"
            } else {
                "globalObservedOnly"
            }
            .into(),
        });
    }
    let mut plan = rp::plan_resources(&input).map_err(|e| e.to_string())?;
    if !active_runs.is_empty() {
        warnings.push("Active process memory has no same-snapshot PID attribution. Bounded active envelopes are conservatively counted in full and may overlap global observed usage; unknown active growth is not silently zero.".into());
        for c in &mut plan.candidates {
            let base = baseline_plan
                .candidates
                .iter()
                .find(|v| v.id == c.id)
                .unwrap();
            if base.status != "insufficient" {
                if active_unknown || base.status == "unknown" {
                    c.status = "unknown".into();
                } else {
                    c.status = "advisory".into();
                }
                for a in &mut c.assessments {
                    if a.status == "insufficient"
                        && base
                            .assessments
                            .iter()
                            .any(|b| b.pool == a.pool && b.status != "insufficient")
                    {
                        a.status = "advisory".into();
                    }
                }
            }
            c.estimate.reasons.push("Active allocation envelopes are unverified; inspect warnings before treating conservative pressure as admission evidence.".into());
        }
    }
    warnings.push("Native telemetry currently exposes RAM and only the first NVIDIA GPU; pinned capacity and per-process GPU/RAM attribution are unavailable.".into());
    warnings.sort();
    warnings.dedup();
    Ok(NativeResourcePlan {
        plan,
        warnings,
        active_runs,
    })
}
#[tauri::command]
pub async fn plan_run_resources(
    manager: State<'_, RunManager>,
    request: RunRequest,
) -> Result<NativeResourcePlan, String> {
    let active = manager.resource_requests().await?;
    tokio::task::spawn_blocking(move||{
        let mut warnings=Vec::new();let request=request_resources(&request,&mut warnings)?;
        let mut resources=Vec::new();for (run,info) in active {match request_resources(&run,&mut warnings){Ok(value)=>resources.push((value,info)),Err(_)=>{
            let fallback=rp::ResourceRequest{engine:info.engine.clone(),model:unknown_model(),context_tokens:u64::from(info.context_tokens.max(1)),minimum_context_tokens:u64::from(info.context_tokens.max(1)),options:options()};
            resources.push((fallback,info));warnings.push("An active launch lacks usable metadata; its future memory demand is unknown.".into());
        }}}
        let at=Instant::now();let snapshot=hardware::collect_hardware();
        let age=750+at.elapsed().as_millis().min(u128::from(u64::MAX-750)) as u64;
        combine_plan(hardware_budget(snapshot,age),request,resources,warnings)
    }).await.map_err(|_|"Resource planning task failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn native_request(engine: &str, launch: Value) -> RunRequest {
        RunRequest {
            run_id: "test".into(),
            name: "test".into(),
            engine: engine.into(),
            mode: "single".into(),
            model_id: "test".into(),
            context_tokens: 8192,
            auto_port: false,
            launch,
        }
    }
    #[test]
    fn removed_engines_are_rejected_by_resource_planning() {
        for engine in ["ollama", "qwfnfer", "infernix", "unknown-engine"] {
            let request = native_request(engine, serde_json::json!({}));
            assert!(
                request_resources(&request, &mut vec![]).is_err(),
                "{engine}"
            );
        }
    }
    #[test]
    fn flags_are_last_wins_and_equal_form_is_supported() {
        let args = vec!["--ctx-size".into(), "8192".into(), "--ctx-size=4096".into()];
        assert_eq!(cli_number(&args, &["--ctx-size", "-c"]), Some(4096));
        assert_eq!(cache_bytes(Some("q5_1".into())), Some(0.75));
    }
    #[test]
    fn absent_or_failed_gpu_readings_are_not_free_memory() {
        assert!(pool_from_mib(0.0, 0.0).total_bytes.is_none());
        assert!(pool_from_mib(10.0, 11.0).total_bytes.is_none());
    }
    fn with_gguf<T>(mut metadata: Map<String, Value>, run: impl FnOnce(&Path) -> T) -> T {
        metadata
            .entry("general.architecture")
            .or_insert(Value::String("llama".into()));
        for (key, value) in [
            ("llama.block_count", 32),
            ("llama.embedding_length", 4096),
            ("llama.attention.head_count", 32),
            ("llama.attention.head_count_kv", 8),
        ] {
            metadata.entry(key).or_insert(Value::from(value));
        }
        let mut bytes = b"GGUF".to_vec();
        bytes.extend(3u32.to_le_bytes());
        bytes.extend(0u64.to_le_bytes());
        bytes.extend((metadata.len() as u64).to_le_bytes());
        let string = |out: &mut Vec<u8>, s: &str| {
            out.extend((s.len() as u64).to_le_bytes());
            out.extend(s.as_bytes());
        };
        for (key, value) in metadata {
            string(&mut bytes, &key);
            if let Some(s) = value.as_str() {
                bytes.extend(8u32.to_le_bytes());
                string(&mut bytes, s);
            } else {
                bytes.extend(10u32.to_le_bytes());
                bytes.extend(value.as_u64().unwrap().to_le_bytes());
            }
        }
        let path = std::env::temp_dir().join(format!(
            "aplot-resource-fixture-{}-{}.gguf",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, bytes).unwrap();
        let result = run(&path);
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("failed to remove GGUF test fixture: {error}"),
        }
        result
    }
    fn cpu_request(path: &Path) -> RunRequest {
        native_request(
            "llama_cpp",
            serde_json::json!({"binaryPath":"unused","args":["--model",path.to_string_lossy(),"--ctx-size","8192","--gpu-layers","0","--device","none","--no-kv-offload","--cache-type-k","f16","--cache-type-v","f16","--parallel","1","--fit","off","--fit-ctx","4096"]}),
        )
    }
    fn test_budget() -> rp::HardwareBudget {
        rp::HardwareBudget {
            snapshot_id: "fixture".into(),
            snapshot_age_ms: 0,
            max_snapshot_age_ms: 1000,
            ram: pool_from_mib(65536.0, 8192.0),
            pinned_ram: None,
            gpus: BTreeMap::new(),
        }
    }
    #[test]
    fn actual_cpu_flags_and_metadata_produce_approximate_kv_without_gpu_or_process_launch() {
        with_gguf(Map::new(), |path| {
            let request = request_resources(&cpu_request(path), &mut vec![]).unwrap();
            assert_eq!(request.options.placement, "cpu");
            assert!(!request.options.kv_on_gpu);
            assert!(!request.options.unmodelled_allocations);
            let result = combine_plan(test_budget(), request, vec![], vec![]).unwrap();
            let candidate = &result.plan.candidates[0];
            assert_eq!(
                candidate.estimate.kv.as_ref().unwrap().min,
                1024 * 1024 * 1024
            );
            assert!(candidate.estimate.gpus.is_empty());
            assert_eq!(candidate.estimate.confidence, "low");
            assert_eq!(candidate.status, "withinEstimate");
        });
    }
    #[test]
    fn gpu_alias_mapping_does_not_guess_parallel_capacity_or_auto_fit() {
        with_gguf(Map::new(), |path| {
            let mut request = cpu_request(path);
            request.launch["args"] = serde_json::json!([
                "--model",
                path.to_string_lossy(),
                "--ctx-size=8192",
                "--n-gpu-layers=32",
                "--device",
                "CUDA0",
                "--cache-type-k",
                "q5_1",
                "--cache-type-v",
                "q5_1",
                "--parallel",
                "1",
                "--fit",
                "off"
            ]);
            let mapped = request_resources(&request, &mut vec![]).unwrap();
            assert_eq!(mapped.options.placement, "allGpu");
            assert!(!mapped.options.unmodelled_allocations);
            assert_eq!(mapped.model.kv.unwrap().key_bytes_per_element, 0.75);
            let args = request.launch["args"].as_array_mut().unwrap();
            args.pop();
            args.pop();
            assert!(
                request_resources(&request, &mut vec![])
                    .unwrap()
                    .options
                    .unmodelled_allocations
            );
            request.launch["args"]
                .as_array_mut()
                .unwrap()
                .extend([Value::from("--parallel=2"), Value::from("--fit=off")]);
            assert!(request_resources(&request, &mut vec![])
                .unwrap()
                .options
                .kv_capacity_tokens
                .is_none());
        });
    }
    #[test]
    fn configured_context_floor_is_not_silently_lowered() {
        with_gguf(Map::new(), |path| {
            let mut request = cpu_request(path);
            request.launch["args"]
                .as_array_mut()
                .unwrap()
                .push(Value::from("--fit-ctx=16384"));
            let mapped = request_resources(&request, &mut vec![]).unwrap();
            assert_eq!(mapped.minimum_context_tokens, 16384);
            assert!(combine_plan(test_budget(), mapped, vec![], vec![]).is_err());
        });
    }
    #[test]
    fn unattributed_active_claim_pressure_is_advisory_and_known_free_insufficiency_survives() {
        with_gguf(Map::new(), |path| {
            let request = request_resources(&cpu_request(path), &mut vec![]).unwrap();
            let info = RunInfo {
                run_id: "active".into(),
                name: "active".into(),
                engine: "llama_cpp".into(),
                mode: "single".into(),
                endpoint: "unused".into(),
                model_id: "x".into(),
                context_tokens: 8192,
                state: "ready".into(),
                pid: None,
                generation: 1,
                managed: true,
                started_at: None,
                last_error: None,
            };
            let mut budget = test_budget();
            budget.ram = pool_from_mib(4096.0, 1024.0);
            let result = combine_plan(
                budget.clone(),
                request.clone(),
                vec![(request.clone(), info.clone())],
                vec![],
            )
            .unwrap();
            assert_eq!(result.plan.candidates[0].status, "advisory");
            assert_eq!(
                result.active_runs[0].accounting_mode,
                "conservativeEstimateClaim"
            );
            assert_eq!(result.plan.candidates[0].assessments[0].status, "advisory");
            budget.ram = pool_from_mib(2048.0, 1536.0);
            let result =
                combine_plan(budget, request.clone(), vec![(request, info)], vec![]).unwrap();
            assert_eq!(result.plan.candidates[0].status, "insufficient");
        });
    }
    #[test]
    fn supplemental_metadata_blocks_swa_and_moe_dense_formula() {
        for (key, value) in [
            ("llama.attention.sliding_window", 4096),
            ("llama.expert_count", 8),
        ] {
            with_gguf(Map::from_iter([(key.into(), Value::from(value))]), |path| {
                let request = request_resources(&cpu_request(path), &mut vec![]).unwrap();
                let result = combine_plan(test_budget(), request, vec![], vec![]).unwrap();
                assert_eq!(result.plan.candidates[0].status, "unknown");
                assert!(result.plan.candidates[0].estimate.kv.is_none());
            });
        }
    }
    #[test]
    fn unknown_active_growth_is_visible_instead_of_claiming_fit() {
        with_gguf(Map::new(), |path| {
            let request = request_resources(&cpu_request(path), &mut vec![]).unwrap();
            let active = request_resources(
                &native_request("strata", serde_json::json!({})),
                &mut vec![],
            )
            .unwrap();
            let info = RunInfo {
                run_id: "active".into(),
                name: "active".into(),
                engine: "strata".into(),
                mode: "single".into(),
                endpoint: "unused".into(),
                model_id: "x".into(),
                context_tokens: 65536,
                state: "ready".into(),
                pid: None,
                generation: 1,
                managed: true,
                started_at: None,
                last_error: None,
            };
            let result =
                combine_plan(test_budget(), request, vec![(active, info)], vec![]).unwrap();
            assert_eq!(result.plan.candidates[0].status, "unknown");
            assert_eq!(result.active_runs[0].accounting_mode, "globalObservedOnly");
        });
    }
}
