use aplot_server::{router, ServerData};
use std::{net::SocketAddr, path::PathBuf};

struct Options {
    data_dir: PathBuf,
    listen: SocketAddr,
    check: bool,
    snapshot: bool,
    workspace: bool,
    project: Option<PathBuf>,
    new_task: Option<String>,
    name: Option<String>,
    run_task: Option<String>,
    executable: Option<PathBuf>,
    codex_home: Option<PathBuf>,
    model: Option<String>,
    prompt_file: Option<PathBuf>,
    command_id: Option<String>,
    timeout: u64,
    reset_session: Option<String>,
    drain_queue: bool,
    max_turns: usize,
    mobile: bool,
    init_mobile_token: bool,
    mobile_token_file: Option<PathBuf>,
    mobile_assets: Option<PathBuf>,
    public_origin: Option<String>,
    allow_private_http: bool,
}

fn validate_listener_policy(
    listen: SocketAddr,
    mobile: bool,
    allow_private_http: bool,
    public_origin: Option<&str>,
) -> Result<(), &'static str> {
    if allow_private_http {
        if !mobile {
            return Err("unexpected-private-http-option");
        }
        if listen.port() == 0 || !is_rfc1918_listener(listen) {
            return Err("private-http-listen-invalid");
        }
        let expected_origin = format!("http://{listen}");
        if public_origin.is_some_and(|origin| origin != expected_origin) {
            return Err("private-http-origin-mismatch");
        }
        return Ok(());
    }
    if !listen.ip().is_loopback() {
        return Err("remote-access-not-enabled");
    }
    Ok(())
}

fn is_rfc1918_listener(listen: SocketAddr) -> bool {
    let SocketAddr::V4(address) = listen else {
        return false;
    };
    let [first, second, _, _] = address.ip().octets();
    first == 10 || first == 172 && (16..=31).contains(&second) || first == 192 && second == 168
}

fn options() -> Result<Option<Options>, String> {
    let mut args = std::env::args().skip(1);
    let mut data_dir = None;
    let mut listen = "127.0.0.1:0".parse::<SocketAddr>().unwrap();
    let mut check = false;
    let mut snapshot = false;
    let mut workspace = false;
    let mut project = None;
    let mut new_task = None;
    let mut name = None;
    let mut run_task = None;
    let mut executable = None;
    let mut codex_home = None;
    let mut model = None;
    let mut prompt_file = None;
    let mut command_id = None;
    let mut timeout = 300;
    let mut reset_session = None;
    let mut drain_queue = false;
    let mut max_turns = 8;
    let mut mobile = false;
    let mut init_mobile_token = false;
    let mut mobile_token_file = None;
    let mut mobile_assets = None;
    let mut public_origin = None;
    let mut allow_private_http = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!("aplotd --data-dir <directory> [--listen 127.0.0.1:PORT]\nLocal actions: --check | --snapshot | --workspace | --register-project <directory> --name <name> | --new-task <project-id> --name <title>\nThe default listener exposes metadata only. --mobile enables authenticated mobile endpoints.");
                println!("Local read-only turn: --run-codex <task-id> --codex-executable <absolute-path> --model <id> --prompt-file <path> [--codex-home <isolated-directory>] [--command-id <id>] [--timeout-seconds 300]");
                println!("Abandon a saved native conversation pointer (retain history): --reset-session <task-id>");
                println!("Execute accepted queued Codex turns sequentially: --drain-codex-queue --codex-executable <absolute-path> [--codex-home <isolated-directory>] [--max-turns 8] [--timeout-seconds 300]. Each task supplies its saved model. Unsupported runtimes remain queued.");
                println!("Mobile client: --init-mobile-token [--mobile-token-file <private-file>] creates a new access key file (never prints the key). Then --mobile --mobile-assets <built-directory> [--mobile-token-file <private-file>] [--public-origin https://your-server] [--codex-executable <absolute-path> --model <id>]. The listener stays on loopback by default; --allow-private-http permits a matching RFC1918 IPv4 HTTP origin for a trusted LAN.");
                return Ok(None);
            }
            "--data-dir" => data_dir = Some(PathBuf::from(args.next().ok_or("missing-data-dir")?)),
            "--listen" => {
                listen = args
                    .next()
                    .ok_or("missing-listen")?
                    .parse()
                    .map_err(|_| "invalid-listen")?
            }
            "--check" => check = true,
            "--snapshot" => snapshot = true,
            "--reset-session" => reset_session = Some(args.next().ok_or("missing-task-id")?),
            "--drain-codex-queue" => drain_queue = true,
            "--mobile" => mobile = true,
            "--init-mobile-token" => init_mobile_token = true,
            "--mobile-token-file" => {
                mobile_token_file = Some(PathBuf::from(args.next().ok_or("missing-token-file")?))
            }
            "--mobile-assets" => {
                mobile_assets = Some(PathBuf::from(args.next().ok_or("missing-mobile-assets")?))
            }
            "--public-origin" => public_origin = Some(args.next().ok_or("missing-public-origin")?),
            "--allow-private-http" => allow_private_http = true,
            "--max-turns" => {
                max_turns = args
                    .next()
                    .ok_or("missing-max-turns")?
                    .parse()
                    .map_err(|_| "invalid-max-turns")?;
            }
            "--workspace" => workspace = true,
            "--register-project" => {
                project = Some(PathBuf::from(args.next().ok_or("missing-project-root")?))
            }
            "--new-task" => new_task = Some(args.next().ok_or("missing-project-id")?),
            "--name" => name = Some(args.next().ok_or("missing-name")?),
            "--run-codex" => run_task = Some(args.next().ok_or("missing-task-id")?),
            "--codex-executable" => {
                executable = Some(PathBuf::from(args.next().ok_or("missing-executable")?))
            }
            "--codex-home" => {
                codex_home = Some(PathBuf::from(args.next().ok_or("missing-codex-home")?))
            }
            "--model" => model = Some(args.next().ok_or("missing-model")?),
            "--prompt-file" => {
                prompt_file = Some(PathBuf::from(args.next().ok_or("missing-prompt-file")?))
            }
            "--command-id" => command_id = Some(args.next().ok_or("missing-command-id")?),
            "--timeout-seconds" => {
                timeout = args
                    .next()
                    .ok_or("missing-timeout")?
                    .parse()
                    .map_err(|_| "invalid-timeout")?
            }
            _ => return Err(format!("unknown-option: {arg}")),
        }
    }
    validate_listener_policy(listen, mobile, allow_private_http, public_origin.as_deref())?;
    let data_dir = data_dir
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or("explicit-data-dir-required")?;
    if [
        check,
        snapshot,
        workspace,
        project.is_some(),
        new_task.is_some(),
        run_task.is_some(),
        reset_session.is_some(),
        drain_queue,
        mobile,
        init_mobile_token,
    ]
    .into_iter()
    .filter(|value| *value)
    .count()
        > 1
    {
        return Err("conflicting-inspection-options".into());
    }
    if (project.is_some() || new_task.is_some()) != name.is_some() {
        return Err("name-required-for-creation-only".into());
    }
    if run_task.is_some()
        && (executable.is_none()
            || model.as_deref().is_none_or(|value| value.trim().is_empty())
            || prompt_file.is_none()
            || !(1..=3600).contains(&timeout))
    {
        return Err("codex-options-required".into());
    }
    if drain_queue
        && (executable.is_none()
            || model.is_some()
            || prompt_file.is_some()
            || command_id.is_some()
            || !(1..=64).contains(&max_turns)
            || !(1..=3600).contains(&timeout))
    {
        return Err("queue-options-invalid".into());
    }
    if !drain_queue && max_turns != 8 {
        return Err("unexpected-max-turns".into());
    }
    if mobile
        && (mobile_assets.is_none()
            || executable.is_some() != model.is_some()
            || model.as_deref().is_some_and(|m| m.trim().is_empty())
            || prompt_file.is_some()
            || command_id.is_some()
            || !(1..=3600).contains(&timeout)
            || (executable.is_none() && (codex_home.is_some() || timeout != 300)))
    {
        return Err("mobile-options-invalid".into());
    }
    if !mobile && (mobile_assets.is_some() || public_origin.is_some()) {
        return Err("unexpected-mobile-options".into());
    }
    if mobile_token_file.is_some() && !mobile && !init_mobile_token {
        return Err("unexpected-token-file".into());
    }
    if run_task.is_none()
        && !drain_queue
        && !mobile
        && (executable.is_some()
            || codex_home.is_some()
            || model.is_some()
            || prompt_file.is_some()
            || command_id.is_some()
            || timeout != 300)
    {
        return Err("unexpected-codex-options".into());
    }
    Ok(Some(Options {
        data_dir,
        listen,
        check,
        snapshot,
        workspace,
        project,
        new_task,
        name,
        run_task,
        executable,
        codex_home,
        model,
        prompt_file,
        command_id,
        timeout,
        reset_session,
        drain_queue,
        max_turns,
        mobile,
        init_mobile_token,
        mobile_token_file,
        mobile_assets,
        public_origin,
        allow_private_http,
    }))
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("aplotd: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let Some(options) = options().map_err(std::io::Error::other)? else {
        return Ok(());
    };
    let mut data = ServerData::open(&options.data_dir)?;
    let mobile_token_file = options
        .mobile_token_file
        .clone()
        .unwrap_or_else(|| options.data_dir.join("mobile-access.token"));
    if options.init_mobile_token {
        use std::io::Write;
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let mut file_options = std::fs::OpenOptions::new();
        file_options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            file_options.mode(0o600);
        }
        let mut file = file_options.open(&mobile_token_file)?;
        file.write_all(token.as_bytes())?;
        file.sync_all()?;
        println!(
            "{}",
            serde_json::json!({"status":"created","tokenFile":mobile_token_file.canonicalize()?})
        );
        return Ok(());
    }
    if options.mobile {
        use std::io::Read;
        let mut token = String::new();
        std::fs::File::open(&mobile_token_file)?
            .take(130)
            .read_to_string(&mut token)?;
        let token = token.trim().to_owned();
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(std::io::Error::other("mobile-token-invalid").into());
        }
        let server_directory = options.data_dir.canonicalize()?;
        let runtime =
            options
                .executable
                .map(|executable| aplot_server::codex_runtime::CodexRunConfig {
                    executable,
                    codex_home: options
                        .codex_home
                        .unwrap_or(server_directory.join("codex-home")),
                    working_directory: PathBuf::new(),
                    model: options.model.unwrap(),
                    timeout: std::time::Duration::from_secs(options.timeout),
                    access_mode: None,
                    resume_thread_id: None,
                });
        let listener = tokio::net::TcpListener::bind(options.listen).await?;
        let address = listener.local_addr()?;
        let origin = options
            .public_origin
            .unwrap_or_else(|| format!("http://{address}"));
        let (host, worker) = aplot_server::mobile_host::start_mobile_host(data, runtime)?;
        let app = aplot_server::mobile_api::mobile_router(
            host.clone(),
            aplot_server::mobile_api::MobileApiConfig {
                public_origin: origin.clone(),
                access_token: token,
                assets_dir: options.mobile_assets.unwrap(),
                allow_private_http: options.allow_private_http,
            },
        )?;
        let mut worker_task = tokio::spawn(worker.run());
        println!(
            "{}",
            serde_json::json!({"event":"listening","address":address.to_string(),"mobileUrl":format!("{origin}/mobile/")})
        );
        let serving = async {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await
        };
        tokio::pin!(serving);
        tokio::select! {
            result = &mut serving => {
                host.shutdown();
                let worker_result = worker_task.await?;
                result?;
                worker_result?;
            }
            result = &mut worker_task => {
                host.shutdown();
                result??;
                return Err(std::io::Error::other("mobile-worker-stopped").into());
            }
        }
        return Ok(());
    }
    if options.drain_queue {
        let config = aplot_server::codex_runtime::CodexRunConfig {
            executable: options.executable.unwrap(),
            codex_home: options
                .codex_home
                .unwrap_or(options.data_dir.canonicalize()?.join("codex-home")),
            working_directory: PathBuf::new(),
            model: String::new(),
            timeout: std::time::Duration::from_secs(options.timeout),
            access_mode: None,
            resume_thread_id: None,
        };
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let interrupt = tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                let _ = cancel_tx.send(true);
            }
        });
        let report = data
            .drain_codex_queue(config, cancel_rx, options.max_turns)
            .await;
        interrupt.abort();
        let report = report?;
        println!("{}", serde_json::to_string(&report)?);
        if report.cancelled || report.failed > 0 || report.interrupted > 0 {
            return Err(std::io::Error::other("queue-drain-not-completed").into());
        }
        return Ok(());
    }
    if let Some(task_id) = options.reset_session {
        println!("{}", data.reset_runtime_session(&task_id)?);
        return Ok(());
    }
    if let Some(task_id) = options.run_task {
        use std::io::Read;
        let mut prompt = String::new();
        std::fs::File::open(options.prompt_file.unwrap())?
            .take(64_001)
            .read_to_string(&mut prompt)?;
        if prompt.len() > 64_000 {
            return Err(std::io::Error::other("prompt-limit").into());
        }
        let config = aplot_server::codex_runtime::CodexRunConfig {
            executable: options.executable.unwrap(),
            codex_home: options
                .codex_home
                .unwrap_or(options.data_dir.canonicalize()?.join("codex-home")),
            working_directory: PathBuf::new(),
            model: options.model.unwrap(),
            timeout: std::time::Duration::from_secs(options.timeout),
            access_mode: None,
            resume_thread_id: None,
        };
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let interrupt = tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                let _ = cancel_tx.send(true);
            }
        });
        let result = data
            .run_codex(
                &task_id,
                &options
                    .command_id
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                &prompt,
                config,
                cancel_rx,
            )
            .await;
        interrupt.abort();
        let result = result?;
        println!("{result}");
        if result["status"] != "completed" {
            return Err(std::io::Error::other("turn-not-completed").into());
        }
        return Ok(());
    }
    if let Some(project) = options.project {
        println!(
            "{}",
            data.register_project(&project, options.name.as_deref().unwrap())?
        );
        return Ok(());
    }
    if let Some(project_id) = options.new_task {
        println!(
            "{}",
            data.new_task(&project_id, options.name.as_deref().unwrap())?
        );
        return Ok(());
    }
    if options.workspace {
        println!("{}", data.workspace_snapshot()?);
        return Ok(());
    }
    if options.snapshot {
        println!("{}", serde_json::to_string(&data.snapshot()?)?);
        return Ok(());
    }
    if options.check {
        println!("{}", serde_json::to_string(&data.info())?);
        return Ok(());
    }
    let listener = tokio::net::TcpListener::bind(options.listen).await?;
    let address = listener.local_addr()?;
    let app = router(data.info(), address)?;
    println!(
        "{}",
        serde_json::json!({"event":"listening","address":address.to_string(),"server":data.info()})
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    drop(data);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(value: &str) -> SocketAddr {
        value.parse().unwrap()
    }

    #[test]
    fn private_http_opt_in_requires_mobile_private_ipv4_and_matching_origin() {
        assert_eq!(
            validate_listener_policy(addr("127.0.0.1:4180"), true, false, None),
            Ok(())
        );
        assert_eq!(
            validate_listener_policy(addr("192.168.1.20:4180"), true, false, None),
            Err("remote-access-not-enabled")
        );
        assert_eq!(
            validate_listener_policy(addr("192.168.1.20:4180"), true, true, None),
            Ok(())
        );
        for listen in ["10.4.0.2:4180", "172.16.0.2:4180", "172.31.255.254:4180"] {
            assert_eq!(
                validate_listener_policy(addr(listen), true, true, None),
                Ok(()),
                "rejected {listen}"
            );
        }
        assert_eq!(
            validate_listener_policy(
                addr("192.168.1.20:4180"),
                true,
                true,
                Some("http://192.168.1.20:4180")
            ),
            Ok(())
        );
        assert_eq!(
            validate_listener_policy(
                addr("192.168.1.20:4180"),
                true,
                true,
                Some("http://192.168.1.21:4180")
            ),
            Err("private-http-origin-mismatch")
        );
        assert_eq!(
            validate_listener_policy(addr("192.168.1.20:4180"), false, true, None),
            Err("unexpected-private-http-option")
        );
        for listen in [
            "127.0.0.1:4180",
            "0.0.0.0:4180",
            "8.8.8.8:4180",
            "172.15.1.1:4180",
            "172.32.1.1:4180",
            "192.167.1.1:4180",
            "192.168.1.20:0",
            "[::1]:4180",
        ] {
            assert_eq!(
                validate_listener_policy(addr(listen), true, true, None),
                Err("private-http-listen-invalid"),
                "accepted {listen}"
            );
        }
    }
}
