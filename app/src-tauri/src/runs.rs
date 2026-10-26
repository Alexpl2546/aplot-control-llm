//! Per-run lifecycle. Registries are held only for registration/reservation;
//! waiting for a process or HTTP response holds the target's operation lock.
use crate::engine_adapters::{prepare, Prepared};
use crate::{domain::http, process, runtime};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};
use tauri::{AppHandle, State};
use tokio::sync::{Mutex, RwLock};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub run_id: String,
    pub name: String,
    pub engine: String,
    #[serde(default = "single")]
    pub mode: String,
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub context_tokens: u32,
    /// Treat the configured process port as preferred and choose a free port when requested.
    #[serde(default)]
    pub auto_port: bool,
    pub launch: Value,
}
fn single() -> String {
    "single".into()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub run_id: String,
    pub name: String,
    pub engine: String,
    pub mode: String,
    pub endpoint: String,
    pub model_id: String,
    pub context_tokens: u32,
    pub state: String,
    pub pid: Option<u32>,
    pub generation: u64,
    pub managed: bool,
    pub started_at: Option<String>,
    pub last_error: Option<String>,
}

struct RunData {
    requested: RunRequest,
    request: RunRequest,
    prepared: Prepared,
    info: RunInfo,
}
struct RunSlot {
    operation: Arc<Mutex<()>>,
    process: process::ProcessState,
    data: Mutex<Option<RunData>>,
}
impl RunSlot {
    fn new() -> Self {
        Self {
            operation: Arc::new(Mutex::new(())),
            process: process::ProcessState::default(),
            data: Mutex::new(None),
        }
    }
}
struct PortClaim {
    run_id: String,
}
#[derive(Default)]
pub struct RunManager {
    /// A measurement owns the write lease; lifecycle mutations fail explicitly.
    activity: Arc<RwLock<()>>,
    runs: Mutex<BTreeMap<String, Arc<RunSlot>>>,
    /// Conservative port-level reservations also cover wildcard/loopback overlaps.
    ports: Mutex<BTreeMap<u16, Vec<PortClaim>>>,
}

pub(crate) struct MeasurementLease {
    pub info: RunInfo,
    pub request: RunRequest,
    pub api_key: Option<String>,
    _activity: tokio::sync::OwnedRwLockWriteGuard<()>,
    _operation: tokio::sync::OwnedMutexGuard<()>,
}
pub(crate) struct RunEditLease {
    _activity: tokio::sync::OwnedRwLockReadGuard<()>,
    _operation: tokio::sync::OwnedMutexGuard<()>,
}

fn port(value: &str) -> Result<u16, String> {
    let url = http::server_endpoint(value)?;
    url.port_or_known_default()
        .ok_or_else(|| "Endpoint has no port".into())
}

impl RunManager {
    pub(crate) async fn resource_requests(&self) -> Result<Vec<(RunRequest, RunInfo)>, String> {
        let slots: Vec<_> = self.runs.lock().await.values().cloned().collect();
        let mut result = Vec::new();
        for slot in slots {
            self.observe(&slot).await?;
            if let Some(data) = slot.data.lock().await.as_ref() {
                if !["stopped", "crashed"].contains(&data.info.state.as_str()) {
                    result.push((data.request.clone(), data.info.clone()));
                }
            }
        }
        Ok(result)
    }
    pub(crate) async fn artifact_consumers(
        &self,
    ) -> Result<Vec<crate::domain::artifacts::ArtifactConsumer>, String> {
        let slots: Vec<_> = self.runs.lock().await.values().cloned().collect();
        let mut consumers = Vec::new();
        for slot in slots {
            self.observe(&slot).await?;
            if let Some(data) = slot.data.lock().await.as_ref() {
                if !["stopped", "crashed"].contains(&data.info.state.as_str()) {
                    crate::artifact_service::collect_paths(
                        &serde_json::to_value(&data.request).map_err(|e| e.to_string())?,
                        &format!("run:{}", data.info.run_id),
                        "run",
                        true,
                        &mut consumers,
                    );
                    // Strata's Python `-m serve.server` is a module, not a
                    // model file. Its resolved weight reference is captured
                    // from the engine config during launch preparation.
                    if data.info.engine != "strata" {
                        crate::artifact_service::collect_paths(
                            &serde_json::to_value(&data.prepared.0).map_err(|e| e.to_string())?,
                            &format!("run:{}", data.info.run_id),
                            "run",
                            true,
                            &mut consumers,
                        );
                    }
                }
            }
        }
        Ok(consumers)
    }
    pub(crate) async fn edit_lease(&self, id: &str) -> Result<RunEditLease, String> {
        let activity = self.lifecycle_lease()?;
        let slot = self
            .runs
            .lock()
            .await
            .entry(id.into())
            .or_insert_with(|| Arc::new(RunSlot::new()))
            .clone();
        let operation = slot.operation.clone().lock_owned().await;
        self.observe(&slot).await?;
        if slot
            .data
            .lock()
            .await
            .as_ref()
            .is_some_and(|data| !["stopped", "crashed"].contains(&data.info.state.as_str()))
        {
            return Err("Stop the router run before replacing its preset".into());
        }
        Ok(RunEditLease {
            _activity: activity,
            _operation: operation,
        })
    }
    fn lifecycle_lease(&self) -> Result<tokio::sync::OwnedRwLockReadGuard<()>, String> {
        self.activity
            .clone()
            .try_read_owned()
            .map_err(|_| "Cancel the active benchmark before changing runs".into())
    }
    pub(crate) async fn measurement_lease(&self, id: &str) -> Result<MeasurementLease, String> {
        let activity = self
            .activity
            .clone()
            .try_write_owned()
            .map_err(|_| "A benchmark or run operation is already active")?;
        let slot = self.slot(id).await?;
        let operation = slot
            .operation
            .clone()
            .try_lock_owned()
            .map_err(|_| "This run is changing")?;
        self.observe(&slot).await?;
        let peers = self.list().await?;
        if peers
            .iter()
            .any(|peer| peer.run_id != id && !["stopped", "crashed"].contains(&peer.state.as_str()))
        {
            return Err("Stop other runs before measuring shared hardware".into());
        }
        let data = slot.data.lock().await;
        let data = data.as_ref().ok_or("Unknown run")?;
        if !["ready", "loading"].contains(&data.info.state.as_str()) {
            return Err("The run must be available and idle before benchmarking".into());
        }
        Ok(MeasurementLease {
            info: data.info.clone(),
            request: data.request.clone(),
            api_key: data.prepared.key().map(str::to_string),
            _activity: activity,
            _operation: operation,
        })
    }
    async fn slot(&self, id: &str) -> Result<Arc<RunSlot>, String> {
        self.runs
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| "Unknown run".into())
    }
    async fn reserve(&self, id: &str, prepared: &Prepared) -> Result<(), String> {
        let key = port(prepared.endpoint())?;
        let mut ports = self.ports.lock().await;
        let consumers = ports.entry(key).or_default();
        http::server_endpoint(prepared.endpoint())?;
        if consumers.iter().any(|p| p.run_id != id) {
            return Err(format!("Port {key} is already in use"));
        }
        if !consumers.iter().any(|p| p.run_id == id) {
            consumers.push(PortClaim { run_id: id.into() });
        }
        Ok(())
    }
    async fn release(&self, id: &str) {
        let mut ports = self.ports.lock().await;
        ports.retain(|_, consumers| {
            consumers.retain(|p| p.run_id != id);
            !consumers.is_empty()
        });
    }
    async fn reserve_for_start(
        &self,
        request: &mut RunRequest,
        prepared: &mut Prepared,
    ) -> Result<(), String> {
        if !request.auto_port {
            return self.reserve(&request.run_id, prepared).await;
        }
        let process = &mut prepared.0;
        let mut endpoint = http::server_endpoint(
            process
                .endpoint
                .as_deref()
                .ok_or("Missing process endpoint")?,
        )?;
        let preferred = port(endpoint.as_str())?;
        let host = crate::engine_adapters::argument_value(&process.args, &["--host"])
            .map(|value| value.trim_matches(['[', ']']).to_owned())
            .unwrap_or_else(|| {
                endpoint
                    .host_str()
                    .unwrap_or("127.0.0.1")
                    .trim_matches(['[', ']'])
                    .to_owned()
            });
        let mut ports = self.ports.lock().await;
        // Hold the registry lock through selection and reservation so concurrent
        // starts cannot pick the same port. External processes can still race a bind.
        let chosen = (preferred..=u16::MAX)
            .take(256)
            .find(|candidate| {
                !ports
                    .get(candidate)
                    .is_some_and(|claims| claims.iter().any(|claim| claim.run_id != request.run_id))
                    && std::net::TcpListener::bind((host.as_str(), *candidate)).is_ok()
            })
            .ok_or_else(|| format!("No free server port found near {preferred}"))?;
        endpoint
            .set_port(Some(chosen))
            .map_err(|_| "Cannot set server port")?;
        let endpoint = endpoint.to_string().trim_end_matches('/').to_owned();
        if chosen != preferred {
            let mut replaced = false;
            for index in 0..process.args.len() {
                if process.args[index] == "--port" && index + 1 < process.args.len() {
                    process.args[index + 1] = chosen.to_string();
                    replaced = true;
                } else if process.args[index].starts_with("--port=") {
                    process.args[index] = format!("--port={chosen}");
                    replaced = true;
                }
            }
            if !replaced {
                process.args.extend(["--port".into(), chosen.to_string()]);
            }
            match request.engine.as_str() {
                "llama_cpp" => {
                    request.launch["args"] = serde_json::json!(process.args);
                    request.launch["endpoint"] = Value::String(endpoint.clone());
                }
                "strata" => request.launch["port"] = serde_json::json!(chosen),
                _ => return Err("Automatic ports are not supported by this engine".into()),
            }
        }
        process.endpoint = Some(endpoint.clone());
        ports.entry(chosen).or_default().push(PortClaim {
            run_id: request.run_id.clone(),
        });
        Ok(())
    }
    pub(crate) async fn start(
        &self,
        app: Option<&AppHandle>,
        mut request: RunRequest,
    ) -> Result<RunInfo, String> {
        let _activity = self.lifecycle_lease()?;
        let prepared = prepare(&mut request)?;
        let slot = self
            .runs
            .lock()
            .await
            .entry(request.run_id.clone())
            .or_insert_with(|| Arc::new(RunSlot::new()))
            .clone();
        let _operation = slot.operation.lock().await;
        let requested = request.clone();
        self.start_locked(app, &slot, request, prepared, requested)
            .await
    }
    async fn start_locked(
        &self,
        app: Option<&AppHandle>,
        slot: &RunSlot,
        mut request: RunRequest,
        mut prepared: Prepared,
        requested: RunRequest,
    ) -> Result<RunInfo, String> {
        self.observe(slot).await?;
        if let Some(data) = slot.data.lock().await.as_ref() {
            if !["stopped", "crashed"].contains(&data.info.state.as_str()) {
                if data.request == request || data.requested == requested {
                    return Ok(data.info.clone());
                }
                return Err("Stop the existing run before changing its configuration".into());
            }
        }
        self.reserve_for_start(&mut request, &mut prepared).await?;
        {
            let mut core = slot.process.0.lock().await;
            core.run_id = Some(request.run_id.clone());
        }
        let mut info = RunInfo {
            run_id: request.run_id.clone(),
            name: request.name.clone(),
            engine: request.engine.clone(),
            mode: request.mode.clone(),
            endpoint: prepared.endpoint().into(),
            model_id: request.model_id.clone(),
            context_tokens: request.context_tokens,
            state: "starting".into(),
            pid: None,
            generation: slot.process.0.lock().await.generation + 1,
            managed: true,
            started_at: Some(chrono::Utc::now().to_rfc3339()),
            last_error: None,
        };
        let result = process::start_inner(app, &slot.process, prepared.0.clone())
            .await
            .map(|p| {
                info.pid = Some(p.pid);
            });
        if let Err(e) = result {
            info.state = "crashed".into();
            info.last_error = Some(e.clone());
            self.release(&request.run_id).await;
            *slot.data.lock().await = Some(RunData {
                requested,
                request,
                prepared,
                info,
            });
            return Err(e);
        }
        info.state = "loading".into();
        info.generation = slot.process.0.lock().await.generation;
        *slot.data.lock().await = Some(RunData {
            requested,
            request,
            prepared,
            info: info.clone(),
        });
        Ok(info)
    }
    async fn observe(&self, slot: &RunSlot) -> Result<(), String> {
        let mut core = slot.process.0.lock().await;
        let exit = if let Some(process) = core.current.as_mut() {
            process.child.try_wait().map_err(|e| e.to_string())?
        } else {
            None
        };
        let mut data = slot.data.lock().await;
        if let (Some(exit), Some(data)) = (exit, data.as_mut()) {
            core.current.take();
            core.last_error = Some(format!("Engine exited: {exit}"));
            data.info.state = "crashed".into();
            data.info.last_error = core.last_error.clone();
            data.info.pid = None;
            self.release(&data.info.run_id).await;
        }
        Ok(())
    }
    async fn list(&self) -> Result<Vec<RunInfo>, String> {
        let slots: Vec<_> = self.runs.lock().await.values().cloned().collect();
        let mut result = Vec::new();
        for slot in slots {
            self.observe(&slot).await?;
            if let Some(data) = slot.data.lock().await.as_ref() {
                result.push(data.info.clone());
            }
        }
        Ok(result)
    }
    async fn remove(&self, id: &str) -> Result<(), String> {
        // Exclude starts, restarts and benchmarks while removing the registry slot.
        let _activity = self
            .activity
            .clone()
            .try_write_owned()
            .map_err(|_| "A run operation or benchmark is active")?;
        let slot = match self.runs.lock().await.get(id).cloned() {
            Some(slot) => slot,
            None => return Ok(()),
        };
        let _operation = slot.operation.lock().await;
        self.observe(&slot).await?;
        if slot
            .data
            .lock()
            .await
            .as_ref()
            .is_some_and(|data| !["stopped", "crashed"].contains(&data.info.state.as_str()))
        {
            return Err("Stop the server before removing it from the list".into());
        }
        self.release(id).await;
        self.runs.lock().await.remove(id);
        Ok(())
    }
    pub(crate) async fn stop(&self, app: Option<&AppHandle>, id: &str) -> Result<(), String> {
        let _activity = self.lifecycle_lease()?;
        let slot = self.slot(id).await?;
        let _operation = slot.operation.lock().await;
        self.stop_locked(app, &slot, id).await
    }
    async fn stop_locked(
        &self,
        app: Option<&AppHandle>,
        slot: &RunSlot,
        id: &str,
    ) -> Result<(), String> {
        if let Some(app) = app {
            crate::web_ui::close(app, id)?;
        }
        {
            let data = slot.data.lock().await;
            let Some(data) = data.as_ref() else {
                return Ok(());
            };
            if data.info.state == "stopped" {
                return Ok(());
            }
        }
        process::stop_inner(app, &slot.process).await?;
        let generation = slot.process.0.lock().await.generation;
        if let Some(data) = slot.data.lock().await.as_mut() {
            data.info.state = "stopped".into();
            data.info.pid = None;
            data.info.generation = generation;
            data.info.last_error = None;
        }
        self.release(id).await;
        Ok(())
    }
    pub(crate) async fn shutdown(&self, app: Option<&AppHandle>) -> Result<(), String> {
        let ids: Vec<_> = self.runs.lock().await.keys().cloned().collect();
        let mut errors = Vec::new();
        for id in ids {
            if let Err(e) = self.stop(app, &id).await {
                errors.push(format!("{id}: {e}"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

#[tauri::command]
pub async fn prepare_run(mut request: RunRequest) -> Result<RunInfo, String> {
    let prepared = prepare(&mut request)?;
    Ok(RunInfo {
        run_id: request.run_id,
        name: request.name,
        engine: request.engine,
        mode: request.mode,
        endpoint: prepared.endpoint().into(),
        model_id: request.model_id,
        context_tokens: request.context_tokens,
        state: "stopped".into(),
        pid: None,
        generation: 0,
        managed: true,
        started_at: None,
        last_error: None,
    })
}
#[tauri::command]
pub async fn start_run(
    app: AppHandle,
    manager: State<'_, RunManager>,
    legacy: State<'_, process::ProcessState>,
    request: RunRequest,
) -> Result<RunInfo, String> {
    let mut validated = request.clone();
    let prepared = prepare(&mut validated)?;
    let reserved = port(prepared.endpoint())?;
    {
        let mut core = legacy.0.lock().await;
        if let Some(p) = core.current.as_mut() {
            if p.child.try_wait().map_err(|e| e.to_string())?.is_none()
                && port(&p.endpoint)? == reserved
                && !request.auto_port
            {
                return Err("This port is in use by the legacy managed server".into());
            }
        }
    }
    let result = manager.start(Some(&app), request).await?;
    use tauri::Manager;
    crate::db::record_event(
        &app.state::<crate::db::DbState>(),
        "run_start",
        serde_json::to_value(&result).ok(),
    )
    .await;
    Ok(result)
}
#[tauri::command]
pub async fn list_runs(manager: State<'_, RunManager>) -> Result<Vec<RunInfo>, String> {
    manager.list().await
}
#[tauri::command]
pub async fn remove_run(manager: State<'_, RunManager>, run_id: String) -> Result<(), String> {
    manager.remove(&run_id).await
}
#[tauri::command]
pub async fn stop_run(
    app: AppHandle,
    manager: State<'_, RunManager>,
    run_id: String,
) -> Result<(), String> {
    manager.stop(Some(&app), &run_id).await
}
#[tauri::command]
pub async fn restart_run(
    app: AppHandle,
    manager: State<'_, RunManager>,
    run_id: String,
) -> Result<RunInfo, String> {
    let _activity = manager.lifecycle_lease()?;
    let slot = manager.slot(&run_id).await?;
    let _operation = slot.operation.lock().await;
    let mut request = slot
        .data
        .lock()
        .await
        .as_ref()
        .ok_or("Unknown run")?
        .request
        .clone();
    let requested = slot
        .data
        .lock()
        .await
        .as_ref()
        .ok_or("Unknown run")?
        .requested
        .clone();
    let prepared = prepare(&mut request)?;
    manager.stop_locked(Some(&app), &slot, &run_id).await?;
    manager
        .start_locked(Some(&app), &slot, request, prepared, requested)
        .await
}
#[tauri::command]
pub async fn stop_all_runs(app: AppHandle, manager: State<'_, RunManager>) -> Result<(), String> {
    manager.shutdown(Some(&app)).await
}
#[tauri::command]
pub async fn run_runtime(
    manager: State<'_, RunManager>,
    run_id: String,
) -> Result<runtime::RuntimeSnapshot, String> {
    let slot = manager.slot(&run_id).await?;
    let (prepared, info) = {
        let data = slot.data.lock().await;
        let data = data.as_ref().ok_or("Unknown run")?;
        (data.prepared.clone(), data.info.clone())
    };
    let mut snapshot = runtime::snapshot(
        info.endpoint.clone(),
        prepared.key().map(str::to_string),
        info.mode == "router",
        Some(info.model_id.clone()),
        Some(info.engine.clone()),
        &slot.process,
    )
    .await?;
    if let Some(data) = slot.data.lock().await.as_mut() {
        if data.info.generation == info.generation {
            if data.info.state == "stopped" {
                snapshot.state = "stopped".into();
            } else {
                data.info.state = snapshot.state.clone();
                data.info.last_error = snapshot.last_error.clone();
            }
        } else {
            return Err("The run changed while its metrics were being collected".into());
        }
    }
    if snapshot.state == "crashed" {
        manager.release(&run_id).await;
    }
    Ok(snapshot)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTarget {
    run_id: String,
    pub(crate) engine: String,
    pub(crate) base_url: String,
    pub(crate) model_id: String,
    pub(crate) context_tokens: u32,
    pub(crate) api_key: String,
    protocol: String,
    managed: bool,
}

/// Chat must remain bound to the selected process generation, including during streaming.
pub(crate) async fn chat_generation_current(
    manager: &RunManager,
    run_id: &str,
    generation: u64,
) -> bool {
    let Ok(slot) = manager.slot(run_id).await else {
        return false;
    };
    let data = slot.data.lock().await;
    data.as_ref().is_some_and(|d| {
        d.info.generation == generation && ["ready", "busy"].contains(&d.info.state.as_str())
    })
}
#[tauri::command]
pub async fn run_connection(
    manager: State<'_, RunManager>,
    run_id: String,
) -> Result<ConnectionTarget, String> {
    let slot = manager.slot(&run_id).await?;
    let (info, api_key) = {
        let data = slot.data.lock().await;
        let data = data.as_ref().ok_or("Unknown run")?;
        (
            data.info.clone(),
            data.prepared.key().unwrap_or_default().to_string(),
        )
    };
    if !["ready", "busy", "loading", "starting"].contains(&info.state.as_str()) {
        return Err("The selected run is not available".into());
    }
    let model_id = discover_model(&info.endpoint, &api_key, &info.model_id, &info.mode).await?;
    let base_url = format!("{}/v1", info.endpoint.trim_end_matches('/'));
    let current = slot.data.lock().await;
    if current.as_ref().is_none_or(|d| {
        d.info.generation != info.generation
            || ["stopped", "crashed", "stopping"].contains(&d.info.state.as_str())
    }) {
        return Err("The run changed during connection discovery".into());
    }
    Ok(ConnectionTarget {
        run_id,
        engine: info.engine,
        base_url,
        model_id,
        context_tokens: info.context_tokens,
        api_key,
        protocol: "openai-chat-completions".into(),
        managed: info.managed,
    })
}

#[tauri::command]
pub async fn open_run_web_ui(
    app: AppHandle,
    manager: State<'_, RunManager>,
    run_id: String,
) -> Result<(), String> {
    let slot = manager.slot(&run_id).await?;
    let _operation = slot.operation.lock().await;
    manager.observe(&slot).await?;
    let (info, prepared) = {
        let data = slot.data.lock().await;
        let data = data.as_ref().ok_or("Unknown run")?;
        (data.info.clone(), data.prepared.clone())
    };
    if !["llama_cpp", "strata"].contains(&info.engine.as_str())
        || !["ready", "busy"].contains(&info.state.as_str())
    {
        return Err("Web UI requires a ready llama.cpp or Strata run".into());
    }
    crate::web_ui::open(&app, &info, &prepared.0).await
}

pub(crate) async fn discover_model(
    endpoint: &str,
    api_key: &str,
    requested: &str,
    mode: &str,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(3))
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let base_url = format!("{}/v1", endpoint.trim_end_matches('/'));
    let mut query = client.get(format!("{base_url}/models"));
    if !api_key.is_empty() {
        query = query.bearer_auth(&api_key);
    }
    let models: Value = query
        .send()
        .await
        .map_err(|_| "The model API is not reachable")?
        .error_for_status()
        .map_err(|_| "The model API rejected model discovery")?
        .json()
        .await
        .map_err(|_| "Invalid model discovery response")?;
    let ids: Vec<String> = models["data"]
        .as_array()
        .ok_or("The model API did not return a model list")?
        .iter()
        .filter_map(|v| v["id"].as_str().map(str::to_string))
        .collect();
    connection_model_id(&ids, requested, mode)
}
fn connection_model_id(ids: &[String], requested: &str, mode: &str) -> Result<String, String> {
    if ids.iter().any(|id| id == requested) {
        return Ok(requested.into());
    }
    if mode == "single" && ids.len() == 1 {
        return Ok(ids[0].clone());
    }
    Err("The requested model is not exposed by this server".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connection_discovery_does_not_choose_an_unrelated_router_model() {
        let ids = vec!["fast".into(), "coder".into()];
        assert_eq!(
            connection_model_id(&ids, "coder", "router").unwrap(),
            "coder"
        );
        assert!(connection_model_id(&ids, "missing", "router").is_err());
        assert!(connection_model_id(&ids, "missing", "single").is_err());
        assert_eq!(
            connection_model_id(&["actual".into()], "configured", "single").unwrap(),
            "actual"
        );
    }
    #[tokio::test]
    #[ignore = "requires APLOT_SMOKE_BINARY and APLOT_SMOKE_MODEL; isolated CPU servers only"]
    async fn real_multi_run_supervisor_smoke() {
        let binary = std::env::var("APLOT_SMOKE_BINARY").expect("Set APLOT_SMOKE_BINARY");
        let model = std::env::var("APLOT_SMOKE_MODEL").expect("Set APLOT_SMOKE_MODEL");
        let manager = RunManager::default();
        let free_port = || {
            let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            socket.local_addr().unwrap().port()
        };
        let pa = free_port();
        let request = |id: &str, p: u16| RunRequest {
            run_id: id.into(),
            name: id.into(),
            engine: "llama_cpp".into(),
            mode: "single".into(),
            model_id: "smoke".into(),
            context_tokens: 1024,
            auto_port: false,
            launch: serde_json::json!({"binaryPath":binary,"args":["--model",model,"--ctx-size","1024","--n-gpu-layers","0","--parallel","1","--threads","2","--host","127.0.0.1","--port",p.to_string(),"--alias","smoke"],"endpoint":format!("http://127.0.0.1:{p}"),"backend":"llama-server"}),
        };
        let a = manager.start(None, request("smoke-a", pa)).await.unwrap();
        let mut second_request = request("smoke-b", pa);
        second_request.auto_port = true;
        let b = manager.start(None, second_request.clone()).await.unwrap();
        let pb = port(&b.endpoint).unwrap();
        assert_ne!(pa, pb);
        assert_ne!(a.pid, b.pid);
        assert_eq!(
            manager
                .start(None, second_request.clone())
                .await
                .unwrap()
                .pid,
            b.pid
        );
        assert_eq!(
            manager
                .start(None, request("smoke-a", pa))
                .await
                .unwrap()
                .pid,
            a.pid
        );
        let collision = manager.start(None, request("collision", pa)).await;
        assert!(collision.is_err());
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(40))
            .build()
            .unwrap();
        for p in [pa, pb] {
            let mut ready = false;
            for _ in 0..120 {
                if client
                    .get(format!("http://127.0.0.1:{p}/health"))
                    .send()
                    .await
                    .is_ok_and(|r| r.status().is_success())
                {
                    ready = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            assert!(ready, "CPU smoke server did not become ready");
            let response:Value=client.post(format!("http://127.0.0.1:{p}/v1/chat/completions")).json(&serde_json::json!({"model":"smoke","messages":[{"role":"user","content":"Reply with the number 731."}],"max_tokens":16,"temperature":0})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
            assert!(response["choices"][0]["message"]["content"]
                .as_str()
                .is_some_and(|v| !v.trim().is_empty()));
        }
        manager.stop(None, "smoke-b").await.unwrap();
        assert!(client
            .get(format!("http://127.0.0.1:{pa}/health"))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        let restarted = manager.start(None, second_request).await.unwrap();
        assert_eq!(restarted.endpoint, b.endpoint);
        assert!(restarted.generation > b.generation);
        let peer = manager.slot("smoke-b").await.unwrap();
        peer.process
            .0
            .lock()
            .await
            .current
            .as_mut()
            .unwrap()
            .child
            .start_kill()
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let after = manager.list().await.unwrap();
        assert_eq!(
            after.iter().find(|r| r.run_id == "smoke-b").unwrap().state,
            "crashed"
        );
        assert!(client
            .get(format!("http://127.0.0.1:{pa}/health"))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        manager.shutdown(None).await.unwrap();
        let report = serde_json::json!({"a":a,"b":b,"restarted":restarted,"afterCrash":after,"shutdown":manager.list().await.unwrap(),"checks":["two CPU model servers generated","same preferred port automatically separated","duplicate automatic start idempotent","strict port collision rejected","peer stop isolated","same assigned port on restart","generation advanced on restart","peer crash isolated","owned processes shut down"]});
        if let Ok(path) = std::env::var("APLOT_SMOKE_REPORT") {
            std::fs::write(path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
        }
    }
    #[tokio::test]
    async fn automatic_ports_skip_external_and_concurrent_claims_and_update_launches() {
        let external = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let preferred = external.local_addr().unwrap().port();
        let manager = RunManager::default();
        let make = |id: &str, engine: &str| {
            // The final host flag wins, including the --host=value spelling.
            let launch = serde_json::json!({"port":preferred,"args":["--host","203.0.113.1","--port",preferred.to_string(),"--host=127.0.0.1"],"endpoint":format!("http://127.0.0.1:{preferred}")});
            let request = RunRequest {
                run_id: id.into(),
                name: id.into(),
                engine: engine.into(),
                mode: "single".into(),
                model_id: "test".into(),
                context_tokens: 1024,
                auto_port: true,
                launch: launch.clone(),
            };
            let prepared = Prepared(process::StartServerRequest {
                binary_path: String::new(),
                args: serde_json::from_value(launch["args"].clone()).unwrap(),
                endpoint: launch["endpoint"].as_str().map(str::to_owned),
                profile_id: None,
                backend: None,
                working_directory: None,
                api_key: None,
            });
            (request, prepared)
        };
        let (mut a, mut pa) = make("a", "llama_cpp");
        let (mut b, mut pb) = make("b", "strata");
        let (ra, rb) = tokio::join!(
            manager.reserve_for_start(&mut a, &mut pa),
            manager.reserve_for_start(&mut b, &mut pb)
        );
        ra.unwrap();
        rb.unwrap();
        let selected_a = port(pa.endpoint()).unwrap();
        let selected_b = port(pb.endpoint()).unwrap();
        assert_ne!(selected_a, preferred);
        assert_ne!(selected_b, preferred);
        assert_ne!(selected_a, selected_b);
        assert_eq!(a.launch["endpoint"].as_str(), Some(pa.endpoint()));
        assert_eq!(
            a.launch["args"][3].as_str().unwrap(),
            selected_a.to_string()
        );
        assert_eq!(b.launch["port"].as_u64(), Some(selected_b as u64));
        manager.release("a").await;
        assert!(!manager.ports.lock().await.contains_key(&selected_a));
        let (mut next, mut p) = make("next", "llama_cpp");
        manager.reserve_for_start(&mut next, &mut p).await.unwrap();
        // Other tests/processes may claim the released OS port in the meantime.
        assert_ne!(port(p.endpoint()).unwrap(), selected_b);
        assert_ne!(port(p.endpoint()).unwrap(), preferred);
        // An unrelated listener remains untouched by port selection.
        assert!(external.local_addr().is_ok());
    }
    #[test]
    fn endpoints_require_a_server_address_and_real_port() {
        assert_eq!(port("http://127.0.0.1:8123").unwrap(), 8123);
        assert!(port("http://127.0.0.1:8123/v1").is_err());
        assert!(port("http://user:secret@localhost:8123").is_err());
    }
    #[tokio::test]
    async fn reservation_is_independent_and_released_only_for_its_owner() {
        let manager = RunManager::default();
        let prepared = |port| {
            Prepared(process::StartServerRequest {
                binary_path: String::new(),
                args: vec![],
                endpoint: Some(format!("http://127.0.0.1:{port}")),
                profile_id: None,
                backend: None,
                working_directory: None,
                api_key: None,
            })
        };
        manager.reserve("a", &prepared(8123)).await.unwrap();
        manager.reserve("b", &prepared(8124)).await.unwrap();
        assert!(manager.reserve("c", &prepared(8123)).await.is_err());
        manager.release("b").await;
        assert!(manager.reserve("c", &prepared(8123)).await.is_err());
        manager.release("a").await;
        manager.reserve("c", &prepared(8123)).await.unwrap();
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn independent_processes_survive_peer_shutdown_and_crash() {
        let a = process::ProcessState::default();
        let b = process::ProcessState::default();
        let request = |name: &str, port| process::StartServerRequest {
            binary_path: "cmd.exe".into(),
            args: vec![
                "/C".into(),
                "ping".into(),
                "-n".into(),
                "30".into(),
                "127.0.0.1".into(),
            ],
            endpoint: Some(format!("http://127.0.0.1:{port}")),
            profile_id: Some(name.into()),
            backend: None,
            working_directory: None,
            api_key: None,
        };
        let pa = process::start_inner(None, &a, request("a", 8133))
            .await
            .unwrap();
        let pb = process::start_inner(None, &b, request("b", 8134))
            .await
            .unwrap();
        assert_ne!(pa.pid, pb.pid);
        assert!(process::start_inner(None, &a, request("a", 8133))
            .await
            .is_err());
        process::stop_inner(None, &b).await.unwrap();
        assert!(a
            .0
            .lock()
            .await
            .current
            .as_mut()
            .unwrap()
            .child
            .try_wait()
            .unwrap()
            .is_none());
        assert_eq!(a.0.lock().await.generation, 1);
        assert_eq!(b.0.lock().await.generation, 2);
        process::stop_inner(None, &a).await.unwrap();
    }
}
