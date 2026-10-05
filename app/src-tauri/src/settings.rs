use crate::db::DbState;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::State;

pub struct WindowBehaviorState {
    close_to_tray: AtomicBool,
    minimize_to_tray: AtomicBool,
}

impl WindowBehaviorState {
    pub fn new(settings: &AppSettings) -> Self {
        Self {
            close_to_tray: AtomicBool::new(settings.close_to_tray),
            minimize_to_tray: AtomicBool::new(settings.minimize_to_tray),
        }
    }

    pub fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed)
    }

    fn update(&self, settings: &AppSettings) {
        self.close_to_tray
            .store(settings.close_to_tray, Ordering::Relaxed);
        self.minimize_to_tray
            .store(settings.minimize_to_tray, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub setup_completed: bool,
    pub language: String,
    pub theme: String,
    pub dashboard_widgets: Vec<String>,
    pub dashboard_layout: Option<serde_json::Value>,
    pub favorite_model_ids: Vec<String>,
    pub ui_scale: f64,
    pub binary_path: String,
    pub model_directories: Vec<String>,
    pub poll_interval_ms: u64,
    pub auto_start_server: bool,
    pub start_with_windows: bool,
    pub minimize_to_tray: bool,
    pub close_to_tray: bool,
    pub log_retention_lines: usize,
    pub benchmark_runs: u32,
    pub server_engine: String,
    pub ollama_endpoint: String,
    pub ollama_model: String,
    pub ollama_binary_path: String,
    pub ollama_context: u32,
    pub strata_root_path: String,
    pub strata_config_path: String,
    pub strata_host: String,
    pub strata_port: u16,
    pub strata_api_key: String,
    pub qwfn: crate::qwfnfer::QwfnSettings,
    pub server_mode: String,
    pub router_host: String,
    pub router_port: u16,
    pub router_max_loaded_models: u32,
    pub router_autoload: bool,
    pub router_api_key: String,
}
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            setup_completed: false,
            language: "en".into(),
            theme: "dark".into(),
            dashboard_widgets: vec![
                "hardware".into(),
                "inference".into(),
                "charts".into(),
                "logs".into(),
                "quickConfig".into(),
            ],
            ui_scale: 1.1,
            dashboard_layout: None,
            favorite_model_ids: Vec::new(),
            binary_path: String::new(),
            model_directories: Vec::new(),
            poll_interval_ms: 1000,
            auto_start_server: false,
            start_with_windows: false,
            minimize_to_tray: true,
            close_to_tray: true,
            log_retention_lines: 5000,
            benchmark_runs: 5,
            server_engine: "llama_cpp".into(),
            ollama_endpoint: "http://127.0.0.1:11434".into(),
            ollama_model: String::new(),
            ollama_binary_path: String::new(),
            ollama_context: 4096,
            strata_root_path: String::new(),
            strata_config_path: String::new(),
            strata_host: "127.0.0.1".into(),
            strata_port: 8080,
            strata_api_key: String::new(),
            qwfn: crate::qwfnfer::QwfnSettings::default(),
            server_mode: "router".into(),
            router_host: "127.0.0.1".into(),
            router_port: 8080,
            router_max_loaded_models: 1,
            router_autoload: true,
            router_api_key: String::new(),
        }
    }
}

#[tauri::command]
pub async fn get_settings(db: State<'_, DbState>) -> Result<AppSettings, String> {
    let conn = db.0.lock().await;
    read_settings(&conn)
}

fn read_settings(conn: &rusqlite::Connection) -> Result<AppSettings, String> {
    let value: Option<String> = conn
        .query_row("SELECT value_json FROM kv WHERE key='settings'", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let mut settings: AppSettings = value
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if settings.strata_root_path.trim().is_empty() {
        if let Some(root) = crate::db::installation_root() {
            let strata = root.join("engines").join("strata");
            if strata.join("setup.py").is_file() && strata.join("serve").join("server.py").is_file()
            {
                settings.strata_root_path = strata.to_string_lossy().into_owned();
            }
        }
    }
    if settings.qwfn.binary_path.is_empty() {
        if let Some(root) = crate::db::installation_root() {
            let binary = root.join("engines/qwfnfer-secure/build/qwfn-server.exe");
            if binary.is_file() {
                settings.qwfn.binary_path = binary.to_string_lossy().into_owned();
            }
        }
    }
    Ok(settings)
}

pub fn initial_window_settings(db: &DbState) -> AppSettings {
    db.0.try_lock()
        .ok()
        .and_then(|conn| read_settings(&conn).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn save_settings(
    db: State<'_, DbState>,
    window_behavior: State<'_, WindowBehaviorState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let conn = db.0.lock().await;
    let json = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO kv(key,value_json,updated_at) VALUES('settings',?1,?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at", params![json, chrono::Utc::now().to_rfc3339()]).map_err(|e| e.to_string())?;
    window_behavior.update(&settings);
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_local_and_safe() {
        let settings = AppSettings::default();
        assert_eq!(settings.language, "en");
        assert!(!settings.auto_start_server);
        assert!(settings.close_to_tray);
        assert!(settings.poll_interval_ms >= 500);
        assert_eq!(settings.server_mode, "router");
        assert_eq!(settings.server_engine, "llama_cpp");
        assert_eq!(settings.router_max_loaded_models, 1);
        assert!(settings.router_autoload);
        assert!(settings.binary_path.is_empty());
        assert!(settings.model_directories.is_empty());
        assert_eq!(settings.dashboard_widgets.len(), 5);
    }

    #[test]
    fn missing_json_fields_receive_defaults() {
        let settings: AppSettings = serde_json::from_str(r#"{"language":"ru"}"#).unwrap();
        assert_eq!(settings.language, "ru");
        assert_eq!(settings.poll_interval_ms, 1000);
        assert!(!settings.setup_completed);
        assert_eq!(settings.server_mode, "router");
        assert_eq!(settings.server_engine, "llama_cpp");
        assert_eq!(settings.router_port, 8080);
        assert!(settings.favorite_model_ids.is_empty());
        assert!(settings.dashboard_layout.is_none());
    }

    #[test]
    fn model_favorites_survive_settings_roundtrip() {
        let settings = AppSettings {
            favorite_model_ids: vec!["local-model".into(), "ollama:gemma3:12b".into()],
            ..AppSettings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        let restored: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.favorite_model_ids, settings.favorite_model_ids);
    }

    #[test]
    fn window_behavior_uses_saved_tray_preferences() {
        let settings = AppSettings {
            close_to_tray: false,
            minimize_to_tray: false,
            ..AppSettings::default()
        };
        let behavior = WindowBehaviorState::new(&settings);
        assert!(!behavior.close_to_tray());
    }

    #[test]
    fn dashboard_layout_survives_sqlite_and_other_settings_edits() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value_json TEXT NOT NULL)")
            .unwrap();
        let layout = serde_json::json!({"version": 1, "items": {
            "hardware.gpu": {"x": 14.5, "y": 210, "w": 500, "h": 280},
            "charts.throughput": {"x": 530, "y": 210, "w": 670, "h": 350}
        }});
        let settings = AppSettings {
            dashboard_layout: Some(layout.clone()),
            ..AppSettings::default()
        };
        conn.execute(
            "INSERT INTO kv VALUES('settings', ?1)",
            [serde_json::to_string(&settings).unwrap()],
        )
        .unwrap();
        let mut restored = read_settings(&conn).unwrap();
        assert_eq!(restored.dashboard_layout, Some(layout.clone()));
        restored.theme = "light".into();
        conn.execute(
            "UPDATE kv SET value_json=?1",
            [serde_json::to_string(&restored).unwrap()],
        )
        .unwrap();
        assert_eq!(read_settings(&conn).unwrap().dashboard_layout, Some(layout));
    }
}
