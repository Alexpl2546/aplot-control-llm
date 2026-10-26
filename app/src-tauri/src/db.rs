use rusqlite::Connection;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

pub struct DbState(pub Mutex<Connection>);

/// Connection credentials and agent homes stay outside project exports. Debug UI
/// acceptance runs must never read the user's real sign-in state.
pub(crate) fn connection_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("APLOT_TEST_DATA_DIR") {
            return Ok(PathBuf::from(path));
        }
    }
    app.path().app_data_dir().map_err(|_| "storage".into())
}

fn seed_benchmark_suites(conn: &Connection, catalog: &serde_json::Value) -> Result<(), String> {
    let suites = catalog
        .get("suites")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "Bundled benchmark suite catalog has no suites array".to_string())?;
    for suite in suites {
        let id = suite
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Bundled benchmark suite is missing its id".to_string())?;
        let version = suite
            .get("version")
            .and_then(serde_json::Value::as_i64)
            .filter(|version| *version > 0)
            .ok_or_else(|| format!("Bundled benchmark suite {id} is missing its version"))?;
        conn.execute(
            "INSERT INTO benchmark_suites(id, version, suite_json, updated_at) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET version=excluded.version, suite_json=excluded.suite_json, updated_at=excluded.updated_at",
            rusqlite::params![id, version, suite.to_string(), chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|e| format!("Failed to seed benchmark suite {id}: {e}"))?;
    }
    Ok(())
}

pub fn installation_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|path| path.join("engines").is_dir() && path.join("models").is_dir())
        .map(PathBuf::from)
}

/// Resolve the model library for both the legacy portable layout (`engines` +
/// `models`) and the installed layout (`components` + `installer`). Keep this
/// separate from `installation_root`: the latter also selects the database
/// location and should not move user data just because an installer is present.
pub fn model_library_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    model_library_root_from_executable(&exe)
}

fn model_library_root_from_executable(exe: &std::path::Path) -> Option<PathBuf> {
    let parent = exe.parent()?;
    let has_component_store = parent
        .join("components")
        .join("installations.json")
        .is_file();
    let has_packaged_layout =
        parent.join("components").is_dir() && parent.join("installer").is_dir();
    if has_component_store || has_packaged_layout {
        return Some(parent.to_path_buf());
    }
    exe.ancestors()
        .find(|path| path.join("engines").is_dir() && path.join("models").is_dir())
        .map(PathBuf::from)
}

pub fn model_library_path() -> Result<PathBuf, String> {
    model_library_root().map(|root| model_library_path_from_root(&root))
        .ok_or_else(|| "Cannot locate the application's models folder. Keep the executable in the application folder.".to_string())
}

fn model_library_path_from_root(root: &Path) -> PathBuf {
    root.join("models").join("llama")
}

pub(crate) fn model_library_scan_roots() -> Vec<PathBuf> {
    model_library_root()
        .map(|root| model_library_scan_roots_from_root(&root))
        .unwrap_or_default()
}

pub(crate) fn model_library_scan_roots_from_root(root: &Path) -> Vec<PathBuf> {
    ["llama", "llama.cpp", "strata"]
        .into_iter()
        .map(|engine| root.join("models").join(engine))
        .collect()
}

pub fn init_database(app: &AppHandle) -> Result<DbState, String> {
    let legacy_dir: PathBuf = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let isolated_dir = if cfg!(debug_assertions) {
        std::env::var_os("APLOT_TEST_DATA_DIR").map(PathBuf::from)
    } else {
        None
    };
    let isolated = isolated_dir.is_some();
    let dir = isolated_dir.unwrap_or_else(|| {
        installation_root()
            .map(|root| root.join("data"))
            .unwrap_or_else(|| legacy_dir.clone())
    });
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data directory: {e}"))?;
    let path = dir.join("llama-control.sqlite3");
    let legacy = legacy_dir.join("llama-control.sqlite3");
    if !isolated && !path.exists() && legacy.is_file() && path != legacy {
        let source = Connection::open(&legacy).map_err(|e| e.to_string())?;
        source
            .execute("VACUUM INTO ?1", [path.to_string_lossy().as_ref()])
            .map_err(|e| format!("Cannot migrate application data: {e}"))?;
    }
    let mut conn =
        Connection::open(&path).map_err(|e| format!("Failed to open SQLite database: {e}"))?;
    if path.exists() {
        let backups = dir.join("backups");
        fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
        let backup = backups.join(format!(
            "profiles-{}.sqlite3",
            chrono::Utc::now().format("%Y%m%d-%H%M%S-%f")
        ));
        conn.execute("VACUUM INTO ?1", [backup.to_string_lossy().as_ref()])
            .map_err(|e| format!("Cannot back up application data: {e}"))?;
    }
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         CREATE TABLE IF NOT EXISTS profiles (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           description TEXT,
           config_json TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           last_used_at TEXT,
           last_known_good INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS kv (
           key TEXT PRIMARY KEY,
           value_json TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS benchmarks (
           id TEXT PRIMARY KEY,
           profile_id TEXT,
           profile_name TEXT NOT NULL,
           result_json TEXT NOT NULL,
           created_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS benchmark_suites (
           id TEXT PRIMARY KEY,
           version INTEGER NOT NULL,
           suite_json TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS events (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           timestamp TEXT NOT NULL,
           kind TEXT NOT NULL,
           payload_json TEXT
         );",
    )
    .map_err(|e| format!("Failed to initialize database: {e}"))?;
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("../resources/benchmark-suites.json"))
            .map_err(|e| format!("Invalid bundled benchmark suite catalog: {e}"))?;
    seed_benchmark_suites(&conn, &catalog)?;
    crate::migrations::migrate(&mut conn)?;
    crate::downloads::repository::init_schema(&conn)?;
    crate::jobs::init_schema(&conn)?;
    crate::chat_history::init_schema(&conn)?;
    Ok(DbState(Mutex::new(conn)))
}

pub async fn record_event(db: &DbState, kind: &str, payload: Option<serde_json::Value>) {
    let conn = db.0.lock().await;
    let _ = conn.execute(
        "INSERT INTO events(timestamp, kind, payload_json) VALUES(?1, ?2, ?3)",
        rusqlite::params![
            chrono::Utc::now().to_rfc3339(),
            kind,
            payload.map(|v| v.to_string())
        ],
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_library_root_detects_installed_components_layout_without_engines_folder() {
        let root =
            std::env::temp_dir().join(format!("aplot-installed-layout-{}", uuid::Uuid::new_v4()));
        let exe = root.join("aplot-control-llm.exe");
        fs::create_dir_all(root.join("components")).unwrap();
        fs::create_dir_all(root.join("installer")).unwrap();
        fs::create_dir_all(root.join("models")).unwrap();

        assert_eq!(model_library_root_from_executable(&exe), Some(root.clone()));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn model_library_root_detects_installed_layout_before_models_folder_exists() {
        let root =
            std::env::temp_dir().join(format!("aplot-installed-empty-{}", uuid::Uuid::new_v4()));
        let exe = root.join("aplot-control-llm.exe");
        fs::create_dir_all(root.join("components")).unwrap();
        fs::create_dir_all(root.join("installer")).unwrap();

        assert_eq!(model_library_root_from_executable(&exe), Some(root.clone()));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn model_library_root_keeps_legacy_portable_layout() {
        let root =
            std::env::temp_dir().join(format!("aplot-portable-layout-{}", uuid::Uuid::new_v4()));
        let exe = root.join("bin").join("aplot-control-llm.exe");
        fs::create_dir_all(root.join("engines")).unwrap();
        fs::create_dir_all(root.join("models")).unwrap();
        fs::create_dir_all(exe.parent().unwrap()).unwrap();

        assert_eq!(model_library_root_from_executable(&exe), Some(root.clone()));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn model_library_import_path_matches_the_llama_download_directory() {
        let root = PathBuf::from(r"C:\Aplot Control LLM");

        assert_eq!(
            model_library_path_from_root(&root),
            root.join("models").join("llama")
        );
    }

    #[test]
    fn model_library_scan_roots_include_engine_stores_and_the_legacy_import_folder() {
        let root = PathBuf::from(r"C:\Aplot Control LLM");

        assert_eq!(
            model_library_scan_roots_from_root(&root),
            vec![
                root.join("models").join("llama"),
                root.join("models").join("llama.cpp"),
                root.join("models").join("strata"),
            ]
        );
    }

    #[test]
    fn bundled_benchmark_suites_seed_and_update_by_version() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE benchmark_suites(id TEXT PRIMARY KEY, version INTEGER NOT NULL, suite_json TEXT NOT NULL, updated_at TEXT NOT NULL);").unwrap();
        let catalog: serde_json::Value =
            serde_json::from_str(include_str!("../resources/benchmark-suites.json")).unwrap();
        seed_benchmark_suites(&conn, &catalog).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM benchmark_suites", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 3);

        let mut updated = catalog.clone();
        updated["suites"][1]["version"] = serde_json::json!(99);
        seed_benchmark_suites(&conn, &updated).unwrap();
        let version: i64 = conn
            .query_row(
                "SELECT version FROM benchmark_suites WHERE id='context-recall-v1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 99);
    }
}
