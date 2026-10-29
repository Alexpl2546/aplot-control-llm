//! Claude Code stream-json packets translated into runtime-neutral agent frames.
//! Mirrors `features/openai/claudeProtocol.ts` and the turn bookkeeping of
//! `services/claude.ts`, which still serve the chat page and other windows.
use super::codex_protocol::Frame;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

/// Per-session stream bookkeeping.
#[derive(Debug, Default)]
pub(crate) struct Stream {
    streamed: bool,
    last_input: Option<f64>,
    output: f64,
    context_window: Option<f64>,
    native_state: Option<String>,
    active_tasks: HashSet<String>,
    /// A `result` waits until background tasks finish and the session is idle.
    result: Option<Value>,
    pub(crate) stop_requested: bool,
}

fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}
fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}

fn tool_name(name: &str) -> &str {
    match name {
        "Read" => "read_file",
        "Write" => "write_file",
        "Edit" => "edit_file",
        "Bash" => "terminal",
        "Glob" => "list_directory",
        "Grep" => "search_files",
        other => other,
    }
}

/// Frames for one packet, without the deferred-result rule (see [`packet`]).
pub(crate) fn frames(p: &Value, state: &mut Stream) -> Vec<Frame> {
    let kind = p["type"].as_str().unwrap_or("");
    let event = &p["event"];
    let delta = &event["delta"];
    let emit = |kind: &'static str, payload: Value| vec![Frame::Event { kind, payload }];
    if !p["parent_tool_use_id"].is_null() && ["assistant", "user", "stream_event"].contains(&kind) {
        return Vec::new();
    }
    let subtype = p["subtype"].as_str().unwrap_or("");
    if kind == "system"
        && ["task_started", "task_progress", "task_notification"].contains(&subtype)
        && !p["task_id"].is_null()
    {
        let status = if subtype == "task_notification" {
            match p["status"].as_str() {
                Some("completed") => "completed",
                Some("failed") => "failed",
                _ => "stopped",
            }
        } else {
            "running"
        };
        let activity = [&p["summary"], &p["last_tool_name"], &p["description"]]
            .into_iter()
            .find(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!(""));
        return emit(
            "agent.update",
            json!({"id":p["task_id"],"name":if p["description"].is_null() { json!("Claude") } else { p["description"].clone() },"activity":activity,"status":status}),
        );
    }
    if kind == "control_cancel_request" {
        return emit("request.cancel", json!({"id":p["request_id"]}));
    }
    if kind == "system" && subtype == "init" {
        return emit(
            "session.created",
            json!({"sessionId":p["session_id"],"modelId":p["model"]}),
        );
    }
    if kind == "stream_event" {
        if event["type"] == "message_start" {
            let usage = &event["message"]["usage"];
            if let Some(input) = usage["input_tokens"].as_f64() {
                state.last_input = Some(
                    input
                        + number(&usage["cache_read_input_tokens"])
                        + number(&usage["cache_creation_input_tokens"]),
                );
                state.output = 0.0;
            }
        }
        if event["type"] == "message_delta" {
            if let Some(output) = event["usage"]["output_tokens"].as_f64() {
                state.output = output;
            }
        }
        if delta["type"] == "text_delta" {
            state.streamed = true;
            return emit("message.delta", json!({"text":delta["text"]}));
        }
        if delta["type"] == "thinking_delta" {
            return emit("reasoning.delta", json!({"text":delta["thinking"]}));
        }
    }
    if kind == "assistant" {
        let mut out = Vec::new();
        for block in p["message"]["content"].as_array().into_iter().flatten() {
            if block["type"] == "tool_use" {
                out.push(Frame::Event { kind: "tool.start", payload: json!({"tool_id":block["id"],"name":tool_name(block["name"].as_str().unwrap_or("")),"args":block["input"]}) });
            }
            if block["type"] == "text" && !state.streamed {
                out.push(Frame::Event {
                    kind: "message.delta",
                    payload: json!({"text":block["text"]}),
                });
            }
        }
        state.streamed = false;
        return out;
    }
    if kind == "user" {
        return p["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["type"] == "tool_result")
            .map(|b| {
                let output = b["content"].as_str().map(str::to_owned).unwrap_or_else(|| b["content"].to_string());
                Frame::Event { kind: "tool.complete", payload: json!({"tool_id":b["tool_use_id"],"result":{"is_error":b["is_error"] == true,"output":output}}) }
            })
            .collect();
    }
    if kind == "control_request" {
        let r = &p["request"];
        if r["subtype"] != "can_use_tool" {
            return Vec::new();
        }
        let id = p["request_id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| p["request_id"].to_string());
        if r["tool_name"] == "AskUserQuestion" {
            let questions = r["input"]["questions"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .map(|(index, q)| {
                    let choices = q["options"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|o| {
                            json!(o["label"]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| o["label"].to_string()))
                        })
                        .collect::<Vec<_>>();
                    json!({"qid":index.to_string(),"question":q["question"],"choices":choices})
                });
            return vec![Frame::Request {
                id,
                method: "clarify",
                params: json!({"questions":questions.collect::<Vec<_>>()}),
            }];
        }
        let persist = r["permission_suggestions"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|v| v["type"] == "addRules" && v["rules"].is_array());
        let mut choices = vec![json!("once"), json!("deny")];
        if persist {
            choices.extend([json!("session"), json!("always")]);
        }
        return vec![Frame::Request {
            id,
            method: "approval",
            params: json!({"description":r["tool_name"],"command":serde_json::to_string_pretty(&r["input"]).unwrap_or_default(),"choices":choices,"allow_session":persist,"allow_permanent":persist}),
        }];
    }
    if kind == "result" {
        for model in object(&p["modelUsage"]).values() {
            if let Some(window) = model["contextWindow"].as_f64() {
                state.context_window = Some(window);
            }
        }
        let error = p["is_error"] == true;
        let mut payload = json!({"status":if error { "error" } else { "complete" }});
        if error {
            let detail = if p["errors"].is_null() {
                if p["result"].is_null() {
                    json!("Claude request failed")
                } else {
                    p["result"].clone()
                }
            } else {
                p["errors"].clone()
            };
            payload["errorDetail"] =
                json!(detail.to_string().chars().take(2000).collect::<String>());
        }
        if let Some(input) = state.last_input {
            payload["usage"] = json!({"context_used":input + state.output,"context_max":state.context_window.unwrap_or(0.0),"context_source":"provider_usage","context_estimated":false});
        }
        return emit("message.complete", payload);
    }
    Vec::new()
}

/// Frames for a packet including session bookkeeping: the turn completes only
/// once Claude is idle and its background tasks are done.
pub(crate) fn packet(p: &Value, state: &mut Stream) -> Vec<Frame> {
    let kind = p["type"].as_str().unwrap_or("");
    let subtype = p["subtype"].as_str().unwrap_or("");
    if kind == "system" && subtype == "session_state_changed" {
        state.native_state = Some(p["state"].as_str().unwrap_or("").to_owned());
    }
    if kind == "system" && subtype == "background_tasks_changed" {
        state.active_tasks = p["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|t| !t["task_id"].is_null() && t["ambient"] != true)
            .map(|t| {
                t["task_id"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| t["task_id"].to_string())
            })
            .collect();
    }
    if kind == "system" && subtype == "task_started" {
        if let Some(id) = p["task_id"].as_str() {
            state.active_tasks.insert(id.into());
        }
    }
    if kind == "system" && subtype == "task_notification" {
        if let Some(id) = p["task_id"].as_str() {
            state.active_tasks.remove(id);
        }
    }
    let mut out = Vec::new();
    if kind == "result" {
        state.result = Some(p.clone());
    } else {
        out.extend(deliver(p, state));
    }
    let idle = state
        .native_state
        .as_deref()
        .is_none_or(|s| s.is_empty() || s == "idle");
    if state.active_tasks.is_empty() && idle {
        if let Some(result) = state.result.take() {
            out.extend(deliver(&result, state));
        }
    }
    out
}

fn deliver(p: &Value, state: &mut Stream) -> Vec<Frame> {
    let mut out = frames(p, state);
    for frame in &mut out {
        if let Frame::Event {
            kind: "message.complete",
            payload,
        } = frame
        {
            if state.stop_requested {
                payload["status"] = json!("interrupted");
                state.stop_requested = false;
            }
        }
    }
    out
}

/// The `can_use_tool` response for a person's answer.
pub(crate) fn approval_result(packet: &Value, answer: &Value) -> Result<Value, String> {
    let request = &packet["request"];
    let input = &request["input"];
    if request["tool_name"] == "AskUserQuestion" {
        let answers = object(&answer["answers"]);
        if answers.is_empty() {
            return Ok(json!({"behavior":"deny","message":"The user skipped this question."}));
        }
        let mut updated = object(input);
        let mapped = input["questions"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(index, q)| {
                let key = q["question"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| q["question"].to_string());
                let value = answers
                    .get(&index.to_string())
                    .map(|v| {
                        v.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| v.to_string())
                    })
                    .unwrap_or_default();
                (key, json!(value))
            });
        updated.insert("answers".into(), Value::Object(mapped.collect()));
        return Ok(json!({"behavior":"allow","updatedInput":updated}));
    }
    let choice = answer["choice"].as_str().unwrap_or("deny");
    if choice == "deny" {
        return Ok(json!({"behavior":"deny","message":"The user declined this action."}));
    }
    let updates = request["permission_suggestions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["type"] == "addRules" && v["rules"].is_array())
        .cloned()
        .collect::<Vec<_>>();
    let persist = choice == "always" || choice == "session";
    if persist && updates.is_empty() {
        return Err("unsupported-permanent".into());
    }
    let mut result = json!({"behavior":"allow","updatedInput":input});
    if persist {
        let destination = if choice == "always" {
            "userSettings"
        } else {
            "session"
        };
        result["updatedPermissions"] = json!(updates
            .into_iter()
            .map(|mut v| {
                v["destination"] = json!(destination);
                v
            })
            .collect::<Vec<_>>());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_waits_for_background_tasks_and_idle_state() {
        let mut state = Stream::default();
        packet(
            &json!({"type":"system","subtype":"task_started","task_id":"bg"}),
            &mut state,
        );
        assert!(packet(&json!({"type":"result","is_error":false}), &mut state).is_empty());
        let frames = packet(
            &json!({"type":"system","subtype":"task_notification","task_id":"bg","status":"completed"}),
            &mut state,
        );
        assert!(frames.iter().any(|f| matches!(
            f,
            Frame::Event {
                kind: "message.complete",
                ..
            }
        )));
    }

    #[test]
    fn a_stop_turns_the_result_into_an_interruption() {
        let mut state = Stream {
            stop_requested: true,
            ..Stream::default()
        };
        let frames = packet(&json!({"type":"result","is_error":false}), &mut state);
        assert_eq!(
            frames,
            vec![Frame::Event {
                kind: "message.complete",
                payload: json!({"status":"interrupted"})
            }]
        );
    }

    #[test]
    fn streamed_text_is_not_repeated_by_the_final_assistant_message() {
        let mut state = Stream::default();
        let delta =
            json!({"type":"stream_event","event":{"delta":{"type":"text_delta","text":"hi"}}});
        assert_eq!(packet(&delta, &mut state).len(), 1);
        let full = json!({"type":"assistant","message":{"content":[{"type":"text","text":"hi"},{"type":"tool_use","id":"t","name":"Bash","input":{"command":"ls"}}]}});
        let frames = packet(&full, &mut state);
        assert_eq!(frames.len(), 1);
        assert!(
            matches!(&frames[0], Frame::Event { kind: "tool.start", payload } if payload["name"] == "terminal")
        );
    }

    #[test]
    fn approvals_offer_persistence_only_with_rule_suggestions() {
        let mut state = Stream::default();
        let ask = json!({"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm x"}}});
        let [Frame::Request { id, method, params }] =
            <[Frame; 1]>::try_from(packet(&ask, &mut state)).unwrap()
        else {
            panic!()
        };
        assert_eq!((id.as_str(), method), ("r1", "approval"));
        assert_eq!(params["choices"], json!(["once", "deny"]));
        assert_eq!(
            approval_result(&ask, &json!({"choice":"once"})).unwrap()["behavior"],
            "allow"
        );
        assert_eq!(
            approval_result(&ask, &json!({"choice":"deny"})).unwrap()["behavior"],
            "deny"
        );
        assert!(approval_result(&ask, &json!({"choice":"always"})).is_err());
        let question = json!({"request":{"tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which?"}]}}});
        assert_eq!(
            approval_result(&question, &json!({"answers":{"0":"A"}})).unwrap()["updatedInput"]
                ["answers"]["Which?"],
            "A"
        );
    }
}
