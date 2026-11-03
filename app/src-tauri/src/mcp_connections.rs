//! Project-scoped external MCP server configuration.
//!
//! Configuration is saved as data and is only shaped for a new native session
//! when requested. This module never launches a user supplied command or probes
//! a remote server.
use crate::{agent_workspace, db::DbState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::net::IpAddr;
use tauri::{AppHandle, Manager, State};

const MAX_SERVERS_PER_PROJECT: usize = 100;
const MAX_ARGS: usize = 128;
const MAX_ARG_BYTES: usize = 4096;
const MAX_ARGS_BYTES: usize = 16 * 1024;
const MAX_SECRET_BYTES: usize = 4096;
const MAX_URL_BYTES: usize = 2048;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Http,
}

/// Input accepted from the project settings panel. `bearer_token` is handled
/// only in native code and is never part of a summary response.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpConnectionInput {
    pub id: String,
    pub enabled: bool,
    pub transport: McpTransport,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default)]
    pub clear_bearer_token: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionSummary {
    pub id: String,
    pub enabled: bool,
    pub transport: McpTransport,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub has_bearer_token: bool,
    pub updated_at: String,
}

struct ValidatedConfig {
    id: String,
    enabled: bool,
    transport: McpTransport,
    command: Option<String>,
    args: Vec<String>,
    url: Option<String>,
    bearer_token: Option<String>,
    clear_bearer_token: bool,
}

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mcp_connections (
           project_id TEXT NOT NULL,
           id TEXT NOT NULL,
           enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
           transport TEXT NOT NULL CHECK(transport IN ('stdio','http')),
           command TEXT,
           args_json TEXT NOT NULL,
           url TEXT,
           bearer_ciphertext BLOB,
           removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1)),
           updated_at TEXT NOT NULL,
           PRIMARY KEY(project_id,id)
         );
         CREATE INDEX IF NOT EXISTS mcp_connections_project_enabled
           ON mcp_connections(project_id,enabled,id);",
    )
    .map_err(|error| error.to_string())?;
    let has_removed = {
        let mut statement = conn
            .prepare("PRAGMA table_info(mcp_connections)")
            .map_err(|error| error.to_string())?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        columns.iter().any(|name| name == "removed")
    };
    if !has_removed {
        conn.execute_batch(
            "ALTER TABLE mcp_connections ADD COLUMN removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1));",
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id.as_bytes()[0].is_ascii_lowercase() && !id.as_bytes()[0].is_ascii_digit()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-".contains(&byte))
        || id == "aplot"
        || id.starts_with("aplot_")
        || id.starts_with("aplot-")
    {
        return Err("mcp-id-invalid".into());
    }
    Ok(())
}

fn validate_http_url(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > MAX_URL_BYTES {
        return Err("mcp-url-invalid".into());
    }
    let url = reqwest::Url::parse(value.trim()).map_err(|_| "mcp-url-invalid".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("mcp-url-invalid".into());
    }
    if url.scheme() == "http" && !is_loopback_host(url.host_str().unwrap_or_default()) {
        return Err("mcp-http-requires-https".into());
    }
    Ok(url.to_string())
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn secret_like_key(value: &str) -> bool {
    let normalized: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    crate::domain::secrets::is_secret_field(value)
        || normalized.contains("auth")
        || normalized.contains("credential")
        || normalized == "key"
}

fn argument_contains_secret(argument: &str) -> bool {
    if header_contains_secret(argument) {
        return true;
    }
    let assignment = argument.split_once('=');
    let option = assignment
        .map(|(key, _)| key)
        .unwrap_or(argument)
        .trim_matches(['\'', '"']);
    if (option.starts_with('-') || assignment.is_some()) && secret_like_key(option) {
        return true;
    }
    if matches!(option, "--header" | "-H")
        && assignment.is_some_and(|(_, header)| header_contains_secret(header))
    {
        return true;
    }
    let lower = argument.to_ascii_lowercase();
    lower.starts_with("authorization:")
        || lower.starts_with("proxy-authorization:")
        || lower.starts_with("cookie:")
        || lower.contains("bearer ")
        || reqwest::Url::parse(argument).is_ok_and(|url| {
            !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
        })
}

fn header_contains_secret(header: &str) -> bool {
    header.split_once(':').is_some_and(|(name, _)| {
        secret_like_key(name.trim())
            || matches!(
                name.trim().to_ascii_lowercase().as_str(),
                "authorization" | "proxy-authorization" | "cookie"
            )
    })
}

fn validate_args(args: &[String]) -> Result<(), String> {
    if args.len() > MAX_ARGS
        || args.iter().any(|arg| {
            arg.len() > MAX_ARG_BYTES
                || arg.contains('\0')
                || arg.chars().any(char::is_control)
                || argument_contains_secret(arg)
        })
        || args.iter().map(String::len).sum::<usize>() > MAX_ARGS_BYTES
    {
        return Err("mcp-args-invalid".into());
    }
    for (index, arg) in args.iter().enumerate() {
        if matches!(arg.as_str(), "--header" | "-H")
            && args
                .get(index + 1)
                .is_some_and(|header| header_contains_secret(header))
        {
            return Err("mcp-args-invalid".into());
        }
    }
    Ok(())
}

fn validate_input(input: McpConnectionInput) -> Result<ValidatedConfig, String> {
    validate_id(&input.id)?;
    let bearer_token = input.bearer_token.filter(|token| !token.is_empty());
    if input.clear_bearer_token && bearer_token.is_some() {
        return Err("mcp-secret-conflict".into());
    }
    if let Some(token) = bearer_token.as_deref() {
        if token.len() > MAX_SECRET_BYTES
            || token.trim() != token
            || token
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
        {
            return Err("mcp-secret-invalid".into());
        }
        if input.transport != McpTransport::Http {
            return Err("mcp-secret-http-only".into());
        }
    }

    let (command, args, url) = match input.transport {
        McpTransport::Stdio => {
            let command = input.command.ok_or("mcp-command-required")?;
            let command = command.trim().to_owned();
            if command.is_empty()
                || command.len() > 1024
                || command.chars().any(char::is_control)
                || command
                    .split_whitespace()
                    .any(|part| part.starts_with('-') || argument_contains_secret(part))
                || input.url.is_some()
            {
                return Err("mcp-command-invalid".into());
            }
            validate_args(&input.args)?;
            (Some(command), input.args, None)
        }
        McpTransport::Http => {
            if input.command.is_some() || !input.args.is_empty() {
                return Err("mcp-transport-invalid".into());
            }
            let url = validate_http_url(input.url.as_deref().ok_or("mcp-url-required")?)?;
            (None, Vec::new(), Some(url))
        }
    };

    Ok(ValidatedConfig {
        id: input.id,
        enabled: input.enabled,
        transport: input.transport,
        command,
        args,
        url,
        bearer_token,
        clear_bearer_token: input.clear_bearer_token,
    })
}

fn workspace_data(conn: &Connection) -> Result<Value, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM kv WHERE key=?1",
            [agent_workspace::KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let raw = raw.ok_or("project-missing")?;
    let envelope: Value = serde_json::from_str(&raw).map_err(|_| "workspace-invalid")?;
    if envelope["version"] != 2 || !envelope["data"].is_object() {
        return Err("workspace-invalid".into());
    }
    Ok(envelope["data"].clone())
}

fn require_project(conn: &Connection, project_id: &str) -> Result<(), String> {
    if project_id.is_empty() || project_id.len() > 128 || project_id.chars().any(char::is_control) {
        return Err("project-missing".into());
    }
    let data = workspace_data(conn)?;
    if data["projects"]
        .as_array()
        .is_some_and(|projects| projects.iter().any(|project| project["id"] == project_id))
    {
        Ok(())
    } else {
        Err("project-missing".into())
    }
}

fn project_for_task(conn: &Connection, task_id: &str) -> Result<String, String> {
    // Also canonicalizes and validates that the task's project still resolves.
    agent_workspace::task_root(conn, task_id)?;
    let data = workspace_data(conn)?;
    let project_id = data["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id))
        .and_then(|task| task["projectId"].as_str())
        .ok_or("task-missing")?;
    require_project(conn, project_id)?;
    Ok(project_id.to_owned())
}

fn transport_name(transport: McpTransport) -> &'static str {
    match transport {
        McpTransport::Stdio => "stdio",
        McpTransport::Http => "http",
    }
}

fn parse_transport(value: &str) -> Result<McpTransport, String> {
    match value {
        "stdio" => Ok(McpTransport::Stdio),
        "http" => Ok(McpTransport::Http),
        _ => Err("mcp-config-invalid".into()),
    }
}

fn load_for_project(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<McpConnectionSummary>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id,enabled,transport,command,args_json,url,bearer_ciphertext,updated_at
             FROM mcp_connections WHERE project_id=?1 AND removed=0 ORDER BY id COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<Vec<u8>>>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    rows.into_iter()
        .map(
            |(id, enabled, transport, command, args, url, secret, updated_at)| {
                validate_id(&id)?;
                let args: Vec<String> =
                    serde_json::from_str(&args).map_err(|_| "mcp-config-invalid")?;
                validate_args(&args)?;
                let transport = parse_transport(&transport)?;
                Ok(McpConnectionSummary {
                    id,
                    enabled: enabled != 0,
                    transport,
                    command,
                    args,
                    url,
                    has_bearer_token: secret.is_some(),
                    updated_at,
                })
            },
        )
        .collect()
}

fn save_config(
    conn: &mut Connection,
    project_id: &str,
    input: McpConnectionInput,
) -> Result<McpConnectionSummary, String> {
    let config = validate_input(input)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    require_project(&tx, project_id)?;
    let existing_secret: Option<Vec<u8>> = tx
        .query_row(
            "SELECT bearer_ciphertext FROM mcp_connections WHERE project_id=?1 AND id=?2",
            params![project_id, config.id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    let bearer_ciphertext = if config.transport == McpTransport::Stdio {
        None
    } else if let Some(token) = config.bearer_token.as_deref() {
        Some(crate::domain::secrets::seal_recovery_secret(token)?)
    } else if config.clear_bearer_token {
        None
    } else {
        existing_secret
    };
    let args_json = serde_json::to_string(&config.args).map_err(|_| "mcp-config-invalid")?;
    let updated_at = chrono::Utc::now().to_rfc3339();
    let count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM mcp_connections WHERE project_id=?1 AND removed=0",
            [project_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let exists = tx
        .query_row(
            "SELECT 1 FROM mcp_connections WHERE project_id=?1 AND id=?2 AND removed=0",
            params![project_id, config.id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    if !exists && count >= MAX_SERVERS_PER_PROJECT as i64 {
        return Err("mcp-project-limit".into());
    }
    tx.execute(
        "INSERT INTO mcp_connections(project_id,id,enabled,transport,command,args_json,url,bearer_ciphertext,removed,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,?9)
         ON CONFLICT(project_id,id) DO UPDATE SET
           enabled=excluded.enabled,transport=excluded.transport,command=excluded.command,
           args_json=excluded.args_json,url=excluded.url,bearer_ciphertext=excluded.bearer_ciphertext,
           removed=0,updated_at=excluded.updated_at",
        params![
            project_id,
            config.id,
            config.enabled,
            transport_name(config.transport),
            config.command,
            args_json,
            config.url,
            bearer_ciphertext,
            updated_at
        ],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    load_for_project(conn, project_id)?
        .into_iter()
        .find(|item| item.id == config.id)
        .ok_or_else(|| "mcp-config-invalid".into())
}

fn remove_config(conn: &mut Connection, project_id: &str, id: &str) -> Result<(), String> {
    validate_id(id)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    require_project(&tx, project_id)?;
    let removed = tx
        .execute(
            "UPDATE mcp_connections SET removed=1,enabled=0,args_json='[]',bearer_ciphertext=NULL,updated_at=?3
             WHERE project_id=?1 AND id=?2 AND removed=0",
            params![project_id, id, chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    if removed == 0 {
        return Err("mcp-connection-missing".into());
    }
    tx.commit().map_err(|error| error.to_string())
}

fn runtime_configuration_for_project(
    conn: &Connection,
    project_id: &str,
) -> Result<Map<String, Value>, String> {
    let mut result = Map::new();
    let mut statement = conn
        .prepare("SELECT id,transport,command,url FROM mcp_connections WHERE project_id=?1 AND (enabled=0 OR removed=1)")
        .map_err(|error| error.to_string())?;
    let disabled = statement
        .query_map([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for (id, transport, command, url) in disabled {
        validate_id(&id)?;
        // Codex validates the transport even when enabled=false. Keep a valid,
        // non-secret transport skeleton and explicitly clear inherited headers.
        let config = if transport == "http" {
            json!({"enabled":false,"url":url.ok_or("mcp-config-invalid")?,"http_headers":{"Authorization":""}})
        } else {
            json!({"enabled":false,"command":command.unwrap_or_else(|| "aplot-disabled-mcp-server".into()),"args":[]})
        };
        result.insert(id, config);
    }
    for server in load_for_project(conn, project_id)? {
        if !server.enabled {
            continue;
        }
        validate_id(&server.id)?;
        let mut config = Map::new();
        config.insert("enabled".into(), json!(true));
        match server.transport {
            McpTransport::Stdio => {
                let command = server.command.ok_or("mcp-config-invalid")?;
                validate_args(&server.args)?;
                config.insert("command".into(), json!(command));
                config.insert("args".into(), json!(server.args));
            }
            McpTransport::Http => {
                let url = validate_http_url(server.url.as_deref().ok_or("mcp-config-invalid")?)?;
                config.insert("url".into(), json!(url));
                config.insert("http_headers".into(), json!({"Authorization":""}));
                let ciphertext: Option<Vec<u8>> = conn
                    .query_row(
                        "SELECT bearer_ciphertext FROM mcp_connections WHERE project_id=?1 AND id=?2",
                        params![project_id, server.id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?
                    .flatten();
                if let Some(ciphertext) = ciphertext {
                    let token = crate::domain::secrets::unseal_connection_secret(&ciphertext)?;
                    config.insert(
                        "http_headers".into(),
                        json!({"Authorization":format!("Bearer {token}")}),
                    );
                }
            }
        }
        result.insert(server.id, Value::Object(config));
    }
    Ok(result)
}

/// Return project MCP server entries for a native session. The map is ready to
/// merge into Codex `mcp_servers`. HTTP bearer values are decrypted only here
/// and placed in the native RPC override as an Authorization header; they are
/// never returned by Tauri commands. Disabled and removed servers are explicitly
/// disabled in overrides so a resumed/forked thread cannot inherit them. No
/// connection or health probe is made.
pub(crate) async fn configuration_for_task(
    app: &AppHandle,
    task_id: &str,
) -> Result<Map<String, Value>, String> {
    let db = app.state::<DbState>();
    let conn = db.0.lock().await;
    init_schema(&conn)?;
    let project_id = project_for_task(&conn, task_id)?;
    runtime_configuration_for_project(&conn, &project_id)
}

#[tauri::command]
pub async fn mcp_connections_list(
    db: State<'_, DbState>,
    project_id: String,
) -> Result<Vec<McpConnectionSummary>, String> {
    let conn = db.0.lock().await;
    init_schema(&conn)?;
    require_project(&conn, &project_id)?;
    load_for_project(&conn, &project_id)
}

#[tauri::command]
pub async fn mcp_connections_save(
    db: State<'_, DbState>,
    project_id: String,
    config: McpConnectionInput,
) -> Result<McpConnectionSummary, String> {
    let mut conn = db.0.lock().await;
    init_schema(&conn)?;
    save_config(&mut conn, &project_id, config)
}

#[tauri::command]
pub async fn mcp_connections_remove(
    db: State<'_, DbState>,
    project_id: String,
    id: String,
) -> Result<(), String> {
    let mut conn = db.0.lock().await;
    init_schema(&conn)?;
    remove_config(&mut conn, &project_id, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;
    use std::{fs, path::PathBuf};

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("aplot-mcp-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn setup() -> (Temp, Connection, String, String) {
        let temp = Temp::new();
        let project_a = temp.0.join("project-a");
        let project_b = temp.0.join("project-b");
        fs::create_dir_all(&project_a).unwrap();
        fs::create_dir_all(&project_b).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);",
        )
        .unwrap();
        init_schema(&conn).unwrap();
        let data = json!({
            "projects":[
                {"id":"project-a","name":"Project A","path":project_a},
                {"id":"project-b","name":"Project B","path":project_b}
            ],
            "tasks":[{"id":"task-b","projectId":"project-b"}],
            "threads":{},"memory":[]
        });
        conn.execute(
            "INSERT INTO kv(key,value_json,updated_at) VALUES(?1,?2,'now')",
            params![
                agent_workspace::KEY,
                json!({"version":2,"revision":1,"data":data}).to_string()
            ],
        )
        .unwrap();
        (temp, conn, "project-a".into(), "project-b".into())
    }

    fn stdio(id: &str, enabled: bool, args: Vec<&str>) -> McpConnectionInput {
        McpConnectionInput {
            id: id.into(),
            enabled,
            transport: McpTransport::Stdio,
            command: Some("node".into()),
            args: args.into_iter().map(str::to_owned).collect(),
            url: None,
            bearer_token: None,
            clear_bearer_token: false,
        }
    }

    fn http(id: &str, url: &str, token: Option<&str>, enabled: bool) -> McpConnectionInput {
        McpConnectionInput {
            id: id.into(),
            enabled,
            transport: McpTransport::Http,
            command: None,
            args: Vec::new(),
            url: Some(url.into()),
            bearer_token: token.map(str::to_owned),
            clear_bearer_token: false,
        }
    }

    #[test]
    fn project_bindings_are_isolated_and_disabled_servers_are_explicit() {
        let (_temp, mut conn, project_a, project_b) = setup();
        save_config(&mut conn, &project_a, stdio("docs", true, vec!["--stdio"])).unwrap();
        save_config(&mut conn, &project_b, stdio("private", true, vec![])).unwrap();
        save_config(&mut conn, &project_a, stdio("paused", false, vec![])).unwrap();

        let a = runtime_configuration_for_project(&conn, &project_a).unwrap();
        let b = runtime_configuration_for_project(&conn, &project_b).unwrap();
        assert!(a.contains_key("docs"));
        assert_eq!(a["paused"]["enabled"], false);
        assert!(!a.contains_key("private"));
        assert!(b.contains_key("private"));
        assert!(!b.contains_key("docs"));
    }

    #[test]
    fn removed_server_keeps_only_a_disabled_tombstone_for_future_thread_overrides() {
        let (_temp, mut conn, project_a, _) = setup();
        save_config(
            &mut conn,
            &project_a,
            stdio("removed-server", true, vec!["--safe"]),
        )
        .unwrap();
        remove_config(&mut conn, &project_a, "removed-server").unwrap();
        assert!(load_for_project(&conn, &project_a).unwrap().is_empty());
        let stored: (i64, Option<Vec<u8>>, Option<String>, String) = conn
            .query_row(
                "SELECT removed,bearer_ciphertext,command,args_json FROM mcp_connections WHERE project_id=?1 AND id='removed-server'",
                [&project_a],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(stored, (1, None, Some("node".into()), "[]".into()));
        let config = runtime_configuration_for_project(&conn, &project_a).unwrap();
        assert_eq!(
            config["removed-server"],
            json!({"enabled":false,"command":"node","args":[]})
        );

        save_config(&mut conn, &project_a, stdio("removed-server", true, vec![])).unwrap();
        assert_eq!(
            runtime_configuration_for_project(&conn, &project_a).unwrap()["removed-server"]
                ["enabled"],
            true
        );
    }

    #[test]
    fn rejects_reserved_ids_plaintext_auth_arguments_and_invalid_urls() {
        let (_temp, mut conn, project_a, _) = setup();
        for id in ["aplot", "aplot_tools", "aplot-tools", "BadName", "../x"] {
            assert!(
                save_config(&mut conn, &project_a, stdio(id, true, vec![])).is_err(),
                "accepted id {id}"
            );
        }
        for args in [
            vec!["--api-key", "plain-secret"],
            vec!["--authorization=Bearer plain-secret"],
            vec!["API_KEY=plain-secret"],
            vec!["--header", "Authorization: Bearer plain-secret"],
            vec!["--header", "X-Api-Key: plain-secret"],
            vec!["--header=Authorization: Bearer plain-secret"],
            vec!["--token", "plain-secret"],
        ] {
            assert!(save_config(&mut conn, &project_a, stdio("safe", true, args)).is_err());
        }
        for url in [
            "http://mcp.example.test/mcp",
            "https://user:secret@mcp.example.test/mcp",
            "https://mcp.example.test/mcp?token=secret",
            "file:///tmp/server",
        ] {
            assert!(
                save_config(&mut conn, &project_a, http("remote", url, None, true)).is_err(),
                "accepted {url}"
            );
        }
        assert!(save_config(
            &mut conn,
            &project_a,
            http("local", "http://localhost:9000/mcp", None, true)
        )
        .is_ok());
        assert!(save_config(
            &mut conn,
            &project_a,
            http("secure", "https://mcp.example.test/mcp", None, true)
        )
        .is_ok());
    }

    #[test]
    fn input_cannot_add_plain_environment_values() {
        let input = json!({
            "id":"stdio-server","enabled":true,"transport":"stdio",
            "command":"node","args":[],"env":{"API_KEY":"plaintext"}
        });
        assert!(serde_json::from_value::<McpConnectionInput>(input).is_err());
    }

    #[test]
    fn task_configuration_uses_the_saved_workspace_project() {
        let (_temp, conn, _, project_b) = setup();
        assert_eq!(project_for_task(&conn, "task-b").unwrap(), project_b);
        assert_eq!(
            project_for_task(&conn, "missing-task").unwrap_err(),
            "task-missing"
        );
    }

    #[test]
    fn native_runtime_shape_keeps_stdio_arguments_as_an_array() {
        let (_temp, mut conn, project_a, _) = setup();
        save_config(
            &mut conn,
            &project_a,
            stdio(
                "docs",
                true,
                vec!["-y", "@example/mcp-server", "space argument"],
            ),
        )
        .unwrap();
        let config = runtime_configuration_for_project(&conn, &project_a).unwrap();
        assert_eq!(config["docs"]["enabled"], true);
        assert_eq!(config["docs"]["command"], "node");
        assert_eq!(
            config["docs"]["args"],
            json!(["-y", "@example/mcp-server", "space argument"])
        );
    }

    #[test]
    fn disabled_http_configuration_has_a_valid_transport_and_clears_auth() {
        let (_temp, mut conn, project_a, _) = setup();
        save_config(
            &mut conn,
            &project_a,
            http("remote", "https://mcp.example.test/mcp", None, false),
        )
        .unwrap();
        let config = runtime_configuration_for_project(&conn, &project_a).unwrap();
        assert_eq!(config["remote"]["enabled"], false);
        assert_eq!(config["remote"]["url"], "https://mcp.example.test/mcp");
        assert_eq!(config["remote"]["http_headers"]["Authorization"], "");
        remove_config(&mut conn, &project_a, "remote").unwrap();
        assert_eq!(
            runtime_configuration_for_project(&conn, &project_a).unwrap(),
            config
        );
    }

    #[cfg(windows)]
    #[test]
    fn bearer_token_is_dpapi_protected_and_only_exposed_in_native_rpc_config() {
        let (_temp, mut conn, project_a, _) = setup();
        let token = "mcp-test-token-not-for-status";
        let summary = save_config(
            &mut conn,
            &project_a,
            http("remote", "https://mcp.example.test/mcp", Some(token), true),
        )
        .unwrap();
        assert!(summary.has_bearer_token);
        let ciphertext: Vec<u8> = conn
            .query_row(
                "SELECT bearer_ciphertext FROM mcp_connections WHERE project_id=?1 AND id='remote'",
                [&project_a],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!String::from_utf8_lossy(&ciphertext).contains(token));
        let encoded_summary = serde_json::to_string(&summary).unwrap();
        assert!(!encoded_summary.contains(token));
        let runtime = runtime_configuration_for_project(&conn, &project_a).unwrap();
        assert_eq!(
            runtime["remote"]["http_headers"]["Authorization"],
            format!("Bearer {token}")
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn bearer_token_storage_fails_closed_without_dpapi() {
        let (_temp, mut conn, project_a, _) = setup();
        assert!(save_config(
            &mut conn,
            &project_a,
            http(
                "remote",
                "https://mcp.example.test/mcp",
                Some("token"),
                true
            ),
        )
        .is_err());
        assert!(load_for_project(&conn, &project_a).unwrap().is_empty());
    }
}
