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

fn root_path(value: &str) -> Result<PathBuf, String> {
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

fn resolved_config_path(root: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

fn validate_config(root: &Path, path: &Path) -> Result<StrataModelOption, String> {
    let config = config_value(path)?;
    let model_name = config
        .get("model_name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "The Strata configuration has no model name.".to_string())?;
    let exe = config
        .get("exe")
        .and_then(Value::as_str)
        .ok_or_else(|| "The Strata configuration has no engine executable.".to_string())?;
    if !resolved_config_path(root, exe).is_file() {
        return Err("The Strata engine executable is missing. Run Strata setup again.".into());
    }
    let tokenizer = config
        .get("tokenizer")
        .and_then(Value::as_str)
        .ok_or_else(|| "The Strata configuration has no tokenizer folder.".to_string())?;
    if !resolved_config_path(root, tokenizer)
        .join("vocab.json")
        .is_file()
    {
        return Err("The Strata tokenizer is missing. Run Strata setup again.".into());
    }
    let args = config
        .get("args")
        .and_then(Value::as_array)
        .ok_or_else(|| "The Strata configuration has no engine arguments.".to_string())?;
    let context_length = args
        .windows(2)
        .find(|pair| pair[0].as_str() == Some("--max-context"))
        .and_then(|pair| pair[1].as_str())
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    Ok(StrataModelOption {
        config_path: path.to_string_lossy().into_owned(),
        model_path: args
            .windows(2)
            .find(|pair| {
                pair[0]
                    .as_str()
                    .is_some_and(|v| v == "-m" || v == "--model" || v == "--native")
            })
            .and_then(|pair| pair[1].as_str())
            .map(|value| {
                resolved_config_path(root, value)
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
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if path.is_file() && filename.starts_with("strata-") && filename.ends_with(".json") {
            configurations.push(validate_config(&root, &path)?);
        }
    }
    configurations.sort_by(|left, right| left.model_name.cmp(&right.model_name));
    if configurations.is_empty() {
        return Err("No Strata model configurations were found. Complete setup from the Strata START-HERE.bat first.".into());
    }
    Ok(configurations)
}

pub fn build_start_request(
    request: StartStrataServerRequest,
) -> Result<StartServerRequest, String> {
    let root = root_path(&request.root_path)?;
    let python = python_path(&root);
    if !python.is_file() {
        return Err(
            "Strata's private Python environment is missing. Complete its setup first.".into(),
        );
    }
    let config = config_path(&root, &request.config_path)?;
    let model = validate_config(&root, &config)?;
    let host = request.host.trim();
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
    Ok(StartServerRequest {
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
        profile_id: Some(model.model_name),
        backend: Some("strata".into()),
        working_directory: Some(root.to_string_lossy().into_owned()),
        api_key: Some(request.api_key),
        qwfn_mtp_gpu: None,
    })
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
        assert!(build_start_request(StartStrataServerRequest {
            host: "0.0.0.0".into(),
            api_key: String::new(),
            ..request
        })
        .is_err());
    }
}
