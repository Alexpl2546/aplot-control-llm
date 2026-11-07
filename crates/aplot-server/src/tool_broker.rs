//! Server-owned app tools exposed to a task runtime.
//!
//! Tool arguments never contain caller identity. The supervisor supplies the
//! task and generation from its active capability; reads are scoped by core
//! workspace helpers and mutations create durable, idempotent requests only.
use crate::{
    delegation_admin::{AgentProposalArguments, DelegateArguments},
    ServerData,
};
use aplot_core::{tasks::store, workspace};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAX_ARGUMENT_BYTES: usize = 64 * 1024;
const MAX_WIRE_BYTES: usize = 32 * 1024;
const MAX_LIST_ROWS: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyArguments {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListAgentsArguments {
    project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskResultArguments {
    task_id: String,
    wait_seconds: Option<u8>,
}

/// Dynamic function descriptors advertised to the Codex app-server runtime.
/// The strict schemas match the desktop names and camelCase argument fields.
pub fn descriptors() -> Vec<Value> {
    let schema = |properties: Value, required: &[&str]| {
        json!({
            "type":"object",
            "properties":properties,
            "required":required,
            "additionalProperties":false
        })
    };
    vec![
        json!({
            "type":"function",
            "name":"aplot_list_projects",
            "description":"List existing Aplot projects and their IDs.",
            "inputSchema":schema(json!({}), &[])
        }),
        json!({
            "type":"function",
            "name":"aplot_list_agents",
            "description":"List existing app agents, their jobs and execution configuration. Optional project filter.",
            "inputSchema":schema(json!({"projectId":{"type":"string","maxLength":200}}), &[])
        }),
        json!({
            "type":"function",
            "name":"aplot_task_result",
            "description":"Read status and result of a task delegated by this agent. This server returns immediately; waitSeconds must be 0 or omitted.",
            "inputSchema":schema(json!({
                "taskId":{"type":"string","minLength":1,"maxLength":200},
                "waitSeconds":{"type":"integer","minimum":0,"maximum":0}
            }), &["taskId"])
        }),
        json!({
            "type":"function",
            "name":"aplot_delegate",
            "description":"Queue a linked task with an existing app agent. Returns its taskId and queued status; read its result separately with aplot_task_result. Uses the caller's project unless specified.",
            "inputSchema":schema(json!({
                "agentId":{"type":"string","minLength":1,"maxLength":200},
                "prompt":{"type":"string","minLength":1,"maxLength":16000},
                "projectId":{"type":"string","minLength":1,"maxLength":200}
            }), &["agentId","prompt"])
        }),
        json!({
            "type":"function",
            "name":"aplot_propose_agent",
            "description":"Propose creating a specialist. A host user must explicitly approve it; this tool cannot approve or create the agent itself.",
            "inputSchema":schema(json!({
                "name":{"type":"string","minLength":1,"maxLength":20},
                "title":{"type":"string","minLength":1,"maxLength":80},
                "instructions":{"type":"string","minLength":1,"maxLength":16000}
            }), &["name","title","instructions"])
        }),
    ]
}

impl ServerData {
    /// Dispatch one runtime tool call under the active task capability.
    ///
    /// Business denials and invalid arguments are returned as a normal tool
    /// result with `success:false`; database failures are returned as `Err` so
    /// the supervisor can stop the turn instead of pretending it succeeded.
    pub fn dispatch_task_tool(
        &mut self,
        caller_task_id: &str,
        generation: u64,
        native_call_id: &str,
        tool: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        if let Some(error) = self.check_active_caller(caller_task_id, generation)? {
            return Ok(failure(error));
        }
        if native_call_id.trim().is_empty() || native_call_id.chars().count() > 512 {
            return Ok(failure("tool-call-id-invalid"));
        }
        if tool.len() > 128 {
            return Ok(failure("unknown-tool"));
        }
        if serde_json::to_vec(&arguments)
            .map_err(|_| "tool-arguments-encode-failed".to_owned())?
            .len()
            > MAX_ARGUMENT_BYTES
        {
            return Ok(failure("tool-arguments-limit"));
        }

        match tool {
            "aplot_list_projects" => {
                let _: EmptyArguments = match serde_json::from_value(arguments) {
                    Ok(arguments) => arguments,
                    Err(_) => return Ok(failure("invalid-arguments")),
                };
                let rows = match workspace::app_tool_list_projects(&self.tasks, caller_task_id) {
                    Ok(rows) => rows,
                    Err(error) => return tool_error_response(error),
                };
                Ok(list_success("projects", rows))
            }
            "aplot_list_agents" => {
                let args: ListAgentsArguments = match serde_json::from_value(arguments) {
                    Ok(arguments) => arguments,
                    Err(_) => return Ok(failure("invalid-arguments")),
                };
                if args
                    .project_id
                    .as_deref()
                    .is_some_and(|id| id.trim().is_empty() || id.chars().count() > 200)
                {
                    return Ok(failure("invalid-arguments"));
                }
                let rows = match workspace::app_tool_list_agents(
                    &self.tasks,
                    caller_task_id,
                    args.project_id.as_deref().map(str::trim),
                ) {
                    Ok(rows) => rows,
                    Err(error) => return tool_error_response(error),
                };
                Ok(list_success("agents", rows))
            }
            "aplot_task_result" => {
                let args: TaskResultArguments = match serde_json::from_value(arguments) {
                    Ok(arguments) => arguments,
                    Err(_) => return Ok(failure("invalid-arguments")),
                };
                if args.task_id.trim().is_empty()
                    || args.task_id.chars().count() > 200
                    || args.wait_seconds.is_some_and(|seconds| seconds != 0)
                {
                    return Ok(failure(
                        if args.wait_seconds.is_some_and(|seconds| seconds != 0) {
                            "wait-not-supported"
                        } else {
                            "invalid-arguments"
                        },
                    ));
                }
                let mut result = match workspace::app_tool_task_result(
                    &self.tasks,
                    caller_task_id,
                    args.task_id.trim(),
                ) {
                    Ok(result) => result,
                    Err(error) => return tool_error_response(error),
                };
                for (field, limit) in [
                    ("taskId", 200),
                    ("status", 40),
                    ("agent", 120),
                    ("error", 300),
                ] {
                    if let Some(value) =
                        result.get(field).and_then(Value::as_str).map(str::to_owned)
                    {
                        result[field] = json!(take_chars(&value, limit));
                    }
                }
                result["pending"] = json!(matches!(
                    result["status"].as_str(),
                    Some("queued" | "running" | "waiting_for_user")
                ));
                Ok(success(result, Some("result")))
            }
            "aplot_delegate" => {
                let args: DelegateArguments = match serde_json::from_value(arguments) {
                    Ok(arguments) => arguments,
                    Err(_) => return Ok(failure("invalid-arguments")),
                };
                let args = match normalize_delegate(args) {
                    Ok(args) => args,
                    Err(error) => return Ok(failure(error)),
                };
                let command_id = stable_command_id(caller_task_id, generation, native_call_id);
                match self.request_delegation(caller_task_id, generation, &command_id, args) {
                    Ok(receipt) => Ok(success(
                        serde_json::to_value(receipt).map_err(|error| error.to_string())?,
                        None,
                    )),
                    Err(error) => mutation_error(error),
                }
            }
            "aplot_propose_agent" => {
                let args: AgentProposalArguments = match serde_json::from_value(arguments) {
                    Ok(arguments) => arguments,
                    Err(_) => return Ok(failure("invalid-arguments")),
                };
                let args = match normalize_proposal(args) {
                    Ok(args) => args,
                    Err(error) => return Ok(failure(error)),
                };
                let command_id = stable_command_id(caller_task_id, generation, native_call_id);
                match self.request_agent_proposal(caller_task_id, generation, &command_id, args) {
                    Ok(receipt) => Ok(success(
                        serde_json::to_value(receipt).map_err(|error| error.to_string())?,
                        None,
                    )),
                    Err(error) => mutation_error(error),
                }
            }
            _ => Ok(failure("unknown-tool")),
        }
    }

    fn check_active_caller(
        &self,
        caller_task_id: &str,
        generation: u64,
    ) -> Result<Option<&'static str>, String> {
        if caller_task_id.trim().is_empty() || caller_task_id.chars().count() > 200 {
            return Ok(Some("task-not-active"));
        }
        let Some(row) = store::read_task(&self.tasks, caller_task_id)
            .map_err(|_| "tool-database-error".to_owned())?
        else {
            return Ok(Some("task-not-active"));
        };
        if !row.state.pending || !row.state.live || row.state.ended || row.state.stopped {
            return Ok(Some("task-not-active"));
        }
        match row.state.native_generation {
            Some(current) if current == generation => Ok(None),
            Some(_) => Ok(Some("task-generation-stale")),
            None => Ok(Some("task-generation-unavailable")),
        }
    }
}

fn normalize_delegate(mut args: DelegateArguments) -> Result<DelegateArguments, &'static str> {
    args.agent_id = args.agent_id.trim().to_owned();
    args.prompt = args.prompt.trim().to_owned();
    if args.agent_id.is_empty() || args.agent_id.chars().count() > 200 {
        return Err("invalid-agent-id");
    }
    if args.prompt.is_empty() {
        return Err("prompt-empty");
    }
    if args.prompt.chars().count() > 16_000 {
        return Err("prompt-limit");
    }
    if let Some(project_id) = &mut args.project_id {
        *project_id = project_id.trim().to_owned();
        if project_id.is_empty() || project_id.chars().count() > 200 {
            return Err("invalid-project-id");
        }
    }
    Ok(args)
}

fn normalize_proposal(
    mut args: AgentProposalArguments,
) -> Result<AgentProposalArguments, &'static str> {
    args.name = args.name.trim().to_owned();
    args.title = args.title.trim().to_owned();
    args.instructions = args.instructions.trim().to_owned();
    if args.name.is_empty() || args.name.chars().count() > 20 {
        return Err("proposal-name-limit");
    }
    if args.title.is_empty() || args.title.chars().count() > 80 {
        return Err("proposal-title-limit");
    }
    if args.instructions.is_empty() || args.instructions.chars().count() > 16_000 {
        return Err("proposal-instructions-limit");
    }
    Ok(args)
}

fn stable_command_id(caller_task_id: &str, generation: u64, native_call_id: &str) -> String {
    let material = format!("{caller_task_id}\0{generation}\0{native_call_id}");
    format!("tool-{:x}", Sha256::digest(material.as_bytes()))
}

fn tool_error_response(error: String) -> Result<Value, String> {
    if safe_error_code(&error) {
        // Core workspace methods use stable short codes for user-facing denials.
        // Keep unstructured SQL/runtime detail out of the model-visible result.
        Ok(failure(&error))
    } else {
        Err("tool-database-error".into())
    }
}

fn mutation_error(error: std::io::Error) -> Result<Value, String> {
    let message = error.to_string();
    if safe_error_code(&message) {
        Ok(failure(&message))
    } else {
        Err("tool-database-error".into())
    }
}

fn safe_error_code(error: &str) -> bool {
    !error.is_empty()
        && error.len() <= 96
        && error
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn failure(error: &str) -> Value {
    wire(false, json!({"error":error}))
}

fn list_success(field: &str, mut result: Value) -> Value {
    let Some(rows) = result.get_mut(field).and_then(Value::as_array_mut) else {
        return failure("workspace-invalid");
    };
    let mut truncated = false;
    let mut bounded_rows = Vec::new();
    // The core agent projection clips instructions. Also cap identifiers and
    // display text here, before wrapping them in another JSON string. IDs are
    // preserved intact; unaddressable rows are omitted and marked truncated.
    for mut row in rows.drain(..) {
        if bounded_rows.len() >= MAX_LIST_ROWS {
            truncated = true;
            break;
        }
        let Some(id) = row.get("id").and_then(Value::as_str) else {
            truncated = true;
            continue;
        };
        if id.trim().is_empty() || id.chars().count() > 200 {
            truncated = true;
            continue;
        }
        for (key, max_chars) in [
            ("name", 120),
            ("title", 120),
            ("runtime", 24),
            ("model", 160),
            ("instructions", 300),
        ] {
            if let Some(value) = row.get(key).and_then(Value::as_str).map(str::to_owned) {
                let limited = take_chars(&value, max_chars);
                if limited.chars().count() < value.chars().count() {
                    truncated = true;
                }
                row[key] = json!(limited);
            }
        }
        bounded_rows.push(row);
    }
    result[field] = json!(bounded_rows);
    loop {
        if truncated {
            result["truncated"] = json!(true);
        }
        if wire_size(true, &result) <= MAX_WIRE_BYTES {
            break;
        }
        let Some(rows) = result.get_mut(field).and_then(Value::as_array_mut) else {
            return failure("result-limit");
        };
        if rows.pop().is_none() {
            return failure("result-limit");
        }
        truncated = true;
    }
    wire(true, result)
}

fn success(mut result: Value, shrink_string_field: Option<&str>) -> Value {
    if let Some(field) = shrink_string_field {
        let Some(original) = result.get(field).and_then(Value::as_str).map(str::to_owned) else {
            return failure("workspace-invalid");
        };
        let mut limit = original.chars().count().min(4_000);
        loop {
            result[field] = json!(take_chars(&original, limit));
            if wire_size(true, &result) <= MAX_WIRE_BYTES || limit == 0 {
                break;
            }
            limit /= 2;
        }
        if limit < original.chars().count() {
            result["resultTruncated"] = json!(true);
        }
    }
    if wire_size(true, &result) <= MAX_WIRE_BYTES {
        wire(true, result)
    } else {
        failure("result-limit")
    }
}

fn wire(success: bool, result: Value) -> Value {
    let text = result.to_string();
    let wrapped = json!({
        "contentItems":[{"type":"inputText","text":text}],
        "success":success
    });
    if wrapped.to_string().len() <= MAX_WIRE_BYTES {
        wrapped
    } else {
        let small = json!({"contentItems":[{"type":"inputText","text":"{\"error\":\"result-limit\"}"}],"success":false});
        small
    }
}

fn wire_size(success: bool, result: &Value) -> usize {
    json!({
        "contentItems":[{"type":"inputText","text":result.to_string()}],
        "success":success
    })
    .to_string()
    .len()
}

fn take_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aplot_core::tasks::store::Journal;
    use std::path::PathBuf;

    struct Fixture {
        directory: PathBuf,
        project_root: PathBuf,
        server: ServerData,
        caller_id: String,
        project_id: String,
    }

    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("aplot-tool-broker-{}", uuid::Uuid::new_v4()));
            let project_root = directory.join("project");
            std::fs::create_dir_all(&project_root).unwrap();
            let mut server = ServerData::open(&directory.join("server")).unwrap();
            let project = server.register_project(&project_root, "Project").unwrap();
            let project_id = project["project"]["id"].as_str().unwrap().to_owned();
            let task = server.new_task(&project_id, "Caller").unwrap();
            let caller_id = task["task"]["id"].as_str().unwrap().to_owned();
            let saved = workspace::read_saved(&server.tasks).unwrap().unwrap();
            let mut data = saved["data"].clone();
            data["presets"] = json!([{
                "id":"reviewer",
                "name":"Reviewer",
                "title":"Code reviewer",
                "runtime":"codex",
                "instructions":"Review the requested code.",
                "binding":{"apiKey":"private-secret-that-must-not-leak"},
                "accessMode":"restricted",
                "projectIds":[project_id]
            }]);
            workspace::write_saved(&mut server.tasks, data, saved["revision"].as_u64().unwrap())
                .unwrap();
            let tx = server.tasks.transaction().unwrap();
            let mut journal = Journal::new(&tx);
            journal
                .edit_state(&caller_id, |state| {
                    state.pending = true;
                    state.live = true;
                    state.native_generation = Some(7);
                })
                .unwrap();
            drop(journal);
            tx.commit().unwrap();
            Self {
                directory,
                project_root,
                server,
                caller_id,
                project_id,
            }
        }

        fn call(&mut self, call_id: &str, tool: &str, args: Value) -> Value {
            self.server
                .dispatch_task_tool(&self.caller_id, 7, call_id, tool, args)
                .unwrap()
        }

        fn result(response: &Value) -> Value {
            serde_json::from_str(response["contentItems"][0]["text"].as_str().unwrap()).unwrap()
        }

        fn cleanup(self) {
            let Self {
                directory, server, ..
            } = self;
            drop(server);
            let _ = std::fs::remove_dir_all(directory);
        }
    }

    #[test]
    fn descriptors_preserve_names_camel_case_and_strict_shapes() {
        let names: Vec<_> = descriptors()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            names,
            [
                "aplot_list_projects",
                "aplot_list_agents",
                "aplot_task_result",
                "aplot_delegate",
                "aplot_propose_agent"
            ]
        );
        for tool in descriptors() {
            assert_eq!(tool["type"], "function");
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        }
        let result = descriptors()
            .into_iter()
            .find(|tool| tool["name"] == "aplot_task_result")
            .unwrap();
        assert_eq!(
            result["inputSchema"]["properties"]["waitSeconds"]["maximum"],
            0
        );
    }

    #[test]
    fn reads_are_generation_checked_scoped_and_nonblocking() {
        let mut fixture = Fixture::new();
        let projects = fixture.call("list-projects", "aplot_list_projects", json!({}));
        assert_eq!(projects["success"], true);
        let project_value = Fixture::result(&projects);
        assert_eq!(project_value["projects"][0]["id"], fixture.project_id);
        assert!(project_value["projects"][0].get("path").is_none());

        let agents = fixture.call(
            "list-agents",
            "aplot_list_agents",
            json!({"projectId":fixture.project_id}),
        );
        assert_eq!(agents["success"], true);
        assert_eq!(Fixture::result(&agents)["agents"][0]["id"], "reviewer");
        assert!(!agents
            .to_string()
            .contains("private-secret-that-must-not-leak"));
        assert_eq!(
            fixture.call(
                "unknown-project",
                "aplot_list_agents",
                json!({"projectId":"elsewhere"})
            )["success"],
            false
        );

        let child = fixture.call(
            "delegate",
            "aplot_delegate",
            json!({"agentId":"reviewer","prompt":"Check this change."}),
        );
        assert_eq!(child["success"], true);
        let child_receipt = Fixture::result(&child);
        assert_eq!(child_receipt["status"], "queued");
        let pending = fixture.call(
            "result",
            "aplot_task_result",
            json!({"taskId":child_receipt["taskId"],"waitSeconds":0}),
        );
        assert_eq!(pending["success"], true);
        assert_eq!(Fixture::result(&pending)["pending"], true);
        assert_eq!(
            fixture.call(
                "wait",
                "aplot_task_result",
                json!({"taskId":child_receipt["taskId"],"waitSeconds":1})
            )["success"],
            false
        );
        assert_eq!(
            fixture.call("sibling", "aplot_task_result", json!({"taskId":"missing"}))["success"],
            false
        );
        fixture.cleanup();
    }

    #[test]
    fn calls_are_idempotent_strict_and_proposals_do_not_approve_themselves() {
        let mut fixture = Fixture::new();
        let args = json!({"agentId":"reviewer","prompt":"Check once."});
        let first = fixture.call("native-call-1", "aplot_delegate", args.clone());
        let replay = fixture.call("native-call-1", "aplot_delegate", args);
        assert_eq!(first, replay);
        let changed = fixture.call(
            "native-call-1",
            "aplot_delegate",
            json!({"agentId":"reviewer","prompt":"Changed."}),
        );
        assert_eq!(changed["success"], false);

        let proposal_args = json!({"name":"Security","title":"Security reviewer","instructions":"Review security boundaries."});
        let proposal = fixture.call("proposal-1", "aplot_propose_agent", proposal_args.clone());
        assert_eq!(proposal["success"], true);
        assert_eq!(Fixture::result(&proposal)["status"], "pending");
        assert_eq!(
            proposal,
            fixture.call("proposal-1", "aplot_propose_agent", proposal_args)
        );

        assert_eq!(
            fixture.call(
                "bad-extra",
                "aplot_delegate",
                json!({"agentId":"reviewer","prompt":"p","callerTaskId":"other"})
            )["success"],
            false
        );
        assert_eq!(
            fixture.call("bad-type", "aplot_list_projects", json!({"anything":true}))["success"],
            false
        );
        assert_eq!(
            fixture.call(
                "too-large",
                "aplot_propose_agent",
                json!({"name":"x","title":"x","instructions":"x".repeat(70_000)})
            )["success"],
            false
        );
        assert!(descriptors()
            .iter()
            .all(|tool| tool["name"] != "aplot_review_agent_proposal"));
        fixture.cleanup();
    }

    #[test]
    fn stale_generation_and_inactive_caller_cannot_use_tools() {
        let mut fixture = Fixture::new();
        let stale = fixture
            .server
            .dispatch_task_tool(
                &fixture.caller_id,
                6,
                "list",
                "aplot_list_projects",
                json!({}),
            )
            .unwrap();
        assert_eq!(stale["success"], false);
        let tx = fixture.server.tasks.transaction().unwrap();
        let mut journal = Journal::new(&tx);
        journal
            .edit_state(&fixture.caller_id, |state| state.pending = false)
            .unwrap();
        drop(journal);
        tx.commit().unwrap();
        let inactive = fixture
            .server
            .dispatch_task_tool(
                &fixture.caller_id,
                7,
                "list",
                "aplot_list_projects",
                json!({}),
            )
            .unwrap();
        assert_eq!(inactive["success"], false);
        fixture.cleanup();
    }

    #[test]
    fn result_and_project_lists_stay_bounded_and_valid_json() {
        let mut fixture = Fixture::new();
        let saved = workspace::read_saved(&fixture.server.tasks)
            .unwrap()
            .unwrap();
        let mut data = saved["data"].clone();
        for index in 0..90 {
            data["projects"].as_array_mut().unwrap().push(json!({
                "id":format!("extra-{index}"),
                "name":"P".repeat(5000),
                "path":fixture.project_root.to_string_lossy()
            }));
        }
        workspace::write_saved(
            &mut fixture.server.tasks,
            data,
            saved["revision"].as_u64().unwrap(),
        )
        .unwrap();
        let response = fixture.call("large-list", "aplot_list_projects", json!({}));
        assert!(response.to_string().len() <= MAX_WIRE_BYTES);
        assert_eq!(response["success"], true);
        let list = Fixture::result(&response);
        assert_eq!(list["truncated"], true);
        assert!(list["projects"].as_array().unwrap().len() <= MAX_LIST_ROWS);

        let oversized_result = success(
            json!({
                "taskId":"child",
                "status":"completed",
                "result":"\0".repeat(16_000),
                "pending":false
            }),
            Some("result"),
        );
        assert!(oversized_result.to_string().len() <= MAX_WIRE_BYTES);
        let bounded = Fixture::result(&oversized_result);
        assert_eq!(bounded["resultTruncated"], true);
        assert!(bounded["result"].as_str().unwrap().chars().count() < 16_000);
        fixture.cleanup();
    }
}
