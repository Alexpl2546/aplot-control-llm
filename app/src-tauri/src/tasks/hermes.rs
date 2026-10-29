//! Hermes adapter for host-owned tasks. The bridge already speaks agent
//! frames; a host-owned bridge (`host:<task>`) hands them to [`route`].
//! Voice frames only change the window's draft, so they are forwarded live
//! and never journaled.
use super::codex_protocol::Frame;
use super::driver::{self, Live};
use super::store::{TaskConfig, TaskState};
use super::TaskHost;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const PREFIX: &str = "host:";

/// Event types the driver understands; others (status lines) are dropped.
fn event_kind(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "message.delta" => "message.delta",
        "message.interim" => "message.interim",
        "message.complete" => "message.complete",
        "reasoning.delta" => "reasoning.delta",
        "thinking.delta" => "reasoning.delta",
        "reasoning.available" => "reasoning.available",
        "tool.start" => "tool.start",
        "tool.complete" => "tool.complete",
        "session.usage" => "session.usage",
        "session.created" => "session.created",
        "request.cancel" => "request.cancel",
        "agent.update" => "agent.update",
        "error" => "error",
        _ => return None,
    })
}

pub(crate) fn frames(frame: &Value) -> Vec<Frame> {
    match frame["kind"].as_str() {
        Some("event") => {
            let Some(kind) = frame["type"].as_str().and_then(event_kind) else {
                return Vec::new();
            };
            let mut payload = frame["payload"].clone();
            if kind == "session.usage" {
                payload = json!({"usage":payload["usage"]});
            }
            vec![Frame::Event { kind, payload }]
        }
        Some("request") => {
            let method = match frame["method"].as_str() {
                Some("approval") => "approval",
                Some("clarify") => "clarify",
                _ => return Vec::new(),
            };
            let Some(id) = frame["id"].as_str() else {
                return Vec::new();
            };
            vec![Frame::Request {
                id: id.into(),
                method,
                params: frame["params"].clone(),
            }]
        }
        Some("error") => vec![Frame::Error {
            code: frame["code"].as_str().unwrap_or("agent-error").into(),
            detail: frame["payload"]["errorDetail"].as_str().map(str::to_owned),
        }],
        _ => Vec::new(),
    }
}

/// The reply Hermes accepts for a person's answer (see `valid_reply`).
pub(crate) fn approval_result(request: &Value, answer: &Value) -> Result<Value, String> {
    if request["method"] == "approval" {
        let choice = answer["choice"].as_str().unwrap_or("deny");
        return Ok(json!({"choice":choice}));
    }
    for key in ["answers", "answer"] {
        if let Some(value) = answer.get(key) {
            let mut reply = serde_json::Map::new();
            reply.insert(key.into(), value.clone());
            return Ok(Value::Object(reply));
        }
    }
    Ok(json!({}))
}

pub(crate) async fn route(app: &AppHandle, worker: &str, process: u64, frame: &Value) {
    let Some(task_id) = worker.strip_prefix(PREFIX) else {
        return;
    };
    let Some(host) = app.try_state::<TaskHost>() else {
        return;
    };
    if frame["kind"] == "closed" {
        driver::closed(app, &host, |l| {
            l.runtime == "hermes" && l.native == worker && l.generation == process
        })
        .await;
        return;
    }
    let replaced = host
        .sessions
        .live
        .lock()
        .unwrap()
        .get(task_id)
        .is_some_and(|l| l.native == worker && l.generation != process);
    if replaced {
        return;
    }
    if frame["kind"] == "event"
        && matches!(
            frame["type"].as_str(),
            Some("voice.status" | "voice.transcript")
        )
    {
        host.transient(task_id, frame);
        return;
    }
    let request = json!({"method":frame["method"],"params":frame["params"]});
    if let Err(error) =
        driver::apply_frames(app, &host, task_id, "", process, &request, frames(frame)).await
    {
        eprintln!("agent task {task_id}: {error}");
    }
}

pub(crate) async fn start_session(
    app: &AppHandle,
    task_id: &str,
    cwd: &str,
    config: &TaskConfig,
    _state: &TaskState,
) -> Result<Live, String> {
    let key = format!("{PREFIX}{task_id}");
    let request = crate::hermes_agent::AgentStart {
        id: key.clone(),
        run_id: config.run_id.clone().ok_or("server-missing")?,
        generation: config.generation.ok_or("server-missing")?,
        cwd: cwd.into(),
        skills: config.skills.clone().filter(|s| !s.is_empty()),
        language: config.language.clone().unwrap_or_else(|| "en".into()),
        context: config.context.clone().unwrap_or_default(),
        home_id: Some(task_id.into()),
        access_mode: config
            .access_mode
            .clone()
            .unwrap_or_else(|| "manual".into()),
        reasoning: config.reasoning.clone().filter(|s| !s.is_empty()),
    };
    let process = crate::hermes_agent::start(
        app.clone(),
        request,
        crate::hermes_agent::Sink::Host(app.clone()),
    )
    .await?;
    Ok(Live::new("hermes", key, String::new(), process))
}

pub(crate) async fn start_turn(
    app: &AppHandle,
    worker: &str,
    input: &Value,
) -> Result<Option<String>, String> {
    let attachments = input["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a["path"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let text = input["text"].as_str().unwrap_or("").to_owned();
    crate::hermes_agent::prompt(&app.state(), &app.state(), worker, text, Some(attachments))
        .await?;
    Ok(None)
}

pub(crate) async fn stop(app: &AppHandle, worker: &str, close: bool) -> Result<(), String> {
    crate::hermes_agent::stop(&app.state(), worker, close).await
}

pub(crate) async fn respond(
    app: &AppHandle,
    worker: &str,
    process: u64,
    request_id: &str,
    result: Value,
) -> Result<(), String> {
    crate::hermes_agent::respond(
        &app.state(),
        &app.state(),
        worker,
        Some(process),
        request_id,
        result,
    )
    .await
}

pub(crate) async fn has_request(
    app: &AppHandle,
    worker: &str,
    process: u64,
    request_id: &str,
) -> bool {
    crate::hermes_agent::has_request(&app.state(), worker, process, request_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_frames_map_to_driver_frames() {
        let request = json!({"kind":"request","id":"r1","method":"approval","params":{"choices":["once","deny"]}});
        assert!(matches!(
            &frames(&request)[..],
            [Frame::Request {
                method: "approval",
                ..
            }]
        ));
        assert!(matches!(
            &frames(&json!({"kind":"event","type":"thinking.delta","payload":{"text":"x"}}))[..],
            [Frame::Event {
                kind: "reasoning.delta",
                ..
            }]
        ));
        assert!(frames(&json!({"kind":"event","type":"status.update","payload":{}})).is_empty());
        assert_eq!(
            frames(&json!({"kind":"error","code":"changed"})),
            vec![Frame::Error {
                code: "changed".into(),
                detail: None
            }]
        );
    }

    #[test]
    fn replies_are_reduced_to_what_the_bridge_validates() {
        let approval = json!({"method":"approval"});
        assert_eq!(
            approval_result(&approval, &json!({"choice":"deny","answers":{}})).unwrap(),
            json!({"choice":"deny"})
        );
        let clarify = json!({"method":"clarify"});
        assert_eq!(
            approval_result(&clarify, &json!({"answer":"yes"})).unwrap(),
            json!({"answer":"yes"})
        );
        assert_eq!(
            approval_result(&clarify, &json!({"choice":"deny"})).unwrap(),
            json!({})
        );
    }
}
