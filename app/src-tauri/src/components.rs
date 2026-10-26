//! Paths published by the optional-component installer. No model or process is started here.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComponentLocation {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub version: String,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    components: Vec<ComponentLocation>,
}
pub(crate) fn store_root() -> Option<PathBuf> {
    resolve_store_root(
        std::env::var_os("APLOT_COMPONENT_ROOT"),
        std::env::var_os("LOCALAPPDATA"),
    )
}
fn resolve_store_root(
    configured: Option<std::ffi::OsString>,
    local_app_data: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    if let Some(configured) = configured {
        let path = PathBuf::from(configured);
        // A bad explicit root must not fall back to a different removable store.
        return (path.is_absolute()
            && !path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir)))
        .then(|| path.components().collect());
    }
    Some(PathBuf::from(local_app_data?).join("Aplot Control LLM/components"))
}
fn valid(id: &str, path: &Path) -> bool {
    // A prepared Python environment is not a finished engine installation.
    let root = if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    if root.join("aplot-installing.json").is_file() && !root.join("aplot-component.json").is_file()
    {
        return false;
    }
    match id {
        "claude" => {
            path.is_file()
                && path
                    .file_name()
                    .is_some_and(|s| s.eq_ignore_ascii_case("claude.exe"))
        }
        "codex" => {
            path.is_file()
                && path.file_name().is_some_and(|s| {
                    s.eq_ignore_ascii_case("codex.exe")
                        || s.eq_ignore_ascii_case("codex-x86_64-pc-windows-msvc.exe")
                })
        }
        "strata" => {
            path.join("setup.py").is_file()
                && path.join("serve/server.py").is_file()
                && path.join(".venv/Scripts/python.exe").is_file()
        }
        "hermes" => {
            path.join("tui_gateway/entry.py").is_file()
                && [".venv/Scripts/python.exe", "venv/Scripts/python.exe"]
                    .iter()
                    .any(|p| path.join(p).is_file())
        }
        "llama_cpp" => {
            path.file_name()
                .is_some_and(|s| s.eq_ignore_ascii_case("llama-server.exe"))
                && path.is_file()
        }
        _ => false,
    }
}
fn read_manifest(path: &Path) -> Vec<ComponentLocation> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Manifest>(&s).ok())
        .filter(|manifest| manifest.schema_version == 1)
        .unwrap_or_default()
        .components
        .into_iter()
        .filter(|item| valid(&item.id, Path::new(&item.path)))
        .collect()
}
pub(crate) fn managed_locations() -> Vec<ComponentLocation> {
    store_root()
        .map(|root| read_manifest(&root.join("installations.json")))
        .unwrap_or_default()
}
pub(crate) fn location(id: &str) -> Option<PathBuf> {
    managed_locations()
        .into_iter()
        .find(|item| item.id == id)
        .map(|item| PathBuf::from(item.path))
}
pub(crate) fn apply_defaults(settings: &mut crate::settings::AppSettings) {
    apply_locations(settings, managed_locations());
}
fn apply_locations(settings: &mut crate::settings::AppSettings, locations: Vec<ComponentLocation>) {
    for item in locations {
        let target = match item.id.as_str() {
            "llama_cpp" => &mut settings.binary_path,
            "strata" => &mut settings.strata_root_path,
            _ => continue,
        };
        if target.trim().is_empty() {
            *target = item.path;
        }
    }
}
fn configured_locations(settings: &serde_json::Value, result: &mut Vec<ComponentLocation>) {
    for (id, pointer) in [("llama_cpp", "/binaryPath"), ("strata", "/strataRootPath")] {
        if let Some(path) = settings.pointer(pointer).and_then(|s| s.as_str()) {
            if valid(id, Path::new(path)) && !result.iter().any(|item| item.id == id) {
                result.push(ComponentLocation {
                    id: id.into(),
                    path: path.into(),
                    version: "existing".into(),
                });
            }
        }
    }
}
pub(crate) fn inventory(app_directory: Option<PathBuf>) -> Vec<ComponentLocation> {
    inventory_with_origin(app_directory, None)
}
/// Read-only discovery for launch selectors. Does not run any engine or load a model.
#[tauri::command]
pub(crate) async fn available_engines(
    settings: crate::settings::AppSettings,
) -> Vec<ComponentLocation> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = Vec::new();
        configured_locations(
            &serde_json::to_value(settings).unwrap_or_default(),
            &mut result,
        );
        for item in inventory(None) {
            if ["llama_cpp", "strata"].contains(&item.id.as_str())
                && !result.iter().any(|r| r.id == item.id)
            {
                result.push(item);
            }
        }
        result
    })
    .await
    .unwrap_or_default()
}
fn discovery_roots(app_directory: Option<PathBuf>, origin: Option<PathBuf>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let seeds = [
        app_directory,
        origin,
        crate::db::installation_root(),
        std::env::current_dir().ok(),
    ];
    for seed in seeds.into_iter().flatten() {
        for path in seed.ancestors().take(6) {
            if (path.join("engines").is_dir() || path.join("data/llama-control.sqlite3").is_file())
                && !roots.iter().any(|r| r == path)
            {
                roots.push(path.to_path_buf());
            }
        }
        if !roots.contains(&seed) {
            roots.push(seed);
        }
    }
    if let Some(drive) = std::env::var_os("SystemDrive") {
        let root = PathBuf::from(format!("{}\\Aplot Control LLM", drive.to_string_lossy()));
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    roots
}
fn discover_layout(root: &Path, result: &mut Vec<ComponentLocation>) {
    // Bounded application layout search; never crawl the user's drives or model library.
    for (id, folders, name) in [
        (
            "llama_cpp",
            vec!["llama.cpp", "llama_cpp"],
            "llama-server.exe",
        ),
        ("strata", vec!["strata"], "setup.py"),
    ] {
        if result.iter().any(|item| item.id == id) {
            continue;
        }
        let mut queue: Vec<_> = folders
            .iter()
            .map(|folder| (root.join("engines").join(folder), 0))
            .collect();
        let mut visited = 0;
        while let Some((directory, depth)) = queue.pop() {
            visited += 1;
            if visited > 180 {
                break;
            }
            let candidate = if id == "strata" {
                directory.clone()
            } else {
                directory.join(name)
            };
            if valid(id, &candidate) {
                result.push(ComponentLocation {
                    id: id.into(),
                    path: candidate.to_string_lossy().into_owned(),
                    version: "existing".into(),
                });
                break;
            }
            if depth >= 4 {
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(&directory) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    if name.starts_with('.')
                        || ["models", "node_modules", "third_party", "venv", "data"]
                            .contains(&name.as_str())
                    {
                        continue;
                    }
                    if entry
                        .file_type()
                        .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
                    {
                        queue.push((entry.path(), depth + 1));
                    }
                }
            }
        }
    }
}
fn inventory_with_origin(
    app_directory: Option<PathBuf>,
    origin: Option<PathBuf>,
) -> Vec<ComponentLocation> {
    let mut result = Vec::new();
    let roots = discovery_roots(app_directory, origin);
    let mut databases: Vec<_> = roots
        .iter()
        .map(|root| root.join("data/llama-control.sqlite3"))
        .collect();
    if let Some(roaming) = std::env::var_os("APPDATA") {
        databases.push(PathBuf::from(roaming).join("app.aplot.llamacontrol/llama-control.sqlite3"));
    }
    for database in databases {
        // Inventory is read-only, does not run migrations and never exports credentials.
        if let Ok(conn) = rusqlite::Connection::open_with_flags(
            database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ) {
            if let Ok(raw) =
                conn.query_row("SELECT value_json FROM kv WHERE key='settings'", [], |r| {
                    r.get::<_, String>(0)
                })
            {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                    configured_locations(&value, &mut result);
                }
            }
            if let Ok(mut query) = conn.prepare("SELECT envelope_json FROM launch_profiles_v2") {
                if let Ok(rows) = query.query_map([], |r| r.get::<_, String>(0)) {
                    for row in rows.flatten() {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&row) {
                            if let Some(config) = value.pointer("/profile/legacyConfig") {
                                configured_locations(config, &mut result);
                                for id in ["llama_cpp", "strata"] {
                                    if let Some(options) =
                                        config.pointer(&format!("/engineOptions/{id}"))
                                    {
                                        configured_locations(options, &mut result);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if let Some((root, _)) = crate::hermes::agent_runtime() {
        result.push(ComponentLocation {
            id: "hermes".into(),
            path: root.to_string_lossy().into_owned(),
            version: "existing".into(),
        });
    }
    for item in managed_locations() {
        if !result.iter().any(|r| r.id == item.id) {
            result.push(item);
        }
    }
    if !result.iter().any(|c| c.id == "claude") {
        if let Some(path) = crate::claude_agent::discovered_executable() {
            result.push(ComponentLocation {
                id: "claude".into(),
                path: path.to_string_lossy().into_owned(),
                version: "existing".into(),
            });
        }
    }
    if !result.iter().any(|c| c.id == "codex") {
        if let Some(path) = crate::codex_agent::discovered_executable() {
            result.push(ComponentLocation {
                id: "codex".into(),
                path: path.to_string_lossy().into_owned(),
                version: "existing".into(),
            });
        }
    }
    for root in roots {
        discover_layout(&root, &mut result);
    }
    for folder in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        for (id, name) in [("llama_cpp", "llama-server.exe")] {
            let path = folder.join(name);
            if !result.iter().any(|r| r.id == id) && valid(id, &path) {
                result.push(ComponentLocation {
                    id: id.into(),
                    path: path.to_string_lossy().into_owned(),
                    version: "existing".into(),
                });
            }
        }
    }
    result
}
/// Called before Tauri/single-instance initialization by the installer probe.
/// The protocol has one fixed read-only query and writes only the requested JSON report.
pub fn inventory_cli() -> Option<i32> {
    let args = std::env::args_os().collect::<Vec<_>>();
    if args.get(1).is_none_or(|a| a != "--component-inventory") {
        return None;
    }
    if ![3, 4, 5].contains(&args.len()) {
        return Some(2);
    }
    let data = serde_json::json!({"schemaVersion":1,"components":inventory_with_origin(args.get(3).map(PathBuf::from), args.get(4).map(PathBuf::from))});
    Some(
        if std::fs::write(
            PathBuf::from(&args[2]),
            serde_json::to_vec(&data).unwrap_or_default(),
        )
        .is_ok()
        {
            0
        } else {
            1
        },
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_component_store_is_absolute_and_never_falls_back_when_invalid() {
        let base = std::env::temp_dir();
        let configured = base.join("проект с пробелами/components");
        assert_eq!(
            resolve_store_root(
                Some(configured.clone().into_os_string()),
                Some(base.clone().into_os_string())
            ),
            Some(configured)
        );
        for invalid in [
            PathBuf::new(),
            PathBuf::from("relative/components"),
            base.join("components/../other"),
        ] {
            assert_eq!(
                resolve_store_root(
                    Some(invalid.into_os_string()),
                    Some(base.clone().into_os_string())
                ),
                None
            );
        }
        assert_eq!(
            resolve_store_root(None, Some(base.clone().into_os_string())),
            Some(base.join("Aplot Control LLM/components"))
        );
        assert_eq!(resolve_store_root(None, None), None);
    }
    #[test]
    fn unfinished_python_engine_is_not_discovered_as_ready() {
        let root = std::env::temp_dir().join(format!("aplot-incomplete-{}", uuid::Uuid::new_v4()));
        for file in [
            "setup.py",
            "serve/server.py",
            ".venv/Scripts/python.exe",
            "aplot-installing.json",
        ] {
            let path = root.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, []).unwrap();
        }
        assert!(!valid("strata", &root));
        std::fs::write(root.join("aplot-component.json"), "{}").unwrap();
        assert!(valid("strata", &root));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn portable_layout_discovers_supported_engines_and_ignores_legacy_paths() {
        let root = std::env::temp_dir().join(format!("aplot-discovery-{}", uuid::Uuid::new_v4()));
        let origin = root.join("releases/build");
        let legacy_binary = root.join("engines/Ollama/ollama.exe");
        let configured = root.join("custom/llama-server.exe");
        for folder in [
            &origin,
            legacy_binary.parent().unwrap(),
            configured.parent().unwrap(),
            &root.join("data"),
        ] {
            std::fs::create_dir_all(folder).unwrap();
        }
        std::fs::write(&legacy_binary, []).unwrap();
        std::fs::write(&configured, []).unwrap();
        let connection =
            rusqlite::Connection::open(root.join("data/llama-control.sqlite3")).unwrap();
        connection
            .execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY,value_json TEXT);")
            .unwrap();
        connection
            .execute(
                "INSERT INTO kv VALUES('settings',?1)",
                [
                    serde_json::json!({"binaryPath":configured,"ollamaBinaryPath":legacy_binary,"apiKey":"never-export-me"})
                        .to_string(),
                ],
            )
            .unwrap();
        drop(connection);
        let inventory = inventory_with_origin(Some(root.join("new-install")), Some(origin));
        assert!(!inventory.iter().any(|r| r.id == "ollama"));
        assert!(inventory
            .iter()
            .any(|r| r.id == "llama_cpp" && Path::new(&r.path) == configured));
        assert!(legacy_binary.is_file());
        assert!(!serde_json::to_string(&inventory)
            .unwrap()
            .contains("never-export-me"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn bounded_layout_discovery_finds_supported_builds_and_ignores_legacy_engines() {
        let root = std::env::temp_dir().join(format!("aplot-layout-{}", uuid::Uuid::new_v4()));
        let correct = root.join("engines/llama.cpp/build/llama-server.exe");
        let ignored = root.join("engines/infernix/models/fake/infernix-serve.exe");
        let legacy = root.join("engines/QwFNfer/qwfn-server.exe");
        for path in [&correct, &ignored, &legacy] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, []).unwrap();
        }
        let mut result = Vec::new();
        discover_layout(&root, &mut result);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "llama_cpp");
        assert_eq!(Path::new(&result[0].path), correct);
        assert!(legacy.is_file());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn component_defaults_fill_only_empty_paths_without_changing_engine_or_autostart() {
        let mut settings = crate::settings::AppSettings {
            binary_path: "user-llama.exe".into(),
            extensions: [
                (
                    "ollamaBinaryPath".into(),
                    serde_json::json!("legacy-ollama.exe"),
                ),
                (
                    "qwfn".into(),
                    serde_json::json!({"binaryPath":"legacy-qwfn.exe"}),
                ),
                (
                    "infernix".into(),
                    serde_json::json!({"binaryPath":"legacy-infernix.exe"}),
                ),
            ]
            .into(),
            ..Default::default()
        };
        let legacy_settings = settings.extensions.clone();
        let locations = [
            "llama_cpp",
            "strata",
            "ollama",
            "qwfnfer",
            "infernix",
            "hermes",
        ]
        .into_iter()
        .map(|id| ComponentLocation {
            id: id.into(),
            path: format!("managed-{id}"),
            version: "1".into(),
        })
        .collect();
        apply_locations(&mut settings, locations);
        assert_eq!(settings.binary_path, "user-llama.exe");
        assert_eq!(settings.strata_root_path, "managed-strata");
        assert_eq!(settings.extensions, legacy_settings);
        assert_eq!(settings.server_engine, "llama_cpp");
        assert!(!settings.auto_start_server);
    }
    #[test]
    fn inventory_returns_only_existing_component_paths_and_never_credentials() {
        let root = std::env::temp_dir().join(format!("aplot-components-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let binary = root.join("llama-server.exe");
        std::fs::write(&binary, []).unwrap();
        let mut result = Vec::new();
        configured_locations(
            &serde_json::json!({"binaryPath":binary,"apiKey":"private","strataRootPath":"missing"}),
            &mut result,
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "llama_cpp");
        assert!(!valid("ollama", &binary));
        assert!(!valid("qwfnfer", &binary));
        assert!(!valid("infernix", &binary));
        assert!(!serde_json::to_string(&result).unwrap().contains("private"));
        assert!(!valid("future-agent", &binary));
        std::fs::remove_file(binary).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
