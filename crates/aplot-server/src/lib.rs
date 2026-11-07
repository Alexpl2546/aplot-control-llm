//! Standalone server bootstrap. The default router exposes metadata only;
//! the separately configured mobile router serves authenticated task access.
use aplot_core::tasks::store;
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::get,
    Json, Router,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    net::SocketAddr,
    path::Path,
};

pub mod codex_runtime;
pub mod delegation_admin;
pub mod mobile_api;
pub mod mobile_host;
pub mod queue_supervisor;
mod runtime_session;
pub mod tool_broker;
mod turn_runner;
mod workspace_admin;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    schema_version: u32,
    server_id: String,
}

/// Holds the OS lock for the entire server lifetime. A second process must not
/// become a writer for the same data directory, even through an alternate path.
pub struct ServerData {
    identity: Identity,
    tasks: Connection,
    _owner: File,
}

impl ServerData {
    pub fn open(directory: &Path) -> io::Result<Self> {
        fs::create_dir_all(directory)?;
        let owner = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join("server.lock"))?;
        match owner.try_lock() {
            Ok(()) => {}
            Err(fs::TryLockError::WouldBlock) => {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "server-data-already-owned",
                ));
            }
            Err(fs::TryLockError::Error(error)) => return Err(error),
        }
        let path = directory.join("server.json");
        let identity = match fs::read(&path) {
            Ok(bytes) => {
                let identity: Identity = serde_json::from_slice(&bytes).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "server-identity-invalid")
                })?;
                if identity.schema_version != 1
                    || uuid::Uuid::parse_str(&identity.server_id).is_err()
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "server-identity-unsupported",
                    ));
                }
                identity
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let identity = Identity {
                    schema_version: 1,
                    server_id: uuid::Uuid::new_v4().to_string(),
                };
                let temporary = directory.join("server.json.tmp");
                let mut file = File::create(&temporary)?;
                file.write_all(&serde_json::to_vec_pretty(&identity)?)?;
                file.sync_all()?;
                drop(file);
                fs::rename(temporary, path)?;
                identity
            }
            Err(error) => return Err(error),
        };
        // Use a separate journal until an explicit desktop migration exists.
        // Never adopt/recover the desktop's live database by guessing its path.
        let mut tasks =
            Connection::open(directory.join("server-tasks.sqlite3")).map_err(io::Error::other)?;
        tasks
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(io::Error::other)?;
        let version: u32 = tasks
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(io::Error::other)?;
        if version > 3 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "server-task-schema-newer",
            ));
        }
        tasks
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
            .map_err(io::Error::other)?;
        let tx = tasks.transaction().map_err(io::Error::other)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);").map_err(io::Error::other)?;
        store::create_schema(&tx).map_err(io::Error::other)?;
        runtime_session::create_schema(&tx).map_err(io::Error::other)?;
        aplot_core::delegation::create_schema(&tx).map_err(io::Error::other)?;
        tx.pragma_update(None, "user_version", 3)
            .map_err(io::Error::other)?;
        tx.commit().map_err(io::Error::other)?;
        store::recover(&mut tasks).map_err(io::Error::other)?;
        aplot_core::delegation::recover_proposals(&mut tasks).map_err(io::Error::other)?;
        Ok(Self {
            identity,
            tasks,
            _owner: owner,
        })
    }

    /// Local administrative snapshot. Private history is deliberately absent
    /// from the unauthenticated HTTP API. The transaction couples cursor/data.
    pub fn snapshot(&mut self) -> io::Result<serde_json::Value> {
        let tx = self.tasks.transaction().map_err(io::Error::other)?;
        let tasks = store::task_ids(&tx, None)
            .map_err(io::Error::other)?
            .into_iter()
            .map(|id| store::task_view(&tx, &id))
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?;
        let workspace = aplot_core::workspace_sync::snapshot(&tx).map_err(io::Error::other)?;
        let snapshot = serde_json::json!({"serverId":self.identity.server_id,"cursor":store::cursor(&tx).map_err(io::Error::other)?,"hostRuntimes":[],"tasks":tasks.into_iter().flatten().collect::<Vec<_>>(),"workspace":workspace});
        tx.commit().map_err(io::Error::other)?;
        Ok(snapshot)
    }

    pub fn info(&self) -> ServerInfo {
        ServerInfo {
            api_version: 1,
            server_id: self.identity.server_id.clone(),
            version: env!("CARGO_PKG_VERSION"),
            capabilities: Capabilities {
                task_execution: false,
                remote_access: false,
            },
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub api_version: u32,
    pub server_id: String,
    pub version: &'static str,
    pub capabilities: Capabilities,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub task_execution: bool,
    pub remote_access: bool,
}

#[derive(Clone)]
struct ApiState {
    info: ServerInfo,
    authority: String,
}

/// The public bootstrap listener is restricted to loopback until device
/// authentication and grants exist. It never opens the desktop database.
pub fn router(info: ServerInfo, address: SocketAddr) -> io::Result<Router> {
    if !address.ip().is_loopback() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "remote-access-not-enabled",
        ));
    }
    let state = ApiState {
        info,
        authority: address.to_string(),
    };
    Ok(Router::new()
        .route(
            "/healthz",
            get(|| async { Json(serde_json::json!({"status":"ok"})) }),
        )
        .route(
            "/api/v1/info",
            get(|State(state): State<ApiState>| async move { Json(state.info) }),
        )
        .layer(middleware::from_fn_with_state(state.clone(), local_request))
        .with_state(state))
}

async fn local_request(
    State(state): State<ApiState>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    // Reject cross-origin browser access and DNS-rebinding Host values. No
    // credentials, data routes or mutation endpoints are exposed at this stage.
    if request.headers().contains_key(header::ORIGIN)
        || request
            .headers()
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            != Some(state.authority.as_str())
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    struct TestDir(std::path::PathBuf);
    impl TestDir {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("aplot-server-test-{}", uuid::Uuid::new_v4())))
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn identity_persists_and_ownership_is_exclusive() {
        let dir = TestDir::new();
        let first = ServerData::open(&dir.0).unwrap();
        assert_eq!(
            ServerData::open(&dir.0).err().unwrap().kind(),
            io::ErrorKind::WouldBlock
        );
        let id = first.info().server_id;
        drop(first);
        assert_eq!(ServerData::open(&dir.0).unwrap().info().server_id, id);
    }

    #[test]
    fn malformed_identity_is_never_replaced() {
        let dir = TestDir::new();
        fs::create_dir_all(&dir.0).unwrap();
        fs::write(dir.0.join("server.json"), b"broken").unwrap();
        assert!(ServerData::open(&dir.0).is_err());
        assert_eq!(fs::read(dir.0.join("server.json")).unwrap(), b"broken");
    }

    #[test]
    fn newer_database_is_rejected_and_old_preview_schema_upgrades() {
        let dir = TestDir::new();
        let data = ServerData::open(&dir.0).unwrap();
        let id = data.info().server_id;
        data.tasks.pragma_update(None, "user_version", 1).unwrap();
        data.tasks
            .execute_batch("DROP TABLE server_runtime_bindings")
            .unwrap();
        drop(data);
        let upgraded = ServerData::open(&dir.0).unwrap();
        assert_eq!(upgraded.info().server_id, id);
        assert_eq!(
            upgraded
                .tasks
                .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
                .unwrap(),
            3
        );
        upgraded
            .tasks
            .pragma_update(None, "user_version", 999)
            .unwrap();
        drop(upgraded);
        assert!(ServerData::open(&dir.0)
            .err()
            .unwrap()
            .to_string()
            .contains("server-task-schema-newer"));
    }

    #[test]
    fn shared_journal_recovers_after_reopen_without_repeating_work() {
        let dir = TestDir::new();
        let mut data = ServerData::open(&dir.0).unwrap();
        let tx = data.tasks.transaction().unwrap();
        let mut journal = store::Journal::new(&tx);
        journal.ensure_task("saved-task", "codex").unwrap();
        journal
            .edit_state("saved-task", |state| {
                state.live = true;
                state.pending = true;
                state.native_generation = Some(7);
            })
            .unwrap();
        drop(journal);
        tx.commit().unwrap();
        drop(data);
        let mut reopened = ServerData::open(&dir.0).unwrap();
        let snapshot = reopened.snapshot().unwrap();
        assert_eq!(snapshot["tasks"][0]["id"], "saved-task");
        assert_eq!(snapshot["tasks"][0]["state"]["live"], false);
        assert_eq!(snapshot["tasks"][0]["state"]["pending"], false);
        assert!(snapshot["tasks"][0]["state"]
            .get("nativeGeneration")
            .is_none());
        assert!(snapshot["hostRuntimes"].as_array().unwrap().is_empty());
        assert!(!dir.0.join("llama-control.sqlite3").exists());
    }

    #[tokio::test]
    async fn metadata_api_rejects_browser_origins_and_wrong_hosts() {
        let dir = TestDir::new();
        let data = ServerData::open(&dir.0).unwrap();
        let app = router(data.info(), "127.0.0.1:8123".parse().unwrap()).unwrap();
        for (host, origin, expected) in [
            ("127.0.0.1:8123", None, 200),
            ("attacker.example", None, 403),
            ("127.0.0.1:8123", Some("https://attacker.example"), 403),
        ] {
            let mut request = axum::http::Request::builder()
                .uri("/api/v1/info")
                .header("host", host);
            if let Some(origin) = origin {
                request = request.header("origin", origin);
            }
            let response = app
                .clone()
                .oneshot(request.body(axum::body::Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), expected);
            if expected == 200 {
                assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            }
        }
        assert!(router(data.info(), "0.0.0.0:8123".parse().unwrap()).is_err());
    }
}
