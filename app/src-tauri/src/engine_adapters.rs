//! Engine-specific request validation and launch preparation. Lifecycle code
//! consumes Prepared without knowing the engine's CLI or model file format.
use crate::{domain::http, process, runs::RunRequest};

#[derive(Clone)]
pub(crate) struct Prepared(pub process::StartServerRequest);
impl Prepared {
    pub fn endpoint(&self) -> &str {
        self.0
            .endpoint
            .as_deref()
            .unwrap_or("http://127.0.0.1:8080")
    }
    pub fn key(&self) -> Option<&str> {
        self.0.api_key.as_deref()
    }
}
fn argument_u32(args: &[String], flags: &[&str]) -> Option<u32> {
    argument_value(args, flags).and_then(|value| value.parse().ok())
}
pub(crate) fn argument_value<'a>(args: &'a [String], flags: &[&str]) -> Option<&'a str> {
    let mut value = None;
    for (index, arg) in args.iter().enumerate() {
        if flags.contains(&arg.as_str()) {
            value = args.get(index + 1).map(String::as_str);
        } else if let Some((flag, item)) = arg.split_once('=') {
            if flags.contains(&flag) {
                value = Some(item);
            }
        }
    }
    value
}
fn validate_bind_target(p: &process::StartServerRequest) -> Result<(), String> {
    let url = http::server_endpoint(p.endpoint.as_deref().unwrap_or("http://127.0.0.1:8080"))?;
    let bind_port = argument_value(&p.args, &["--port"])
        .unwrap_or("8080")
        .parse::<u16>()
        .map_err(|_| "Invalid engine bind port")?;
    if bind_port == 0 || url.port_or_known_default() != Some(bind_port) {
        return Err("The declared endpoint port must match the engine's --port argument".into());
    }
    if let Some(host) = argument_value(&p.args, &["--host"]) {
        let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
        let target = url
            .host_str()
            .unwrap_or("")
            .trim_matches(['[', ']'])
            .to_ascii_lowercase();
        let loopback = |s: &str| matches!(s, "localhost" | "127.0.0.1" | "::1");
        if host != target
            && !(loopback(&host) && loopback(&target))
            && !matches!(host.as_str(), "0.0.0.0" | "::")
        {
            return Err(
                "The declared endpoint host must match the engine's --host argument".into(),
            );
        }
    }
    Ok(())
}
pub(crate) fn prepare(request: &mut RunRequest) -> Result<Prepared, String> {
    if request.run_id.trim().is_empty()
        || request.run_id.len() > 128
        || request.name.trim().is_empty()
    {
        return Err("Run ID and name are required".into());
    }
    if !["single", "router"].contains(&request.mode.as_str())
        || (request.mode == "router" && request.engine != "llama_cpp")
    {
        return Err("This engine does not support native router mode".into());
    }
    let prepared = match request.engine.as_str() {
        "llama_cpp" => {
            let mut p: process::StartServerRequest =
                serde_json::from_value(request.launch.clone()).map_err(|e| e.to_string())?;
            p.backend = Some("llama-server".into());
            if request.mode == "single" {
                let model = argument_value(&p.args, &["--model", "-m"])
                    .ok_or("A model argument is required")?;
                crate::models::validate_generation_model(model)?;
            } else if argument_value(&p.args, &["--models-preset"]).is_none() {
                return Err("A router preset is required".into());
            }
            request.context_tokens =
                argument_u32(&p.args, &["--ctx-size", "-c"]).unwrap_or(request.context_tokens);
            p
        }
        "strata" => {
            let p: crate::strata::StartStrataServerRequest =
                serde_json::from_value(request.launch.clone()).map_err(|e| e.to_string())?;
            let (p, model) = crate::strata::prepare_start_request(p)?;
            if model.context_length > 0 {
                request.context_tokens = model.context_length;
            }
            // Discard stale caller-supplied metadata, including for pack-only
            // configurations without a single native model file.
            request.launch["resolvedModelPaths"] =
                serde_json::json!(model.model_path.into_iter().collect::<Vec<_>>());
            if request.model_id.is_empty() {
                request.model_id = model.model_name;
            }
            p
        }
        _ => return Err("Unsupported engine".into()),
    };
    let mut prepared = Prepared(prepared);
    prepared.0.endpoint = Some(process::connection_endpoint(prepared.endpoint())?);
    validate_bind_target(&prepared.0)?;
    Ok(prepared)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cli_identity_matches_last_effective_port_and_accepts_equal_form() {
        let mut p = process::StartServerRequest {
            binary_path: String::new(),
            args: vec![
                "--port".into(),
                "8080".into(),
                "--port=8081".into(),
                "--host=127.0.0.1".into(),
            ],
            endpoint: Some("http://localhost:8081".into()),
            profile_id: None,
            backend: None,
            working_directory: None,
            api_key: None,
        };
        assert!(validate_bind_target(&p).is_ok());
        p.endpoint = Some("http://localhost:8080".into());
        assert!(validate_bind_target(&p).is_err());
        assert_eq!(argument_u32(&p.args, &["--port"]), Some(8081));
    }
}
