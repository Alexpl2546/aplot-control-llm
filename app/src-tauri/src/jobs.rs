//! Cancellable, run-scoped measurements. A job owns an immutable run lease.
//! Cancellation drops the HTTP future; completed samples remain in the job record.
use crate::{
    benchmark,
    db::DbState,
    runs::{MeasurementLease, RunManager},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::watch;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub job_id: String,
    pub run_id: String,
    pub generation: u64,
    pub engine: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub benchmark_id: Option<String>,
    pub error: Option<String>,
    pub evidence: Value,
}

struct ActiveJob {
    info: JobInfo,
    cancel: watch::Sender<bool>,
}
#[derive(Default)]
pub struct JobManager {
    active: Mutex<BTreeMap<String, ActiveJob>>,
}
#[derive(Clone)]
struct Scope {
    job_id: String,
    run_id: String,
    generation: u64,
    samples: Arc<Mutex<Vec<Value>>>,
}
tokio::task_local! { static EXECUTION: Scope; }

/// Returns true when the legacy progress channel must be suppressed.
pub(crate) fn scoped_progress(app: Option<&AppHandle>, payload: &Value) -> bool {
    EXECUTION.try_with(|scope| {
        if let Some(sample) = payload.get("sample").filter(|v| !v.is_null()) {
            if let Ok(mut samples) = scope.samples.lock() {
                samples.push(sample.clone());
            }
        }
        if let Some(app) = app {
            let _ = app.emit("job://progress", json!({"jobId":scope.job_id,"runId":scope.run_id,"generation":scope.generation,"progress":payload}));
        }
    }).is_ok()
}

/// Redacts both structured credentials and CLI credential values.
pub(crate) fn public_snapshot(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let value = if crate::domain::secrets::is_secret_value(key, value) {
                        Value::String("[redacted]".into())
                    } else {
                        public_snapshot(value)
                    };
                    (key.clone(), value)
                })
                .collect(),
        ),
        Value::Array(items) => {
            let mut redact_next = false;
            Value::Array(
                items
                    .iter()
                    .map(|item| {
                        if redact_next {
                            redact_next = false;
                            return Value::String("[redacted]".into());
                        }
                        if let Some(arg) = item.as_str() {
                            let flag = arg.trim_start_matches('-');
                            if let Some((key, _)) = flag.split_once('=') {
                                if crate::domain::secrets::is_secret_field(key) {
                                    return Value::String(format!("--{key}=[redacted]"));
                                }
                            } else if arg.starts_with('-')
                                && crate::domain::secrets::is_secret_field(flag)
                            {
                                redact_next = true;
                            }
                        }
                        public_snapshot(item)
                    })
                    .collect(),
            )
        }
        _ => value.clone(),
    }
}

/// Native commands are authoritative; caller editor data is a labelled aid for
/// reproducing UI controls, never substituted for the actual run request.
fn configuration_snapshot(run: &Value, editor: Option<&Value>) -> Value {
    json!({
        "run": public_snapshot(run),
        "editorConfiguration": editor.map(public_snapshot),
        "editorConfigurationSource": "caller",
    })
}

pub(crate) fn init_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS execution_jobs (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL,
        record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );",
    )
    .map_err(|e| format!("Could not initialize job storage: {e}"))?;
    // A process restart cannot resume an in-flight HTTP request or run lease.
    let records: Vec<(String, String)> = {
        let mut statement = conn.prepare("SELECT id,record_json FROM execution_jobs WHERE status IN ('queued','running','cancelling')").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    for (id, record) in records {
        let mut info: JobInfo = serde_json::from_str(&record).map_err(|e| e.to_string())?;
        info.status = "interrupted".into();
        info.error = Some("The application exited before this measurement completed".into());
        info.updated_at = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE execution_jobs SET status=?1,record_json=?2,updated_at=?3 WHERE id=?4",
            rusqlite::params![
                info.status,
                serde_json::to_string(&info).map_err(|e| e.to_string())?,
                info.updated_at,
                id
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
async fn persist(db: &DbState, info: &JobInfo) -> Result<(), String> {
    db.0.lock().await.execute("INSERT INTO execution_jobs(id,run_id,status,record_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,record_json=excluded.record_json,updated_at=excluded.updated_at",
        rusqlite::params![info.job_id,info.run_id,info.status,serde_json::to_string(info).map_err(|e| e.to_string())?,info.created_at,info.updated_at]).map_err(|e| e.to_string())?;
    Ok(())
}

impl JobManager {
    fn register(
        &self,
        lease: &MeasurementLease,
        request: &benchmark::BenchmarkRequest,
    ) -> Result<(JobInfo, watch::Receiver<bool>), String> {
        let mut jobs = self.active.lock().map_err(|_| "Job registry unavailable")?;
        if !jobs.is_empty() {
            return Err("A measurement is already active".into());
        }
        let now = chrono::Utc::now().to_rfc3339();
        let info = JobInfo {
            job_id: uuid::Uuid::new_v4().to_string(),
            run_id: lease.info.run_id.clone(),
            generation: lease.info.generation,
            engine: lease.info.engine.clone(),
            status: "queued".into(),
            created_at: now.clone(),
            updated_at: now,
            benchmark_id: None,
            error: None,
            evidence: json!({"run":lease.info,"configuration":public_snapshot(&serde_json::to_value(&lease.request).map_err(|e| e.to_string())?),"request":public_snapshot(&serde_json::to_value(request).map_err(|e| e.to_string())?),"isolation":"other-managed-runs-stopped","hardwareCounters":"system-wide","samples":[]}),
        };
        let (cancel, receiver) = watch::channel(false);
        jobs.insert(
            info.job_id.clone(),
            ActiveJob {
                info: info.clone(),
                cancel,
            },
        );
        Ok((info, receiver))
    }
    fn forget(&self, id: &str) {
        if let Ok(mut jobs) = self.active.lock() {
            jobs.remove(id);
        }
    }
    fn update(&self, info: &JobInfo) {
        if let Ok(mut jobs) = self.active.lock() {
            if let Some(job) = jobs.get_mut(&info.job_id) {
                job.info = info.clone();
            }
        }
    }
    fn cancel(&self, id: &str) -> Result<(), String> {
        let mut jobs = self.active.lock().map_err(|_| "Job registry unavailable")?;
        if let Some(job) = jobs.get_mut(id) {
            job.info.status = "cancelling".into();
            let _ = job.cancel.send(true);
        }
        // Repeated cancellation after completion is harmless.
        Ok(())
    }
    pub(crate) async fn shutdown(&self) -> Result<(), String> {
        {
            let jobs = self.active.lock().map_err(|_| "Job registry unavailable")?;
            for job in jobs.values() {
                let _ = job.cancel.send(true);
            }
        }
        for _ in 0..100 {
            if self
                .active
                .lock()
                .map_err(|_| "Job registry unavailable")?
                .is_empty()
            {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        Err("Timed out while recording cancelled measurements".into())
    }
}

async fn execute(
    app: Option<&AppHandle>,
    db: &DbState,
    lease: &MeasurementLease,
    request: benchmark::BenchmarkRequest,
) -> Result<benchmark::BenchmarkResult, String> {
    if request.suite_id.is_some() {
        benchmark::execute_suite(
            app,
            db,
            request,
            lease.info.endpoint.clone(),
            lease.info.name.clone(),
            lease.api_key.clone(),
        )
        .await
    } else {
        benchmark::run_benchmark_inner(
            app,
            db,
            request,
            lease.info.endpoint.clone(),
            lease.info.name.clone(),
            lease.api_key.clone(),
        )
        .await
    }
}

#[tauri::command]
pub async fn start_benchmark_job(
    app: AppHandle,
    manager: State<'_, RunManager>,
    jobs: State<'_, JobManager>,
    run_id: String,
    request: benchmark::BenchmarkRequest,
) -> Result<JobInfo, String> {
    let prepared =
        prepare_registration(&manager, &jobs, &app.state::<DbState>(), &run_id, request).await?;
    let queued = prepared.info.clone();
    tokio::spawn(async move {
        run_registered_job(
            Some(&app),
            &app.state::<JobManager>(),
            &app.state::<DbState>(),
            prepared,
        )
        .await;
    });
    Ok(queued)
}

struct PreparedJob {
    lease: MeasurementLease,
    request: benchmark::BenchmarkRequest,
    info: JobInfo,
    cancel: watch::Receiver<bool>,
}
async fn prepare_registration(
    manager: &RunManager,
    jobs: &JobManager,
    db: &DbState,
    run_id: &str,
    mut request: benchmark::BenchmarkRequest,
) -> Result<PreparedJob, String> {
    let lease = manager.measurement_lease(&run_id).await?;
    request.config_snapshot = Some(configuration_snapshot(
        &serde_json::to_value(&lease.request).map_err(|e| e.to_string())?,
        request.config_snapshot.as_ref(),
    ));
    request.context_limit_tokens =
        (lease.info.context_tokens > 0).then_some(lease.info.context_tokens);
    if lease.info.mode == "router" && request.model.as_deref().is_none_or(|id| id.is_empty()) {
        return Err("Select a router model before benchmarking".into());
    }
    let requested = if lease.info.mode == "router" {
        request.model.as_deref().unwrap_or_default()
    } else {
        &lease.info.model_id
    };
    request.model = Some(
        crate::runs::discover_model(
            &lease.info.endpoint,
            lease.api_key.as_deref().unwrap_or_default(),
            requested,
            &lease.info.mode,
        )
        .await?,
    );
    let (info, cancel) = jobs.register(&lease, &request)?;
    if let Err(error) = persist(db, &info).await {
        jobs.forget(&info.job_id);
        return Err(error);
    }
    Ok(PreparedJob {
        lease,
        request,
        info,
        cancel,
    })
}

async fn run_registered_job(
    app: Option<&AppHandle>,
    manager: &JobManager,
    db: &DbState,
    prepared: PreparedJob,
) -> JobInfo {
    let PreparedJob {
        lease,
        request,
        mut info,
        mut cancel,
    } = prepared;
    info.status = "running".into();
    info.updated_at = chrono::Utc::now().to_rfc3339();
    manager.update(&info);
    if let Some(app) = app {
        let _ = app.emit("job://state", &info);
    }
    let samples = Arc::new(Mutex::new(Vec::new()));
    let scope = Scope {
        job_id: info.job_id.clone(),
        run_id: info.run_id.clone(),
        generation: info.generation,
        samples: samples.clone(),
    };
    let result = EXECUTION.scope(scope, async {
            let measurement = execute(app, db, &lease, request);
            tokio::pin!(measurement);
            let mut checkpoint = tokio::time::interval(std::time::Duration::from_secs(1));
            loop {
                tokio::select! {
                    biased;
                    _ = async { if !*cancel.borrow() { let _ = cancel.changed().await; } } => break Err("cancelled".to_string()),
                    result = &mut measurement => break result,
                    _ = checkpoint.tick() => {
                        info.evidence["samples"] = Value::Array(samples.lock().map(|v| v.clone()).unwrap_or_default());
                        info.updated_at = chrono::Utc::now().to_rfc3339();
                        manager.update(&info);
                        if let Err(error) = persist(db, &info).await {
                            break Err(format!("Could not checkpoint measurement: {error}"));
                        }
                    }
                }
            }
        }).await;
    info.updated_at = chrono::Utc::now().to_rfc3339();
    info.evidence["samples"] = Value::Array(samples.lock().map(|v| v.clone()).unwrap_or_default());
    match result {
        Ok(result) => {
            info.status = "completed".into();
            info.benchmark_id = Some(result.id);
        }
        Err(error) if error == "cancelled" => {
            info.status = "cancelled".into();
        }
        Err(error) => {
            info.status = "failed".into();
            info.error = Some(error);
        }
    }
    if let Err(error) = persist(db, &info).await {
        info.error = Some(format!("Could not persist job outcome: {error}"));
        info.status = "failed".into();
    }
    drop(lease);
    manager.forget(&info.job_id);
    if let Some(app) = app {
        let _ = app.emit("job://state", &info);
    }
    info
}
#[tauri::command]
pub async fn cancel_job(jobs: State<'_, JobManager>, job_id: String) -> Result<(), String> {
    jobs.cancel(&job_id)
}
#[tauri::command]
pub async fn list_jobs(
    db: State<'_, DbState>,
    jobs: State<'_, JobManager>,
) -> Result<Vec<JobInfo>, String> {
    let conn = db.0.lock().await;
    let mut statement = conn
        .prepare("SELECT record_json FROM execution_jobs ORDER BY created_at DESC LIMIT 100")
        .map_err(|e| e.to_string())?;
    let records = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut result: Vec<JobInfo> = records
        .map(|record| {
            record
                .map_err(|e| e.to_string())
                .and_then(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
        })
        .collect::<Result<_, _>>()?;
    let active = jobs.active.lock().map_err(|_| "Job registry unavailable")?;
    for info in &mut result {
        if let Some(job) = active.get(&info.job_id) {
            *info = job.info.clone();
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires APLOT_SMOKE_BINARY/APLOT_SMOKE_MODEL; CPU-only, isolated in-memory DB"]
    async fn real_registered_job_persists_a_native_model_result() {
        let binary = std::env::var("APLOT_SMOKE_BINARY").unwrap();
        let model = std::env::var("APLOT_SMOKE_MODEL").unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let endpoint = format!("http://127.0.0.1:{port}");
        let runs = RunManager::default();
        let request = crate::runs::RunRequest {
            run_id: "real-job".into(),
            name: "real-job".into(),
            engine: "llama_cpp".into(),
            mode: "single".into(),
            model_id: "job-fixture".into(),
            context_tokens: 1024,
            auto_port: false,
            launch: json!({"binaryPath":binary,"args":["--model",model,"--ctx-size","1024","--n-gpu-layers","0","--parallel","1","--threads","2","--host","127.0.0.1","--port",port.to_string(),"--alias","job-fixture"],"endpoint":endpoint}),
        };
        runs.start(None, request).await.unwrap();
        let client = reqwest::Client::new();
        let mut ready = false;
        for _ in 0..120 {
            if client
                .get(format!("{endpoint}/health"))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                ready = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        assert!(ready);
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE benchmarks(id TEXT PRIMARY KEY,profile_id TEXT,profile_name TEXT,result_json TEXT,created_at TEXT);").unwrap();
        init_schema(&conn).unwrap();
        let db = DbState(tokio::sync::Mutex::new(conn));
        let jobs = JobManager::default();
        let prepared = prepare_registration(
            &runs,
            &jobs,
            &db,
            "real-job",
            benchmark::BenchmarkRequest {
                runs: 1,
                prompt_tokens: 32,
                generation_tokens: 8,
                config_snapshot: Some(json!({"ctxSize":1024,"parallel":1,"fit":false})),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let queued = prepared.info.clone();
        let result = run_registered_job(None, &jobs, &db, prepared).await;
        runs.shutdown(None).await.unwrap();
        assert_eq!(result.status, "completed", "{:?}", result.error);
        assert_eq!(result.evidence["samples"].as_array().unwrap().len(), 1);
        let payload: String =
            db.0.lock()
                .await
                .query_row(
                    "SELECT result_json FROM benchmarks WHERE id=?1",
                    [result.benchmark_id.as_ref().unwrap()],
                    |r| r.get(0),
                )
                .unwrap();
        let payload: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["configSnapshot"]["run"]["contextTokens"], 1024);
        assert_eq!(
            payload["configSnapshot"]["editorConfigurationSource"],
            "caller"
        );
        assert!(payload["averages"]["generationTps"].as_f64().unwrap() > 0.0);
        if let Ok(path) = std::env::var("APLOT_JOB_REPORT") {
            std::fs::write(
                path,
                serde_json::to_string_pretty(
                    &json!({"queued":queued,"outcome":result,"benchmark":payload}),
                )
                .unwrap(),
            )
            .unwrap();
        }
    }
    #[test]
    fn benchmark_snapshot_keeps_native_truth_and_labels_redacted_editor_data() {
        let run = json!({"engine":"llama_cpp","launch":{"args":["--ctx-size","8192","--api-key","actual-secret"]}});
        let editor = json!({"ctxSize":4096,"apiKey":"editor-secret"});
        let snapshot = configuration_snapshot(&run, Some(&editor));
        assert_eq!(snapshot["run"]["launch"]["args"][1], "8192");
        assert_eq!(snapshot["editorConfiguration"]["ctxSize"], 4096);
        assert_eq!(snapshot["editorConfigurationSource"], "caller");
        assert!(!snapshot.to_string().contains("actual-secret"));
        assert!(!snapshot.to_string().contains("editor-secret"));
        assert!(configuration_snapshot(&run, None)["editorConfiguration"].is_null());
        let cli = json!({"extraArgs":"--threads 8 --api-key 'cli-secret'","config":{"extraArgs":"--token=embedded-secret"}});
        let sanitized = public_snapshot(&cli).to_string();
        assert!(!sanitized.contains("cli-secret"));
        assert!(!sanitized.contains("embedded-secret"));
        assert_eq!(
            public_snapshot(&json!({"extraArgs":"--threads 8"}))["extraArgs"],
            "--threads 8"
        );
    }
    #[test]
    fn reports_redact_nested_fields_and_cli_keys() {
        let value = json!({"launch":{"apiKey":"private","args":["--api-key","private","--token=secret","--ctx-size","2048"]},"contextTokens":2048});
        let redacted = public_snapshot(&value);
        let text = redacted.to_string();
        assert!(!text.contains("private"));
        assert!(!text.contains("=secret"));
        assert_eq!(redacted["contextTokens"], 2048);
    }
    #[test]
    fn startup_marks_only_inflight_jobs_interrupted_and_preserves_evidence() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        for status in ["running", "completed", "cancelled"] {
            let info = JobInfo {
                job_id: status.into(),
                run_id: "r".into(),
                generation: 1,
                engine: "llama_cpp".into(),
                status: status.into(),
                created_at: "t".into(),
                updated_at: "t".into(),
                benchmark_id: None,
                error: None,
                evidence: json!({"samples":[{"run":1}]}),
            };
            conn.execute(
                "INSERT INTO execution_jobs VALUES(?1,'r',?2,?3,'t','t')",
                rusqlite::params![status, status, serde_json::to_string(&info).unwrap()],
            )
            .unwrap();
        }
        init_schema(&conn).unwrap();
        let json: String = conn
            .query_row(
                "SELECT record_json FROM execution_jobs WHERE id='running'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let interrupted: JobInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(interrupted.status, "interrupted");
        assert_eq!(interrupted.evidence["samples"][0]["run"], 1);
        let status: String = conn
            .query_row(
                "SELECT status FROM execution_jobs WHERE id='completed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "completed");
    }
    #[tokio::test]
    async fn scoped_progress_keeps_completed_samples_after_cancellation() {
        let samples = Arc::new(Mutex::new(Vec::new()));
        let scope = Scope {
            job_id: "j".into(),
            run_id: "r".into(),
            generation: 1,
            samples: samples.clone(),
        };
        EXECUTION
            .scope(scope, async {
                assert!(scoped_progress(
                    None,
                    &json!({"sample":{"run":1,"totalMs":42}})
                ));
            })
            .await;
        assert_eq!(samples.lock().unwrap()[0]["totalMs"], 42);
        assert!(!scoped_progress(None, &json!({"sample":null})));
    }

    #[tokio::test]
    async fn cancellation_drops_a_stalled_http_request_and_keeps_prior_sample() {
        use std::io::Read;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (stalled_tx, stalled_rx) = tokio::sync::oneshot::channel();
        let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
        let worker = std::thread::spawn(move || {
            let (mut first, _) = listener.accept().unwrap();
            first
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            assert!(benchmark::tests::parse_http_request(&mut first).is_some());
            benchmark::tests::write_http_response(&mut first, "text/event-stream", b"data: {\"content\":\"ok\",\"timings\":{\"prompt_per_second\":100,\"predicted_per_second\":20}}\n\ndata: [DONE]\n\n");
            drop(first);
            let (mut second, _) = listener.accept().unwrap();
            second
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            assert!(benchmark::tests::parse_http_request(&mut second).is_some());
            let _ = stalled_tx.send(());
            let mut byte = [0u8; 1];
            let closed = matches!(second.read(&mut byte), Ok(0));
            let _ = closed_tx.send(closed);
        });
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE benchmarks(id TEXT PRIMARY KEY,profile_id TEXT,profile_name TEXT,result_json TEXT,created_at TEXT);").unwrap();
        let db = DbState(tokio::sync::Mutex::new(conn));
        let samples = Arc::new(Mutex::new(Vec::new()));
        let scope = Scope {
            job_id: "cancel-http".into(),
            run_id: "r".into(),
            generation: 1,
            samples: samples.clone(),
        };
        let request = benchmark::BenchmarkRequest {
            runs: 2,
            prompt_tokens: 8,
            generation_tokens: 8,
            ..Default::default()
        };
        let started = std::time::Instant::now();
        EXECUTION.scope(scope, async {
            tokio::select! {
                _ = async { tokio::time::timeout(std::time::Duration::from_secs(10), stalled_rx).await.unwrap().unwrap(); } => {},
                result = benchmark::run_benchmark_inner(None,&db,request,endpoint,"Cancellation test".into(),None) => panic!("Request should remain stalled: {}",result.is_ok()),
            }
        }).await;
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(2), closed_rx)
                .await
                .unwrap()
                .unwrap()
        );
        worker.join().unwrap();
        assert_eq!(samples.lock().unwrap().len(), 1);
        let count: i64 =
            db.0.lock()
                .await
                .query_row("SELECT COUNT(*) FROM benchmarks", [], |r| r.get(0))
                .unwrap();
        assert_eq!(
            count, 0,
            "An interrupted benchmark must not become a successful result"
        );
    }
}
