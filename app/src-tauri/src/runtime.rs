use crate::{hardware, llama, process::ProcessState};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::task::JoinSet;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CpuRuntime {
    pub name: String,
    pub utilization: f32,
    pub threads: usize,
    pub clock_m_hz: f32,
    pub temperature_c: Option<f32>,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRuntime {
    pub used_mi_b: u64,
    pub total_mi_b: u64,
    pub modules: Vec<hardware::MemoryModule>,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SlotRuntime {
    pub id: i64,
    pub model_id: Option<String>,
    pub state: String,
    pub context_used: i64,
    pub context_total: i64,
    pub generation_tps: Option<f32>,
    pub prompt_tps: Option<f32>,
    pub task_id: Option<i64>,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub state: String,
    pub uptime_seconds: u64,
    pub endpoint: String,
    pub backend: String,
    pub model_name: Option<String>,
    pub pid: Option<u32>,
    pub process_started_at: Option<String>,
    pub last_error: Option<String>,
    pub gpu: hardware::GpuSnapshot,
    pub cpu: CpuRuntime,
    pub memory: MemoryRuntime,
    pub generation_tps: f32,
    pub generation_mean_tps: Option<f32>,
    pub generation_window_seconds: Option<f32>,
    pub prompt_tps: f32,
    pub active_requests: usize,
    pub queued_requests: usize,
    pub ttft_ms: Option<u64>,
    pub context_used: i64,
    pub context_total: i64,
    pub slots: Vec<SlotRuntime>,
    pub metrics_available: bool,
    pub slots_available: bool,
    pub health_status: u16,
}

async fn router_telemetry(
    endpoint: &str,
    api_key: Option<&str>,
    fallback_model_id: Option<&str>,
) -> (llama::MetricsSnapshot, Vec<llama::SlotSnapshot>, bool) {
    let model_ids = match llama::router_loaded_models(endpoint, api_key).await {
        Ok(model_ids) => model_ids,
        Err(_) => fallback_model_id
            .filter(|model_id| !model_id.trim().is_empty())
            .map(|model_id| vec![model_id.to_string()])
            .unwrap_or_default(),
    };
    if model_ids.is_empty() {
        return (llama::MetricsSnapshot::default(), Vec::new(), false);
    }

    let mut requests = JoinSet::new();
    for model_id in model_ids {
        let endpoint = endpoint.to_string();
        let api_key = api_key.map(str::to_string);
        requests.spawn(async move {
            tokio::join!(
                llama::metrics_for_model(&endpoint, api_key.as_deref(), Some(&model_id)),
                llama::slots_for_model(&endpoint, api_key.as_deref(), Some(&model_id))
            )
        });
    }

    let mut aggregate = llama::MetricsSnapshot::default();
    let mut slots = Vec::new();
    let mut slots_available = false;
    let mut weighted_kv_ratio = 0.0_f32;
    let mut kv_weight = 0_i64;
    while let Some(result) = requests.join_next().await {
        if let Ok((metrics, model_slots)) = result {
            if let Ok(metrics) = metrics {
                aggregate.prompt_tps += metrics.prompt_tps;
                aggregate.generation_tps += metrics.generation_tps;
                aggregate.requests_processing += metrics.requests_processing;
                aggregate.requests_deferred += metrics.requests_deferred;
                aggregate.kv_cache_tokens += metrics.kv_cache_tokens;
                aggregate.n_tokens_max += metrics.n_tokens_max;
                aggregate.available |= metrics.available;
                weighted_kv_ratio +=
                    metrics.kv_cache_usage_ratio * metrics.n_tokens_max.max(0) as f32;
                kv_weight += metrics.n_tokens_max.max(0);
            }
            if let Ok(model_slots) = model_slots {
                slots_available = true;
                slots.extend(model_slots);
            }
        }
    }
    if kv_weight > 0 {
        aggregate.kv_cache_usage_ratio = weighted_kv_ratio / kv_weight as f32;
    }
    (aggregate, slots, slots_available)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn runtime_state(
    pid: Option<u32>,
    ready: bool,
    reachable: bool,
    health_status: u16,
    active: usize,
    exited: bool,
    last_error: Option<&str>,
) -> &'static str {
    if exited || (pid.is_none() && last_error.is_some()) {
        "crashed"
    } else if ready {
        if active > 0 {
            "busy"
        } else {
            "ready"
        }
    } else if pid.is_none() {
        "stopped"
    } else if reachable || health_status == 503 {
        "loading"
    } else {
        "starting"
    }
}

#[tauri::command]
pub async fn runtime_snapshot(
    endpoint: String,
    api_key: Option<String>,
    router_mode: bool,
    fallback_model_id: Option<String>,
    engine: Option<String>,
    process_state: State<'_, ProcessState>,
) -> Result<RuntimeSnapshot, String> {
    let generation = process_state.0.lock().await.generation;
    let hardware_task = tokio::task::spawn_blocking(hardware::collect_hardware);
    let (mut health, mut metrics, mut slots, mut slots_available) = if router_mode {
        let (health, (metrics, slots, slots_available)) = tokio::join!(
            llama::health(&endpoint, api_key.as_deref()),
            router_telemetry(&endpoint, api_key.as_deref(), fallback_model_id.as_deref())
        );
        (health, metrics, slots, slots_available)
    } else if engine.as_deref() == Some("qwfnfer") {
        let (health, metrics) = tokio::join!(
            llama::health(&endpoint, api_key.as_deref()),
            crate::qwfnfer::metrics(&endpoint, api_key.as_deref())
        );
        (health, metrics.unwrap_or_default(), Vec::new(), false)
    } else {
        let (health, metrics, slots_result) = tokio::join!(
            llama::health(&endpoint, api_key.as_deref()),
            llama::metrics(&endpoint, api_key.as_deref()),
            llama::slots(&endpoint, api_key.as_deref())
        );
        let slots_available = slots_result.is_ok();
        (
            health,
            metrics.unwrap_or_default(),
            slots_result.unwrap_or_default(),
            slots_available,
        )
    };
    let hardware = hardware_task.await.map_err(|e| e.to_string())?;
    let (pid, started_ms, last_error, exited, generation_changed) = {
        let mut g = process_state.0.lock().await;
        let mut pid = None;
        let mut started_ms = None;
        let mut exited_status = None;

        if let Some(process) = g.current.as_mut() {
            started_ms = Some(process.started_at_ms);
            match process.child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => exited_status = Some(status),
                None => pid = process.child.id(),
            }
        }

        let exited = exited_status.is_some();
        if let Some(status) = exited_status {
            g.last_exit_code = status.code();
            let message = match status.code() {
                Some(code) => format!("llama-server exited with code {code}"),
                None => "llama-server exited unexpectedly".to_string(),
            };
            g.last_error = Some(message);
            g.current.take();
        }

        (
            pid,
            started_ms,
            g.last_error.clone(),
            exited,
            g.generation != generation,
        )
    };
    // HTTP may have answered before stop/restart, while hardware collection or
    // the process lock completed afterwards. Never pair that response with a
    // different process generation.
    if generation_changed {
        health = llama::HealthResult {
            reachable: false,
            ready: false,
            status: 0,
        };
        metrics = llama::MetricsSnapshot::default();
        slots.clear();
        slots_available = false;
    }
    let slot_runtime: Vec<SlotRuntime> = slots
        .iter()
        .map(|s| SlotRuntime {
            id: s.id,
            model_id: s.model_id.clone(),
            state: s.runtime_state().into(),
            context_used: s.context_tokens(),
            context_total: s.n_ctx,
            generation_tps: s
                .timings
                .as_ref()
                .map(|t| t.predicted_per_second)
                .filter(|v| *v > 0.0),
            prompt_tps: s
                .timings
                .as_ref()
                .map(|t| t.prompt_per_second)
                .filter(|v| *v > 0.0),
            task_id: s.id_task,
        })
        .collect();
    let slot_used = slot_runtime.iter().map(|s| s.context_used).sum::<i64>();
    let slot_total = slot_runtime.iter().map(|s| s.context_total).sum::<i64>();
    let context_used = if metrics.kv_cache_tokens > 0 {
        metrics.kv_cache_tokens
    } else {
        slot_used
    };
    let context_total = if slot_total > 0 {
        slot_total
    } else if matches!(engine.as_deref(), Some("strata" | "qwfnfer")) {
        metrics.n_tokens_max.max(0)
    } else {
        0
    };
    let active = metrics
        .requests_processing
        .max(slot_runtime.iter().filter(|s| s.state != "idle").count());
    let state = runtime_state(
        pid,
        health.ready,
        health.reachable,
        health.status,
        active,
        exited,
        last_error.as_deref(),
    );
    let uptime = started_ms
        .map(|s| now_ms().saturating_sub(s) / 1000)
        .unwrap_or(0);
    let started_iso = started_ms
        .and_then(|ms| chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms as i64))
        .map(|d| d.to_rfc3339());
    Ok(RuntimeSnapshot {
        state: state.into(),
        uptime_seconds: uptime,
        endpoint,
        backend: if engine.as_deref() == Some("qwfnfer") {
            "QwFNfer (local)".into()
        } else if engine.as_deref() == Some("strata") {
            "Strata (local)".into()
        } else {
            "llama.cpp (local)".into()
        },
        model_name: metrics.model_name.clone(),
        pid,
        process_started_at: started_iso,
        last_error: if exited {
            Some(last_error.unwrap_or_else(|| "llama-server exited unexpectedly".into()))
        } else {
            last_error
        },
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
        generation_tps: if metrics.generation_tps > 0.0 {
            metrics.generation_tps
        } else {
            slot_runtime.iter().filter_map(|s| s.generation_tps).sum()
        },
        prompt_tps: if metrics.prompt_tps > 0.0 {
            metrics.prompt_tps
        } else {
            slot_runtime.iter().filter_map(|s| s.prompt_tps).sum()
        },
        generation_mean_tps: metrics.generation_mean_tps,
        generation_window_seconds: metrics.generation_window_seconds,
        active_requests: active,
        queued_requests: metrics.requests_deferred,
        // llama-server's status endpoints do not expose first-token latency.
        // Keep it absent instead of reporting a fabricated zero.
        ttft_ms: metrics.ttft_ms,
        context_used,
        context_total,
        slots: slot_runtime,
        metrics_available: metrics.available,
        slots_available,
        health_status: health.status,
    })
}

#[cfg(test)]
mod tests {
    use super::runtime_state;

    #[test]
    fn crash_state_persists_after_the_child_is_reaped() {
        assert_eq!(
            runtime_state(None, false, false, 0, 0, true, Some("exit code 1")),
            "crashed"
        );
        assert_eq!(
            runtime_state(None, false, false, 0, 0, false, Some("exit code 1")),
            "crashed"
        );
    }

    #[test]
    fn clearing_the_error_returns_to_stopped() {
        assert_eq!(
            runtime_state(None, false, false, 0, 0, false, None),
            "stopped"
        );
    }

    #[test]
    fn reachable_server_transitions_through_loading_ready_and_busy() {
        assert_eq!(
            runtime_state(Some(42), false, true, 503, 0, false, None),
            "loading"
        );
        assert_eq!(
            runtime_state(Some(42), true, true, 200, 0, false, None),
            "ready"
        );
        assert_eq!(
            runtime_state(Some(42), true, true, 200, 1, false, None),
            "busy"
        );
        assert_eq!(
            runtime_state(Some(42), false, false, 0, 0, false, None),
            "starting"
        );
    }
}
