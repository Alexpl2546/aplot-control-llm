use crate::process::StartServerRequest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrataModelOption {
    pub config_path: String,
    pub model_path: Option<String>,
    pub model_name: String,
    pub context_length: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartStrataServerRequest {
    pub root_path: String,
    pub config_path: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub api_key: String,
}

pub(crate) fn root_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value.trim());
    if value.trim().is_empty() {
        return Err("Choose the Strata installation folder in Settings.".into());
    }
    let root = path
        .canonicalize()
        .map_err(|error| format!("Cannot open the Strata folder: {error}"))?;
    if !root.join("setup.py").is_file() || !root.join("serve").join("server.py").is_file() {
        return Err(
            "This folder is not a Strata installation. Choose the folder containing setup.py."
                .into(),
        );
    }
    Ok(root)
}

fn python_path(root: &Path) -> PathBuf {
    root.join(".venv").join("Scripts").join("python.exe")
}

fn config_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(value.trim())
        .canonicalize()
        .map_err(|error| format!("Cannot open the selected Strata model configuration: {error}"))?;
    if candidate.parent() != Some(root)
        || !candidate.is_file()
        || !candidate
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("strata-") && name.ends_with(".json"))
    {
        return Err(
            "Choose a strata-*.json model configuration from the selected Strata folder.".into(),
        );
    }
    Ok(candidate)
}

fn config_value(path: &Path) -> Result<Value, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Cannot read Strata model configuration: {error}"))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Invalid Strata model configuration: {error}"))
}

fn resolved_config_path(base: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

fn configured_working_directory(root: &Path, config: &Value) -> PathBuf {
    config
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| resolved_config_path(root, value))
        .unwrap_or_else(|| root.to_path_buf())
}

fn decimal_mtp_count(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn argument_path_directory(flag: &str) -> Option<bool> {
    match flag {
        "--pack" | "--mtp" => Some(true),
        "--native"
        | "--native-dense-gguf"
        | "--embd-gguf"
        | "--ple-gguf"
        | "--expert-profile"
        | "--mtp-draft-vocab" => Some(false),
        _ => None,
    }
}

fn validate_argument_path(
    cwd: &Path,
    flag: &str,
    value: &str,
    directory: bool,
) -> Result<PathBuf, String> {
    let path = resolved_config_path(cwd, value);
    let exists = if directory {
        path.is_dir()
    } else {
        path.is_file()
    };
    if exists {
        Ok(path)
    } else {
        let kind = if directory { "folder" } else { "file" };
        Err(format!(
            "The Strata {flag} {kind} is missing: {}.",
            path.display()
        ))
    }
}

fn validate_engine_argument_paths(cwd: &Path, args: &[Value]) -> Result<(), String> {
    for (index, argument) in args.iter().enumerate() {
        let Some(argument) = argument.as_str() else {
            continue;
        };
        if let Some((flag, _)) = argument.split_once('=') {
            if argument_path_directory(flag).is_some() {
                return Err(format!(
                    "The Strata configuration must pass {flag} and its path as separate arguments."
                ));
            }
            continue;
        }
        let flag = argument;
        let Some(value_kind) = argument_path_directory(flag) else {
            continue;
        };
        let value = args
            .get(index + 1)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty() && !value.starts_with('-'))
            .ok_or_else(|| format!("The Strata configuration has no path after {flag}."))?;

        // Strata also accepts a numeric --mtp value as a draft count for Qwen3.6.
        if flag == "--mtp" && decimal_mtp_count(value) {
            continue;
        }

        let path = validate_argument_path(cwd, flag, value, value_kind)?;
        if flag == "--mtp" {
            // These three files are required by Strata's session model input list. draft_vocab.bin is
            // intentionally optional in the engine and is only required when explicitly passed below.
            for required_file in ["dense.bin", "dense.txt", "experts.bin"] {
                let required_path = path.join(required_file);
                if !required_path.is_file() {
                    return Err(format!(
                        "The Strata --mtp runtime is missing {required_file}: {}.",
                        required_path.display()
                    ));
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_config(root: &Path, path: &Path) -> Result<StrataModelOption, String> {
    let config = config_value(path)?;
    let cwd = configured_working_directory(root, &config);
    if !cwd.is_dir() {
        return Err(format!(
            "The Strata working directory is missing: {}.",
            cwd.display()
        ));
    }
    let model_name = config
        .get("model_name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "The Strata configuration has no model name.".to_string())?;
    let exe = config
        .get("exe")
        .and_then(Value::as_str)
        .ok_or_else(|| "The Strata configuration has no engine executable.".to_string())?;
    if exe != "component:strata-engine" && !resolved_config_path(&cwd, exe).is_file() {
        return Err("The Strata engine executable is missing. Run Strata setup again.".into());
    }
    let tokenizer = config
        .get("tokenizer")
        .and_then(Value::as_str)
        .ok_or_else(|| "The Strata configuration has no tokenizer folder.".to_string())?;
    // The Python server resolves tokenizer relative to its own process cwd (the install root);
    // engine paths, by contrast, are resolved against the config's cwd below.
    let tokenizer_path = resolved_config_path(root, tokenizer);
    for required_file in ["vocab.json", "merges.txt", "token_type.json"] {
        let file_path = tokenizer_path.join(required_file);
        if !file_path.is_file() {
            return Err(format!(
                "The Strata tokenizer is incomplete; {} is missing. Run Strata setup again.",
                file_path.display()
            ));
        }
    }
    let args = config
        .get("args")
        .and_then(Value::as_array)
        .ok_or_else(|| "The Strata configuration has no engine arguments.".to_string())?;
    if args.iter().any(|argument| !argument.is_string()) {
        return Err("Every Strata engine argument must be a string.".into());
    }
    validate_engine_argument_paths(&cwd, args)?;
    let context_length = args
        .windows(2)
        .rfind(|pair| pair[0].as_str() == Some("--max-context"))
        .and_then(|pair| pair[1].as_str())
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    Ok(StrataModelOption {
        config_path: path.to_string_lossy().into_owned(),
        model_path: args
            .windows(2)
            .rfind(|pair| {
                pair[0]
                    .as_str()
                    .is_some_and(|v| v == "-m" || v == "--model" || v == "--native")
            })
            .and_then(|pair| pair[1].as_str())
            .map(|value| {
                resolved_config_path(&cwd, value)
                    .to_string_lossy()
                    .into_owned()
            }),
        model_name: model_name.to_string(),
        context_length,
    })
}

#[tauri::command]
pub fn discover_strata_models(root_value: String) -> Result<Vec<StrataModelOption>, String> {
    let root = root_path(&root_value)?;
    let python = python_path(&root);
    if !python.is_file() {
        return Err(
            "Strata is not prepared yet. Complete its setup before selecting it here.".into(),
        );
    }
    let mut configurations = Vec::new();
    let mut invalid_configurations = Vec::new();
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if path.is_file() && filename.starts_with("strata-") && filename.ends_with(".json") {
            match validate_config(&root, &path) {
                Ok(configuration) => configurations.push(configuration),
                Err(error) => invalid_configurations.push(format!("{filename}: {error}")),
            }
        }
    }
    if configurations.is_empty() {
        if let Some(error) = invalid_configurations.first() {
            return Err(format!(
                "No valid Strata model configurations found: {error}"
            ));
        }
    } else if !invalid_configurations.is_empty() {
        eprintln!(
            "Skipping invalid Strata model configurations: {}",
            invalid_configurations.join("; ")
        );
    }
    configurations.sort_by(|left, right| left.model_name.cmp(&right.model_name));
    // Installing the engine does not download models. Invalid profiles are
    // skipped individually so one stale configuration cannot hide valid ones.
    Ok(configurations)
}

fn task_filename(task_id: &str) -> Result<String, String> {
    if task_id.len() != 36 || !task_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err("Invalid task profile identifier.".into());
    }
    Ok(format!("strata-task-{task_id}.json"))
}

fn task_configuration(mut config: Value, context: u32) -> Result<Value, String> {
    if ![8192, 16384, 32768, 65536, 131072].contains(&context) {
        return Err("Unsupported task context.".into());
    }
    let args = config
        .get_mut("args")
        .and_then(Value::as_array_mut)
        .ok_or("The Strata configuration has no engine arguments.")?;
    let indexes: Vec<usize> = args
        .iter()
        .enumerate()
        .filter(|(_, v)| v.as_str() == Some("--max-context"))
        .map(|(i, _)| i)
        .collect();
    if indexes.len() != 1 {
        return Err("A task requires one explicit maximum context.".into());
    }
    let index = indexes[0] + 1;
    let maximum = args
        .get(index)
        .and_then(Value::as_str)
        .and_then(|v| v.parse::<u32>().ok())
        .ok_or("Invalid source context.")?;
    if context > maximum {
        return Err("The requested context exceeds the source profile.".into());
    }
    args[index] = Value::String(context.to_string());
    Ok(config)
}

/// Derive a launch file only on explicit Apply. The source config is never modified.
#[tauri::command]
pub fn create_strata_task_config(
    root_value: String,
    config_value: String,
    context: u32,
    task_id: String,
) -> Result<String, String> {
    use std::io::Write;
    let root = root_path(&root_value)?;
    let source = config_path(&root, &config_value)?;
    validate_config(&root, &source)?;
    let config = task_configuration(config_value_from_path(&source)?, context)?;
    let destination = root.join(task_filename(&task_id)?);
    let data = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|e| e.to_string())?;
    if let Err(error) = file.write_all(&data).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&destination);
        return Err(error.to_string());
    }
    Ok(destination.to_string_lossy().into_owned())
}

fn config_value_from_path(path: &Path) -> Result<Value, String> {
    config_value(path)
}

/// Cleanup is restricted to a generated UUID filename directly in the validated root.
#[tauri::command]
pub fn remove_strata_task_config(root_value: String, task_id: String) -> Result<(), String> {
    let root = root_path(&root_value)?;
    let path = root.join(task_filename(&task_id)?);
    if path.exists() {
        let resolved = path.canonicalize().map_err(|e| e.to_string())?;
        if resolved.parent() != Some(root.as_path()) {
            return Err("Task file is outside the Strata root.".into());
        }
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn build_start_request(
    request: StartStrataServerRequest,
) -> Result<StartServerRequest, String> {
    prepare_start_request(request).map(|(launch, _)| launch)
}

/// Return launch metadata from the same validated configuration as the
/// command. Callers must not resolve model paths against the Python cwd: the
/// native engine can have a different cwd declared in the config.
pub(crate) fn prepare_start_request(
    request: StartStrataServerRequest,
) -> Result<(StartServerRequest, StrataModelOption), String> {
    let root = root_path(&request.root_path)?;
    let python = python_path(&root);
    if !python.is_file() {
        return Err(
            "Strata's private Python environment is missing. Complete its setup first.".into(),
        );
    }
    let config = config_path(&root, &request.config_path)?;
    let model = validate_config(&root, &config)?;
    let host = request.host.trim().trim_matches(['[', ']']);
    if host.is_empty() || request.port == 0 {
        return Err("Set a valid Strata host and port in Settings.".into());
    }
    let is_loopback = matches!(
        host.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1" | "[::1]"
    );
    if !is_loopback && request.api_key.trim().is_empty() {
        return Err("Set a Strata API key before listening on the local network.".into());
    }
    let host_for_url = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let launch = StartServerRequest {
        binary_path: python.to_string_lossy().into_owned(),
        args: vec![
            "-m".into(),
            "serve.server".into(),
            "--engine".into(),
            "strata".into(),
            "--config".into(),
            config.to_string_lossy().into_owned(),
            "--host".into(),
            host.to_string(),
            "--port".into(),
            request.port.to_string(),
        ],
        endpoint: Some(format!("http://{host_for_url}:{}", request.port)),
        profile_id: Some(model.model_name.clone()),
        backend: Some("strata".into()),
        working_directory: Some(root.to_string_lossy().into_owned()),
        api_key: Some(request.api_key),
    };
    Ok((launch, model))
}

/// Strata engine settings the app can edit by hand. Paths and every other
/// argument are kept exactly as Strata prepared them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrataConfigDetails {
    pub model_name: String,
    pub max_context: Option<u32>,
    pub kv: Option<String>,
    pub mtp: bool,
    /// The draft layer can be turned back on (its folder is known).
    pub mtp_available: bool,
    pub spec: Option<u32>,
    /// Pictures are read through the model's mmproj projector.
    pub vision: bool,
    /// The projector is known (on, or turned off by Aplot) and its file is on disk.
    pub vision_available: bool,
    /// The projector runs on the video card; otherwise on the CPU.
    pub vision_gpu: bool,
    /// Set when the context is stretched past the trained length (YaRN).
    pub rope_scaling: Option<String>,
    pub files: Vec<StrataConfigFile>,
    /// A copy made by Aplot; saving writes over it instead of making another.
    pub aplot_copy: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrataConfigFile {
    pub flag: String,
    pub path: String,
    pub exists: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrataConfigEdits {
    pub max_context: u32,
    pub kv: String,
    pub mtp: bool,
    pub spec: Option<u32>,
    #[serde(default)]
    pub vision: Option<bool>,
    #[serde(default)]
    pub vision_gpu: Option<bool>,
}

const STRATA_KV_MODES: [&str; 4] = ["int8", "q4_0", "k8v4", "fp16"];
const APLOT_COPY_PREFIX: &str = "strata-aplot-";
/// Where a turned-off draft layer remembers its folder, so it can be turned on again.
const SAVED_MTP_KEY: &str = "aplot_mtp";
/// Where a turned-off picture reader keeps its settings.
const SAVED_VISION_KEY: &str = "aplot_vision";
/// Qwen3.8-Flash-Next is trained to 256K; past it Strata's setup stretches RoPE with YaRN.
const STRATA_TRAINED_CONTEXT: u32 = 262_144;

fn arg_value(args: &[Value], flag: &str) -> Option<String> {
    let index = args.iter().position(|value| value.as_str() == Some(flag))?;
    args.get(index + 1)?.as_str().map(str::to_owned)
}

fn set_arg(args: &mut Vec<Value>, flag: &str, value: String) {
    match args.iter().position(|item| item.as_str() == Some(flag)) {
        Some(index) if index + 1 < args.len() => args[index + 1] = Value::String(value),
        _ => args.extend([Value::String(flag.into()), Value::String(value)]),
    }
}

fn remove_arg(args: &mut Vec<Value>, flag: &str) {
    if let Some(index) = args.iter().position(|item| item.as_str() == Some(flag)) {
        let end = (index + 2).min(args.len());
        args.drain(index..end);
    }
}

fn has_flag(args: &[Value], flag: &str) -> bool {
    args.iter().any(|item| item.as_str() == Some(flag))
}

fn remove_flag(args: &mut Vec<Value>, flag: &str) {
    args.retain(|item| item.as_str() != Some(flag));
}

fn is_aplot_copy(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(APLOT_COPY_PREFIX))
}

fn config_details(root: &Path, path: &Path, config: &Value) -> StrataConfigDetails {
    let cwd = configured_working_directory(root, config);
    let args = config
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut files = Vec::new();
    for (index, argument) in args.iter().enumerate() {
        let Some(flag) = argument.as_str() else {
            continue;
        };
        let Some(directory) = argument_path_directory(flag) else {
            continue;
        };
        let Some(value) = args.get(index + 1).and_then(Value::as_str) else {
            continue;
        };
        if flag == "--mtp" && decimal_mtp_count(value) {
            continue;
        }
        let resolved = resolved_config_path(&cwd, value);
        let exists = if directory {
            resolved.is_dir()
        } else {
            resolved.is_file()
        };
        files.push(StrataConfigFile {
            flag: flag.to_owned(),
            path: resolved.to_string_lossy().into_owned(),
            exists,
        });
    }
    let mtp = arg_value(&args, "--mtp").is_some();
    let vision = has_flag(&args, "--vision") && config.get("vision").is_some_and(Value::is_object);
    let reader = config
        .get("vision")
        .filter(|value| value.is_object())
        .or_else(|| config.get(SAVED_VISION_KEY));
    let projector = reader
        .and_then(|value| value.get("mmproj"))
        .and_then(Value::as_str)
        .map(|value| resolved_config_path(&cwd, value));
    if let Some(path) = &projector {
        files.push(StrataConfigFile {
            flag: "mmproj".into(),
            path: path.to_string_lossy().into_owned(),
            exists: path.is_file(),
        });
    }
    StrataConfigDetails {
        model_name: config
            .get("model_name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        max_context: arg_value(&args, "--max-context").and_then(|value| value.parse().ok()),
        kv: arg_value(&args, "--kv"),
        mtp,
        mtp_available: mtp || config.get(SAVED_MTP_KEY).and_then(Value::as_str).is_some(),
        spec: arg_value(&args, "--spec").and_then(|value| value.parse().ok()),
        vision,
        vision_available: projector.is_some_and(|path| path.is_file()),
        vision_gpu: reader
            .and_then(|value| value.get("gpu"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        rope_scaling: arg_value(&args, "--rope-scaling"),
        files,
        aplot_copy: is_aplot_copy(path),
    }
}

#[tauri::command]
pub fn strata_config_details(
    root_value: String,
    config_value: String,
) -> Result<StrataConfigDetails, String> {
    let root = root_path(&root_value)?;
    let path = config_path(&root, &config_value)?;
    Ok(config_details(
        &root,
        &path,
        &config_value_from_path(&path)?,
    ))
}

/// Applies the edits to a copy of the configuration. The model name carries the
/// context so the copy is told apart in model lists.
fn edited_config(mut config: Value, edits: &StrataConfigEdits) -> Result<Value, String> {
    if !(4096..=1_048_576).contains(&edits.max_context) {
        return Err("context-out-of-range".into());
    }
    if !STRATA_KV_MODES.contains(&edits.kv.as_str()) {
        return Err("kv-unsupported".into());
    }
    if edits.spec.is_some_and(|spec| !(1..=8).contains(&spec)) {
        return Err("spec-out-of-range".into());
    }
    let saved_mtp = config
        .get(SAVED_MTP_KEY)
        .and_then(Value::as_str)
        .map(str::to_owned);
    let args = config
        .get_mut("args")
        .and_then(Value::as_array_mut)
        .ok_or("The Strata configuration has no engine arguments.")?;
    set_arg(args, "--max-context", edits.max_context.to_string());
    set_arg(args, "--kv", edits.kv.clone());
    let mut remember = None;
    match (edits.mtp, arg_value(args, "--mtp")) {
        (false, Some(path)) => {
            remember = Some(path);
            for flag in ["--mtp", "--spec", "--spec-min-p"] {
                remove_arg(args, flag);
            }
        }
        (true, None) => {
            let path = saved_mtp.clone().ok_or("mtp-unavailable")?;
            set_arg(args, "--mtp", path);
            set_arg(args, "--spec", edits.spec.unwrap_or(4).to_string());
            if arg_value(args, "--spec-min-p").is_none() {
                set_arg(args, "--spec-min-p", "0.5".into());
            }
        }
        (true, Some(_)) => {
            if let Some(spec) = edits.spec {
                set_arg(args, "--spec", spec.to_string());
            }
        }
        (false, None) => {}
    }
    if edits.max_context > STRATA_TRAINED_CONTEXT {
        let factor = f64::from(edits.max_context) / f64::from(STRATA_TRAINED_CONTEXT);
        set_arg(args, "--rope-scaling", "yarn".into());
        set_arg(
            args,
            "--rope-scale",
            format!("{}", (factor * 1000.0).round() / 1000.0),
        );
    } else {
        remove_arg(args, "--rope-scaling");
        remove_arg(args, "--rope-scale");
    }
    let vision_on = edits.vision.unwrap_or_else(|| has_flag(args, "--vision"));
    if vision_on {
        if !has_flag(args, "--vision") {
            args.push(Value::String("--vision".into()));
        }
    } else {
        remove_flag(args, "--vision");
    }
    let args_now = args.clone();
    if vision_on {
        if !config.get("vision").is_some_and(Value::is_object) {
            let saved = config
                .as_object_mut()
                .and_then(|map| map.remove(SAVED_VISION_KEY))
                .ok_or("vision-unavailable")?;
            config["vision"] = saved;
        }
        if let Some(gpu) = edits.vision_gpu {
            config["vision"]["gpu"] = Value::Bool(gpu);
            if !gpu && config["vision"].get("threads").is_none() {
                let threads = std::thread::available_parallelism()
                    .map(|n| n.get() / 2)
                    .unwrap_or(8)
                    .clamp(4, 16);
                config["vision"]["threads"] = Value::from(threads);
            }
        }
    } else if let Some(reader) = config.as_object_mut().and_then(|map| map.remove("vision")) {
        config[SAVED_VISION_KEY] = reader;
    }
    if config.get("args_written").is_some() {
        config["args_written"] = Value::Array(args_now);
    }
    if let Some(path) = remember {
        config[SAVED_MTP_KEY] = Value::String(path);
    }
    let name = config
        .get("model_name")
        .and_then(Value::as_str)
        .unwrap_or("strata")
        .to_owned();
    let base = match name.rsplit_once('-') {
        Some((head, tail))
            if tail.ends_with('k')
                && tail[..tail.len() - 1].chars().all(|c| c.is_ascii_digit()) =>
        {
            head.to_owned()
        }
        _ => name,
    };
    config["model_name"] = Value::String(format!("{base}-{}k", edits.max_context / 1024));
    Ok(config)
}

#[tauri::command]
pub fn save_strata_config(
    root_value: String,
    config_value: String,
    edits: StrataConfigEdits,
) -> Result<String, String> {
    let root = root_path(&root_value)?;
    let source = config_path(&root, &config_value)?;
    let config = edited_config(config_value_from_path(&source)?, &edits)?;
    let destination = if is_aplot_copy(&source) {
        source.clone()
    } else {
        let name = config["model_name"]
            .as_str()
            .unwrap_or("strata")
            .to_lowercase();
        let slug: String = name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        root.join(format!("{APLOT_COPY_PREFIX}{slug}.json"))
    };
    let existed = destination.exists();
    let temporary = destination.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
    let data = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&temporary, data).map_err(|e| e.to_string())?;
    fs::rename(&temporary, &destination).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        e.to_string()
    })?;
    if let Err(error) = validate_config(&root, &destination) {
        if !existed {
            let _ = fs::remove_file(&destination);
        }
        return Err(error);
    }
    Ok(destination.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    struct TestInstall(PathBuf);

    impl TestInstall {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("strata-test-{}", Uuid::new_v4()));
            fs::create_dir_all(root.join("serve")).unwrap();
            fs::create_dir_all(root.join(".venv").join("Scripts")).unwrap();
            fs::create_dir_all(root.join("engine")).unwrap();
            fs::create_dir_all(root.join("tokenizer")).unwrap();
            fs::write(root.join("setup.py"), "").unwrap();
            fs::write(root.join("serve").join("server.py"), "").unwrap();
            fs::write(root.join(".venv").join("Scripts").join("python.exe"), "").unwrap();
            fs::write(root.join("engine").join("strata.exe"), "").unwrap();
            fs::write(root.join("tokenizer").join("vocab.json"), "{}").unwrap();
            fs::write(root.join("tokenizer").join("merges.txt"), "").unwrap();
            fs::write(root.join("tokenizer").join("token_type.json"), "{}").unwrap();
            fs::write(
                root.join("strata-test.json"),
                r#"{
                "exe":"engine/strata.exe",
                "tokenizer":"tokenizer",
                "model_name":"qwen-test",
                "args":["--max-context","65536"]
            }"#,
            )
            .unwrap();
            Self(root)
        }

        fn model_config(&self) -> PathBuf {
            self.0.join("strata-test.json")
        }

        fn write_config(&self, config: &Value) {
            fs::write(self.model_config(), serde_json::to_vec(config).unwrap()).unwrap();
        }
    }

    impl Drop for TestInstall {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn discovers_prepared_model_configs_and_context() {
        let install = TestInstall::new();
        let models = discover_strata_models(install.0.to_string_lossy().into_owned()).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model_name, "qwen-test");
        assert_eq!(models[0].context_length, 65_536);
    }

    #[test]
    fn refuses_tokenizers_missing_any_file_required_by_server() {
        let install = TestInstall::new();
        for (name, contents) in [
            ("vocab.json", "{}"),
            ("merges.txt", ""),
            ("token_type.json", "{}"),
        ] {
            let path = install.0.join("tokenizer").join(name);
            fs::remove_file(&path).unwrap();
            let error = validate_config(&install.0, &install.model_config()).unwrap_err();
            assert!(error.contains(name), "{name}: {error}");
            fs::write(path, contents).unwrap();
        }
    }

    #[test]
    fn validates_documented_companion_paths_from_config_cwd() {
        let install = TestInstall::new();
        let cwd = install.0.join("server work");
        fs::create_dir_all(cwd.join("engine")).unwrap();
        fs::create_dir_all(cwd.join("pack data")).unwrap();
        fs::create_dir_all(cwd.join("weights")).unwrap();
        fs::create_dir_all(cwd.join("data")).unwrap();
        let mtp = cwd.join("draft data").join("rt");
        fs::create_dir_all(&mtp).unwrap();
        fs::write(cwd.join("engine/strata.exe"), "").unwrap();
        let native = install.0.join("absolute model.gguf");
        let embedding = install.0.join("absolute embedding.gguf");
        let draft_vocab = install.0.join("absolute draft vocab.bin");
        fs::write(&native, "").unwrap();
        fs::write(&embedding, "").unwrap();
        fs::write(&draft_vocab, "").unwrap();
        fs::write(cwd.join("weights/dense model.gguf"), "").unwrap();
        fs::write(cwd.join("weights/ple.gguf"), "").unwrap();
        fs::write(cwd.join("data/profile.bin"), "").unwrap();
        for name in ["dense.bin", "dense.txt", "experts.bin"] {
            fs::write(mtp.join(name), "").unwrap();
        }

        let mut config = config_value(&install.model_config()).unwrap();
        config["cwd"] = Value::String("server work".into());
        config["exe"] = Value::String("engine/strata.exe".into());
        // The server loads this relative path from the installation root, not config cwd.
        config["tokenizer"] = Value::String("tokenizer".into());
        config["args"] = serde_json::json!([
            "--pack",
            "pack data",
            "--native",
            native.to_string_lossy(),
            "--native-dense-gguf",
            "weights/dense model.gguf",
            "--embd-gguf",
            embedding.to_string_lossy(),
            "--ple-gguf",
            "weights/ple.gguf",
            "--expert-profile",
            "data/profile.bin",
            "--mtp",
            "draft data/rt",
            "--mtp-draft-vocab",
            draft_vocab.to_string_lossy(),
        ]);
        install.write_config(&config);

        let model = validate_config(&install.0, &install.model_config()).unwrap();
        assert_eq!(
            model.model_path.as_deref(),
            Some(native.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn run_metadata_uses_native_cwd_and_the_validated_model_configuration() {
        let install = TestInstall::new();
        let cwd = install.0.join("native work");
        fs::create_dir_all(cwd.join("engine")).unwrap();
        fs::create_dir_all(cwd.join("models")).unwrap();
        fs::write(cwd.join("engine/strata.exe"), "").unwrap();
        let model_path = cwd.join("models/native.gguf");
        fs::write(&model_path, "").unwrap();
        let mut config = config_value(&install.model_config()).unwrap();
        config["cwd"] = Value::String("native work".into());
        config["args"] = serde_json::json!([
            "--max-context",
            "8192",
            "--native",
            "models/native.gguf",
            "--max-context",
            "32768"
        ]);
        install.write_config(&config);
        let mut request = crate::runs::RunRequest {
            run_id: "strata-cwd-test".into(),
            name: "Native test".into(),
            engine: "strata".into(),
            mode: "single".into(),
            model_id: String::new(),
            context_tokens: 8192,
            auto_port: false,
            launch: serde_json::json!({
                "rootPath": install.0.to_string_lossy(), "configPath": install.model_config().to_string_lossy(),
                "host": "0.0.0.0", "port": 8123, "apiKey": "private-key",
                "resolvedModelPaths": ["stale-model.gguf"]
            }),
        };
        let launch = crate::engine_adapters::prepare(&mut request).unwrap();
        assert_eq!(request.context_tokens, 32768);
        assert_eq!(request.model_id, "qwen-test");
        let protected_paths = request.launch["resolvedModelPaths"].as_array().unwrap();
        assert_eq!(protected_paths.len(), 1);
        assert_eq!(
            Path::new(protected_paths[0].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            model_path.canonicalize().unwrap()
        );
        assert_eq!(launch.endpoint(), "http://127.0.0.1:8123");
        assert_eq!(
            crate::engine_adapters::argument_value(&launch.0.args, &["--host"]),
            Some("0.0.0.0")
        );
        assert_eq!(
            launch.0.working_directory.as_deref(),
            Some(install.0.canonicalize().unwrap().to_string_lossy().as_ref())
        );
    }

    #[test]
    fn invalid_working_directory_and_non_string_arguments_are_rejected_before_launch() {
        let install = TestInstall::new();
        let mut config = config_value(&install.model_config()).unwrap();
        config["exe"] = Value::String(install.0.join("engine/strata.exe").to_string_lossy().into());
        config["cwd"] = Value::String("missing-work-directory".into());
        install.write_config(&config);
        assert!(validate_config(&install.0, &install.model_config())
            .unwrap_err()
            .contains("working directory"));
        config["cwd"] = Value::String(".".into());
        config["args"] = serde_json::json!(["--max-context", 32768]);
        install.write_config(&config);
        assert!(validate_config(&install.0, &install.model_config())
            .unwrap_err()
            .contains("must be a string"));
    }

    #[test]
    fn pack_only_configuration_does_not_keep_a_stale_native_model_path() {
        let install = TestInstall::new();
        let mut request = crate::runs::RunRequest {
            run_id: "strata-pack-test".into(),
            name: "Pack test".into(),
            engine: "strata".into(),
            mode: "single".into(),
            model_id: "configured".into(),
            context_tokens: 8192,
            auto_port: false,
            launch: serde_json::json!({
                "rootPath": install.0.to_string_lossy(), "configPath": install.model_config().to_string_lossy(),
                "host": "127.0.0.1", "port": 8123, "resolvedModelPaths": ["stale-model.gguf"]
            }),
        };
        crate::engine_adapters::prepare(&mut request).unwrap();
        assert_eq!(request.launch["resolvedModelPaths"], serde_json::json!([]));
        assert_eq!(request.context_tokens, 65536);
        assert_eq!(request.model_id, "configured");
    }

    #[test]
    fn validates_only_required_mtp_runtime_files_and_skips_numeric_mtp() {
        let install = TestInstall::new();
        let mut config = config_value(&install.model_config()).unwrap();
        config["args"] = serde_json::json!(["--mtp", "2"]);
        install.write_config(&config);
        assert!(validate_config(&install.0, &install.model_config()).is_ok());

        let mtp = install.0.join("mtp");
        fs::create_dir_all(&mtp).unwrap();
        for name in ["dense.bin", "experts.bin"] {
            fs::write(mtp.join(name), "").unwrap();
        }
        config["args"] = serde_json::json!(["--mtp", "mtp"]);
        install.write_config(&config);
        let error = validate_config(&install.0, &install.model_config()).unwrap_err();
        assert!(error.contains("dense.txt"));

        fs::write(mtp.join("dense.txt"), "").unwrap();
        // draft_vocab.bin is optional in the engine's runtime-file contract.
        assert!(validate_config(&install.0, &install.model_config()).is_ok());
    }

    #[test]
    fn missing_explicit_companion_paths_are_rejected() {
        let install = TestInstall::new();
        for (flag, value) in [
            ("--pack", "missing-pack"),
            ("--native", "missing-model.gguf"),
            ("--native-dense-gguf", "missing-dense.gguf"),
            ("--embd-gguf", "missing-embedding.gguf"),
            ("--ple-gguf", "missing-ple.gguf"),
            ("--expert-profile", "missing-profile.bin"),
            ("--mtp", "missing-mtp"),
            ("--mtp-draft-vocab", "missing-draft-vocab.bin"),
        ] {
            let mut config = config_value(&install.model_config()).unwrap();
            config["args"] = serde_json::json!([flag, value]);
            install.write_config(&config);
            let error = validate_config(&install.0, &install.model_config()).unwrap_err();
            assert!(error.contains(flag), "{flag}: {error}");
        }

        let mut config = config_value(&install.model_config()).unwrap();
        config["args"] = serde_json::json!(["--native"]);
        install.write_config(&config);
        let error = validate_config(&install.0, &install.model_config()).unwrap_err();
        assert!(error.contains("no path after --native"));
    }

    #[test]
    fn rejects_unsupported_inline_paths_and_missing_values_before_next_flags() {
        let install = TestInstall::new();
        for argument in ["--native=missing.gguf", "--mtp=2"] {
            let mut config = config_value(&install.model_config()).unwrap();
            config["args"] = serde_json::json!([argument]);
            install.write_config(&config);
            let error = validate_config(&install.0, &install.model_config()).unwrap_err();
            assert!(error.contains("separate arguments"), "{argument}: {error}");
        }

        let mut config = config_value(&install.model_config()).unwrap();
        config["args"] = serde_json::json!(["--native", "--max-context", "32768"]);
        install.write_config(&config);
        let error = validate_config(&install.0, &install.model_config()).unwrap_err();
        assert!(error.contains("no path after --native"));
    }

    #[test]
    fn installed_engine_without_models_has_an_empty_library() {
        let install = TestInstall::new();
        fs::remove_file(install.model_config()).unwrap();
        fs::remove_file(install.0.join("tokenizer/vocab.json")).unwrap();
        let models = discover_strata_models(install.0.to_string_lossy().into_owned()).unwrap();
        assert!(models.is_empty());
    }

    #[test]
    fn invalid_existing_model_config_remains_an_error() {
        let install = TestInstall::new();
        fs::write(install.model_config(), "invalid json").unwrap();
        let error = discover_strata_models(install.0.to_string_lossy().into_owned()).unwrap_err();
        assert!(error.contains("strata-test.json"));
        assert!(error.contains("Invalid Strata model configuration"));
    }

    #[test]
    fn invalid_existing_config_does_not_hide_other_models() {
        let install = TestInstall::new();
        fs::write(install.0.join("strata-broken.json"), "invalid json").unwrap();
        let models = discover_strata_models(install.0.to_string_lossy().into_owned()).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model_name, "qwen-test");
    }

    #[test]
    fn missing_companion_config_does_not_hide_valid_model_and_is_reported_alone() {
        let install = TestInstall::new();
        fs::write(
            install.0.join("strata-broken.json"),
            serde_json::to_vec(&serde_json::json!({
                "exe": "engine/strata.exe",
                "tokenizer": "tokenizer",
                "model_name": "stale-model",
                "args": ["--ple-gguf", "models/missing-ple.gguf"]
            }))
            .unwrap(),
        )
        .unwrap();

        let models = discover_strata_models(install.0.to_string_lossy().into_owned()).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model_name, "qwen-test");

        fs::remove_file(install.model_config()).unwrap();
        let error = discover_strata_models(install.0.to_string_lossy().into_owned()).unwrap_err();
        assert!(error.contains("strata-broken.json"));
        assert!(error.contains("--ple-gguf"));
    }

    #[test]
    fn task_configs_are_separate_bounded_and_preserve_engine_workarounds() {
        let install = TestInstall::new();
        let mut source = config_value(&install.model_config()).unwrap();
        source["args"] = serde_json::json!([
            "--max-context",
            "65536",
            "--spec",
            "4",
            "--resident-budget-gib",
            "24"
        ]);
        source["env"] = serde_json::json!({"STRATA_HC_Q8":"1", "STRATA_ROUTE_TAIL_SKIP":"0"});
        fs::write(install.model_config(), serde_json::to_vec(&source).unwrap()).unwrap();
        let before = fs::read(install.model_config()).unwrap();
        let root = install.0.to_string_lossy().into_owned();
        let id = Uuid::new_v4().to_string();
        let generated = create_strata_task_config(
            root.clone(),
            install.model_config().to_string_lossy().into_owned(),
            32768,
            id.clone(),
        )
        .unwrap();
        let derived = config_value(Path::new(&generated)).unwrap();
        assert_eq!(derived["env"], source["env"]);
        assert_eq!(
            derived["args"],
            serde_json::json!([
                "--max-context",
                "32768",
                "--spec",
                "4",
                "--resident-budget-gib",
                "24"
            ])
        );
        assert_eq!(fs::read(install.model_config()).unwrap(), before);
        assert!(create_strata_task_config(
            root.clone(),
            install.model_config().to_string_lossy().into_owned(),
            32768,
            id.clone()
        )
        .is_err());
        assert!(create_strata_task_config(
            root.clone(),
            install.model_config().to_string_lossy().into_owned(),
            131072,
            Uuid::new_v4().to_string()
        )
        .is_err());
        assert!(remove_strata_task_config(root.clone(), "../strata-test.json".into()).is_err());
        remove_strata_task_config(root, id).unwrap();
        assert!(!Path::new(&generated).exists());
        assert_eq!(fs::read(install.model_config()).unwrap(), before);
    }

    #[test]
    fn task_context_rejects_ambiguous_or_invalid_source_arguments() {
        assert!(task_configuration(
            serde_json::json!({"args":["--max-context","65536","--max-context","131072"]}),
            32768
        )
        .is_err());
        assert!(
            task_configuration(serde_json::json!({"args":["--max-context","auto"]}), 32768)
                .is_err()
        );
        assert!(
            task_configuration(serde_json::json!({"args":["--max-context","65536"]}), 1234)
                .is_err()
        );
    }

    #[test]
    fn builds_hidden_server_command_and_requires_a_key_for_lan() {
        let install = TestInstall::new();
        let request = StartStrataServerRequest {
            root_path: install.0.to_string_lossy().into_owned(),
            config_path: install.model_config().to_string_lossy().into_owned(),
            host: "127.0.0.1".into(),
            port: 8080,
            api_key: "secret".into(),
        };
        let launch = build_start_request(request.clone()).unwrap();
        assert!(launch.binary_path.ends_with("python.exe"));
        assert!(launch
            .args
            .windows(2)
            .any(|pair| pair == ["--engine", "strata"]));
        assert!(launch.args.iter().all(|argument| argument != "secret"));
        assert_eq!(launch.api_key.as_deref(), Some("secret"));
        assert_eq!(launch.backend.as_deref(), Some("strata"));
        let ipv6 = build_start_request(StartStrataServerRequest {
            host: "[::1]".into(),
            ..request.clone()
        })
        .unwrap();
        assert_eq!(
            crate::engine_adapters::argument_value(&ipv6.args, &["--host"]),
            Some("::1")
        );
        assert_eq!(ipv6.endpoint.as_deref(), Some("http://[::1]:8080"));
        assert!(build_start_request(StartStrataServerRequest {
            host: "0.0.0.0".into(),
            api_key: String::new(),
            ..request
        })
        .is_err());
    }

    #[test]
    fn edits_turn_the_draft_layer_off_and_back_on_and_rename_by_context() {
        let source = serde_json::json!({
            "model_name": "qwen-iq3_s-220k",
            "args": ["--native", "m.gguf", "--spec", "4", "--spec-min-p", "0.5", "--mtp", "C:/mtp/rt", "--max-context", "225280", "--kv", "int8"],
            "args_written": []
        });
        let off = edited_config(
            source,
            &StrataConfigEdits {
                max_context: 131072,
                kv: "q4_0".into(),
                mtp: false,
                spec: None,
                vision: None,
                vision_gpu: None,
            },
        )
        .unwrap();
        let args = off["args"].as_array().unwrap();
        assert_eq!(arg_value(args, "--max-context").as_deref(), Some("131072"));
        assert_eq!(arg_value(args, "--kv").as_deref(), Some("q4_0"));
        assert!(arg_value(args, "--mtp").is_none() && arg_value(args, "--spec").is_none());
        assert_eq!(off["model_name"], "qwen-iq3_s-128k");
        assert_eq!(off["args_written"], off["args"]);
        let on = edited_config(
            off,
            &StrataConfigEdits {
                max_context: 131072,
                kv: "q4_0".into(),
                mtp: true,
                spec: Some(3),
                vision: None,
                vision_gpu: None,
            },
        )
        .unwrap();
        let args = on["args"].as_array().unwrap();
        assert_eq!(arg_value(args, "--mtp").as_deref(), Some("C:/mtp/rt"));
        assert_eq!(arg_value(args, "--spec").as_deref(), Some("3"));
        assert!(edited_config(
            on,
            &StrataConfigEdits {
                max_context: 1024,
                kv: "int8".into(),
                mtp: true,
                spec: None,
                vision: None,
                vision_gpu: None,
            }
        )
        .is_err());
    }

    #[test]
    fn edits_switch_the_picture_reader_and_stretch_long_contexts_with_yarn() {
        let source = serde_json::json!({
            "model_name": "qwen-iq3_s",
            "args": ["--native", "m.gguf", "--max-context", "8192", "--vision"],
            "vision": {"mmproj": "C:/m/mmproj.gguf", "gpu": true, "max_tokens": 300}
        });
        let edits = |max_context, vision, vision_gpu| StrataConfigEdits {
            max_context,
            kv: "int8".into(),
            mtp: false,
            spec: None,
            vision,
            vision_gpu,
        };
        let long = edited_config(source, &edits(1_048_576, Some(true), Some(false))).unwrap();
        let args = long["args"].as_array().unwrap();
        assert_eq!(arg_value(args, "--rope-scaling").as_deref(), Some("yarn"));
        assert_eq!(arg_value(args, "--rope-scale").as_deref(), Some("4"));
        assert_eq!(long["vision"]["gpu"], false);
        assert!(long["vision"]["threads"].as_u64().is_some());
        let off = edited_config(long, &edits(131_072, Some(false), None)).unwrap();
        let args = off["args"].as_array().unwrap();
        assert!(!has_flag(args, "--vision") && arg_value(args, "--rope-scaling").is_none());
        assert!(
            off.get("vision").is_none() && off[SAVED_VISION_KEY]["mmproj"] == "C:/m/mmproj.gguf"
        );
        assert_eq!(arg_value(args, "--max-context").as_deref(), Some("131072"));
        let on = edited_config(off, &edits(131_072, Some(true), Some(true))).unwrap();
        assert!(has_flag(on["args"].as_array().unwrap(), "--vision"));
        assert_eq!(on["vision"]["gpu"], true);
        assert!(on.get(SAVED_VISION_KEY).is_none());
    }
}
