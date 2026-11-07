use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, BufRead, Write},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

fn home() -> io::Result<std::path::PathBuf> {
    env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "CODEX_HOME"))
}

fn mode() -> String {
    fs::read_to_string(home().unwrap().join("fixture-mode"))
        .unwrap_or_else(|_| "complete".into())
        .trim()
        .to_owned()
}

fn send(value: &str) -> io::Result<()> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    output.write_all(value.as_bytes())?;
    output.write_all(b"\n")?;
    output.flush()
}

fn quote(value: &str) -> String {
    let mut escaped = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c if c.is_control() => escaped.push(' '),
            c => escaped.push(c),
        }
    }
    escaped.push('"');
    escaped
}

fn request_id(line: &str) -> Option<&str> {
    let start = line.find("\"id\":")? + "\"id\":".len();
    let rest = line[start..].trim_start();
    let end = rest
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(rest.len());
    (end > 0).then_some(&rest[..end])
}

fn response(id: &str, result: &str) -> io::Result<()> {
    send(&format!("{{\"id\":{id},\"result\":{result}}}"))
}

fn error_response(id: &str, message: &str) -> io::Result<()> {
    send(&format!(
        "{{\"id\":{id},\"error\":{{\"code\":-32602,\"message\":{}}}}}",
        quote(message)
    ))
}

fn append_marker(home: &std::path::Path, file: &str, value: &str) -> io::Result<()> {
    let mut marker = OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join(file))?;
    writeln!(marker, "{value}")
}

fn completion(status: &str, error: Option<&str>, include_ids: bool) -> io::Result<()> {
    let ids = if include_ids {
        "\"threadId\":\"fixture-thread\","
    } else {
        ""
    };
    let turn_id = if include_ids {
        "\"id\":\"fixture-turn\","
    } else {
        ""
    };
    let error = error.map_or("null".to_owned(), |value| {
        format!("{{\"message\":{}}}", quote(value))
    });
    send(&format!(
        "{{\"method\":\"turn/completed\",\"params\":{{{ids}\"turn\":{{{turn_id}\"status\":{},\"error\":{error}}}}}}}",
        quote(status)
    ))
}

fn event_delta(kind: &str, value: &str) -> io::Result<()> {
    send(&format!(
        "{{\"method\":{},\"params\":{{\"delta\":{}}}}}",
        quote(kind),
        quote(value)
    ))
}

fn write_launch_marker(home: &std::path::Path) -> io::Result<()> {
    #[cfg(windows)]
    fs::write(
        home.join("system-drive.log"),
        env::var("SystemDrive").unwrap_or_default(),
    )?;
    let mut marker = OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join("launches.log"))?;
    writeln!(marker, "launch")
}

fn descendant_helper() -> io::Result<()> {
    let home = home()?;
    thread::sleep(Duration::from_millis(700));
    fs::write(home.join("descendant-survived"), b"alive")
}

fn run() -> io::Result<()> {
    if env::args().any(|argument| argument == "--descendant-writer") {
        return descendant_helper();
    }
    let home = home()?;
    fs::create_dir_all(&home)?;
    write_launch_marker(&home)?;
    let mode = mode();
    let mut dynamic_thread = format!("fixture-thread-{}", std::process::id());

    let input = io::stdin();
    let mut lines = input.lock().lines();
    while let Some(line) = lines.next() {
        let line = line?;
        if line.contains("\"method\":\"initialize\"") {
            response(request_id(&line).unwrap(), "{\"capabilities\":{}}")?;
        } else if line.contains("\"method\":\"config/read\"") {
            let search_mode = if mode == "hosted-search-disabled" { "disabled" } else { "live" };
            response(request_id(&line).unwrap(), &format!("{{\"config\":{{\"web_search\":{}}}}}", quote(search_mode)))?;
        } else if line.contains("\"method\":\"thread/inject_items\"") {
            append_marker(&home, "injected-items.log", &line)?;
            if mode == "inject-fail" {
                error_response(request_id(&line).unwrap(), "fixture policy refresh rejected")?;
            } else {
                response(request_id(&line).unwrap(), "{}")?;
            }
        } else if line.contains("\"method\":\"thread/start\"") {
            append_marker(&home, "thread-starts.log", "start")?;
            append_marker(&home, "thread-start-params.log", &line)?;
            if mode == "delegate-tools" {
                if !line.contains("\"dynamicTools\"") || !line.contains("aplot_delegate") {
                    return Err(io::Error::other("dynamic-tools-not-advertised"));
                }
                append_marker(&home, "tool-thread-params.log", &line)?;
                response(
                    request_id(&line).unwrap(),
                    &format!("{{\"thread\":{{\"id\":{}}}}}", quote(&dynamic_thread)),
                )?;
                continue;
            }
            response(
                request_id(&line).unwrap(),
                "{\"thread\":{\"id\":\"fixture-thread\"}}",
            )?;
        } else if line.contains("\"method\":\"thread/resume\"") {
            append_marker(&home, "thread-resumes.log", &line)?;
            append_marker(&home, "thread-resume-params.log", &line)?;
            if mode == "delegate-tools" {
                let marker = "\"threadId\":\"";
                let start = line
                    .find(marker)
                    .ok_or_else(|| io::Error::other("resume-thread-missing"))?
                    + marker.len();
                dynamic_thread = line[start..].split('"').next().unwrap().to_owned();
                response(
                    request_id(&line).unwrap(),
                    &format!("{{\"thread\":{{\"id\":{}}}}}", quote(&dynamic_thread)),
                )?;
                continue;
            }
            if mode == "resume-fail" {
                error_response(request_id(&line).unwrap(), "fixture thread missing")?;
            } else if mode == "resume-wrong-id" {
                response(
                    request_id(&line).unwrap(),
                    "{\"thread\":{\"id\":\"different-thread\"}}",
                )?;
            } else {
                response(
                    request_id(&line).unwrap(),
                    "{\"thread\":{\"id\":\"fixture-thread\"}}",
                )?;
            }
        } else if line.contains("\"method\":\"turn/start\"") {
            append_marker(&home, "turn-start-params.log", &line)?;
            let id = request_id(&line).unwrap().to_owned();
            if mode == "descendant" {
                let mut child = Command::new(env::current_exe()?);
                child
                    .arg("--descendant-writer")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    child.creation_flags(0x08000000);
                }
                child.spawn()?;
            }
            match mode.as_str() {
                "delegate-tools" => {
                    response(&id, "{\"turn\":{\"id\":\"fixture-turn\"}}")?;
                    send(&format!("{{\"id\":900,\"method\":\"item/tool/call\",\"params\":{{\"threadId\":{},\"turnId\":\"fixture-turn\",\"callId\":\"list-1\",\"tool\":\"aplot_list_projects\",\"arguments\":{{}}}}}}", quote(&dynamic_thread)))?;
                    let answer = lines.next().transpose()?.unwrap_or_default();
                    if !answer.contains("\"success\":true") {
                        return Err(io::Error::other("project-list-failed"));
                    }
                    if line.contains("parent delegation") {
                        for rpc_id in [901, 902] {
                            send(&format!("{{\"id\":{rpc_id},\"method\":\"item/tool/call\",\"params\":{{\"threadId\":{},\"turnId\":\"fixture-turn\",\"callId\":\"delegate-1\",\"tool\":\"aplot_delegate\",\"arguments\":{{\"agentId\":\"specialist\",\"prompt\":\"child read-only work\"}}}}}}", quote(&dynamic_thread)))?;
                            let answer = lines.next().transpose()?.unwrap_or_default();
                            append_marker(&home, "delegation-replies.log", &answer)?;
                            if !answer.contains("\"success\":true") || !answer.contains("queued") {
                                return Err(io::Error::other("delegation-failed"));
                            }
                        }
                    }
                    let collecting = line.contains("collect result");
                    if collecting {
                        let task_id = fs::read_to_string(home.join("result-task-id"))?;
                        send(&format!("{{\"id\":903,\"method\":\"item/tool/call\",\"params\":{{\"threadId\":{},\"turnId\":\"fixture-turn\",\"callId\":\"result-1\",\"tool\":\"aplot_task_result\",\"arguments\":{{\"taskId\":{}}}}}}}", quote(&dynamic_thread), quote(task_id.trim())))?;
                        let answer = lines.next().transpose()?.unwrap_or_default();
                        append_marker(&home, "result-replies.log", &answer)?;
                        if !answer.contains("\"success\":true")
                            || !answer.contains("completed")
                            || !answer.contains("standalone tool answer")
                        {
                            return Err(io::Error::other("child-result-not-completed"));
                        }
                    }
                    let text = if collecting {
                        "collected child result"
                    } else {
                        "standalone tool answer"
                    };
                    send(&format!("{{\"method\":\"item/agentMessage/delta\",\"params\":{{\"threadId\":{},\"turnId\":\"fixture-turn\",\"delta\":{}}}}}", quote(&dynamic_thread), quote(text)))?;
                    send(&format!("{{\"method\":\"turn/completed\",\"params\":{{\"threadId\":{},\"turn\":{{\"id\":\"fixture-turn\",\"status\":\"completed\",\"error\":null}}}}}}", quote(&dynamic_thread)))?;
                }
                "hang" => {
                    response(&id, "{\"turn\":{\"id\":\"fixture-turn\"}}")?;
                }
                "approval" => {
                    send("{\"id\":900,\"method\":\"item/commandExecution/requestApproval\",\"params\":{\"command\":\"write-file\",\"availableDecisions\":[\"accept\",\"decline\"]}}")?;
                    let answer = lines.next().transpose()?.unwrap_or_default();
                    if !answer.contains("\"decision\":\"decline\"") {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "approval-not-denied",
                        ));
                    }
                    completion("completed", None, true)?;
                    response(&id, "{\"turn\":{\"id\":\"fixture-turn\"}}")?;
                }
                "user-input" => {
                    send("{\"id\":901,\"method\":\"item/tool/requestUserInput\",\"params\":{\"questions\":[]}}")?;
                    let answer = lines.next().transpose()?.unwrap_or_default();
                    if !answer.contains("\"code\":-32601") {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "input-not-rejected",
                        ));
                    }
                    completion("failed", Some("unsupported input request"), true)?;
                    response(&id, "{\"turn\":{\"id\":\"fixture-turn\"}}")?;
                }
                "large" => {
                    event_delta("item/agentMessage/delta", &"x".repeat(64_001))?;
                    response(&id, "{\"turn\":{\"id\":\"fixture-turn\"}}")?;
                }
                "missing-ids" => {
                    response(&id, "{\"turn\":{\"id\":\"fixture-turn\"}}")?;
                    completion("completed", None, false)?;
                }
                "wrong-scope" => {
                    response(&id, "{\"turn\":{\"id\":\"fixture-turn\"}}")?;
                    send("{\"method\":\"item/agentMessage/delta\",\"params\":{\"threadId\":\"other-thread\",\"delta\":\"wrong\"}}")?;
                    send("{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"other-thread\",\"turn\":{\"id\":\"fixture-turn\",\"status\":\"completed\"}}}")?;
                    event_delta("item/agentMessage/delta", "fixture answer")?;
                    completion("completed", None, true)?;
                }
                _ => {
                    event_delta("item/agentMessage/delta", if mode == "mobile-demo" {
                        "Тестовый ответ локального имитатора. Сообщение с телефона принято, история сохранена на сервере."
                    } else { "fixture answer" })?;
                    event_delta("item/reasoning/summaryTextDelta", "fixture reasoning")?;
                    send("{\"method\":\"item/started\",\"params\":{\"item\":{\"id\":\"fixture-tool\",\"type\":\"commandExecution\",\"command\":\"printf fixture\",\"status\":\"inProgress\"}}}")?;
                    send("{\"method\":\"item/commandExecution/outputDelta\",\"params\":{\"itemId\":\"fixture-tool\",\"delta\":\"tool output\"}}")?;
                    send("{\"method\":\"item/completed\",\"params\":{\"item\":{\"id\":\"fixture-tool\",\"type\":\"commandExecution\",\"command\":\"printf fixture\",\"status\":\"completed\",\"exitCode\":0,\"aggregatedOutput\":\"ok\"}}}")?;
                    if mode == "failed" {
                        completion("failed", Some("fixture failure"), true)?;
                    } else {
                        completion("completed", None, true)?;
                    }
                    response(&id, "{\"turn\":{\"id\":\"fixture-turn\"}}")?;
                }
            }
        } else if line.contains("\"method\":\"turn/interrupt\"") {
            completion("interrupted", Some("fixture interrupted"), true)?;
            response(request_id(&line).unwrap(), "{}")?;
        } else if line.contains("\"method\":\"account/read\"") {
            if !line.contains("\"refreshToken\":false") {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "account-read-requested-refresh",
                ));
            }
            let result = match mode.as_str() {
                "account-null" => "{\"account\":null,\"requiresOpenaiAuth\":true}",
                "account-api-key" => {
                    "{\"account\":{\"type\":\"apiKey\"},\"requiresOpenaiAuth\":true}"
                }
                "account-no-email" => {
                    "{\"account\":{\"type\":\"chatgpt\",\"email\":null},\"requiresOpenaiAuth\":true}"
                }
                "account-changed" => {
                    "{\"account\":{\"type\":\"chatgpt\",\"email\":\"changed@example.com\",\"planType\":\"pro\"},\"requiresOpenaiAuth\":true}"
                }
                _ => {
                    "{\"account\":{\"type\":\"chatgpt\",\"email\":\"fixture@example.com\",\"planType\":\"pro\"},\"requiresOpenaiAuth\":true}"
                }
            };
            response(request_id(&line).unwrap(), result)?;
        } else if line.contains("\"method\":\"initialized\"") {
            // Initialization notification.
        }
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("fixture: {error}");
        std::process::exit(1);
    }
}
