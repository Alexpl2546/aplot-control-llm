use crate::gguf;
use serde::Serialize;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::Path,
};
use tauri::Emitter;
use walkdir::WalkDir;

struct ScanReporter {
    app: tauri::AppHandle,
    root: String,
    visited: usize,
    found: usize,
    last: std::time::Instant,
}
impl ScanReporter {
    fn visit(&mut self, path: &Path, found: bool) {
        self.visited += 1;
        self.found += usize::from(found);
        if self.last.elapsed() >= std::time::Duration::from_millis(250) || found {
            let _ = self.app.emit("disk-scan-progress", serde_json::json!({"root":self.root,"visited":self.visited,"found":self.found,"path":path.to_string_lossy()}));
            self.last = std::time::Instant::now();
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommonLocationDiscovery {
    pub binary_candidates: Vec<String>,
    pub model_directories: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRoot {
    pub path: String,
    pub label: String,
}

#[tauri::command]
pub async fn list_scan_roots() -> Result<Vec<ScanRoot>, String> {
    tokio::task::spawn_blocking(|| {
        let mut roots = Vec::new();
        #[cfg(windows)]
        for drive in b'C'..=b'Z' {
            let path = format!("{}:\\", drive as char);
            if Path::new(&path).is_dir() {
                roots.push(ScanRoot {
                    label: path.trim_end_matches('\\').to_string(),
                    path,
                });
            }
        }
        #[cfg(not(windows))]
        roots.push(ScanRoot {
            path: "/".to_string(),
            label: "/".to_string(),
        });
        Ok(roots)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn skip_drive_scan_entry(entry: &walkdir::DirEntry) -> bool {
    if !entry.file_type().is_dir() {
        return true;
    }
    let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
    !matches!(
        name.as_str(),
        "windows" | "system volume information" | "$recycle.bin" | "windowsapps" | "recovery"
    )
}

#[tauri::command]
pub async fn scan_llama_servers(
    root_path: String,
    app: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let root = Path::new(&root_path);
        if !root.is_dir() {
            return Err(format!("The selected drive is not available: {root_path}"));
        }
        let mut reporter = ScanReporter {
            app,
            root: root_path.clone(),
            visited: 0,
            found: 0,
            last: std::time::Instant::now(),
        };
        let mut binaries: Vec<String> = WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(skip_drive_scan_entry)
            .filter_map(Result::ok)
            .filter(|entry| {
                let found = entry.file_type().is_file()
                    && entry
                        .file_name()
                        .to_string_lossy()
                        .eq_ignore_ascii_case("llama-server.exe");
                reporter.visit(entry.path(), found);
                found
            })
            .map(|entry| entry.path().to_string_lossy().into_owned())
            .collect();
        binaries.sort();
        Ok(binaries)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn common_model_roots() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors() {
            if ancestor.join("models").is_dir() && ancestor.join("engines").is_dir() {
                roots.push(ancestor.join("models").join("llama.cpp"));
                break;
            }
        }
    }
    if let Ok(user) = std::env::var("USERPROFILE") {
        let user = Path::new(&user);
        roots.extend([
            user.join("Models"),
            user.join(".cache").join("lm-studio").join("models"),
            user.join("AppData")
                .join("Local")
                .join("LM-Studio")
                .join("models"),
        ]);
    }
    roots.push(Path::new(r"C:\Models").to_path_buf());
    roots
}

fn common_binary_roots() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors() {
            if ancestor.join("models").is_dir() && ancestor.join("engines").is_dir() {
                roots.push(ancestor.join("engines").join("llama.cpp"));
                break;
            }
        }
    }
    if let Ok(user) = std::env::var("USERPROFILE") {
        let user = Path::new(&user);
        roots.extend([
            user.join("AppData").join("Local").join("Programs"),
            user.join("bin"),
        ]);
    }
    roots.extend([
        Path::new(r"C:\Program Files\llama.cpp").to_path_buf(),
        Path::new(r"C:\Program Files\llama.cpp\bin").to_path_buf(),
    ]);
    roots
}

fn scan_common_locations() -> CommonLocationDiscovery {
    let mut model_directories = std::collections::BTreeSet::new();
    for root in common_model_roots()
        .into_iter()
        .filter(|path| path.is_dir())
    {
        for entry in WalkDir::new(&root)
            .max_depth(7)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if entry.file_type().is_file()
                && entry
                    .path()
                    .extension()
                    .and_then(|x| x.to_str())
                    .is_some_and(|x| x.eq_ignore_ascii_case("gguf"))
            {
                if let Some(parent) = entry.path().parent() {
                    model_directories.insert(parent.to_string_lossy().into_owned());
                }
            }
        }
    }
    let mut binary_candidates = std::collections::BTreeSet::new();
    for root in common_binary_roots()
        .into_iter()
        .filter(|path| path.is_dir())
    {
        for entry in WalkDir::new(&root)
            .max_depth(6)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if entry.file_type().is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("llama-server.exe")
            {
                binary_candidates.insert(entry.path().to_string_lossy().into_owned());
            }
        }
    }
    CommonLocationDiscovery {
        binary_candidates: binary_candidates.into_iter().collect(),
        model_directories: model_directories.into_iter().collect(),
    }
}

#[tauri::command]
pub async fn discover_common_locations() -> Result<CommonLocationDiscovery, String> {
    tokio::task::spawn_blocking(scan_common_locations)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub modified_at: String,
    pub quantization: Option<String>,
    pub architecture: Option<String>,
    pub parameter_count: Option<String>,
    pub context_length: Option<u64>,
    pub model_name: Option<String>,
    pub metadata: Option<serde_json::Value>,
}
fn id_for(path: &str) -> String {
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    format!("model-{:016x}", h.finish())
}
fn infer_quantization(name: &str) -> Option<String> {
    let u = name.to_ascii_uppercase();
    for q in [
        "IQ3_XXS", "IQ3_S", "IQ2_XS", "IQ4_NL", "Q8_0", "Q6_K", "Q5_K_M", "Q5_K_S", "Q5_1", "Q5_0",
        "Q4_K_M", "Q4_K_S", "Q4_1", "Q4_0", "Q3_K_M", "Q3_K_S", "Q2_K", "BF16", "F16", "F32",
    ] {
        if u.contains(q) {
            return Some(q.into());
        }
    }
    None
}
fn modified(meta: &fs::Metadata) -> String {
    meta.modified()
        .ok()
        .map(chrono::DateTime::<chrono::Utc>::from)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}
fn as_u64(v: Option<&serde_json::Value>) -> Option<u64> {
    v.and_then(|x| {
        x.as_u64()
            .or_else(|| x.as_i64().and_then(|n| u64::try_from(n).ok()))
    })
}
fn format_params(n: u64) -> String {
    if n >= 1_000_000_000 {
        format!("{:.1}B", n as f64 / 1e9)
    } else if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1e6)
    } else {
        n.to_string()
    }
}

#[tauri::command]
pub async fn scan_models(directories: Vec<String>) -> Result<Vec<ModelInfo>, String> {
    tokio::task::spawn_blocking(move || {
        Ok::<_, String>(scan_model_roots(directories, false, true, None))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scan_disk_models(
    root_path: String,
    app: tauri::AppHandle,
) -> Result<Vec<ModelInfo>, String> {
    tokio::task::spawn_blocking(move || {
        if !Path::new(&root_path).is_dir() {
            return Err(format!("The selected drive is not available: {root_path}"));
        }
        let reporter = ScanReporter {
            app,
            root: root_path.clone(),
            visited: 0,
            found: 0,
            last: std::time::Instant::now(),
        };
        Ok(scan_model_roots(
            vec![root_path],
            true,
            false,
            Some(reporter),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn scan_model_roots(
    directories: Vec<String>,
    skip_system_folders: bool,
    include_metadata: bool,
    mut reporter: Option<ScanReporter>,
) -> Vec<ModelInfo> {
    let mut result = Vec::new();
    for directory in directories {
        if !Path::new(&directory).exists() {
            continue;
        }
        for entry in WalkDir::new(&directory)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| !skip_system_folders || skip_drive_scan_entry(entry))
            .filter_map(Result::ok)
        {
            let path = entry.path();
            if let Some(reporter) = reporter.as_mut() {
                reporter.visit(
                    path,
                    entry.file_type().is_file()
                        && path
                            .extension()
                            .and_then(|ext| ext.to_str())
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("gguf")),
                );
            }
            if !entry.file_type().is_file()
                || path
                    .extension()
                    .and_then(|x| x.to_str())
                    .map(|x| !x.eq_ignore_ascii_case("gguf"))
                    .unwrap_or(true)
            {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(x) => x,
                Err(_) => continue,
            };
            let p = path.to_string_lossy().to_string();
            let file_name = entry.file_name().to_string_lossy().to_string();
            let gg = gguf::read_metadata(path).ok();
            let arch = gg
                .as_ref()
                .and_then(|m| m.get("general.architecture"))
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            let model_name = gg
                .as_ref()
                .and_then(|m| m.get("general.name"))
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            let params = gg
                .as_ref()
                .and_then(|m| as_u64(m.get("general.parameter_count")))
                .map(format_params);
            let context = arch.as_ref().and_then(|a| {
                gg.as_ref()
                    .and_then(|m| as_u64(m.get(&format!("{a}.context_length"))))
            });
            let metadata = if include_metadata {
                gg.map(serde_json::Value::Object)
            } else {
                None
            };
            result.push(ModelInfo {
                id: id_for(&p),
                path: p,
                file_name: file_name.clone(),
                size_bytes: meta.len(),
                modified_at: modified(&meta),
                quantization: infer_quantization(&file_name),
                architecture: arch,
                parameter_count: params,
                context_length: context,
                model_name,
                metadata,
            });
        }
    }
    result.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    result
}

pub fn inspect_model(path: &Path) -> Result<ModelInfo, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let gg = gguf::read_metadata(path).map_err(|e| e.to_string())?;
    let architecture = gg
        .get("general.architecture")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let context_length = architecture
        .as_ref()
        .and_then(|a| as_u64(gg.get(&format!("{a}.context_length"))));
    let model_name = gg
        .get("general.name")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let parameter_count = as_u64(gg.get("general.parameter_count")).map(format_params);
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    Ok(ModelInfo {
        id: id_for(&path.to_string_lossy()),
        path: path.to_string_lossy().into_owned(),
        file_name: name.clone(),
        size_bytes: meta.len(),
        modified_at: modified(&meta),
        quantization: infer_quantization(&name),
        architecture,
        parameter_count,
        context_length,
        model_name,
        metadata: Some(serde_json::Value::Object(gg)),
    })
}
pub fn validate_generation_model(path: &str) -> Result<(), String> {
    let model =
        inspect_model(Path::new(path)).map_err(|e| format!("Model is not a readable GGUF: {e}"))?;
    let arch = model
        .architecture
        .as_deref()
        .ok_or("GGUF model architecture is missing.")?;
    let name = model.file_name.to_ascii_lowercase();
    if ["clip", "mmproj"].contains(&arch)
        || name.starts_with("mmproj-")
        || name.starts_with("mtp-")
        || model
            .metadata
            .as_ref()
            .and_then(|v| v.get("general.type"))
            .and_then(|v| v.as_str())
            == Some("adapter")
    {
        return Err("An adapter or projector cannot be launched as a language model.".into());
    }
    if model
        .metadata
        .as_ref()
        .and_then(|v| v.get("split.no"))
        .and_then(|v| v.as_u64())
        .is_some_and(|v| v > 0)
    {
        return Err("Select the first GGUF shard to launch the complete model.".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn validate_llama_models(paths: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        for path in paths {
            validate_generation_model(&path)?;
            let model = inspect_model(Path::new(&path))?;
            if model.architecture.as_deref() == Some("qwen4exp") {
                return Err("Use the Strata integration for this qwen4exp GGUF. The verified llama.cpp configuration uses PrismML, which does not support its architecture.".into());
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod compatibility_tests {
    use super::*;
    fn write_string(out: &mut Vec<u8>, value: &str) {
        out.extend_from_slice(&(value.len() as u64).to_le_bytes());
        out.extend_from_slice(value.as_bytes());
    }
    #[tokio::test]
    async fn llama_launch_guard_rejects_strata_architecture_before_start() {
        let path =
            std::env::temp_dir().join(format!("aplot-strata-guard-{}.gguf", uuid::Uuid::new_v4()));
        let mut bytes = b"GGUF".to_vec();
        bytes.extend_from_slice(&3u32.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&1u64.to_le_bytes());
        write_string(&mut bytes, "general.architecture");
        bytes.extend_from_slice(&8u32.to_le_bytes());
        write_string(&mut bytes, "qwen4exp");
        fs::write(&path, bytes).unwrap();
        assert!(validate_generation_model(&path.to_string_lossy()).is_ok());
        let error = validate_llama_models(vec![path.to_string_lossy().into_owned()])
            .await
            .unwrap_err();
        assert!(error.contains("Strata"));
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn launch_guard_rejects_projector_adapter_secondary_shard_and_invalid_file() {
        let path = std::env::temp_dir().join(format!("aplot-guard-{}.gguf", uuid::Uuid::new_v4()));
        for (architecture, model_type, shard, allowed) in [
            ("qwen2", "model", 0, true),
            ("clip", "model", 0, false),
            ("qwen2", "adapter", 0, false),
            ("qwen2", "model", 1, false),
        ] {
            let mut bytes = b"GGUF".to_vec();
            bytes.extend_from_slice(&3u32.to_le_bytes());
            bytes.extend_from_slice(&0u64.to_le_bytes());
            bytes.extend_from_slice(&3u64.to_le_bytes());
            for (key, value) in [
                ("general.architecture", architecture),
                ("general.type", model_type),
            ] {
                write_string(&mut bytes, key);
                bytes.extend_from_slice(&8u32.to_le_bytes());
                write_string(&mut bytes, value);
            }
            write_string(&mut bytes, "split.no");
            bytes.extend_from_slice(&4u32.to_le_bytes());
            bytes.extend_from_slice(&(shard as u32).to_le_bytes());
            fs::write(&path, bytes).unwrap();
            assert_eq!(
                validate_generation_model(&path.to_string_lossy()).is_ok(),
                allowed
            );
        }
        fs::write(&path, b"not a GGUF").unwrap();
        assert!(validate_generation_model(&path.to_string_lossy()).is_err());
        fs::remove_file(path).unwrap();
    }
}
