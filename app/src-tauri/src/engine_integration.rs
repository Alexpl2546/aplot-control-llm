use crate::{
    benchmark::{BenchmarkAverage, BenchmarkRequest, BenchmarkResult, BenchmarkSample},
    db::DbState,
    hardware, models, ollama,
    runtime::{CpuRuntime, MemoryRuntime, RuntimeSnapshot},
};
use serde_json::{json, Value};
use std::{path::Path, time::Instant};
use tauri::State;

fn local_model_name(model: &str) -> Result<(), String> {
    if model.trim().is_empty()
        || model.ends_with("-cloud")
        || model
            .chars()
            .any(|c| c.is_whitespace() || c == '\\' || c == '"')
    {
        return Err("Choose a local Ollama model name.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn ollama_cached_library(
    endpoint_value: String,
    db: State<'_, DbState>,
) -> Result<Vec<Value>, String> {
    let key = format!(
        "ollama_library_cache|{}",
        endpoint_value.trim_end_matches('/')
    );
    let conn = db.0.lock().await;
    let raw: String = conn
        .query_row("SELECT value_json FROM kv WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .unwrap_or_else(|_| "[]".into());
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ollama_library(
    endpoint_value: String,
    db: State<'_, DbState>,
) -> Result<Vec<Value>, String> {
    let tags = ollama::request(&endpoint_value, "tags", None).await?;
    let sources: Value = {
        let conn = db.0.lock().await;
        conn.query_row(
            "SELECT value_json FROM kv WHERE key='ollama_import_sources'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}))
    };
    let mut result = Vec::new();
    for mut item in tags["models"].as_array().cloned().unwrap_or_default() {
        let name = item["name"].as_str().unwrap_or_default().to_owned();
        if !item["remote_host"].as_str().unwrap_or_default().is_empty() || name.ends_with("-cloud")
        {
            continue;
        }
        let show = match ollama::request(&endpoint_value, "show", Some(json!({"model":name}))).await
        {
            Ok(show) => show,
            Err(_) => continue,
        };
        item["capabilities"] = show["capabilities"].clone();
        let architecture = show["model_info"]["general.architecture"]
            .as_str()
            .unwrap_or_default();
        item["context_length"] =
            show["model_info"][format!("{architecture}.context_length")].clone();
        if let Some(path) = show["modelfile"]
            .as_str()
            .and_then(|text| text.lines().find_map(|line| line.strip_prefix("FROM ")))
            .map(|s| s.trim_matches('"'))
        {
            if let Ok(model) = models::inspect_model(Path::new(path)) {
                item["ggufModel"] = serde_json::to_value(model).map_err(|e| e.to_string())?;
            }
        }
        let source = &sources[format!("{}|{name}", endpoint_value.trim_end_matches('/'))];
        if let Some(path) = source["path"]
            .as_str()
            .filter(|path| Path::new(path).is_file())
        {
            if source["digest"] == item["digest"] {
                item["sourcePath"] = json!(path);
            }
        }
        result.push(item);
    }
    let conn = db.0.lock().await;
    let key = format!(
        "ollama_library_cache|{}",
        endpoint_value.trim_end_matches('/')
    );
    conn.execute("INSERT INTO kv(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at", rusqlite::params![key,serde_json::to_string(&result).map_err(|e| e.to_string())?,chrono::Utc::now().to_rfc3339()]).map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub async fn ollama_pull(endpoint_value: String, model: String) -> Result<(), String> {
    local_model_name(&model)?;
    ollama::request(
        &endpoint_value,
        "pull",
        Some(json!({"model":model,"stream":false})),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn ollama_import(
    endpoint_value: String,
    binary_path: String,
    path: String,
    model: String,
    db: State<'_, DbState>,
) -> Result<(), String> {
    local_model_name(&model)?;
    models::validate_generation_model(&path)?;
    let name = if model.contains(':') {
        model.clone()
    } else {
        format!("{model}:latest")
    };
    let existing = ollama::request(&endpoint_value, "tags", None).await?;
    if existing["models"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["name"].as_str() == Some(&name))
    }) {
        return Err("This Ollama name already exists. Choose a new name for import.".into());
    }
    let url = ollama::endpoint(&endpoint_value)?;
    if url.scheme() != "http"
        || !matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        )
    {
        return Err("GGUF import requires a local Ollama server.".into());
    }
    let exe = if binary_path.trim().is_empty() {
        ollama::detected_binary().ok_or("Cannot find ollama.exe.")?
    } else {
        binary_path.into()
    };
    if !exe.is_file()
        || !exe
            .file_name()
            .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("ollama.exe"))
    {
        return Err("Choose ollama.exe in Settings.".into());
    }
    let source = Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
    let file =
        std::env::temp_dir().join(format!("aplot-import-{}.Modelfile", uuid::Uuid::new_v4()));
    std::fs::write(
        &file,
        format!(
            "FROM \"{}\"\n",
            source.to_string_lossy().trim_start_matches("\\\\?\\")
        ),
    )
    .map_err(|e| e.to_string())?;
    let mut command = tokio::process::Command::new(&exe);
    command
        .args(["create", &model, "-f"])
        .arg(&file)
        .env("OLLAMA_HOST", &endpoint_value)
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command.output().await;
    let _ = std::fs::remove_file(&file);
    let output = output.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let tags = ollama::request(&endpoint_value, "tags", None).await?;
    let digest = tags["models"]
        .as_array()
        .and_then(|items| {
            items.iter().find(|v| {
                v["name"].as_str() == Some(&model)
                    || v["name"].as_str() == Some(&format!("{model}:latest"))
            })
        })
        .map(|v| v["digest"].clone())
        .ok_or("Imported model was not registered.")?;

    let show = ollama::request(&endpoint_value, "show", Some(json!({"model":name}))).await?;
    // Registration alone does not prove the bundled runtime can load this architecture or quantization.
    let validation = if !show["capabilities"]
        .as_array()
        .is_some_and(|items| items.iter().any(|v| v.as_str() == Some("completion")))
    {
        Err("This GGUF cannot generate text with Ollama.".to_string())
    } else {
        ollama::request(&endpoint_value, "generate", Some(json!({"model":name,"prompt":"OK","stream":false,"keep_alive":0,"options":{"num_ctx":512,"num_predict":1}}))).await.map(|_| ()).map_err(|e| format!("Ollama could not load the imported GGUF: {e}"))
    };
    if let Err(error) = validation {
        let mut cleanup = tokio::process::Command::new(&exe);
        cleanup
            .args(["rm", &name])
            .env("OLLAMA_HOST", &endpoint_value)
            .kill_on_drop(true);
        #[cfg(windows)]
        cleanup.creation_flags(0x08000000);
        let _ = cleanup.output().await;
        return Err(error);
    }

    let conn = db.0.lock().await;
    let mut sources: Value = conn
        .query_row(
            "SELECT value_json FROM kv WHERE key='ollama_import_sources'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));
    sources[format!("{}|{name}", endpoint_value.trim_end_matches('/'))] =
        json!({"path":path,"digest":digest});
    conn.execute("INSERT INTO kv(key,value_json,updated_at) VALUES('ollama_import_sources',?1,?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at", rusqlite::params![sources.to_string(),chrono::Utc::now().to_rfc3339()]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn ollama_runtime(
    endpoint_value: String,
    model: String,
) -> Result<RuntimeSnapshot, String> {
    let hw = tokio::task::spawn_blocking(hardware::collect_hardware);
    let status = ollama::request(&endpoint_value, "ps", None).await;
    let hardware = hw.await.map_err(|e| e.to_string())?;
    let loaded = status
        .as_ref()
        .ok()
        .and_then(|v| v["models"].as_array())
        .and_then(|items| items.iter().find(|v| v["name"].as_str() == Some(&model)));
    Ok(RuntimeSnapshot {
        state: if loaded.is_some() { "ready" } else { "stopped" }.into(),
        uptime_seconds: 0,
        endpoint: endpoint_value,
        backend: "Ollama (local)".into(),
        model_name: loaded.map(|v| v["name"].as_str().unwrap_or_default().to_string()),
        pid: None,
        process_started_at: None,
        last_error: status.as_ref().err().cloned(),
        gpu: hardware.gpu.unwrap_or_default(),
        cpu: CpuRuntime {
            name: hardware.cpu_name,
            utilization: hardware.cpu_utilization,
            threads: hardware.cpu_threads,
            clock_m_hz: hardware.cpu_clock_m_hz,
            temperature_c: hardware.cpu_temperature_c,
        },
        memory: MemoryRuntime {
            used_mi_b: hardware.memory_used_mi_b,
            total_mi_b: hardware.memory_total_mi_b,
            modules: hardware.memory_modules,
        },
        generation_tps: 0.0,
        generation_mean_tps: None,
        generation_window_seconds: None,
        prompt_tps: 0.0,
        active_requests: 0,
        queued_requests: 0,
        ttft_ms: None,
        context_used: 0,
        context_total: loaded
            .and_then(|v| v["context_length"].as_i64())
            .unwrap_or(0),
        slots: Vec::new(),
        metrics_available: false,
        slots_available: false,
        health_status: if status.is_ok() { 200 } else { 0 },
    })
}

fn rate(value: &Value, count: &str, duration: &str) -> f32 {
    let nanos = value[duration].as_f64().unwrap_or(0.0);
    if nanos > 0.0 {
        (value[count].as_f64().unwrap_or(0.0) * 1e9 / nanos) as f32
    } else {
        0.0
    }
}

#[tauri::command]
pub async fn ollama_benchmark(
    app: tauri::AppHandle,
    endpoint_value: String,
    model: String,
    context: u32,
    request: BenchmarkRequest,
    profile_name: String,
    db: State<'_, DbState>,
) -> Result<BenchmarkResult, String> {
    crate::benchmark::report_progress(Some(&app), "prepare", 0, 0, 0, 0, None);
    let result = async {
    if request
        .suite_id
        .as_deref()
        .is_some_and(|id| id != "throughput-v1")
    {
        return Err("Exact context suites are available for llama.cpp and Strata; Ollama supports throughput tests here.".into());
    }
    if request.runs == 0
        || request.runs > 20
        || request.generation_tokens == 0
        || request.generation_tokens > 4096
        || request.prompt_tokens == 0
        || request.prompt_tokens >= context
        || !(512..=262144).contains(&context)
    {
        return Err("Invalid Ollama benchmark token or run limits.".into());
    }
    ollama::model_action(&endpoint_value, &model, "load", "", context).await?;
    let prompt = request.prompt.clone().unwrap_or_else(|| {
        "benchmark token sequence ".repeat((request.prompt_tokens as usize / 3).max(1))
    });
    let mut samples = Vec::new();
    for run in 1..=request.runs {
        crate::benchmark::report_progress(Some(&app), "throughput", samples.len(), request.runs, run, 1, None);
        let started = Instant::now();
        let (done_tx, mut done_rx) = tokio::sync::watch::channel(false);
        let sampler = tokio::spawn(async move {
            let mut peaks = (0.0_f32, 0.0_f32, 0.0_f32);
            loop {
                let hw = tokio::task::spawn_blocking(hardware::collect_hardware)
                    .await
                    .map_err(|e| e.to_string())?;
                let gpu = hw.gpu.unwrap_or_default();
                peaks.0 = peaks.0.max(gpu.memory_used_mi_b as f32);
                peaks.1 = peaks.1.max(hw.memory_used_mi_b as f32);
                peaks.2 = peaks.2.max(gpu.utilization);
                if *done_rx.borrow() {
                    break;
                }
                tokio::select! { _ = done_rx.changed() => {}, _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {} }
            }
            Ok::<_, String>(peaks)
        });
        let response=ollama::request(&endpoint_value,"generate",Some(json!({"model":model,"prompt":prompt,"stream":false,"keep_alive":"10m","options":{"num_ctx":context,"num_predict":request.generation_tokens,"temperature":0,"seed":42}}))).await;
        let _ = done_tx.send(true);
        let peaks = sampler.await.map_err(|e| e.to_string())??;
        let value = response?;
        if value["eval_count"].as_u64().unwrap_or(0) == 0 {
            return Err("Ollama did not generate tokens.".into());
        }
        samples.push(BenchmarkSample {
            run,
            prompt_tps: rate(&value, "prompt_eval_count", "prompt_eval_duration"),
            generation_tps: rate(&value, "eval_count", "eval_duration"),
            ttft_ms: None,
            total_ms: started.elapsed().as_secs_f32() * 1000.0,
            vram_peak_mi_b: peaks.0,
            ram_peak_mi_b: peaks.1,
            gpu_peak_percent: peaks.2,
            prompt_token_count: value["prompt_eval_count"].as_u64().map(|v| v as u32),
            output_token_count: value["eval_count"].as_u64().map(|v| v as u32),
            phase: Some("ollama-throughput".into()),
            ..Default::default()
        });
        crate::benchmark::report_progress(Some(&app), "sample", samples.len(), request.runs, run, 1, samples.last());
    }
    let count = samples.len() as f32;
    let averages = BenchmarkAverage {
        prompt_tps: samples.iter().map(|s| s.prompt_tps).sum::<f32>() / count,
        generation_tps: samples.iter().map(|s| s.generation_tps).sum::<f32>() / count,
        total_ms: samples.iter().map(|s| s.total_ms).sum::<f32>() / count,
        vram_peak_mi_b: samples.iter().map(|s| s.vram_peak_mi_b).fold(0.0, f32::max),
        ram_peak_mi_b: samples.iter().map(|s| s.ram_peak_mi_b).fold(0.0, f32::max),
        gpu_peak_percent: samples
            .iter()
            .map(|s| s.gpu_peak_percent)
            .fold(0.0, f32::max),
        ..Default::default()
    };
    let result = BenchmarkResult {
        id: uuid::Uuid::new_v4().to_string(),
        profile_id: request.profile_id.clone(),
        profile_name,
        created_at: chrono::Utc::now().to_rfc3339(),
        config_snapshot: Some(json!({"engine":"ollama","engineModel":model,"ctxSize":context})),
        suite_id: Some("throughput-v1".into()),
        suite_version: Some(1),
        objective: request.objective.clone(),
        meets_targets: Some(
            averages.generation_tps >= request.minimum_generation_tps.unwrap_or(0.0),
        ),
        request,
        samples,
        averages,
        auto_tune_candidate: Some(false),
        recommendation_score: None,
        suite_summary: None,
        suite_windows: Vec::new(),
    };
    crate::benchmark::persist_benchmark(db.inner(), &result).await?;
    Ok(result)
    }.await;
    crate::benchmark::finish_progress(&app, &result);
    result
}
