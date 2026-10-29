//! Codex app-server notifications translated into runtime-neutral agent frames.
//! Mirrors `features/openai/codexProtocol.ts`, which still serves runtimes and
//! windows that are not moved to the host.
use serde_json::{json, Map, Value};

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Frame {
    Event {
        kind: &'static str,
        payload: Value,
    },
    Request {
        id: String,
        method: &'static str,
        params: Value,
    },
    /// `code` is the public error code the composer shows (`agent-error`, `changed`, ...).
    Error {
        code: String,
        detail: Option<String>,
    },
}

fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}
fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
fn clip(value: String, limit: usize) -> String {
    value.chars().take(limit).collect()
}

pub(crate) struct Policy {
    pub approval_policy: &'static str,
    pub sandbox: &'static str,
    pub sandbox_policy: Value,
}

pub(crate) fn policy(mode: &str, cwd: &str) -> Policy {
    Policy {
        approval_policy: if mode == "manual" {
            "on-request"
        } else {
            "never"
        },
        sandbox: match mode {
            "full" => "danger-full-access",
            "restricted" => "read-only",
            _ => "workspace-write",
        },
        sandbox_policy: match mode {
            "full" => json!({"type":"dangerFullAccess"}),
            "restricted" => json!({"type":"readOnly","networkAccess":false}),
            _ => {
                json!({"type":"workspaceWrite","writableRoots":[cwd],"networkAccess":false,"excludeTmpdirEnvVar":true,"excludeSlashTmp":true})
            }
        },
    }
}

/// Same decision rules as `toolOutcome` in `workspaceModel.ts`, for Codex results.
pub(crate) fn tool_outcome(result: &Value) -> &'static str {
    let parsed;
    let result = match result {
        Value::String(raw) => match serde_json::from_str::<Value>(raw) {
            Ok(value) => {
                parsed = value;
                &parsed
            }
            Err(_) => return "unknown",
        },
        other => other,
    };
    let r = object(result);
    let status = r.get("status").map(text).unwrap_or_default().to_lowercase();
    let message = r
        .get("error")
        .or_else(|| r.get("output"))
        .map(text)
        .unwrap_or_default()
        .to_lowercase();
    let denied_text = message.contains("denied by user")
        || message.contains("denied by the user")
        || ((message.contains("permission") || message.contains("approval"))
            && (message.contains("denied") || message.contains("rejected")));
    if r.get("denied") == Some(&json!(true))
        || ["denied", "rejected"].contains(&status.as_str())
        || denied_text
    {
        return "denied";
    }
    if ["interrupted", "cancelled", "canceled"].contains(&status.as_str()) {
        return "interrupted";
    }
    let flag = |key: &str, value: bool| r.get(key) == Some(&json!(value));
    let exit = r.get("exit_code").and_then(Value::as_i64);
    let has_error = r
        .get("error")
        .is_some_and(|e| !e.is_null() && e != "" && e != &json!(false));
    if flag("is_error", true)
        || flag("success", false)
        || flag("ok", false)
        || has_error
        || ["error", "failed"].contains(&status.as_str())
        || exit.is_some_and(|code| code != 0)
    {
        return "error";
    }
    // A bare completion or a string summary is insufficient evidence of success.
    if flag("success", true)
        || flag("ok", true)
        || flag("is_error", false)
        || exit == Some(0)
        || ["success", "completed", "complete", "ok"].contains(&status.as_str())
    {
        return "success";
    }
    if [
        "content",
        "total_lines",
        "bytes_written",
        "responses",
        "todos",
    ]
    .iter()
    .any(|k| r.contains_key(*k))
    {
        return "success";
    }
    "unknown"
}

pub(crate) fn frames(event: &Value) -> Vec<Frame> {
    let method = event["method"].as_str().unwrap_or("");
    let p = &event["params"];
    let item = &p["item"];
    let emit = |kind: &'static str, payload: Value| vec![Frame::Event { kind, payload }];
    let item_event = method == "item/started" || method == "item/completed";
    if item_event && item["type"] == "collabAgentToolCall" {
        let states = object(&item["agentsStates"]);
        return item["receiverThreadIds"]
            .as_array()
            .into_iter()
            .flatten()
            .take(32)
            .map(|id| {
                let id = text(id);
                let child = states.get(&id).cloned().unwrap_or(Value::Null);
                let status = child["status"].as_str().unwrap_or("running");
                let status = match status {
                    "completed" | "failed" | "stopped" => status,
                    "errored" => "failed",
                    _ => "running",
                };
                let activity = if child["message"].is_null() { text(&item["prompt"]) } else { text(&child["message"]) };
                Frame::Event {
                    kind: "agent.update",
                    payload: json!({"id":id,"name":item["tool"].as_str().unwrap_or("Codex"),"activity":clip(activity,600),"status":status}),
                }
            })
            .collect();
    }
    match method {
        "item/agentMessage/delta" => return emit("message.delta", json!({"text":p["delta"]})),
        "item/reasoning/summaryTextDelta" => {
            return emit("reasoning.delta", json!({"text":p["delta"]}))
        }
        "item/commandExecution/outputDelta" => {
            return emit(
                "tool.output",
                json!({"tool_id":p["itemId"],"text":p["delta"]}),
            )
        }
        "turn/completed" => {
            let turn = &p["turn"];
            let status = match turn["status"].as_str() {
                Some("completed") => "complete",
                Some("interrupted") => "interrupted",
                _ => "error",
            };
            let mut payload = json!({"status":status});
            if !turn["error"].is_null() {
                payload["errorDetail"] = json!(clip(
                    turn["error"]["message"]
                        .as_str()
                        .unwrap_or("Codex request failed")
                        .into(),
                    1000
                ));
            }
            return emit("message.complete", payload);
        }
        "error" => {
            return vec![Frame::Error {
                code: "agent-error".into(),
                detail: Some(clip(
                    p["error"]["message"]
                        .as_str()
                        .unwrap_or("Codex request failed")
                        .into(),
                    1000,
                )),
            }]
        }
        "thread/tokenUsage/updated" => {
            let usage = &p["tokenUsage"];
            return emit(
                "session.usage",
                json!({"usage":{"context_used":usage["last"]["totalTokens"].as_f64().unwrap_or(0.0),
                    "context_max":usage["modelContextWindow"].as_f64().unwrap_or(0.0),
                    "context_source":"provider_usage","context_estimated":false}}),
            );
        }
        _ => {}
    }
    let kind = item["type"].as_str().unwrap_or("");
    if item_event && ["commandExecution", "fileChange", "mcpToolCall", "webSearch"].contains(&kind)
    {
        let changes = item["changes"].as_array().cloned().unwrap_or_default();
        let name = match kind {
            "commandExecution" => "terminal".to_owned(),
            "fileChange" => "apply_patch".to_owned(),
            _ => item["tool"].as_str().unwrap_or(kind).to_owned(),
        };
        let args = if kind == "commandExecution" {
            json!({"command":item["command"],"cwd":item["cwd"]})
        } else {
            json!({"changes":changes,"path":changes.first().map(|c| c["path"].clone()).unwrap_or(Value::Null)})
        };
        let status = match item["status"].as_str() {
            Some("completed") => json!("completed"),
            Some("declined") => json!("denied"),
            _ => item["status"].clone(),
        };
        let output = [&item["aggregatedOutput"], &item["result"]]
            .into_iter()
            .find(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!(""));
        let diff = changes
            .iter()
            .map(|c| c["diff"].as_str().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        return emit(
            if method == "item/started" {
                "tool.start"
            } else {
                "tool.complete"
            },
            json!({"tool_id":item["id"],"name":name,"args":args,
                "result":{"status":status,"exit_code":item["exitCode"],"output":output},"inline_diff":diff}),
        );
    }
    let Some(id) = event.get("id").filter(|id| !id.is_null()) else {
        return Vec::new();
    };
    let native = id.to_string();
    if method.ends_with("/requestApproval") {
        let decisions = p["availableDecisions"].as_array();
        let session = decisions.is_none_or(|d| d.iter().any(|v| v == "acceptForSession"));
        let always = !p["proposedExecpolicyAmendment"].is_null()
            && decisions.is_none_or(|d| {
                d.iter()
                    .any(|v| v.get("acceptWithExecpolicyAmendment").is_some())
            });
        let mut choices = vec![json!("once"), json!("deny")];
        if session {
            choices.push(json!("session"));
        }
        if always {
            choices.push(json!("always"));
        }
        let command = if p["command"].is_null() {
            serde_json::to_string(&if p["changes"].is_null() {
                json!({})
            } else {
                p["changes"].clone()
            })
            .unwrap_or_default()
        } else {
            text(&p["command"])
        };
        return vec![Frame::Request {
            id: native,
            method: "approval",
            params: json!({"description":if p["reason"].is_null() { json!(method) } else { p["reason"].clone() },
                "command":command,"choices":choices,"allow_session":session,"allow_permanent":always}),
        }];
    }
    if method == "item/tool/requestUserInput" {
        let questions = p["questions"].as_array().into_iter().flatten().map(|q| {
            let choices = q["options"].as_array().map(|o| {
                o.iter()
                    .map(|o| json!(text(&o["label"])))
                    .collect::<Vec<_>>()
            });
            json!({"qid":q["id"],"question":q["question"],"choices":choices})
        });
        return vec![Frame::Request {
            id: native,
            method: "clarify",
            params: json!({"questions":questions.collect::<Vec<_>>()}),
        }];
    }
    Vec::new()
}

/// The JSON-RPC result Codex expects for a person's answer.
pub(crate) fn approval_result(request: &Value, answer: &Value) -> Result<Value, String> {
    if request["method"] == "item/tool/requestUserInput" {
        let answers = object(&answer["answers"])
            .into_iter()
            .map(|(id, value)| (id, json!({"answers":[text(&value)]})))
            .collect::<Map<_, _>>();
        return Ok(json!({"answers":answers}));
    }
    let amendment = &request["params"]["proposedExecpolicyAmendment"];
    Ok(match answer["choice"].as_str() {
        Some("always") if amendment.is_null() => return Err("unsupported-permanent".into()),
        Some("always") => {
            json!({"decision":{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":amendment}}})
        }
        Some("session") => json!({"decision":"acceptForSession"}),
        Some("once") => json!({"decision":"accept"}),
        _ => json!({"decision":"decline"}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_request_keeps_the_native_id_and_offers_only_supported_choices() {
        let event = json!({"id":7,"method":"item/commandExecution/requestApproval","params":{"threadId":"t","command":"cargo test","availableDecisions":["accept","decline"]}});
        let [Frame::Request { id, method, params }] =
            <[Frame; 1]>::try_from(frames(&event)).unwrap()
        else {
            panic!()
        };
        assert_eq!(id, "7");
        assert_eq!(method, "approval");
        assert_eq!(params["choices"], json!(["once", "deny"]));
        assert_eq!(params["command"], "cargo test");
    }

    #[test]
    fn answers_map_to_codex_decisions() {
        let request = json!({"method":"item/commandExecution/requestApproval","params":{}});
        assert_eq!(
            approval_result(&request, &json!({"choice":"once"})).unwrap(),
            json!({"decision":"accept"})
        );
        assert_eq!(
            approval_result(&request, &json!({"choice":"deny"})).unwrap(),
            json!({"decision":"decline"})
        );
        assert_eq!(
            approval_result(&request, &json!({"choice":"session"})).unwrap(),
            json!({"decision":"acceptForSession"})
        );
        assert!(approval_result(&request, &json!({"choice":"always"})).is_err());
        let clarify = json!({"method":"item/tool/requestUserInput","params":{}});
        assert_eq!(
            approval_result(&clarify, &json!({"answers":{"q1":"yes"}})).unwrap(),
            json!({"answers":{"q1":{"answers":["yes"]}}})
        );
    }

    #[test]
    fn turn_and_tool_events() {
        let done = json!({"method":"turn/completed","params":{"threadId":"t","turn":{"status":"failed","error":{"message":"quota"}}}});
        assert_eq!(
            frames(&done),
            vec![Frame::Event {
                kind: "message.complete",
                payload: json!({"status":"error","errorDetail":"quota"})
            }]
        );
        let tool = json!({"method":"item/completed","params":{"item":{"id":"i","type":"commandExecution","command":"ls","status":"completed","exitCode":0,"aggregatedOutput":"ok"}}});
        let [Frame::Event { kind, payload }] = <[Frame; 1]>::try_from(frames(&tool)).unwrap()
        else {
            panic!()
        };
        assert_eq!(kind, "tool.complete");
        assert_eq!(tool_outcome(&payload["result"]), "success");
        assert_eq!(tool_outcome(&json!({"status":"denied"})), "denied");
        assert_eq!(
            tool_outcome(&json!({"status":"completed","exit_code":2})),
            "error"
        );
    }

    #[test]
    fn manual_mode_asks_and_restricted_mode_reads_only() {
        assert_eq!(policy("manual", "C:\\p").approval_policy, "on-request");
        assert_eq!(policy("restricted", "C:\\p").sandbox, "read-only");
        assert_eq!(
            policy("full", "C:\\p").sandbox_policy["type"],
            "dangerFullAccess"
        );
        assert_eq!(
            policy("manual", "C:\\p").sandbox_policy["writableRoots"][0],
            "C:\\p"
        );
    }
}
