use crate::db::DbState;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::State;

const SUPPORTED_LANGUAGES: [&str; 10] =
    ["en", "ru", "de", "fr", "es", "pt", "it", "zh", "ja", "ko"];

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
    pub pinned_server_ids: Vec<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_engine_id: Option<String>,
    pub strata_root_path: String,
    pub strata_config_path: String,
    pub strata_host: String,
    pub strata_port: u16,
    pub strata_api_key: String,
    pub server_mode: String,
    pub router_host: String,
    pub router_port: u16,
    pub router_max_loaded_models: u32,
    pub router_autoload: bool,
    pub router_api_key: String,
    /// Unknown and retired settings remain available for round-trip export.
    #[serde(default, flatten)]
    pub extensions: BTreeMap<String, Value>,
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
            ui_scale: 0.0, // 0 = Auto: the frontend picks the scale from the window size
            dashboard_layout: None,
            favorite_model_ids: Vec::new(),
            pinned_server_ids: Vec::new(),
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
            legacy_engine_id: None,
            strata_root_path: String::new(),
            strata_config_path: String::new(),
            strata_host: "127.0.0.1".into(),
            strata_port: 8080,
            strata_api_key: String::new(),
            server_mode: "router".into(),
            router_host: "127.0.0.1".into(),
            router_port: 8080,
            router_max_loaded_models: 1,
            router_autoload: true,
            router_api_key: String::new(),
            extensions: BTreeMap::new(),
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
    let raw = value
        .as_deref()
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    let mut decode = raw.clone().unwrap_or_else(|| json!({}));
    if decode
        .get("serverEngine")
        .is_some_and(|engine| !engine.is_string())
    {
        decode["serverEngine"] = Value::String(String::new());
    }
    let mut settings: AppSettings = serde_json::from_value(decode).unwrap_or_default();
    if !SUPPORTED_LANGUAGES.contains(&settings.language.as_str()) {
        settings.language = AppSettings::default().language;
    }
    let stored_engine = raw
        .as_ref()
        .and_then(|settings| settings.get("serverEngine"));
    match stored_engine {
        Some(Value::String(engine)) if engine.trim().is_empty() => {
            settings.server_engine.clear();
            settings.legacy_engine_id = None;
            settings.auto_start_server = false;
            settings.router_autoload = false;
        }
        Some(Value::String(engine)) if crate::domain::profile::is_supported_engine(engine) => {
            settings.server_engine = engine.clone();
            settings.legacy_engine_id = None;
        }
        Some(Value::String(engine)) => {
            settings.server_engine.clear();
            settings.legacy_engine_id = Some(engine.clone());
            settings.auto_start_server = false;
            settings.router_autoload = false;
        }
        Some(engine) => {
            settings.server_engine.clear();
            settings.legacy_engine_id = Some(engine.to_string());
            settings.auto_start_server = false;
            settings.router_autoload = false;
        }
        None => {
            if settings
                .legacy_engine_id
                .as_deref()
                .is_some_and(|engine| !engine.trim().is_empty())
            {
                settings.server_engine.clear();
                settings.auto_start_server = false;
                settings.router_autoload = false;
            }
        }
    }
    if settings.strata_root_path.trim().is_empty() {
        if let Some(root) = crate::db::installation_root() {
            let strata = root.join("engines").join("strata");
            if strata.join("setup.py").is_file() && strata.join("serve").join("server.py").is_file()
            {
                settings.strata_root_path = strata.to_string_lossy().into_owned();
            }
        }
    }
    crate::components::apply_defaults(&mut settings);
    Ok(settings)
}

fn settings_value_for_storage(settings: &mut AppSettings) -> Result<Value, String> {
    if !SUPPORTED_LANGUAGES.contains(&settings.language.as_str()) {
        return Err(format!(
            "Unsupported application language: {}",
            settings.language
        ));
    }
    if !settings.server_engine.trim().is_empty()
        && !crate::domain::profile::is_supported_engine(&settings.server_engine)
    {
        return Err(crate::domain::profile::unsupported_engine_error(
            &settings.server_engine,
        ));
    }
    if settings.server_engine.trim().is_empty() {
        settings.auto_start_server = false;
        settings.router_autoload = false;
    } else {
        settings.legacy_engine_id = None;
    }
    let mut value = serde_json::to_value(&*settings).map_err(|e| e.to_string())?;
    if settings.server_engine.trim().is_empty() {
        if let Some(legacy_engine) = settings
            .legacy_engine_id
            .as_deref()
            .filter(|engine| !engine.trim().is_empty())
        {
            value["serverEngine"] = Value::String(legacy_engine.to_string());
        }
    }
    if let Some(object) = value.as_object_mut() {
        object.remove("legacyEngineId");
    }
    Ok(value)
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
    mut settings: AppSettings,
) -> Result<AppSettings, String> {
    let conn = db.0.lock().await;
    let value = settings_value_for_storage(&mut settings)?;
    let json = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO kv(key,value_json,updated_at) VALUES('settings',?1,?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at", params![json, chrono::Utc::now().to_rfc3339()]).map_err(|e| e.to_string())?;
    window_behavior.update(&settings);
    Ok(settings)
}

#[cfg(test)]
mod tests {
    #[test]
    fn all_application_languages_survive_storage() {
        for language in super::SUPPORTED_LANGUAGES {
            let mut settings = super::AppSettings {
                language: language.to_string(),
                ..super::AppSettings::default()
            };
            let value = super::settings_value_for_storage(&mut settings).unwrap();
            assert_eq!(value["language"], language);
            let restored: super::AppSettings = serde_json::from_value(value).unwrap();
            assert_eq!(restored.language, language);
        }
    }

    #[test]
    fn unsupported_application_language_is_rejected() {
        let mut settings = super::AppSettings {
            language: "unsupported".into(),
            ..super::AppSettings::default()
        };
        assert!(super::settings_value_for_storage(&mut settings).is_err());
    }

    #[test]
    fn invalid_stored_language_recovers_without_losing_other_settings() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value_json TEXT NOT NULL)")
            .unwrap();
        conn.execute(
            "INSERT INTO kv VALUES('settings', ?1)",
            [r#"{"language":"invalid","theme":"light","binaryPath":"C:/llama-server.exe"}"#],
        )
        .unwrap();
        let settings = super::read_settings(&conn).unwrap();
        assert_eq!(settings.language, "en");
        assert_eq!(settings.theme, "light");
        assert_eq!(settings.binary_path, "C:/llama-server.exe");
    }

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
    fn retired_engine_settings_round_trip_without_autostart_or_default_replacement() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE kv(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);",
        )
        .unwrap();
        let original = json!({
            "serverEngine":"ollama",
            "autoStartServer":true,
            "routerAutoload":true,
            "ollamaEndpoint":"http://127.0.0.1:11434",
            "ollamaModel":"legacy-model",
            "qwfn":{"binaryPath":"C:/old/qwfn.exe","apiKey":"preserved-secret"},
            "infernix":{"modelPath":"C:/old/model.infernix"},
            "futureSetting":{"kept":true}
        });
        conn.execute(
            "INSERT INTO kv VALUES('settings',?1,'a')",
            [original.to_string()],
        )
        .unwrap();

        let mut settings = read_settings(&conn).unwrap();
        assert_eq!(settings.server_engine, "");
        assert_eq!(settings.legacy_engine_id.as_deref(), Some("ollama"));
        assert!(!settings.auto_start_server);
        assert!(!settings.router_autoload);

        let stored = settings_value_for_storage(&mut settings).unwrap();
        assert_eq!(stored["serverEngine"], "ollama");
        assert_eq!(stored["ollamaEndpoint"], original["ollamaEndpoint"]);
        assert_eq!(stored["qwfn"]["apiKey"], "preserved-secret");
        assert_eq!(
            stored["infernix"]["modelPath"],
            original["infernix"]["modelPath"]
        );
        assert_eq!(stored["futureSetting"], original["futureSetting"]);
        assert_eq!(stored["autoStartServer"], false);
        assert_eq!(stored["routerAutoload"], false);
        assert!(stored.get("legacyEngineId").is_none());
    }

    #[test]
    fn supported_engine_selection_clears_legacy_marker_and_keeps_old_fields_for_export() {
        let mut settings: AppSettings = serde_json::from_value(json!({
            "serverEngine":"strata",
            "legacyEngineId":"infernix",
            "infernix":{"modelPath":"C:/old/model.infernix"}
        }))
        .unwrap();
        let stored = settings_value_for_storage(&mut settings).unwrap();
        assert_eq!(stored["serverEngine"], "strata");
        assert_eq!(stored["infernix"]["modelPath"], "C:/old/model.infernix");
        assert!(stored.get("legacyEngineId").is_none());
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
