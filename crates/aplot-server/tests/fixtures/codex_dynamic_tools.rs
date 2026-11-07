use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, BufRead, Write},
    path::PathBuf,
};

fn home() -> io::Result<PathBuf> {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "CODEX_HOME"))
}

fn send(value: &str) -> io::Result<()> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    output.write_all(value.as_bytes())?;
    output.write_all(b"\n")?;
    output.flush()
}

fn request_id(line: &str) -> io::Result<String> {
    let start = line
        .find("\"id\":")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "request id missing"))?
        + "\"id\":".len();
    let rest = line[start..].trim_start();
    let end = rest
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(rest.len());
    if end == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "request id invalid",
        ));
    }
    Ok(rest[..end].to_owned())
}

fn response(id: &str, result: &str) -> io::Result<()> {
    send(&format!("{{\"id\":{id},\"result\":{result}}}"))
}

fn append(home: &std::path::Path, file: &str, line: &str) -> io::Result<()> {
    let mut target = OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join(file))?;
    writeln!(target, "{line}")
}

fn turn_started() -> io::Result<()> {
    send("{\"method\":\"turn/started\",\"params\":{\"threadId\":\"fixture-thread\",\"turn\":{\"id\":\"fixture-turn\",\"status\":\"inProgress\"}}}")
}

fn tool_call(id: u64, call_id: &str, tool: &str, args: &str, turn_id: &str) -> io::Result<()> {
    send(&format!(
        "{{\"id\":{id},\"method\":\"item/tool/call\",\"params\":{{\"threadId\":\"fixture-thread\",\"turnId\":\"{turn_id}\",\"callId\":\"{call_id}\",\"tool\":\"{tool}\",\"arguments\":{args}}}}}"
    ))
}

fn next_answer(lines: &mut impl Iterator<Item = io::Result<String>>) -> io::Result<String> {
    let answer = lines
        .next()
        .transpose()?
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "client response missing"))?;
    append(&home()?, "client-responses.log", &answer)?;
    Ok(answer)
}

fn finish_turn(id: &str) -> io::Result<()> {
    send("{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"fixture-thread\",\"turn\":{\"id\":\"fixture-turn\",\"status\":\"completed\",\"error\":null}}}")?;
    response(id, "{\"turn\":{\"id\":\"fixture-turn\"}}")
}

fn run() -> io::Result<()> {
    let home = home()?;
    fs::create_dir_all(&home)?;
    append(&home, "launches.log", "launch")?;
    let mode = fs::read_to_string(home.join("fixture-mode")).unwrap_or_default();
    let mode = mode.trim();
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    while let Some(line) = lines.next() {
        let line = line?;
        if line.contains("\"method\":\"initialize\"") {
            append(&home, "initialize.log", &line)?;
            response(&request_id(&line)?, "{\"capabilities\":{}}")?;
        } else if line.contains("\"method\":\"initialized\"") {
        } else if line.contains("\"method\":\"config/read\"") {
            response(&request_id(&line)?, "{\"config\":{\"web_search\":\"live\"}}")?;
        } else if line.contains("\"method\":\"thread/inject_items\"") {
            append(&home, "injected-items.log", &line)?;
            response(&request_id(&line)?, "{}")?;
        } else if line.contains("\"method\":\"account/read\"") {
            response(
                &request_id(&line)?,
                "{\"account\":{\"type\":\"chatgpt\",\"email\":\"fixture@example.com\"}}",
            )?;
        } else if line.contains("\"method\":\"thread/start\"") {
            append(&home, "thread-start.log", &line)?;
            response(
                &request_id(&line)?,
                "{\"thread\":{\"id\":\"fixture-thread\"}}",
            )?;
        } else if line.contains("\"method\":\"thread/resume\"") {
            append(&home, "thread-resume.log", &line)?;
            response(
                &request_id(&line)?,
                "{\"thread\":{\"id\":\"fixture-thread\"}}",
            )?;
        } else if line.contains("\"method\":\"turn/start\"") {
            let id = request_id(&line)?;
            append(&home, "turn-start.log", &line)?;
            match mode {
                "calls" => {
                    turn_started()?;
                    tool_call(
                        90,
                        "call-1",
                        "aplot_list_projects",
                        "{\"projectId\":\"p1\"}",
                        "fixture-turn",
                    )?;
                    let first = next_answer(&mut lines)?;
                    if !first.contains("\"success\":true") {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "tool result missing",
                        ));
                    }
                    tool_call(
                        91,
                        "call-1",
                        "aplot_list_projects",
                        "\"{\\\"projectId\\\":\\\"p1\\\"}\"",
                        "fixture-turn",
                    )?;
                    let replay = next_answer(&mut lines)?;
                    if !replay.contains("\"success\":true") {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "tool replay missing",
                        ));
                    }
                    tool_call(
                        92,
                        "call-1",
                        "aplot_list_projects",
                        "{\"projectId\":\"other\"}",
                        "fixture-turn",
                    )?;
                    if !next_answer(&mut lines)?.contains("\"error\"") {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "changed call id was accepted",
                        ));
                    }
                    tool_call(
                        93,
                        "call-out-of-scope",
                        "aplot_list_projects",
                        "{}",
                        "other-turn",
                    )?;
                    if !next_answer(&mut lines)?.contains("\"error\"") {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "out-of-scope call was accepted",
                        ));
                    }
                    tool_call(94, "call-unknown", "aplot_secret", "{}", "fixture-turn")?;
                    if !next_answer(&mut lines)?.contains("\"error\"") {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "unknown tool was accepted",
                        ));
                    }
                    finish_turn(&id)?;
                }
                "unbound" => {
                    tool_call(
                        90,
                        "call-before-started",
                        "aplot_list_projects",
                        "{}",
                        "fixture-turn",
                    )?;
                    if !next_answer(&mut lines)?.contains("\"error\"") {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "unbound tool call was accepted",
                        ));
                    }
                    turn_started()?;
                    tool_call(
                        91,
                        "call-after-started",
                        "aplot_list_projects",
                        "{}",
                        "fixture-turn",
                    )?;
                    if !next_answer(&mut lines)?.contains("\"success\":true") {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "validated tool call failed",
                        ));
                    }
                    finish_turn(&id)?;
                }
                "approval" => {
                    turn_started()?;
                    send("{\"id\":900,\"method\":\"item/commandExecution/requestApproval\",\"params\":{\"command\":\"write-file\",\"availableDecisions\":[\"accept\",\"decline\"]}}")?;
                    let answer = next_answer(&mut lines)?;
                    if !answer.contains("\"decision\":\"decline\"") {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "approval-not-denied",
                        ));
                    }
                    finish_turn(&id)?;
                }
                "oversized-arguments" => {
                    turn_started()?;
                    let large = "x".repeat(70_000);
                    let args = format!("{{\"blob\":\"{large}\"}}");
                    tool_call(
                        90,
                        "call-large",
                        "aplot_list_projects",
                        &args,
                        "fixture-turn",
                    )?;
                    if !next_answer(&mut lines)?.contains("\"error\"") {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "oversized arguments were accepted",
                        ));
                    }
                    finish_turn(&id)?;
                }
                "tool-result-large" => {
                    turn_started()?;
                    tool_call(
                        90,
                        "call-large-result",
                        "aplot_list_projects",
                        "{}",
                        "fixture-turn",
                    )?;
                    let _ = next_answer(&mut lines)?;
                    finish_turn(&id)?;
                }
                "call-limit" => {
                    turn_started()?;
                    for index in 0..33 {
                        tool_call(
                            100 + index,
                            &format!("call-{index}"),
                            "aplot_list_projects",
                            "{}",
                            "fixture-turn",
                        )?;
                        let answer = next_answer(&mut lines)?;
                        let valid = if index < 32 {
                            answer.contains("\"success\":true")
                        } else {
                            answer.contains("\"error\"")
                        };
                        if !valid {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "tool call limit mismatch",
                            ));
                        }
                    }
                    finish_turn(&id)?;
                }
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "unknown fixture mode",
                    ))
                }
            }
        } else if line.contains("\"method\":\"turn/interrupt\"") {
            response(&request_id(&line)?, "{}")?;
        }
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("dynamic tool fixture: {error}");
        std::process::exit(1);
    }
}
